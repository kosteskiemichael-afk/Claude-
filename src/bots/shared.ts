// Shared pieces for the store bots: config, burr-holder protection, eBay data
// fetchers and the change log every bot writes to.
import { readFileSync, existsSync } from "node:fs";
import { rest, trading, tradingWarnings } from "../ebay.js";

// ---------------- config ----------------
export type PriceRule = {
  query: string;              // eBay search used to find competitors
  must_include?: string[];    // competitor title must contain all of these words
  exclude?: string[];         // ignore competitor titles containing any of these
  min?: number;               // never go below this item price
  max?: number;               // never go above this item price
  label_cost?: number;        // what your shipping label costs you
  material_cost?: number;     // filament + packaging
  note?: string;
};

export type BotConfig = {
  timezone: string;
  run_hours_local: number[];
  dry_run: boolean;
  my_seller_ids: string[];
  inventory: { enabled: boolean; restock_below: number; restock_to: number; never_restock: string[] };
  pricing: {
    enabled: boolean;
    fee_rate: number;          // eBay final value fee + ad + processing, as a fraction
    per_order_fee: number;     // eBay's fixed per-order fee
    min_margin: number;        // profit floor as a fraction of the sale price
    default_label_cost: number;
    default_material_cost: number;
    undercut: number;          // how far below the cheapest competitor to sit
    raise_when_below_pct: number; // raise if you're this much cheaper than everyone
    max_step_pct: number;      // biggest price move in a single run
    min_change: number;        // ignore moves smaller than this
    once_per_day: boolean;     // reprice only on the morning run (avoids price wars)
    rules: Record<string, PriceRule>;
  };
  marketing: { enabled: boolean; target_ad_rate: number; max_ad_rate: number; ad_rates: Record<string, number>; add_unpromoted: boolean };
  service: { enabled: boolean; ship_warning_hours: number };
  production: { enabled: boolean };
  finder: { enabled: boolean; day: number; min_sold: number; queries: string[] };
};

const DEFAULTS: BotConfig = {
  timezone: "America/Indianapolis",
  run_hours_local: [7, 13, 19],
  dry_run: false,
  my_seller_ids: ["nexamfgco"],
  inventory: { enabled: true, restock_below: 3, restock_to: 10, never_restock: [] },
  pricing: {
    enabled: true,
    fee_rate: 0.156, // 13.6% final value fee (US, most categories) + 2% ad
    per_order_fee: 0.4,
    min_margin: 0.4,
    default_label_cost: 1.69,
    default_material_cost: 0.5,
    undercut: 0.01,
    raise_when_below_pct: 0.02,
    max_step_pct: 0.1,
    min_change: 0.2,
    once_per_day: true,
    rules: {},
  },
  marketing: { enabled: true, target_ad_rate: 2.0, max_ad_rate: 5.0, ad_rates: {}, add_unpromoted: false },
  service: { enabled: true, ship_warning_hours: 18 },
  production: { enabled: true },
  finder: {
    enabled: true,
    day: 1, // Monday morning
    min_sold: 100,
    queries: [
      "3d printed replacement part", "3d printed replacement gear", "3d printed replacement knob",
      "3d printed replacement clip", "3d printed battery door", "3d printed replacement cover",
      "3d printed replacement handle", "3d printed replacement cap", "3d printed replacement latch",
      "3d printed replacement bracket", "3d printed replacement hinge", "3d printed obsolete part",
    ],
  },
};

function merge<T>(base: T, over: any): T {
  if (!over || typeof over !== "object" || Array.isArray(over)) return (over ?? base) as T;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as any)[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) && k !== "rules" ? merge(b, v) : v;
  }
  return out;
}

export function loadConfig(): BotConfig {
  let file: any = {};
  const path = process.env.BOT_CONFIG_FILE || "bots.config.json";
  if (existsSync(path)) file = JSON.parse(readFileSync(path, "utf8"));
  const envJson = process.env.BOT_CONFIG ? JSON.parse(process.env.BOT_CONFIG) : {};
  const cfg = merge(merge(DEFAULTS, file), envJson);
  if (process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true") cfg.dry_run = true;
  return cfg;
}

// ---------------- burr holder protection ----------------
const PROTECTED_IDS = new Set(
  (process.env.PROTECTED_ITEM_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
);
const PROTECTED_WORDS = (process.env.PROTECTED_TITLE_KEYWORDS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export function isProtected(itemId: string, title?: string): boolean {
  if (PROTECTED_IDS.has(String(itemId))) return true;
  const t = (title || "").toLowerCase();
  return PROTECTED_WORDS.some((w) => t.includes(w));
}

// ---------------- report ----------------
export type Report = {
  changes: string[];   // things the bots did
  urgent: string[];    // needs you now (messages, late shipments)
  info: string[];      // FYI lines
};
export const newReport = (): Report => ({ changes: [], urgent: [], info: [] });

// ---------------- helpers ----------------
export const val = (x: any): string | undefined =>
  x === undefined || x === null ? undefined : typeof x === "object" ? x["#text"] : String(x);
export const num = (x: any): number | undefined => {
  const v = val(x);
  return v === undefined || v === "" ? undefined : Number(v);
};
export const money = (n: number) => `$${n.toFixed(2)}`;
export const short = (t: string, n = 38) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);

// ---------------- eBay data ----------------
export type Listing = {
  item_id: string;
  title: string;
  price: number;
  quantity_available: number;
  sold: number;
  shipping_cost: number;
  has_variations: boolean;
  protected: boolean;
};

export async function activeListings(): Promise<Listing[]> {
  const out: Listing[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await trading("GetMyeBaySelling", {
      ActiveList: { Include: "true", Pagination: { EntriesPerPage: 200, PageNumber: page } },
      DetailLevel: "ReturnAll",
    });
    const al = r.ActiveList || {};
    for (const it of al.ItemArray?.Item || []) {
      const opt = it.ShippingDetails?.ShippingServiceOptions?.[0];
      const id = String(val(it.ItemID));
      const title = String(val(it.Title) || "");
      out.push({
        item_id: id,
        title,
        price: num(it.SellingStatus?.CurrentPrice ?? it.BuyItNowPrice ?? it.StartPrice) ?? 0,
        quantity_available: num(it.QuantityAvailable) ?? num(it.Quantity) ?? 0,
        sold: num(it.SellingStatus?.QuantitySold) ?? 0,
        shipping_cost: opt ? num(opt.ShippingServiceCost) ?? 0 : 0,
        has_variations: !!it.Variations,
        protected: isProtected(id, title),
      });
    }
    const pages = num(al.PaginationResult?.TotalNumberOfPages) ?? 1;
    if (page >= pages) break;
  }
  return out;
}

export type Order = {
  order_id: string;
  created: string;
  status: string;
  ship_by?: string;
  buyer?: string;
  items: { item_id: string; title: string; quantity: number }[];
};

export async function recentOrders(days: number, onlyUnshipped: boolean): Promise<Order[]> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  let filter = `creationdate:[${since}..]`;
  if (onlyUnshipped) filter += ",orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}";
  const out: Order[] = [];
  for (let offset = 0; offset < 1000; offset += 200) {
    const j = await rest("GET", "/sell/fulfillment/v1/order", {
      query: { filter, limit: "200", offset: String(offset) },
    });
    for (const o of j.orders || []) {
      if (o.cancelStatus?.cancelState && o.cancelStatus.cancelState !== "NONE_REQUESTED") continue;
      const shipBy = (o.lineItems || [])
        .map((li: any) => li.lineItemFulfillmentInstructions?.shipByDate)
        .filter(Boolean).sort()[0];
      out.push({
        order_id: o.orderId,
        created: o.creationDate,
        status: o.orderFulfillmentStatus,
        ship_by: shipBy,
        buyer: o.buyer?.username,
        items: (o.lineItems || []).map((li: any) => ({
          item_id: String(li.legacyItemId), title: String(li.title || ""), quantity: Number(li.quantity || 1),
        })),
      });
    }
    if (!j.next || (j.orders || []).length < 200) break;
  }
  return out;
}

/** Price / quantity change through ReviseInventoryStatus. Refuses protected items. */
export async function setPriceQty(
  cfg: BotConfig,
  changes: { item_id: string; title: string; price?: number; quantity?: number }[],
): Promise<string[]> {
  const safe = changes.filter((c) => !isProtected(c.item_id, c.title));
  if (cfg.dry_run || !safe.length) return [];
  const warnings: string[] = [];
  for (let i = 0; i < safe.length; i += 4) {
    const chunk = safe.slice(i, i + 4);
    const r = await trading("ReviseInventoryStatus", {
      InventoryStatus: chunk.map((c) => ({
        ItemID: c.item_id,
        ...(c.price !== undefined ? { StartPrice: c.price.toFixed(2) } : {}),
        ...(c.quantity !== undefined ? { Quantity: c.quantity } : {}),
      })),
    });
    warnings.push(...tradingWarnings(r));
  }
  return warnings;
}
