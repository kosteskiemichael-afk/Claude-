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
const SHIP_TTL = 24 * 3600_000;

// Reads shipping from the Browse API (5,000 calls/day) instead of GetItem, whose small daily limit
// was being used up re-reading all ~160 listings after every restart.
async function browseItem(itemId: string): Promise<any> {
  try { return await rest("GET", "/buy/browse/v1/item/get_item_by_legacy_id", { app: true, query: { legacy_item_id: itemId }, timeoutMs: 15000 }); }
  catch {
    const g = await rest("GET", "/buy/browse/v1/item/get_items_by_item_group", { app: true, query: { item_group_id: itemId }, timeoutMs: 15000 });
    const it = (g.items || [])[0]; if (!it) throw new Error("item not found"); return it;
  }
}
async function readShip(cfg: BotConfig, itemId: string): Promise<Ship> {
  const it = await browseItem(itemId);
  const o = (it.shippingOptions || [])[0];
  if (!o) throw new Error("no shipping options");
  const cost = Number(o.shippingCost?.value ?? NaN);
  if (/CALCULATED/i.test(o.shippingCostType || "")) return { kind: "calculated", buyer: cfg.pricing.calc_ship_estimate ?? 5.51 };
  if (isFinite(cost) && cost === 0) return { kind: "free", buyer: 0 };
  return { kind: "flat", buyer: isFinite(cost) ? cost : (cfg.pricing.calc_ship_estimate ?? 5.51) };
}
export { browseItem };

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

/** Lowest item price we'll sell at:
 *  - min_margin profit (30%), but
 *  - small items (that floor under small_item_price, $10) need small_item_margin (50%), and
 *  - every sale must clear min_profit dollars ($2.50) after fees, label and material. */
export function floorPrice(cfg: BotConfig, id: string, ship: Ship, adPct?: number | null, margin?: number): number {
  const rate = fvf(cfg) + adFrac(cfg, adPct);
  const fixed = cfg.pricing.per_order_fee + label(cfg, id, ship) + material(cfg, id) + ship.buyer * rate;
  const at = (m: number) => fixed / (1 - rate - m);
  if (margin !== undefined) return Math.ceil(at(margin) * 100) / 100;
  let p = at(cfg.pricing.min_margin);
  if (p < (cfg.pricing.small_item_price ?? 10)) p = Math.max(p, at(cfg.pricing.small_item_margin ?? 0.5));
  p = Math.max(p, ((cfg.pricing.min_profit ?? 2.5) + fixed) / (1 - rate));
  return Math.ceil(p * 100) / 100;
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
