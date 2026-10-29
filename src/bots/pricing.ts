// Pricing & competition bot. Goal: the most profit per sale, not the lowest price.
//  - If a competitor is cheaper, sit 1 cent under them, but never below your profit floor.
//  - If you're well under everyone, raise toward them (money left on the table).
//  - Moves are capped per run so one weird competitor listing can't wreck a price.
import { rest } from "../ebay.js";
import { brainOn, matchCompetitors, MatchInput, planSearches } from "./brain.js";
import type { Traffic } from "./inventory.js";
import { BotConfig, Listing, PriceRule, Report, money, setPriceQty, short } from "./shared.js";
import { adRates, floorPrice, profitAt, Ship, shipInfo } from "./profit.js";

export type Competitor = { seller: string; title: string; total: number };

export async function findCompetitors(cfg: BotConfig, rule: PriceRule, minWordHits?: number): Promise<Competitor[]> {
  const j = await rest("GET", "/buy/browse/v1/item_summary/search", {
    app: true,
    query: {
      q: rule.query,
      limit: "100",
      filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:US,deliveryCountry:US,conditions:{NEW}",
    },
  });
  const mine = new Set(cfg.my_seller_ids.map((s) => s.toLowerCase()));
  const must = (rule.must_include || []).map((w) => w.toLowerCase());
  const bad = (rule.exclude || []).map((w) => w.toLowerCase());
  const out: (Competitor & { id?: string; printed?: boolean })[] = [];
  for (const it of j.itemSummaries || []) {
    const seller = String(it.seller?.username || "").toLowerCase();
    const title = String(it.title || "");
    const t = title.toLowerCase();
    if (mine.has(seller)) continue;
    const hits = must.filter((w) => t.includes(w)).length;
    if (hits < (minWordHits ?? must.length)) continue;
    if (bad.some((w) => t.includes(w))) continue;
    const price = Number(it.price?.value);
    if (!isFinite(price) || it.price?.currency !== "USD") continue;
    const ships = (it.shippingOptions || []).map((s: any) => Number(s.shippingCost?.value ?? 0)).filter(isFinite);
    const ship = ships.length ? Math.min(...ships) : 0;
    if (NOT_PRINTED.test(title)) continue; // clearly an OEM / metal / molded part, not a printed one
    out.push({ seller, title, total: price + ship, id: it.itemId, printed: PRINTED.test(title) });
  }
  return confirmPrinted(out);
}

// Only compare against other 3D-printed parts. The title usually says so; if it doesn't,
// read the listing's description and keep it only if it mentions 3D printing.
const PRINTED = /3[\s-]?d[\s-]?print|\b3d\b|printed|\b(petg|pla|abs|asa|tpu|nylon)\b|fdm|additive/i;
const NOT_PRINTED = /not 3d printed|injection[\s-]?mold|\bgenuine\b|factory original|original equipment|die[\s-]?cast|\b(brass|aluminum|aluminium|steel|metal) gear/i;
async function confirmPrinted(list: (Competitor & { id?: string; printed?: boolean })[]): Promise<Competitor[]> {
  const unsure = list.filter((c) => !c.printed && c.id).slice(0, 20);
  const check = async (c: Competitor & { id?: string; printed?: boolean }) => {
    try {
      const d = await rest("GET", `/buy/browse/v1/item/${encodeURIComponent(c.id!)}`, { app: true, timeoutMs: 10000 });
      const text = [d.shortDescription, d.description, ...(d.localizedAspects || []).map((a: any) => `${a.name} ${a.value}`)].join(" ").replace(/<[^>]+>/g, " ");
      c.printed = PRINTED.test(text) && !NOT_PRINTED.test(text);
    } catch { c.printed = false; } // can't confirm: leave it out
  };
  for (let i = 0; i < unsure.length; i += 5) await Promise.all(unsure.slice(i, i + 5).map(check));
  return list.filter((c) => c.printed).map(({ seller, title, total }) => ({ seller, title, total }));
}

/** Lowest total price (item + shipping) that still makes min_margin profit. */
export function floorTotal(cfg: BotConfig, rule: PriceRule): number {
  const p = cfg.pricing;
  const costs = (rule.label_cost ?? p.default_label_cost) + (rule.material_cost ?? p.default_material_cost) + p.per_order_fee;
  return costs / (1 - p.fee_rate - p.min_margin);
}

export function decidePrice(
  cfg: BotConfig, rule: PriceRule, l: Listing, comps: Competitor[], ship?: Ship, adPct?: number | null,
): { price: number; reason: string } | null {
  // What the buyer really pays for shipping (calculated listings show $0 in the listing data).
  const buyerShip = ship ? ship.buyer : l.shipping_cost;
  const floor = ship ? floorPrice(cfg, l.item_id, ship, adPct) : floorTotal(cfg, rule) - l.shipping_cost;
  const p = cfg.pricing;
  if (!comps.length) return null;
  // Ignore anything absurdly cheap (broken listings, wrong part, parts lots).
  const sorted = comps.map((c) => c.total).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const usable = sorted.filter((t) => t >= median * 0.4);
  const lowest = usable[0];
  const myTotal = l.price + buyerShip;

  let targetTotal: number | null = null;
  let reason = "";
  if (myTotal > lowest + 0.005) {
    targetTotal = Math.max(lowest - p.undercut, floor + buyerShip);
    reason = `cheapest competitor ${money(lowest)}`;
  } else if (myTotal < lowest * (1 - p.raise_when_below_pct)) {
    targetTotal = lowest - p.undercut;
    reason = `you were ${money(lowest - myTotal)} under the cheapest (${money(lowest)})`;
  }
  if (targetTotal === null) return null;

  let price = targetTotal - buyerShip;
  const minPrice = Math.max(rule.min ?? 0, floor);
  if (rule.max !== undefined) price = Math.min(price, rule.max);
  price = Math.max(price, minPrice);
  // Cap the move per run.
  const step = l.price * p.max_step_pct;
  price = Math.min(Math.max(price, l.price - step), l.price + step);
  price = Math.round(price * 100) / 100;
  if (Math.abs(price - l.price) < p.min_change) return null;
  return { price, reason };
}

export async function pricingBot(cfg: BotConfig, listings: Listing[], r: Report, traffic?: Map<string, Traffic>) {
  const byId = new Map(listings.map((l) => [l.item_id, l]));
  const changes: { item_id: string; title: string; price: number }[] = [];
  const open = listings.filter((l) => !l.protected && !l.has_variations);
  const ships = await shipInfo(cfg, open);
  const ads = await adRates().catch(() => new Map<string, number>());
  const adOf = (id: string) => (ads.has(id) ? ads.get(id)! : 0);
  const shipOf = (l: Listing): Ship => ships.get(l.item_id) || { kind: "calculated", buyer: cfg.pricing.calc_ship_estimate ?? 5.51 };
  const profitNote = (l: Listing, price: number) => {
    const pr = profitAt(cfg, l.item_id, price, shipOf(l), adOf(l.item_id));
    return `profit ${money(pr.profit)}/sale, ${Math.round(pr.margin * 100)}%`;
  };
  const sold30 = (id: string) => traffic?.get(id)?.sold ?? 0;

  // Price-action logic, tuned for profit:
  //  - RAISE when you're cheaper than every true competitor (to 1¢ under the cheapest).
  //  - RAISE 3%/day while a listing is selling fast (5+ in 30 days) and nobody undercuts you.
  //  - CUT to 1¢ under a cheaper competitor when the cut is small (≤ small_cut_max), even if it's selling.
  //  - Bigger cuts only when a listing has had 0 sales in 30 days.
  //  - Otherwise HOLD. A listing that sells at its price doesn't need a cut.
  // Cooldown: each listing gets its own "price day" once every cooldown_days (no stored state needed).
  // Raises and big cuts wait for that day; matching a cheaper competitor happens any day.
  const cd = Math.max(1, cfg.pricing.cooldown_days ?? 5);
  const today = Math.floor(Date.now() / 86400_000);
  const myDay = (id: string) => cd === 1 || [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9973, 0) % cd === today % cd;
  const apply = (l: Listing, rule: PriceRule, comps: Competitor[], tag: string) => {
    const s30 = sold30(l.item_id);
    const d = decidePrice(cfg, rule, l, comps, shipOf(l), adOf(l.item_id));
    if (d && d.price < l.price) {
      // Sales mode: small cuts (a few cents up to small_cut_max) to beat a cheaper competitor always go through.
      const small = l.price - d.price <= (cfg.pricing.small_cut_max ?? 0);
      if (!small && !myDay(l.item_id)) return;
      if (!small && (!traffic || s30 > 0)) {
        if (s30 > 0) r.info.push(`Held ${short(l.title, 30)} at ${money(l.price)}: ${s30} sold in 30 days (${d.reason}).`);
        return;
      }
    }
    let target = d?.price;
    let reason = d?.reason || "";
    if (!d && s30 >= 5 && traffic) {
      const lowest = comps.length ? Math.min(...comps.map((c) => c.total)) - shipOf(l).buyer - cfg.pricing.undercut : Infinity;
      const cap = Math.min(rule.max ?? l.price * 1.25, lowest);
      const up = Math.round(Math.min(l.price * 1.03, cap) * 100) / 100;
      if (up - l.price >= cfg.pricing.min_change) { target = up; reason = `selling fast: ${s30} sold in 30 days`; }
    }
    if (target === undefined) return;
    if (target > l.price && !myDay(l.item_id)) return; // raises wait for this listing's price day
    changes.push({ item_id: l.item_id, title: l.title, price: target });
    r.changes.push(`${tag}Price ${money(l.price)} → ${money(target)} (${reason}; ${profitNote(l, target)}): ${short(l.title)}`);
  };

  // 1) Items with hand-written rules.
  for (const [itemId, rule] of Object.entries(cfg.pricing.rules)) {
    const l = byId.get(itemId);
    if (!l) { r.info.push(`Price rule for ${itemId} skipped: listing not active.`); continue; }
    if (l.protected || l.has_variations) continue;
    try { apply(l, rule, await findCompetitors(cfg, rule), ""); }
    catch (e) { r.info.push(`Pricing check failed for ${short(l.title)}: ${(e as Error).message.slice(0, 120)}`); }
  }

  // 2) Every other listing: the brain finds and verifies true competitors.
  if (brainOn()) {
    try {
      const rest = listings.filter((l) => !l.protected && !l.has_variations && !cfg.pricing.rules[l.item_id]);
      const plans = (await planSearches(rest.map((l) => ({ item_id: l.item_id, title: l.title })))).filter((p) => !p.skip);
      const inputs: MatchInput[] = [];
      const pools = new Map<string, Competitor[]>();
      for (const p of plans) {
        const l = byId.get(String(p.item_id));
        if (!l) continue;
        const words = (p.must_include || []).map(String);
        const pool = (await findCompetitors(cfg, { query: p.query, must_include: words }, Math.ceil(words.length / 2)))
          .sort((a, b) => a.total - b.total).slice(0, 25);
        if (pool.length < 2) continue;
        pools.set(l.item_id, pool);
        inputs.push({ item_id: l.item_id, title: l.title, pack_qty: p.pack_qty || 1,
          candidates: pool.map((c, i) => ({ i, title: c.title, total: c.total })) });
      }
      const matched = await matchCompetitors(inputs);
      let checked = 0;
      for (const inp of inputs) {
        const m = matched.get(inp.item_id);
        const pool = pools.get(inp.item_id)!;
        if (!m || (m.matches || []).length < 2) continue; // need 2+ true competitors before acting
        const comps = m.matches
          .filter((x) => pool[x.i])
          .map((x) => ({ ...pool[x.i], total: (pool[x.i].total / Math.max(1, x.their_pack_qty || 1)) * inp.pack_qty }));
        const l = byId.get(inp.item_id)!;
        checked++;
        apply(l, { query: "", max: Math.round(l.price * 1.6 * 100) / 100 }, comps, "🧠 ");
      }
      r.info.push(`Brain price-checked ${checked} more listings against verified competitors.`);
    } catch (e) {
      r.info.push(`Brain pricing skipped: ${(e as Error).message.slice(0, 140)}`);
    }
  }

  // 3) Profit guard: never keep selling a listing at a thin margin. Anything under guard_margin
  //    is raised toward the full profit floor (at most +15% per run, so it's gradual).
  const guard = cfg.pricing.guard_margin ?? 0.25;
  const changed = new Set(changes.map((c) => c.item_id));
  let thin = 0;
  for (const l of open) {
    if (changed.has(l.item_id) || l.price <= 0) continue;
    const sh = shipOf(l), ad = adOf(l.item_id);
    const pr = profitAt(cfg, l.item_id, l.price, sh, ad);
    if (pr.margin >= guard) { if (pr.margin < cfg.pricing.min_margin) thin++; continue; }
    const target = Math.round(Math.min(floorPrice(cfg, l.item_id, sh, ad), l.price * 1.15) * 100) / 100;
    if (target - l.price < cfg.pricing.min_change) continue;
    changes.push({ item_id: l.item_id, title: l.title, price: target });
    r.changes.push(`🛡 Profit guard ${money(l.price)} → ${money(target)} (was ${money(pr.profit)}/sale, ${Math.round(pr.margin * 100)}%; now ${profitNote(l, target)}): ${short(l.title)}`);
  }
  if (thin) r.info.push(`${thin} listings make ${Math.round(guard * 100)}–${Math.round(cfg.pricing.min_margin * 100)}% profit (see Profit per sale on Nexa Command).`);

  if (changes.length) {
    const warn = await setPriceQty(cfg, changes);
    warn.forEach((w) => r.info.push(`eBay note: ${w}`));
  }
}
