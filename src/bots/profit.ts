// Real profit per sale for each listing: what the buyer pays, minus eBay fees (on item + shipping),
// the ad fee, the shipping label you pay for, and plastic/packaging.
//  - Free shipping: you pay the label (pricing.free_ship_label_cost).
//  - Calculated / flat shipping: the buyer pays the label, but eBay still charges fees on that shipping.
// Shipping setup is read from each listing (GetItem) and cached for 6 hours.
import { rest, trading } from "../ebay.js";
import { BotConfig, Listing, val } from "./shared.js";

export type Ship = { kind: "free" | "calculated" | "flat"; buyer: number };
export type Profit = { total: number; fees: number; profit: number; margin: number; floor: number };

const shipCache = new Map<string, { at: number; ship: Ship }>();
const SHIP_TTL = 6 * 3600_000;

async function readShip(cfg: BotConfig, itemId: string): Promise<Ship> {
  const r = await trading("GetItem", { ItemID: itemId, DetailLevel: "ReturnAll" });
  const item = Array.isArray(r.Item) ? r.Item[0] : r.Item;
  const sd = item?.ShippingDetails;
  if (!sd) throw new Error("no shipping details");
  const type = String(val(Array.isArray(sd.ShippingType) ? sd.ShippingType[0] : sd.ShippingType) || "");
  const opts = sd.ShippingServiceOptions ? (Array.isArray(sd.ShippingServiceOptions) ? sd.ShippingServiceOptions : [sd.ShippingServiceOptions]) : [];
  const first = opts[0] || {};
  const free = String(val(first.FreeShipping) || "") === "true" || /free/i.test(String(val(first.ShippingService) || ""));
  if (free) return { kind: "free", buyer: 0 };
  if (/calculated/i.test(type) && !/^flat/i.test(type)) return { kind: "calculated", buyer: cfg.pricing.calc_ship_estimate ?? 5.51 };
  const cost = Number(val(first.ShippingServiceCost) ?? NaN);
  if (isFinite(cost) && cost === 0) return { kind: "free", buyer: 0 };
  return { kind: "flat", buyer: isFinite(cost) ? cost : (cfg.pricing.calc_ship_estimate ?? 5.51) };
}

/** Shipping setup for each listing (cached). Unknown listings fall back to the listing's own shipping cost. */
export async function shipInfo(cfg: BotConfig, listings: Listing[]): Promise<Map<string, Ship>> {
  const out = new Map<string, Ship>();
  const todo: Listing[] = [];
  for (const l of listings) {
    const hit = shipCache.get(l.item_id);
    if (hit && Date.now() - hit.at < SHIP_TTL) out.set(l.item_id, hit.ship);
    else todo.push(l);
  }
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map(async (l) => {
      try {
        const ship = await readShip(cfg, l.item_id);
        shipCache.set(l.item_id, { at: Date.now(), ship });
        out.set(l.item_id, ship);
      } catch {
        out.set(l.item_id, { kind: "flat", buyer: l.shipping_cost }); // couldn't read it: use what the listing data shows
      }
    }));
  }
  return out;
}

const fvf = (cfg: BotConfig) => cfg.pricing.fvf_rate ?? 0.136;
const adFrac = (cfg: BotConfig, adPct?: number | null) => (adPct ?? cfg.marketing.max_ad_rate ?? 5) / 100;
const material = (cfg: BotConfig, id: string) => cfg.pricing.costs?.[id]?.material ?? cfg.pricing.default_material_cost;
const label = (cfg: BotConfig, id: string, ship: Ship) =>
  ship.kind === "free" ? (cfg.pricing.costs?.[id]?.label ?? cfg.pricing.free_ship_label_cost ?? 5.51) : 0; // buyer-paid labels net to 0

/** Profit for one unit at item price `price`. */
export function profitAt(cfg: BotConfig, id: string, price: number, ship: Ship, adPct?: number | null): Profit {
  const total = price + ship.buyer;
  const fees = total * (fvf(cfg) + adFrac(cfg, adPct)) + cfg.pricing.per_order_fee;
  const profit = price - fees - label(cfg, id, ship) - material(cfg, id); // buyer-paid shipping covers its own label
  return { total, fees, profit, margin: price > 0 ? profit / price : 0, floor: floorPrice(cfg, id, ship, adPct) };
}

/** Lowest item price that still makes min_margin profit (as a share of the item price). */
export function floorPrice(cfg: BotConfig, id: string, ship: Ship, adPct?: number | null, margin = cfg.pricing.min_margin): number {
  const rate = fvf(cfg) + adFrac(cfg, adPct);
  const fixed = cfg.pricing.per_order_fee + label(cfg, id, ship) + material(cfg, id) + ship.buyer * rate;
  return Math.ceil((fixed / (1 - rate - margin)) * 100) / 100;
}

/** Ad rate (%) per listing from running Promoted Listings (cost-per-sale) campaigns. */
export async function adRates(): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  const j = await rest("GET", "/sell/marketing/v1/ad_campaign", { query: { limit: "100" } });
  for (const c of j.campaigns || []) {
    if (c.campaignStatus !== "RUNNING") continue;
    const a = await rest("GET", `/sell/marketing/v1/ad_campaign/${c.campaignId}/ad`, { query: { limit: "500" } });
    for (const ad of a.ads || []) m.set(String(ad.listingId), Number(ad.bidPercentage));
  }
  return m;
}
