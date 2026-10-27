// Product finder bot (weekly): searches eBay for 3D-printed parts other sellers
// are moving in volume (100+ sold), skips anything you already sell, and looks
// for a CAD file you're allowed to sell prints of (CC0 / CC BY / CC BY-SA / GPL...).
// Each idea comes with the exact eBay listing, seller, sold count and CAD link.
import { rest } from "../ebay.js";
import { askJson, brainOn, FAST_MODEL } from "./brain.js";
import { storedLinks } from "../store.js";
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
export function nextQueries(cfg: BotConfig, manual: boolean): string[] {
  const day = Math.floor(Date.now() / 86400_000);
  if (!manual) return todaysQueries(cfg, day);
  clickBatch = ((clickBatch ?? (day + Math.floor(Math.random() * batchCount(cfg)))) + 1) % batchCount(cfg);
  return batchOf(cfg, clickBatch);
}

// Ideas found since the service started, newest first. The dashboard shows these on the product board.
export type FoundIdea = { found: string; title: string; seller: string; sold: number; price: number; ebay: string; cad: string; license: string; cadName: string; status: string; decision: string };
export const finds: FoundIdea[] = [];

async function searchEbay(cfg: BotConfig, queries: string[]): Promise<Hit[]> {
  const mine = new Set(cfg.my_seller_ids.map((s) => s.toLowerCase()));
  const seen = new Map<string, Hit>();
  for (const q of queries) {
    try {
      const j = await rest("GET", "/buy/browse/v1/item_summary/search", {
        app: true,
        query: { q, limit: "200", filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:US,conditions:{NEW}" },
      });
      let kept = 0;
      for (const it of j.itemSummaries || []) {
        if (kept >= 30) break;
        const title = String(it.title || "");
        const seller = String(it.seller?.username || "");
        if (!/3d|printed/i.test(title) || /not 3d printed/i.test(title) || mine.has(seller.toLowerCase())) continue;
        const legacy = String(it.legacyItemId || it.itemId?.split("|")[1] || "");
        if (!legacy || seen.has(legacy)) continue;
        seen.set(legacy, { id: it.itemId, legacy, title, seller, price: Number(it.price?.value || 0) });
        kept++;
      }
    } catch { /* one bad query shouldn't stop the scan */ }
  }
  return [...seen.values()];
}

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

async function printables(query: string): Promise<{ id: string; name: string; license: string }[]> {
  const r = await fetch("https://api.printables.com/graphql/", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", origin: "https://www.printables.com", referer: "https://www.printables.com/" },
    body: JSON.stringify({
      query: "query($q:String!){searchPrints2(query:$q,limit:10){items{id name license{abbreviation}}}}",
      variables: { q: query },
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

export type FinderSummary = { searched: string[]; checked: number; found: number; fresh: number };
export async function finderBot(cfg: BotConfig, myListings: Listing[], r: Report, manual = false): Promise<FinderSummary> {
  const myTokens = myListings.map((l) => tokens(l.title));
  const queries = nextQueries(cfg, manual);
  const summary: FinderSummary = { searched: queries, checked: 0, found: 0, fresh: 0 };
  (r as any).finder = summary;
  let hits = await searchEbay(cfg, queries);
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
  if (!top.length) { r.info.push(`🔎 Product finder: checked ${hits.length} new printed listings, none with ${cfg.finder.min_sold}+ sold (searched: ${queries.slice(0, 4).join(", ")}…).`); return summary; }

  console.log(`Finder: ${top.length} with ${cfg.finder.min_sold}+ sold; checking CAD`);
  const withCad: { h: Hit; cad: Cad }[] = [];
  const noCad: Hit[] = [];
  let cadErrors = 0;
  for (const h of top) {
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
    status: cad ? (brainOn() ? "CAD checked - same part" : "Possible CAD - check it's the same part") : "No free CAD found - check paid",
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
      status: cad ? (brainOn() ? "Sellable CAD (verified)" : "Possible CAD - check") : "No free CAD",
    }));
    try {
      const resp = await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows }), signal: AbortSignal.timeout(30000), redirect: "follow" });
      const t = await resp.text();
      r.info.push(resp.ok ? `📊 Added to your Google Sheet: ${t.slice(0, 80)}` : `Google Sheet update failed (${resp.status}).`);
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
  r.info.unshift("🔎 PRODUCT IDEAS\n" + parts.join("\n\n"));
  return summary;
}
