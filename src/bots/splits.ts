// Split finder: goes through every multi-variation listing (lathe gear sets etc.), and for each
// option (e.g. "32 Tooth") checks how well that exact part sells as its own listing on eBay.
// Output: a ranked list of which options deserve their own single listing, with proof
// (competitor title, seller, sold count, price) and how many you've sold of that option yourself.
// Read-only: it never changes a listing.
import { rest, trading } from "../ebay.js";
import { activeListings, val } from "./shared.js";

export type SplitRow = {
  rank?: number;
  priority: "HIGH" | "MEDIUM" | "LOW";
  score: number;
  parent_item_id: string;
  parent_title: string;
  parent_impressions: number;
  parent_views: number;
  option: string;
  your_price: number;
  your_sold_of_option: number;
  your_qty: number;
  search_used: string;
  competitor_listings_found: number;
  best_competitor_title: string;
  best_competitor_seller: string;
  best_competitor_sold: number;
  best_competitor_price: number;
  best_competitor_url: string;
  suggested_title: string;
};

const arr = (x: any) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const STOP = new Set(["new", "replacement", "3d", "printed", "nylon", "or", "set", "for", "the", "and", "of", "with", "us", "made", "part", "parts", "kit", "-", "|", "&", "fits"]);

function baseWords(title: string): string[] {
  const words = title.replace(/[^\w"'/.-]+/g, " ").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    const lw = w.toLowerCase().replace(/["']/g, "");
    if (STOP.has(lw)) continue;
    if (/^\d+$/.test(lw) && out.length >= 3) break;          // stop at the option numbers ("20 24 32 ...")
    if (/^\d+(t|dp)?$/.test(lw) && out.length >= 2) continue;
    out.push(w.replace(/["']/g, ""));
    if (out.length >= 5) break;
  }
  return out;
}

function optionNumbers(opt: string): string[] {
  return (opt.match(/\d+(?:[./]\d+)?/g) || []).filter((n) => n.length <= 4);
}

const soldOf = (it: any) => Math.max(0, ...(it?.estimatedAvailabilities || []).map((a: any) => Number(a.estimatedSoldQuantity || 0)));

async function competitors(query: string, mustNums: string[], brand: string, myIds: Set<string>) {
  const j = await rest("GET", "/buy/browse/v1/item_summary/search", {
    app: true, timeoutMs: 20000,
    query: { q: query, limit: "40", filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:US" },
  });
  const hits = (j.itemSummaries || []).filter((x: any) => {
    const t = String(x.title || "").toLowerCase();
    if (myIds.has(String(x.legacyItemId || ""))) return false;
    if (brand && !t.includes(brand.toLowerCase())) return false;
    return mustNums.every((n) => new RegExp(`(^|[^\\d])${n.replace(".", "\\.")}([^\\d]|$)`).test(t));
  }).slice(0, 6);
  const detailed = await Promise.all(hits.map(async (h: any) => {
    try {
      const it = await rest("GET", `/buy/browse/v1/item/${encodeURIComponent(h.itemId)}`, { app: true, timeoutMs: 15000 });
      return { title: String(h.title), seller: String(h.seller?.username || ""), price: Number(h.price?.value || 0), sold: soldOf(it), url: String(h.itemWebUrl || "") };
    } catch { return { title: String(h.title), seller: String(h.seller?.username || ""), price: Number(h.price?.value || 0), sold: 0, url: String(h.itemWebUrl || "") }; }
  }));
  detailed.sort((a, b) => b.sold - a.sold);
  return { count: hits.length, best: detailed[0] };
}

export async function findSplits(traffic?: Map<string, { impressions: number; views: number; sold: number }>, log: (s: string) => void = () => {}): Promise<SplitRow[]> {
  const all = await activeListings();
  const listings = all.filter((l) => l.has_variations && !l.protected);
  const myIds = new Set(all.map((l) => l.item_id));
  log(`${listings.length} multi-option listings to check`);
  const rows: SplitRow[] = [];
  for (const l of listings) {
    let item: any;
    try {
      const r = await trading("GetItem", { ItemID: l.item_id, DetailLevel: "ReturnAll" });
      item = Array.isArray(r.Item) ? r.Item[0] : r.Item;
    } catch { continue; }
    const base = baseWords(l.title);
    const brand = base[0] || "";
    const t = traffic?.get(l.item_id);
    const vars = arr(item?.Variations?.Variation);
    const tasks = vars.map((v: any) => async () => {
      const opt = arr(v.VariationSpecifics?.NameValueList).map((nv: any) => arr(nv.Value).map(val).join(" ")).join(" / ");
      if (!opt || /^(set|full set|complete set|all)/i.test(opt)) return;
      const nums = optionNumbers(opt).slice(0, 2);
      const query = [...base, opt].join(" ").replace(/\s+/g, " ").slice(0, 100);
      let comp: Awaited<ReturnType<typeof competitors>> = { count: 0, best: undefined as any };
      try { comp = await competitors(query, nums, brand, myIds); } catch { /* keep zeros */ }
      const mySold = Number(val(v.SellingStatus?.QuantitySold) || 0);
      const compSold = comp.best?.sold || 0;
      const score = Math.round(compSold + mySold * 8 + (comp.count > 0 ? 2 : 0));
      const priority: SplitRow["priority"] = compSold >= 50 || mySold >= 5 ? "HIGH" : compSold >= 15 || mySold >= 2 ? "MEDIUM" : "LOW";
      const suggested = `${base.join(" ")} ${opt} Replacement`.replace(/\s+/g, " ").slice(0, 80);
      rows.push({
        priority, score, parent_item_id: l.item_id, parent_title: l.title,
        parent_impressions: t?.impressions || 0, parent_views: t?.views || 0,
        option: opt, your_price: Number(val(v.StartPrice) || 0), your_sold_of_option: mySold,
        your_qty: Number(val(v.Quantity) || 0) - mySold, search_used: query,
        competitor_listings_found: comp.count,
        best_competitor_title: comp.best?.title || "", best_competitor_seller: comp.best?.seller || "",
        best_competitor_sold: compSold, best_competitor_price: comp.best?.price || 0, best_competitor_url: comp.best?.url || "",
        suggested_title: suggested,
      });
    });
    for (let i = 0; i < tasks.length; i += 4) await Promise.all(tasks.slice(i, i + 4).map((f: () => Promise<void>) => f()));
    log(`checked ${l.title.slice(0, 50)} (${vars.length} options)`);
  }
  rows.sort((a, b) => b.score - a.score);
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}
