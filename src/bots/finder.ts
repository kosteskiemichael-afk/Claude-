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

const OK_LICENSE = /^(CC0|CC-BY|CC-BY-SA|CC-BY-ND|GPL|LGPL|BSD|MIT)/i;

async function searchEbay(cfg: BotConfig): Promise<Hit[]> {
  const mine = new Set(cfg.my_seller_ids.map((s) => s.toLowerCase()));
  const seen = new Map<string, Hit>();
  for (const q of cfg.finder.queries) {
    try {
      const j = await rest("GET", "/buy/browse/v1/item_summary/search", {
        app: true,
        query: { q, limit: "200", filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:US,conditions:{NEW}" },
      });
      for (const it of j.itemSummaries || []) {
        const title = String(it.title || "");
        const seller = String(it.seller?.username || "");
        if (!/3d|printed/i.test(title) || mine.has(seller.toLowerCase())) continue;
        const legacy = String(it.legacyItemId || it.itemId?.split("|")[1] || "");
        if (!legacy || seen.has(legacy)) continue;
        seen.set(legacy, { id: it.itemId, legacy, title, seller, price: Number(it.price?.value || 0) });
      }
    } catch { /* one bad query shouldn't stop the scan */ }
  }
  return [...seen.values()];
}

/** eBay's Browse item details include an estimated sold quantity. */
async function addSoldCounts(hits: Hit[]) {
  for (let i = 0; i < hits.length; i += 20) {
    const chunk = hits.slice(i, i + 20);
    try {
      const j = await rest("GET", "/buy/browse/v1/item/", { app: true, query: { item_ids: chunk.map((h) => h.id).join(",") } });
      for (const it of j.items || []) {
        const h = chunk.find((x) => x.id === it.itemId);
        if (h) h.sold = Math.max(0, ...(it.estimatedAvailabilities || []).map((a: any) => Number(a.estimatedSoldQuantity || 0)));
      }
    } catch {
      for (const h of chunk) {
        try {
          const it = await rest("GET", `/buy/browse/v1/item/${encodeURIComponent(h.id)}`, { app: true });
          h.sold = Math.max(0, ...(it.estimatedAvailabilities || []).map((a: any) => Number(a.estimatedSoldQuantity || 0)));
        } catch { /* skip */ }
      }
    }
  }
}

async function printables(query: string): Promise<{ id: string; name: string; license: string }[]> {
  const r = await fetch("https://api.printables.com/graphql/", {
    method: "POST",
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
    const res = (await printables(q)).filter((x) => OK_LICENSE.test(x.license));
    const best = res.find((x) => overlap(t.slice(0, 6), tokens(x.name)) >= 2);
    if (best) return { url: `https://www.printables.com/model/${best.id}`, name: best.name, license: best.license };
  }
  return null;
}

export async function finderBot(cfg: BotConfig, myListings: Listing[], r: Report) {
  const myTokens = myListings.map((l) => tokens(l.title));
  let hits = await searchEbay(cfg);
  // Skip parts you already sell.
  hits = hits.filter((h) => { const t = tokens(h.title).slice(0, 6); return !myTokens.some((m) => overlap(t, m) >= Math.min(4, t.length)); });
  await addSoldCounts(hits);
  let top = hits.filter((h) => (h.sold || 0) >= cfg.finder.min_sold).sort((a, b) => (b.sold || 0) - (a.sold || 0)).slice(0, 25);
  if (!top.length) { r.info.push("🔎 Product finder: no new 100+ sold printed parts this week."); return; }

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

  const line = (h: Hit) => `"${short(h.title, 70)}" by ${h.seller}: ${h.sold} sold @ ${money(h.price)}`;
  const parts: string[] = [];
  if (verified.length) parts.push("WITH SELLABLE CAD:\n" + verified.slice(0, 10).map((x) => `• ${line(x.h)}\n   CAD: ${x.cad.url} (${x.cad.license}) – ${short(x.cad.name, 50)}`).join("\n"));
  if (noCad.length) parts.push("PROVEN SELLERS, NO FREE CAD (model it yourself):\n" + noCad.slice(0, 6).map((h) => `• ${line(h)}`).join("\n"));
  if (cadErrors) parts.push(`(CAD search failed for ${cadErrors} item(s); check Printables by hand.)`);
  r.info.unshift("🔎 PRODUCT IDEAS THIS WEEK\n" + parts.join("\n\n"));
}
