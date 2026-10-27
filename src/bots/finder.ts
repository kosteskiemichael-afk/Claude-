// Product finder bots. Four strategies, all ending in the same check: a 3D-printed eBay listing
// with real sales (min_sold+), not something you already sell or already saw, plus a CAD file
// you're allowed to sell prints of (CC0 / CC BY / CC BY-SA / GPL...; never NC).
//   keywords     searches "3d printed <part type>" across a pool of 128 searches
//   competitors  mines the whole catalog of proven 3D-print sellers
//   categories   sweeps eBay's categories that hold the most 3D-printed parts
//   cadfirst     starts from sellable CAD files on Printables, then checks eBay demand for them
import { rest } from "../ebay.js";
import { askJson, brainOn, FAST_MODEL } from "./brain.js";
import { storeCall, storedLinks } from "../store.js";
import { BotConfig, Listing, Report, money, short } from "./shared.js";

type Hit = { id: string; legacy: string; title: string; seller: string; price: number; sold?: number };
type Cad = { url: string; name: string; license: string };

const STOP = new Set("new replacement part parts for the and with 3d printed printing print heavy duty pack of set fits fit compatible kit black white plastic gear free shipping usa made".split(" "));
const tokens = (t: string) =>
  [...new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)))];
const overlap = (a: string[], b: string[]) => { const s = new Set(b); return a.filter((w) => s.has(w)).length; };

// Licenses that allow selling prints. Anything NonCommercial (NC) is rejected.
const okLicense = (l: string) => !/NC/i.test(l) && /^(CC0|CC-BY|CC-BY-SA|CC-BY-ND|GPL|LGPL|AGPL|BSD|MIT)(\b|[- .\d]|$)/i.test(l.trim());

/** Split the search pool into even batches; batch k takes every k-th search, so each batch mixes categories. */
function batchOf(cfg: BotConfig, k: number): string[] {
  const all = cfg.finder.queries;
  const batches = Math.max(1, Math.ceil(all.length / Math.min(all.length, cfg.finder.queries_per_run || all.length)));
  return all.filter((_, i) => i % batches === ((k % batches) + batches) % batches);
}
const batchCount = (cfg: BotConfig) => Math.max(1, Math.ceil(cfg.finder.queries.length / Math.min(cfg.finder.queries.length, cfg.finder.queries_per_run || cfg.finder.queries.length)));

/** Today's batch (scheduled morning run). */
export function todaysQueries(cfg: BotConfig, day = Math.floor(Date.now() / 86400_000)): string[] {
  return batchOf(cfg, day);
}

// Each Find-products click moves on to the next batch, so every click looks somewhere new.
let clickBatch: number | null = null;
export function finderBatchCount(cfg: BotConfig) { return batchCount(cfg); }
export function nextQueries(cfg: BotConfig, manual: boolean): string[] {
  const day = Math.floor(Date.now() / 86400_000);
  if (!manual) return todaysQueries(cfg, day);
  clickBatch = ((clickBatch ?? (day + Math.floor(Math.random() * batchCount(cfg)))) + 1) % batchCount(cfg);
  return batchOf(cfg, clickBatch);
}

// Ideas found since the service started, newest first. The dashboard shows these on the product board.
export type FoundIdea = { found: string; title: string; seller: string; sold: number; price: number; ebay: string; cad: string; license: string; cadName: string; status: string; decision: string };
export const finds: FoundIdea[] = [];

const BROWSE = "/buy/browse/v1/item_summary/search";
const BASE_FILTER = "buyingOptions:{FIXED_PRICE},itemLocationCountry:US,conditions:{NEW}";
/** Run Browse searches and keep 3D-printed listings from other sellers. */
async function collect(cfg: BotConfig, searches: { q: string; filter?: string; category?: string; keep?: number; must?: (title: string) => boolean }[]): Promise<Hit[]> {
  const mine = new Set(cfg.my_seller_ids.map((s) => s.toLowerCase()));
  const seen = new Map<string, Hit>();
  for (const sch of searches) {
    try {
      const query: Record<string, string> = { q: sch.q, limit: "200", filter: BASE_FILTER + (sch.filter ? "," + sch.filter : "") };
      if (sch.category) query.category_ids = sch.category;
      const j = await rest("GET", BROWSE, { app: true, query });
      let kept = 0;
      for (const it of j.itemSummaries || []) {
        if (kept >= (sch.keep ?? 50)) break;
        const title = String(it.title || "");
        const seller = String(it.seller?.username || "");
        if (!/3d|printed/i.test(title) || /not 3d printed/i.test(title) || mine.has(seller.toLowerCase())) continue;
        if (sch.must && !sch.must(title)) continue;
        const legacy = String(it.legacyItemId || it.itemId?.split("|")[1] || "");
        if (!legacy || seen.has(legacy)) continue;
        seen.set(legacy, { id: it.itemId, legacy, title, seller, price: Number(it.price?.value || 0) });
        kept++;
      }
    } catch { /* one bad search shouldn't stop the scan */ }
  }
  return [...seen.values()];
}

// ---------- the four strategies ----------
export type Strategy = "keywords" | "competitors" | "categories" | "cadfirst";
export const STRATEGY_NAMES: Record<Strategy, string> = {
  keywords: "Keyword bot", competitors: "Competitor bot", categories: "Category bot", cadfirst: "CAD-first bot",
};
type Gathered = { hits: Hit[]; searched: string[]; presetCad: Map<string, Cad> };
const counters: Record<string, number> = {};
const nextK = (key: string, start = 0) => (counters[key] = (counters[key] ?? start - 1) + 1);

// Competitor bot: sellers already proven to move printed parts; scan their whole printed catalog.
async function gatherCompetitors(cfg: BotConfig): Promise<Gathered> {
  const counts = new Map<string, number>();
  const add = (s: string, w = 1) => { if (s && !cfg.my_seller_ids.includes(s.toLowerCase())) counts.set(s, (counts.get(s) || 0) + w); };
  try { const j = await storeCall({ action: "list" }); for (const x of j.rows || []) if (Number(x.sold) >= cfg.finder.min_sold) add(String(x.seller), 3); } catch { /* ignore */ }
  finds.forEach((f) => add(f.seller, 3));
  if (counts.size < 12) { // seed with whoever shows up most in broad printed-part searches
    for (const h of await collect(cfg, [{ q: "3d printed replacement part", keep: 200 }, { q: "3d printed replacement", keep: 200 }])) add(h.seller);
  }
  const sellers = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s).slice(0, 48);
  if (!sellers.length) return { hits: [], searched: [], presetCad: new Map() };
  const per = 6, batches = Math.ceil(sellers.length / per), k = nextK("competitors") % batches;
  const pick = sellers.slice(k * per, k * per + per);
  const hits = await collect(cfg, pick.flatMap((s) => [{ q: "3d printed", filter: `sellers:{${s}}`, keep: 200 }, { q: "printed", filter: `sellers:{${s}}`, keep: 200 }]));
  return { hits, searched: pick.map((s) => `seller ${s}`), presetCad: new Map() };
}

// Category bot: eBay's own category breakdown of printed parts; search inside each category.
let catCache: { at: number; cats: { id: string; name: string }[] } | null = null;
async function gatherCategories(cfg: BotConfig): Promise<Gathered> {
  if (!catCache || Date.now() - catCache.at > 86400_000) {
    const m = new Map<string, { id: string; name: string; n: number }>();
    for (const q of ["3d printed replacement", "3d printed part", "3d printed knob", "3d printed cover"]) {
      try {
        const j = await rest("GET", BROWSE, { app: true, query: { q, limit: "1", filter: BASE_FILTER, fieldgroups: "CATEGORY_REFINEMENTS" } });
        for (const c of j.refinement?.categoryDistributions || []) {
          const e = m.get(String(c.categoryId)) || { id: String(c.categoryId), name: String(c.categoryName), n: 0 };
          e.n += Number(c.matchCount || 0); m.set(e.id, e);
        }
      } catch { /* ignore */ }
    }
    catCache = { at: Date.now(), cats: [...m.values()].sort((a, b) => b.n - a.n).slice(0, 36) };
  }
  const cats = catCache.cats;
  if (!cats.length) return { hits: [], searched: [], presetCad: new Map() };
  const per = 6, batches = Math.ceil(cats.length / per), k = nextK("categories") % batches;
  const pick = cats.slice(k * per, k * per + per);
  const hits = await collect(cfg, pick.flatMap((c) => [{ q: "3d printed", category: c.id, keep: 80 }, { q: "3d printed replacement", category: c.id, keep: 80 }]));
  return { hits, searched: pick.map((c) => c.name), presetCad: new Map() };
}

// CAD-first bot: sellable CAD files first, then proof that printed copies sell on eBay.
const CAD_FIRST_QUERIES = ["replacement knob", "replacement clip", "battery cover", "replacement handle", "replacement gear",
  "replacement latch", "replacement cap", "replacement bracket", "replacement hinge", "replacement foot", "cup holder insert",
  "appliance replacement part", "car interior clip", "vacuum replacement part", "power tool replacement part", "obsolete part",
  "remote battery cover", "boat replacement part", "dishwasher part", "fridge part"];
async function gatherCadFirst(cfg: BotConfig): Promise<Gathered> {
  const per = 4, batches = Math.ceil(CAD_FIRST_QUERIES.length / per), k = nextK("cadfirst") % batches;
  const pick = CAD_FIRST_QUERIES.slice(k * per, k * per + per);
  const presetCad = new Map<string, Cad>();
  const all = new Map<string, Hit>();
  for (const q of pick) {
    const models = (await printables(q, 30).catch(() => [])).filter((m) => okLicense(m.license)).slice(0, 10);
    for (const m of models) {
      const mt = tokens(m.name);
      if (mt.length < 2) continue;
      const hits = await collect(cfg, [{ q: "3d printed " + mt.slice(0, 3).join(" "), keep: 15, must: (t) => overlap(tokens(t), mt) >= Math.min(3, mt.length) }]);
      for (const h of hits) if (!all.has(h.legacy)) {
        all.set(h.legacy, h);
        presetCad.set(h.legacy, { url: `https://www.printables.com/model/${m.id}`, name: m.name, license: m.license });
      }
    }
  }
  return { hits: [...all.values()], searched: pick.map((q) => `Printables: ${q}`), presetCad };
}

async function gatherKeywords(cfg: BotConfig, manual: boolean): Promise<Gathered> {
  const queries = nextQueries(cfg, manual);
  return { hits: await collect(cfg, queries.map((q) => ({ q }))), searched: queries, presetCad: new Map() };
}

// Find-products clicks cycle through the four bots; the morning run does keywords + one other.
const ORDER: Strategy[] = ["keywords", "competitors", "categories", "cadfirst"];
let clickStrategy = -1;
export function nextStrategy(): Strategy { clickStrategy = (clickStrategy + 1) % ORDER.length; return ORDER[clickStrategy]; }
export function morningExtra(day = Math.floor(Date.now() / 86400_000)): Strategy { return ORDER[1 + (day % 3)]; }
export const DEEP_PLAN: Strategy[] = ["keywords", "competitors", "categories", "cadfirst", "keywords", "competitors", "categories", "cadfirst", "keywords", "keywords", "keywords", "keywords", "keywords"];

/** eBay's Browse item details include an estimated sold quantity. */
async function addSoldCounts(hits: Hit[]) {
  const soldOf = (it: any) => Math.max(0, ...(it.estimatedAvailabilities || []).map((a: any) => Number(a.estimatedSoldQuantity || 0)));
  const one = async (h: Hit) => {
    try { h.sold = soldOf(await rest("GET", `/buy/browse/v1/item/${encodeURIComponent(h.id)}`, { app: true, timeoutMs: 15000 })); }
    catch { /* skip */ }
  };
  // 6 lookups at a time keeps a full scan to a minute or two.
  for (let i = 0; i < hits.length; i += 6) await Promise.all(hits.slice(i, i + 6).map(one));
}

async function printables(query: string, limit = 10): Promise<{ id: string; name: string; license: string }[]> {
  const r = await fetch("https://api.printables.com/graphql/", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", origin: "https://www.printables.com", referer: "https://www.printables.com/" },
    body: JSON.stringify({
      query: "query($q:String!,$n:Int!){searchPrints2(query:$q,limit:$n){items{id name license{abbreviation}}}}",
      variables: { q: query, n: limit },
    }),
  });
  if (!r.ok) throw new Error(`Printables ${r.status}`);
  const j: any = await r.json();
  return (j.data?.searchPrints2?.items || []).map((i: any) => ({ id: String(i.id), name: String(i.name), license: String(i.license?.abbreviation || "") }));
}

// Thingiverse (optional): needs a free app token from thingiverse.com/developers in THINGIVERSE_TOKEN.
async function thingiverse(query: string): Promise<{ id: string; name: string; license: string }[]> {
  const tok = process.env.THINGIVERSE_TOKEN;
  if (!tok) return [];
  const h = { Authorization: `Bearer ${tok}` };
  const r = await fetch(`https://api.thingiverse.com/search/${encodeURIComponent(query)}?type=things&per_page=8`, { headers: h, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return [];
  const j: any = await r.json();
  const hits = (j.hits || j || []).slice(0, 8);
  const out: { id: string; name: string; license: string }[] = [];
  for (const t of hits) {
    try {
      const d: any = await (await fetch(`https://api.thingiverse.com/things/${t.id}`, { headers: h, signal: AbortSignal.timeout(15000) })).json();
      // Thingiverse license names look like "Creative Commons - Attribution - Share Alike".
      const L = String(d.license || "");
      const abbr = /public domain|cc0/i.test(L) ? "CC0"
        : /non-?commercial/i.test(L) ? "CC-BY-NC"
        : /no derivatives/i.test(L) ? "CC-BY-ND"
        : /share alike/i.test(L) ? "CC-BY-SA"
        : /attribution/i.test(L) ? "CC-BY"
        : /gnu|gpl/i.test(L) ? "GPL" : /bsd/i.test(L) ? "BSD" : L;
      out.push({ id: `tv:${t.id}`, name: String(d.name || t.name || ""), license: abbr });
    } catch { /* skip */ }
  }
  return out;
}

async function findCad(h: Hit): Promise<Cad | null> {
  const t = tokens(h.title);
  const tries = [t.slice(0, 4).join(" "), t.slice(0, 3).join(" "), t.slice(0, 2).join(" ")];
  for (const q of tries) {
    if (!q) continue;
    const pr = await printables(q).catch(() => []);
    const tv = await thingiverse(q).catch(() => []);
    const res = [...pr, ...tv].filter((x) => okLicense(x.license));
    const best = res.find((x) => overlap(t.slice(0, 8), tokens(x.name)) >= Math.min(3, t.length));
    if (best) {
      const url = best.id.startsWith("tv:") ? `https://www.thingiverse.com/thing:${best.id.slice(3)}` : `https://www.printables.com/model/${best.id}`;
      return { url, name: best.name, license: best.license };
    }
  }
  return null;
}

export type FinderSummary = { bot: string; searched: string[]; checked: number; found: number; fresh: number };
export async function finderBot(cfg: BotConfig, myListings: Listing[], r: Report, manual = false, strategy: Strategy = "keywords"): Promise<FinderSummary> {
  const myTokens = myListings.map((l) => tokens(l.title));
  const g = strategy === "competitors" ? await gatherCompetitors(cfg)
    : strategy === "categories" ? await gatherCategories(cfg)
    : strategy === "cadfirst" ? await gatherCadFirst(cfg)
    : await gatherKeywords(cfg, manual);
  const queries = g.searched;
  const botName = STRATEGY_NAMES[strategy];
  const summary: FinderSummary = { bot: botName, searched: queries, checked: 0, found: 0, fresh: 0 };
  (r as any).finder = summary;
  let hits = g.hits;
  console.log(`Finder: ${hits.length} printed listings found`);
  // Skip parts you already sell.
  hits = hits.filter((h) => { const t = tokens(h.title).slice(0, 6); return !myTokens.some((m) => overlap(t, m) >= Math.min(4, t.length)); });
  console.log(`Finder: checking sold counts on ${hits.length} new-to-you listings`);
  // Only look at listings you haven't seen yet (already found, added or dismissed ones are skipped).
  const seenBefore = await storedLinks().catch(() => new Set<string>());
  finds.forEach((f) => seenBefore.add(f.ebay));
  hits = hits.filter((h) => !seenBefore.has(`https://www.ebay.com/itm/${h.legacy}`));
  summary.checked = hits.length;
  await addSoldCounts(hits);
  let top = hits.filter((h) => (h.sold || 0) >= cfg.finder.min_sold).sort((a, b) => (b.sold || 0) - (a.sold || 0)).slice(0, 25);
  if (!top.length) { r.info.push(`🔎 ${botName}: checked ${hits.length} new printed listings, none with ${cfg.finder.min_sold}+ sold (searched: ${queries.slice(0, 4).join(", ")}…).`); return summary; }

  console.log(`Finder: ${top.length} with ${cfg.finder.min_sold}+ sold; checking CAD`);
  const withCad: { h: Hit; cad: Cad }[] = [];
  const noCad: Hit[] = [];
  let cadErrors = 0;
  for (const h of top) {
    const pre = g.presetCad.get(h.legacy);
    if (pre) { withCad.push({ h, cad: pre }); continue; }
    try { const cad = await findCad(h); cad ? withCad.push({ h, cad }) : noCad.push(h); }
    catch { cadErrors++; noCad.push(h); }
  }

  // Brain double-checks that each CAD file is really the same part.
  let verified = withCad;
  if (brainOn() && withCad.length) {
    try {
      const res = await askJson<{ keep: number[] }>(
        FAST_MODEL,
        "You check whether a free 3D model is the same replacement part as an eBay listing (same device/model, same part). Be strict.",
        JSON.stringify(withCad.map((x, i) => ({ i, ebay_title: x.h.title, cad_name: x.cad.name }))) + '\nReturn {"keep":[indexes that match]}',
        800,
      );
      verified = withCad.filter((_, i) => (res.keep || []).includes(i));
      noCad.push(...withCad.filter((_, i) => !(res.keep || []).includes(i)).map((x) => x.h));
    } catch { /* keep unverified list */ }
  }

  // Put every idea on the dashboard's product board right away.
  const today = new Date().toISOString().slice(0, 10);
  const known = new Set(finds.map((f) => f.ebay));
  const ideas: FoundIdea[] = [
    ...verified.map((x) => ({ h: x.h, cad: x.cad as Cad | null })),
    ...noCad.map((h) => ({ h, cad: null as Cad | null })),
  ].map(({ h, cad }) => ({
    found: today, title: h.title, seller: h.seller, sold: h.sold || 0, price: h.price,
    ebay: `https://www.ebay.com/itm/${h.legacy}`, cad: cad?.url || "", license: cad?.license || "", cadName: cad?.name || "",
    status: (cad ? (brainOn() ? "CAD checked - same part" : "Possible CAD - check it's the same part") : "No free CAD found - check paid") + ` · ${botName}`,
    decision: "",
  }));
  summary.found = ideas.length;
  summary.fresh = ideas.filter((i) => !known.has(i.ebay)).length;
  for (const i of ideas.reverse()) { const k = finds.findIndex((f) => f.ebay === i.ebay); if (k >= 0) finds.splice(k, 1); finds.unshift(i); }
  finds.splice(200);

  // Log every idea to your Google Sheet (via the Apps Script web app in SHEETS_WEBHOOK_URL).
  const hook = process.env.SHEETS_WEBHOOK_URL;
  if (hook) {
    const rows = [
      ...verified.map((x) => ({ h: x.h, cad: x.cad })),
      ...noCad.map((h) => ({ h, cad: null as Cad | null })),
    ].map(({ h, cad }) => ({
      found: new Date().toISOString().slice(0, 10),
      title: h.title, seller: h.seller, sold: h.sold, price: h.price,
      ebay_url: `https://www.ebay.com/itm/${h.legacy}`,
      cad_url: cad?.url || "", cad_license: cad?.license || "", cad_name: cad?.name || "",
      status: (cad ? (brainOn() ? "CAD checked - same part" : "Possible CAD - check it's the same part") : "No free CAD found - check paid") + ` · ${botName}`,
    }));
    try {
      const resp = await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows }), signal: AbortSignal.timeout(30000), redirect: "follow" });
      const t = await resp.text();
      r.info.push(resp.ok ? `💾 Saved to your product list: ${t.slice(0, 80)}` : `Saving products failed (${resp.status}).`);
    } catch (e) { r.info.push(`Google Sheet update failed: ${(e as Error).message.slice(0, 80)}`); }
  }

  const line = (h: Hit) => `"${short(h.title, 70)}" by ${h.seller}: ${h.sold} sold @ ${money(h.price)}`;
  const parts: string[] = [];
  const cadHead = brainOn()
    ? "WITH SELLABLE CAD (Claude checked it's the same part):\n"
    : "POSSIBLE SELLABLE CAD (keyword match only: open the link and confirm it's the same part):\n";
  if (verified.length) parts.push(cadHead + verified.slice(0, 10).map((x) => `• ${line(x.h)}\n   CAD: ${x.cad.url} (${x.cad.license}) – ${short(x.cad.name, 50)}`).join("\n"));
  if (noCad.length) parts.push("PROVEN SELLERS, NO FREE CAD (model it yourself):\n" + noCad.slice(0, 6).map((h) => `• ${line(h)}`).join("\n"));
  if (cadErrors) parts.push(`(CAD search failed for ${cadErrors} item(s); check Printables by hand.)`);
  r.info.unshift(`🔎 PRODUCT IDEAS (${botName})\n` + parts.join("\n\n"));
  return summary;
}
