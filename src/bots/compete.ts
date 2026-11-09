// Competition watch + listing doctor.
// For every active listing: find the same part from other sellers, pull the full listing of the
// top seller (most sold) and the cheapest, and compare them to yours on everything a buyer sees:
// delivered price, free shipping, photos, item specifics, description, returns, delivery speed,
// title keywords, promotion. Then read your own eBay traffic (shown / clicked / bought) to find
// WHERE each listing loses the buyer, and list the fixes in order. Read-only: changes nothing.
import { rest } from "../ebay.js";
import { activeListings, loadConfig, Listing, saleListingIds } from "./shared.js";
import { adRates, floorPrice, profitAt, shipInfo, Ship } from "./profit.js";
import type { Traffic } from "./inventory.js";

export type Card = {
  id: string; title: string; seller: string; url: string;
  price: number; ship: number; freeShip: boolean; delivered: number;
  photos: number; specifics: number; descWords: number; sold: number;
  returns: boolean; deliveryDays: number | null; feedback: number; category: string;
};
export type Fix = { what: string; why: string; who: "bot" | "you" | "claude"; impact: number };
export type Doctor = {
  item_id: string; title: string; protected: boolean; on_sale: boolean;
  impressions: number; views: number; sold30: number; ctr: number; conv: number;
  stage: string; mine: Card | null; top: Card | null; cheapest: Card | null; competitors: number;
  demand: number; profit: number; fixes: Fix[]; score: number;
};

const STOP = new Set(["new","replacement","3d","printed","for","the","and","with","part","parts","fits","fit","set","of","pack","pcs","kit","heavy","duty","black","white","high","strength","repair","compatible","pc","x","-","|","&","/","upgraded","upgrade","strong","quality","usa","made","us"]);
const words = (t: string) => [...new Set(t.toLowerCase().replace(/[^a-z0-9\-\/ ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)))];
const strip = (h: string) => String(h || "").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

let calcEst = 5.51; // eBay doesn't return calculated shipping without a buyer address: use the store's estimate
async function card(raw: any): Promise<Card> {
  const ships = (raw.shippingOptions || []).map((s: any) => Number(s.shippingCost?.value ?? 0)).filter(isFinite);
  const calc = (raw.shippingOptions || []).some((s: any) => s.shippingCostType === "CALCULATED");
  let ship = ships.length ? Math.min(...ships) : 0;
  if (calc && ship === 0) ship = calcEst;
  const price = Number(raw.price?.value || 0);
  const maxDate = (raw.shippingOptions || []).map((s: any) => Date.parse(s.maxEstimatedDeliveryDate || "")).filter(isFinite);
  const sold = Math.max(0, ...(raw.estimatedAvailabilities || []).map((a: any) => Number(a.estimatedSoldQuantity || 0)));
  return {
    id: String(raw.legacyItemId || raw.itemId || ""), title: String(raw.title || ""), seller: String(raw.seller?.username || ""),
    url: String(raw.itemWebUrl || "").split("?")[0], price, ship, freeShip: ship === 0 && !calc, delivered: Math.round((price + ship) * 100) / 100,
    photos: (raw.image ? 1 : 0) + (raw.additionalImages || []).length, specifics: (raw.localizedAspects || []).length,
    descWords: strip(raw.description || raw.shortDescription || "").split(" ").filter(Boolean).length, sold,
    returns: !!raw.returnTerms?.returnsAccepted, deliveryDays: maxDate.length ? Math.max(1, Math.round((Math.min(...maxDate) - Date.now()) / 86400_000)) : null,
    feedback: Number(raw.seller?.feedbackScore || 0), category: String(raw.categoryPath || ""),
  };
}

export let lastBrowseError = "";
async function myCard(id: string): Promise<Card | null> {
  try { return await card(await rest("GET", "/buy/browse/v1/item/get_item_by_legacy_id", { app: true, query: { legacy_item_id: id }, timeoutMs: 15000 })); }
  catch {
    try {
      const g = await rest("GET", "/buy/browse/v1/item/get_items_by_item_group", { app: true, query: { item_group_id: id }, timeoutMs: 15000 });
      const it = (g.items || [])[0]; if (!it) return null;
      const c = await card(it); c.id = id; c.sold = Math.max(0, ...(g.items || []).map((x: any) => Math.max(0, ...(x.estimatedAvailabilities || []).map((a: any) => Number(a.estimatedSoldQuantity || 0)))));
      return c;
    } catch (e) { lastBrowseError = (e as Error).message.slice(0, 200); return null; }
  }
}

/** Same part from other sellers, with full listing details. Every number in your title must be in theirs. */
async function rivals(title: string, mine: Set<string>): Promise<Card[]> {
  const kw = words(title);
  const nums = kw.filter((w) => /\d/.test(w)).slice(0, 4);
  const names = kw.filter((w) => !/\d/.test(w)).slice(0, 4);
  const must = [...nums, ...names];
  if (must.length < 2) return [];
  const j = await rest("GET", "/buy/browse/v1/item_summary/search", { app: true, timeoutMs: 20000,
    query: { q: kw.slice(0, 7).join(" "), limit: "60", filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:US,deliveryCountry:US" } });
  const need = Math.max(2, Math.ceil(must.length * 0.6));
  const hits = (j.itemSummaries || []).filter((x: any) => {
    const t = String(x.title || "").toLowerCase();
    if (mine.has(String(x.seller?.username || "").toLowerCase())) return false;
    if (!nums.every((n) => t.includes(n))) return false;
    return must.filter((w) => t.includes(w)).length >= need;
  }).slice(0, 6);
  const out: Card[] = [];
  await Promise.all(hits.map(async (h: any) => {
    try { out.push(await card(await rest("GET", `/buy/browse/v1/item/${encodeURIComponent(h.itemId)}`, { app: true, timeoutMs: 15000 }))); } catch { /* skip */ }
  }));
  return out;
}

function diagnose(l: Listing, t: Traffic | undefined, mine: Card | null, top: Card | null, cheap: Card | null, sh: Ship, ad: number, cfg: ReturnType<typeof loadConfig>, onSale: boolean): { stage: string; fixes: Fix[] } {
  const imp = t?.impressions ?? 0, views = t?.views ?? 0, sold = t?.sold ?? 0;
  const ctr = imp ? views / imp : 0, conv = views ? sold / views : 0;
  const fixes: Fix[] = [];
  const myDelivered = mine ? mine.delivered : l.price + sh.buyer;
  const best = top || cheap;
  const add = (what: string, why: string, who: Fix["who"], impact: number) => fixes.push({ what, why, who, impact });

  // Where the buyer is lost.
  let stage = "selling";
  if (imp < 150) stage = "not shown (search)";
  else if (ctr < 0.008) stage = "shown, not clicked";
  else if (views >= 12 && sold === 0) stage = "clicked, not bought";
  else if (sold === 0) stage = "low traffic";

  if (best && mine) {
    // Price and shipping: what shows in search results.
    const gap = myDelivered - best.delivered;
    if (best.freeShip && !mine.freeShip) {
      const fs: Ship = { kind: "free", buyer: 0 };
      const need = Math.max(floorPrice(cfg, l.item_id, fs, ad), Math.min(best.delivered - 0.01, myDelivered));
      const p = profitAt(cfg, l.item_id, need, fs, ad);
      add(`Switch to FREE shipping at ${"$" + need.toFixed(2)}`, `${best.seller} shows free shipping at $${best.delivered.toFixed(2)}; you show $${l.price.toFixed(2)} + shipping ($${myDelivered.toFixed(2)} delivered). Free shipping ranks higher and wins the click. Profit at that price: $${p.profit.toFixed(2)} (${Math.round(p.margin * 100)}%).`, "claude", 9);
    }
    if (gap > 0.5 && !onSale) add(`Price is $${gap.toFixed(2)} over ${best.seller}`, `They deliver for $${best.delivered.toFixed(2)}, you for $${myDelivered.toFixed(2)}. The pricing bot will close this down to your profit floor.`, "bot", gap > 3 ? 8 : 5);
    if (gap < -2 && sold > 0) add(`You're $${(-gap).toFixed(2)} under ${best.seller}`, `Room to raise while it's selling; the pricing bot raises on its price day.`, "bot", 3);
    // Listing quality: what wins after the click.
    if (best.photos - mine.photos >= 2 || mine.photos < 4) add(`Add photos (${mine.photos} vs ${best.photos})`, `Top seller has ${best.photos}. Add: part in hand for scale, part installed, close-up of the fit, a measurement shot, a white-background main photo.`, "you", stage === "shown, not clicked" ? 8 : 6);
    if (best.specifics - mine.specifics >= 3 || mine.specifics < 6) add(`Fill item specifics (${mine.specifics} vs ${best.specifics})`, `eBay search filters on these (brand, model, part number, material, fitment). Missing ones hide you from filtered searches.`, "claude", stage === "not shown (search)" ? 8 : 5);
    if (mine.descWords < 60 || best.descWords - mine.descWords > 120) add(`Longer description (${mine.descWords} vs ${best.descWords} words)`, `Say what it fits, the material, how it installs, and that you ship fast from the US.`, "claude", stage === "clicked, not bought" ? 6 : 3);
    if (best.returns && !mine.returns) add(`Accept returns`, `${best.seller} accepts returns; you don't. Buyers pick the safer listing.`, "you", 6);
    if (best.deliveryDays && mine.deliveryDays && mine.deliveryDays - best.deliveryDays >= 2) add(`Faster delivery (${mine.deliveryDays} vs ${best.deliveryDays} days)`, `Lower handling time or use a faster default service. eBay shows the delivery date in search.`, "you", 5);
    // Title keywords the top seller uses that you don't.
    if (top) {
      const missing = words(top.title).filter((w) => !mine.title.toLowerCase().includes(w) && w.length > 2).slice(0, 5);
      if (missing.length >= 2 && (stage === "not shown (search)" || stage === "shown, not clicked")) add(`Title keywords: ${missing.join(", ")}`, `The top seller's title has these and yours doesn't: "${top.title}".`, "claude", 6);
    }
  } else if (!best) {
    add(`No competitor found`, `Nobody else lists this exact part, so it's down to search visibility: keywords, specifics, promotion.`, "claude", 1);
  }
  if (stage === "not shown (search)" && ad < 2) add(`Promote it (${ad || 0}% now)`, `eBay barely shows it (${imp} times in 30 days). A 2-4% ad puts it in more searches; you only pay when it sells.`, "bot", 6);
  return { stage, fixes: fixes.sort((a, b) => b.impact - a.impact) };
}

export async function competeReport(traffic?: Map<string, Traffic>, log: (s: string) => void = () => {}): Promise<Doctor[]> {
  const cfg = loadConfig();
  calcEst = cfg.pricing.calc_ship_estimate ?? 5.51;
  const listings = await activeListings();
  const mineIds = new Set(cfg.my_seller_ids.map((s) => s.toLowerCase()));
  const ships = await shipInfo(cfg, listings).catch(() => new Map<string, Ship>());
  const ads = await adRates().catch(() => new Map<string, number>());
  const sale = await saleListingIds().catch(() => new Set<string>());
  log(`${listings.length} listings`);
  const out: Doctor[] = [];
  for (let i = 0; i < listings.length; i += 4) {
    await Promise.all(listings.slice(i, i + 4).map(async (l) => {
      try {
        const [mine, comps] = await Promise.all([myCard(l.item_id), rivals(l.title, mineIds).catch((e) => { lastBrowseError = (e as Error).message.slice(0, 200); return [] as Card[]; })]);
        const top = [...comps].sort((a, b) => b.sold - a.sold)[0] || null;
        const cheapest = [...comps].sort((a, b) => a.delivered - b.delivered)[0] || null;
        const t = traffic?.get(l.item_id);
        const sh = ships.get(l.item_id) || { kind: "calculated", buyer: cfg.pricing.calc_ship_estimate ?? 5.51 } as Ship;
        const ad = ads.get(l.item_id) ?? 0;
        const onSale = sale.has(l.item_id) || !!l.on_sale;
        const d = diagnose(l, t, mine, top, cheapest, sh, ad, cfg, onSale);
        const demand = Math.max(top?.sold ?? 0, cheapest?.sold ?? 0);
        const imp = t?.impressions ?? 0, views = t?.views ?? 0, sold30 = t?.sold ?? 0;
        const profit = Math.round(profitAt(cfg, l.item_id, l.price, sh, ad).profit * 100) / 100;
        // Biggest opportunities first: real demand from competitors, you not getting it, big fixes available.
        const score = Math.round((Math.log10(demand + 1) * 3 + (d.fixes[0]?.impact ?? 0)) * (sold30 >= 5 ? 0.5 : 1) * 10) / 10;
        out.push({ item_id: l.item_id, title: l.title, protected: l.protected, on_sale: onSale, impressions: imp, views, sold30,
          ctr: imp ? Math.round((views / imp) * 1000) / 10 : 0, conv: views ? Math.round((sold30 / views) * 1000) / 10 : 0,
          stage: d.stage, mine, top, cheapest, competitors: comps.length, demand, profit, fixes: d.fixes, score });
      } catch (e) { log(`skip ${l.item_id}: ${(e as Error).message.slice(0, 80)}`); }
    }));
    if (i % 20 === 0) log(`checked ${Math.min(i + 4, listings.length)}/${listings.length}`);
  }
  out.sort((a, b) => b.score - a.score);
  if (lastBrowseError) log(`eBay error: ${lastBrowseError}`);
  if (out.length && out.every((r) => !r.mine)) throw new Error(`eBay's Browse API refused every request: ${lastBrowseError || "unknown"}`);
  return out;
}

/** Store-wide picture: what you do differently from the sellers you're up against. */
export function summary(rows: Doctor[]) {
  const withTop = rows.filter((r) => r.mine && r.top);
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);
  const stages: Record<string, number> = {};
  rows.forEach((r) => (stages[r.stage] = (stages[r.stage] || 0) + 1));
  const who: Record<string, number> = {};
  rows.forEach((r) => r.fixes.forEach((f) => (who[f.what.split(" (")[0].replace(/\$[\d.]+/g, "$").replace(/:.*/, "")] = (who[f.what.split(" (")[0].replace(/\$[\d.]+/g, "$").replace(/:.*/, "")] || 0) + 1)));
  return {
    listings: rows.length, compared: withTop.length, stages,
    you_free_ship_pct: pct(withTop.filter((r) => r.mine!.freeShip).length, withTop.length),
    top_free_ship_pct: pct(withTop.filter((r) => r.top!.freeShip).length, withTop.length),
    you_photos: avg(withTop.map((r) => r.mine!.photos)), top_photos: avg(withTop.map((r) => r.top!.photos)),
    you_specifics: avg(withTop.map((r) => r.mine!.specifics)), top_specifics: avg(withTop.map((r) => r.top!.specifics)),
    you_desc_words: avg(withTop.map((r) => r.mine!.descWords)), top_desc_words: avg(withTop.map((r) => r.top!.descWords)),
    you_cheaper_pct: pct(withTop.filter((r) => r.mine!.delivered <= r.top!.delivered).length, withTop.length),
    most_common_fixes: Object.entries(who).sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}

// Last report, shared by the dashboard page, the API and the morning run.
export const competeJob: { running: boolean; started?: string; finished?: string; log: string[]; rows?: Doctor[]; error?: string } = { running: false, log: [] };
export async function runCompete(traffic?: Map<string, Traffic>): Promise<Doctor[] | undefined> {
  if (competeJob.running) return competeJob.rows;
  Object.assign(competeJob, { running: true, started: new Date().toISOString(), log: [], error: undefined });
  try { competeJob.rows = await competeReport(traffic, (s) => competeJob.log.push(s)); }
  catch (e) { competeJob.error = (e as Error).message; }
  competeJob.running = false; competeJob.finished = new Date().toISOString();
  return competeJob.rows;
}
