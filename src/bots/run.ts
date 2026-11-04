// Runs all store bots once. Render's cron job starts this 3x a day.
//   node dist/bots/run.js            normal run
//   DRY_RUN=1 node dist/bots/run.js  show what would change, change nothing
//   BOTS=pricing,marketing ...       run only some bots
import { MARKETPLACE, rest } from "../ebay.js";
import { brainOn, brainUsage, dailyBrief } from "./brain.js";
import { inventoryBot, Traffic } from "./inventory.js";
import { marketingBot } from "./marketing.js";
import { push } from "./notify.js";
import { pricingBot } from "./pricing.js";
import { titleBot } from "./titles.js";
import { feedbackBot } from "./feedback.js";
import { productionBot } from "./production.js";
import { serviceBot } from "./service.js";
import { finderBot, morningExtra, morningFocus, nextStrategy, Strategy } from "./finder.js";
import { activeListings, loadConfig, newReport, recentOrders, Report } from "./shared.js";

export function localHour(tz: string, d = new Date()): number {
  const h = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(d);
  return Number(h);
}

/** Start of the window this run covers: back to the previous scheduled run, plus 30 min overlap. */
export function windowStart(hours: number[], tz: string, now = new Date()): { since: Date; firstRunOfDay: boolean } {
  const slots = [...hours].sort((a, b) => a - b);
  const h = localHour(tz, now);
  let idx = slots.filter((s) => s <= h).length - 1;
  if (idx < 0) idx = slots.length - 1; // before the first slot: treat as the last slot of yesterday
  const cur = slots[idx];
  const prev = slots[(idx - 1 + slots.length) % slots.length];
  const gap = ((cur - prev + 24) % 24) || 24;
  return { since: new Date(now.getTime() - (gap + 0.5) * 3600_000), firstRunOfDay: idx === 0 };
}

export async function trafficMap(): Promise<Map<string, Traffic>> {
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const end = new Date(Date.now() - 86400_000);
  const start = new Date(end.getTime() - 29 * 86400_000);
  const j = await rest("GET", "/sell/analytics/v1/traffic_report", {
    query: {
      dimension: "LISTING",
      filter: `marketplace_ids:{${MARKETPLACE}},date_range:[${ymd(start)}..${ymd(end)}]`,
      metric: "LISTING_IMPRESSION_TOTAL,LISTING_VIEWS_TOTAL,TRANSACTION",
    },
  });
  const keys: string[] = (j.header?.metrics || []).map((m: any) => m.key);
  const m = new Map<string, Traffic>();
  for (const rec of j.records || []) {
    const v = (k: string) => Number(rec.metricValues?.[keys.indexOf(k)]?.value ?? 0);
    m.set(String(rec.dimensionValues?.[0]?.value), {
      impressions: v("LISTING_IMPRESSION_TOTAL"), views: v("LISTING_VIEWS_TOTAL"), sold: v("TRANSACTION"),
    });
  }
  return m;
}

async function step(name: string, r: Report, fn: () => Promise<void> | void) {
  try { await fn(); } catch (e) {
    r.urgent.push(`${name} bot error: ${(e as Error).message.slice(0, 160)}`);
    console.error(`${name} failed`, e);
  }
}

export async function runBots(opts: { only?: string[]; silent?: boolean; strategy?: Strategy; force?: boolean } = {}) {
  const cfg = loadConfig();
  const only = opts.only?.length ? opts.only : (process.env.BOTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const on = (b: string) => (!only.length || only.includes(b)) && (cfg as any)[b]?.enabled !== false;
  const ws = windowStart(cfg.run_hours_local, cfg.timezone);
  const since = ws.since;
  const firstRunOfDay = ws.firstRunOfDay || !!opts.force; // force = a manual 'run everything now' (pricing, ad boosts, morning report)
  const r = newReport();

  const listings = await activeListings();
  const needOrders = on("service") || on("production");
  const unshipped = needOrders ? await recentOrders(30, true) : [];

  const traffic = await trafficMap().catch(() => undefined);
  // Single listings you approved, made from options of multi-option listings. Each is made once
  // (skipped when a listing with that title already exists) and retried on later runs if eBay refuses.
  const splits = ((cfg as any).pending_splits || []) as { parent_item_id: string; option: string; title: string; price: number }[];
  if (splits.length) await step("New listings", r, async () => {
    const { splitOption } = await import("../split.js");
    const have = new Set(listings.map((l) => l.title.trim().toLowerCase()));
    for (const q of splits) {
      if (have.has(q.title.trim().toLowerCase())) continue;
      try { const res: any = await splitOption(q); r.changes.push(`🆕 Listed "${q.title}" at $${q.price.toFixed(2)}: ${res.url}`); have.add(q.title.trim().toLowerCase()); }
      catch (e) { r.info.push(`New listing "${q.title.slice(0, 40)}…" not made yet: ${(e as Error).message.slice(0, 160)}`); if (/usage limit|exceeded/i.test((e as Error).message)) break; }
    }
  });
  // Title swap you asked for: "3D Printed" -> "HD PETG" at the end of the title (burr holders and
  // likely-ASA/outdoor parts skipped). Each listing once; listings already swapped are skipped.
  const ts = (cfg as any).title_swap;
  if (ts?.enabled) await step("Title swap", r, async () => {
    const { trading } = await import("../ebay.js");
    const PHRASE = /\s*[-–|,]?\s*\b3[\s-]?d[\s-]?print(?:ed)?\b\s*/i;
    const skip = (t: string) => (ts.skip_words || []).some((w: string) => t.toLowerCase().includes(w));
    let done = 0; const skipped: string[] = [];
    for (const l of listings) {
      if (done >= (ts.max_per_run ?? 40)) break;
      if (l.protected || !PHRASE.test(l.title) || l.title.includes(ts.to)) continue;
      if (skip(l.title)) { skipped.push(l.title.slice(0, 45)); continue; }
      let t = l.title.replace(PHRASE, " ").replace(/\s{2,}/g, " ").replace(/^[\s\-–|,]+|[\s\-–|,]+$/g, "").trim();
      t = (t + " " + ts.to).trim();
      if (t.length > 80) t = (t.slice(0, 80 - ts.to.length - 1).replace(/\s+\S*$/, "") + " " + ts.to).trim();
      try {
        if (!cfg.dry_run) await trading("ReviseFixedPriceItem", { Item: { ItemID: l.item_id, Title: t } });
        r.changes.push(`✏️ Title: "${l.title}" → "${t}"`); done++;
      } catch (e) { r.info.push(`Title swap failed on ${l.title.slice(0, 40)}: ${(e as Error).message.slice(0, 120)}`); if (/usage limit|exceeded/i.test((e as Error).message)) break; }
    }
    if (skipped.length) r.info.push(`Title swap skipped ${skipped.length} that may not be PETG (outdoor/ASA/other material), tell Claude which are PETG: ${skipped.slice(0, 12).join("; ")}`);
  });
  if (on("inventory")) await step("Inventory", r, () => inventoryBot(cfg, listings, r, firstRunOfDay ? traffic : undefined));
  if (on("pricing") && (firstRunOfDay || !cfg.pricing.once_per_day)) await step("Pricing", r, () => pricingBot(cfg, listings, r, traffic));
  if (on("marketing")) await step("Marketing", r, () => marketingBot(cfg, listings, r, firstRunOfDay ? traffic : undefined));
  if (on("titles") && firstRunOfDay) await step("Title doctor", r, () => titleBot(cfg, listings, r, traffic));
  if (on("feedback")) await step("Feedback fixer", r, () => feedbackBot(cfg, r));
  if (on("service")) await step("Customer service", r, () => serviceBot(cfg, since, unshipped, r));
  const weekday = new Date().toLocaleDateString("en-US", { weekday: "short", timeZone: cfg.timezone });
  const finderDay = cfg.finder.day < 0 || ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][cfg.finder.day] === weekday; // -1 = every day
  if (on("finder") && (only.includes("finder") || (firstRunOfDay && finderDay))) await step("Product finder", r, async () => {
    if (opts.strategy) { await finderBot(cfg, listings, r, true, opts.strategy); return; }
    if (only.includes("finder")) { await finderBot(cfg, listings, r, true, nextStrategy()); return; }
    await finderBot(cfg, listings, r, false, morningFocus()); // morning: one specialist bot + one of the others
    const first = (r as any).finder;
    await finderBot(cfg, listings, r, false, morningExtra());
    const second = (r as any).finder;
    (r as any).finder = { bot: `${first.bot} + ${second.bot}`, searched: [...first.searched, ...second.searched], checked: first.checked + second.checked, found: first.found + second.found, fresh: first.fresh + second.fresh };
  });
  if (on("production")) await step("Production", r, () => productionBot(unshipped, since, firstRunOfDay, r));
  // Competition watch: every morning (or on demand), compare every listing to the sellers winning the same part.
  if (on("compete") && (firstRunOfDay || only.includes("compete"))) await step("Competition watch", r, async () => {
    const { runCompete, summary } = await import("./compete.js");
    const rows = await runCompete(traffic);
    if (!rows?.length) return;
    const s = summary(rows);
    r.info.push(`🏁 Competition watch: compared ${s.compared} listings to the top seller of the same part. ` +
      `Free shipping: you ${s.you_free_ship_pct}% vs them ${s.top_free_ship_pct}%. Photos: ${s.you_photos} vs ${s.top_photos}. ` +
      `Item specifics: ${s.you_specifics} vs ${s.top_specifics}. Cheaper delivered: ${s.you_cheaper_pct}% of listings.`);
    rows.filter((x) => x.fixes.length && !x.protected).slice(0, 5).forEach((x) =>
      r.info.push(`• ${x.title.slice(0, 45)} (${x.stage}): ${x.fixes.slice(0, 2).map((f) => f.what).join("; ")}`));
  });

  // Morning: the brain reads the whole store and picks today's best moves.
  let brief = "";
  if (firstRunOfDay && brainOn()) {
    await step("Brain", r, async () => {
      const week = await recentOrders(7, false).catch(() => []);
      const month = await recentOrders(30, false).catch(() => []);
      const revenue = (os: typeof week) => os.reduce((s, o) => s + o.items.reduce((a, i) => {
        const l = listings.find((x) => x.item_id === i.item_id);
        return a + (l ? l.price * i.quantity : 0);
      }, 0), 0);
      const snapshot = {
        revenue_last_7_days_est: Math.round(revenue(week)),
        revenue_last_30_days_est: Math.round(revenue(month)),
        orders_last_7_days: week.length,
        orders_last_30_days: month.length,
        unshipped_orders: unshipped.length,
        listings: listings.map((l) => ({
          id: l.item_id, title: l.title.slice(0, 70), price: l.price, ship: l.shipping_cost, qty: l.quantity_available,
          sold_total: l.sold, ...(traffic?.get(l.item_id) || {}), protected: l.protected || undefined,
        })),
        bot_actions_this_run: r.changes,
      };
      brief = await dailyBrief(snapshot);
    });
  }

  const tag = cfg.dry_run ? " (TEST RUN – nothing changed)" : "";
  const sections: string[] = [];
  if (brief) sections.push("🧠 TODAY'S MOVES:\n" + brief);
  if (r.urgent.length) sections.push("NEEDS YOU:\n• " + r.urgent.join("\n• "));
  if (r.changes.length) sections.push(`BOTS DID (${r.changes.length}):\n• ` + r.changes.slice(0, 25).join("\n• ") +
    (r.changes.length > 25 ? `\n• …and ${r.changes.length - 25} more` : ""));
  if (r.info.length && (firstRunOfDay || only.length > 0 || r.urgent.length || r.changes.length)) sections.push(r.info.join("\n\n"));

  if (brainOn()) {
    const u = brainUsage();
    console.log(`Brain usage this run: ${u.input_tokens} in / ${u.output_tokens} out tokens`);
  }
  const shouldPush = !opts.silent && (r.urgent.length > 0 || r.changes.length > 0 || firstRunOfDay || only.length > 0);
  if (shouldPush) {
    const title = r.urgent.length ? `Nexa: ${r.urgent.length} thing(s) need you${tag}` : only.includes("finder") ? `Nexa product ideas${tag}` : `Nexa store update${tag}`;
    await push(title, sections.join("\n\n") || "All quiet.", r.urgent.length > 0);
  } else {
    console.log("Nothing to report this run.");
  }
  return r;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) {
  runBots().then(() => process.exit(0)).catch(async (e) => {
    console.error(e);
    await push("Nexa bots failed to run", String(e?.message || e).slice(0, 500), true).catch(() => {});
    process.exit(1);
  });
}
