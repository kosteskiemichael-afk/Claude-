// Product finder bot (weekly): searches eBay for 3D-printed parts other sellers
// are moving in volume (100+ sold), skips anything you already sell, and looks
// for a CAD file you're allowed to sell prints of (CC0 / CC BY / CC BY-SA / GPL...).
// Each idea comes with the exact eBay listing, seller, sold count and CAD link.
import { rest } from "../ebay.js";
import { askJson, brainOn, FAST_MODEL } from "./brain.js";
import { BotConfig, Listing, Report, money, short } from "./shared.js";

type Hit = { id: string; legacy: string; title: string; seller: string; price: number; sold?: number };
type Cad = { url: string; name: string; license: string };

const STOP = new Set("new replacement part parts for the and with 3d printed printing print heavy duty pack of set fits fit compatible kit black white plastic gear free shipping usa made".split(" "));
const tokens = (t: string) =>
  [...new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)))];
const overlap = (a: string[], b: string[]) => { const s = new Set(b); return a.filter((w) => s.has(w)).length; };

// Licenses that allow selling prints. Anything NonCommercial (NC) is rejected.
const okLicense = (l: string) => !/NC/i.test(l) && /^(CC0|CC-BY|CC-BY-SA|CC-BY-ND|GPL|LGPL|AGPL|BSD|MIT)(\b|[- .\d]|$)/i.test(l.trim());

async function searchEbay(cfg: BotConfig): Promise<Hit[]> {
  const mine = new Set(cfg.my_seller_ids.map((s) => s.toLowerCase()));
  const seen = new Map<string, Hit>();
  for (const q of cfg.finder.queries) {
    try {
      const j = await rest("GET", "/buy/browse/v1/item_summary/search", {
        app: true,
        query: { q, limit: "200", filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:US,conditions:{NEW}" },
      });
      let kept = 0;
      for (const it of j.itemSummaries || []) {
        if (kept >= 40) break;
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

async function findCad(h: Hit): Promise<Cad | null> {
  const t = tokens(h.title);
  const tries = [t.slice(0, 4).join(" "), t.slice(0, 3).join(" "), t.slice(0, 2).join(" ")];
  for (const q of tries) {
    if (!q) continue;
    const res = (await printables(q)).filter((x) => okLicense(x.license));
    const best = res.find((x) => overlap(t.slice(0, 8), tokens(x.name)) >= Math.min(3, t.length));
    if (best) return { url: `https://www.printables.com/model/${best.id}`, name: best.name, license: best.license };
  }
  return null;
}

export async function finderBot(cfg: BotConfig, myListings: Listing[], r: Report) {
  const myTokens = myListings.map((l) => tokens(l.title));
  let hits = await searchEbay(cfg);
  console.log(`Finder: ${hits.length} printed listings found`);
  // Skip parts you already sell.
  hits = hits.filter((h) => { const t = tokens(h.title).slice(0, 6); return !myTokens.some((m) => overlap(t, m) >= Math.min(4, t.length)); });
  console.log(`Finder: checking sold counts on ${hits.length} new-to-you listings`);
  await addSoldCounts(hits);
  let top = hits.filter((h) => (h.sold || 0) >= cfg.finder.min_sold).sort((a, b) => (b.sold || 0) - (a.sold || 0)).slice(0, 25);
  if (!top.length) { r.info.push("🔎 Product finder: no new 100+ sold printed parts this week."); return; }

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
      status: cad ? "Has sellable CAD" : "No free CAD",
    }));
    try {
      const resp = await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows }), signal: AbortSignal.timeout(30000), redirect: "follow" });
      const t = await resp.text();
      r.info.push(resp.ok ? `📊 Added to your Google Sheet: ${t.slice(0, 80)}` : `Google Sheet update failed (${resp.status}).`);
    } catch (e) { r.info.push(`Google Sheet update failed: ${(e as Error).message.slice(0, 80)}`); }
  }

  const line = (h: Hit) => `"${short(h.title, 70)}" by ${h.seller}: ${h.sold} sold @ ${money(h.price)}`;
  const parts: string[] = [];
  if (verified.length) parts.push("WITH SELLABLE CAD:\n" + verified.slice(0, 10).map((x) => `• ${line(x.h)}\n   CAD: ${x.cad.url} (${x.cad.license}) – ${short(x.cad.name, 50)}`).join("\n"));
  if (noCad.length) parts.push("PROVEN SELLERS, NO FREE CAD (model it yourself):\n" + noCad.slice(0, 6).map((h) => `• ${line(h)}`).join("\n"));
  if (cadErrors) parts.push(`(CAD search failed for ${cadErrors} item(s); check Printables by hand.)`);
  r.info.unshift("🔎 PRODUCT IDEAS THIS WEEK\n" + parts.join("\n\n"));
}
