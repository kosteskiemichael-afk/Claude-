// Title doctor: finds listings eBay shows a lot but buyers rarely click (low click-through),
// and rewrites the title so it names what buyers actually search for (tooth counts, part
// numbers, machine models), using the listing's own options and the titles of competing
// listings. Guard rails: burr holders never touched, at most `max_per_run` titles a day,
// each listing at most once every `cooldown_days`, never invents a fit the listing doesn't offer.
import { rest, trading } from "../ebay.js";
import { askJson, brainOn, FAST_MODEL } from "./brain.js";
import type { Traffic } from "./inventory.js";
import { BotConfig, Listing, Report, short, val } from "./shared.js";

type Cfg = { enabled: boolean; min_impressions: number; max_ctr: number; max_per_run: number; cooldown_days: number };
const DEF: Cfg = { enabled: true, min_impressions: 5000, max_ctr: 0.004, max_per_run: 3, cooldown_days: 14 };

async function details(id: string) {
  const r = await trading("GetItem", { ItemID: id, DetailLevel: "ReturnAll", IncludeItemSpecifics: "true" });
  const it = Array.isArray(r.Item) ? r.Item[0] : r.Item;
  const arr = (x: any) => (x ? (Array.isArray(x) ? x : [x]) : []);
  const specifics = arr(it?.ItemSpecifics?.NameValueList).map((nv: any) => `${val(nv.Name)}: ${arr(nv.Value).map(val).join(", ")}`);
  const options = arr(it?.Variations?.Variation).flatMap((v: any) => arr(v.VariationSpecifics?.NameValueList).flatMap((nv: any) => arr(nv.Value).map(val)));
  return { specifics: specifics.slice(0, 15), options: [...new Set(options)].slice(0, 40) as string[] };
}

async function competitorTitles(title: string): Promise<string[]> {
  const q = title.replace(/[^\w\s/"-]/g, " ").split(/\s+/).filter((w) => w.length > 1).slice(0, 6).join(" ");
  const j = await rest("GET", "/buy/browse/v1/item_summary/search", { app: true, query: { q, limit: "25", filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:US" } });
  return (j.itemSummaries || []).map((x: any) => String(x.title || "")).filter(Boolean).slice(0, 15);
}

export async function titleBot(cfg: BotConfig, listings: Listing[], r: Report, traffic?: Map<string, Traffic>) {
  const c: Cfg = { ...DEF, ...((cfg as any).titles || {}) };
  if (!c.enabled || !traffic) return;
  if (!brainOn()) { r.info.push("Title doctor skipped: needs ANTHROPIC_API_KEY."); return; }
  const today = Math.floor(Date.now() / 86400_000);
  const dueToday = (id: string) => [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 9973, 0) % c.cooldown_days === today % c.cooldown_days;
  const cands = listings
    .filter((l) => !l.protected)
    .map((l) => ({ l, t: traffic.get(l.item_id) }))
    .filter((x) => x.t && x.t.impressions >= c.min_impressions && x.t.views / x.t.impressions < c.max_ctr && dueToday(x.l.item_id))
    .sort((a, b) => b.t!.impressions - a.t!.impressions)
    .slice(0, c.max_per_run);
  let done = 0;
  for (const { l, t } of cands) {
    try {
      const d = await details(l.item_id);
      const comps = await competitorTitles(l.title);
      const out = await askJson<{ title: string; reason: string }>(FAST_MODEL,
        "You write eBay titles for a seller of 3D-printed replacement parts. Rewrite the title so it gets more clicks from buyers " +
        "searching for this exact part: lead with the brand/machine and part name, include the specific numbers buyers search " +
        "(tooth counts, part numbers, model numbers) ONLY if they appear in the listing's current title, options or item specifics. " +
        "Never claim OEM/genuine, never add a model, size or fit the listing doesn't already state, keep '3D Printed' if present, " +
        "no ALL CAPS words except model/part numbers, no punctuation spam. Max 80 characters. Return {\"title\": \"...\", \"reason\": \"...\"}.",
        JSON.stringify({ current_title: l.title, options: d.options, item_specifics: d.specifics, competitor_titles: comps }), 600);
      const nt = String(out.title || "").replace(/\s+/g, " ").trim();
      const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) || []);
      const keep = [...words(l.title)].filter((w) => w.length > 3 && words(nt).has(w)).length;
      if (!nt || nt.length > 80 || nt === l.title || /genuine|\boem\b|baratza|burr holder/i.test(nt) || keep < 2) {
        r.info.push(`Title doctor skipped ${short(l.title, 30)}: suggestion didn't pass checks.`); continue;
      }
      if (!cfg.dry_run) await trading("ReviseFixedPriceItem", { Item: { ItemID: l.item_id, Title: nt } });
      done++;
      r.changes.push(`✏️ Title (${t!.impressions.toLocaleString()} views in search, ${t!.views} clicks, ${(t!.views / t!.impressions * 100).toFixed(2)}% CTR): "${l.title}" → "${nt}"`);
    } catch (e) {
      r.info.push(`Title doctor failed on ${short(l.title, 30)}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  if (!done && !cands.length) r.info.push("Title doctor: no low-click listings due today.");
}
