// Private live dashboard ("Nexa Command"): https://<service>.onrender.com/dashboard/<CONNECTOR_SECRET>
// The page is a static shell; it pulls /dashboard/<secret>/data every 30 seconds and redraws.
// Read-only, except the two Run buttons, which call the same run endpoint the cron job uses.
import type { Express } from "express";
import { existsSync, readFileSync } from "node:fs";
import { rest } from "./ebay.js";
import { activeListings, loadConfig, recentOrders } from "./bots/shared.js";
import { finds, JUNK, todaysQueries } from "./bots/finder.js";
import { storeCall } from "./store.js";

type Run = { time: number; title: string; message: string; urgent: boolean };

async function botRuns(): Promise<Run[]> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return [];
  const server = process.env.NTFY_SERVER || "https://ntfy.sh";
  const r = await fetch(`${server}/${encodeURIComponent(topic)}/json?poll=1&since=all`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return [];
  return (await r.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.event === "message")
    .map((e) => ({ time: e.time * 1000, title: e.title || "", message: e.message || "", urgent: (e.priority || 3) >= 4 }))
    .sort((a, b) => b.time - a.time);
}

async function adRates(): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  const j = await rest("GET", "/sell/marketing/v1/ad_campaign", { query: { limit: "100" } });
  for (const c of j.campaigns || []) {
    if (c.campaignStatus !== "RUNNING") continue;
    const a = await rest("GET", `/sell/marketing/v1/ad_campaign/${c.campaignId}/ad`, { query: { limit: "500" } });
    for (const ad of a.ads || []) m.set(String(ad.listingId), Number(ad.bidPercentage));
  }
  return m;
}

// Permanent product store: the Apps Script web app in SHEETS_WEBHOOK_URL (it saves every find, and your
// "Added it" / "Not interested" choices). The dashboard reads and writes it; nobody has to open the sheet.
type Idea = { found: string; title: string; seller: string; sold: number; price: number; ebay: string; cad: string; license: string; cadName: string; status: string; decision: string };
const hook = storeCall;
async function sheetIdeas(): Promise<{ ok: boolean; ideas: Idea[] }> {
  const j = await hook({ action: "list" });
  if (!j.ok) return { ok: false, ideas: [] };
  const ideas = (j.rows || []).filter((x: any) => x.title).map((x: any, i: number) => ({ i, idea: {
    found: x.found || "", title: x.title, seller: x.seller || "", sold: Number(x.sold || 0), price: Number(x.price || 0),
    ebay: x.ebay_url || "", cad: x.cad_url || "", license: x.cad_license || "", cadName: x.cad_name || "", status: x.status || "", decision: x.decision || "" } }))
    .sort((a: any, b: any) => b.idea.found.localeCompare(a.idea.found) || b.i - a.i)
    .map((x: any) => x.idea as Idea);
  return { ok: true, ideas };
}
// Choices made on this server since it started (applied instantly, before the store round-trip shows them).
const localDecisions = new Map<string, string>();
const HIDDEN = (d: string) => /^(added|dismissed)/i.test(d || "");

// Product board: products.json (ideas Claude adds) merged with the Google Sheet (ideas the finder adds).
function boardIdeas(): Idea[] {
  const path = process.env.PRODUCTS_FILE || "products.json";
  if (!existsSync(path)) return [];
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return (j.products || []).map((x: any) => ({
      found: String(x.added || ""), title: String(x.title || ""), seller: String(x.seller || ""), sold: Number(x.sold || 0), price: Number(x.price || 0),
      ebay: String(x.ebay || ""), cad: String(x.cad || ""), license: String(x.license || ""), cadName: String(x.cad_name || ""), status: String(x.status || ""), decision: String(x.note || ""),
    }));
  } catch { return []; }
}

// All-time sales (eBay's order API keeps about 2 years of history).
async function allTimeOrders() { return recentOrders(729, false, 20000); }

const TZ = "America/Indianapolis";
const hourIn = (d = new Date()) => Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: TZ }).format(d));
const dayKey = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(t));

// Each source has its own refresh rate: orders every 20s (live sales), the heavier eBay calls every 60s.
const memo = new Map<string, { at: number; p: Promise<any> }>();
function cached<T>(key: string, ttl: number, fn: () => Promise<T>, fallback: T): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.p;
  const p = fn().catch(() => (hit ? hit.p : fallback));
  memo.set(key, { at: Date.now(), p });
  return p;
}

async function buildData() {
  const cfg = loadConfig();
  const [runs, listings, unshipped, month, ads] = await Promise.all([
    cached("runs", 60_000, botRuns, [] as Run[]),
    cached("listings", 60_000, activeListings, []),
    cached("unshipped", 20_000, () => recentOrders(30, true), []),
    cached("month", 20_000, () => recentOrders(30, false), []),
    cached("ads", 120_000, adRates, new Map<string, number>()),
  ]);
  const [sheet, all] = await Promise.all([
    cached("sheet", 180_000, sheetIdeas, { ok: false, ideas: [] as Idea[] }),
    cached("alltime", 600_000, allTimeOrders, [] as Awaited<ReturnType<typeof allTimeOrders>>),
  ]);
  // Merge board + sheet, dedupe by eBay link (board entries win), newest first, with profit math.
  const seenUrl = new Set<string>();
  const p = cfg.pricing;
  const decided = new Map<string, string>(sheet.ideas.filter((x) => x.decision).map((x) => [x.ebay, x.decision] as [string, string]));
  for (const [k, v] of localDecisions) decided.set(k, v);
  const allProducts = [...boardIdeas(), ...finds, ...sheet.ideas].filter((x) => { const k = x.ebay || x.title; if (seenUrl.has(k)) return false; seenUrl.add(k); return true; })
    .map((x) => ({ ...x, decision: decided.get(x.ebay) ?? x.decision }));
  const withNumbers = (list: typeof allProducts) => list
    .map((x, i) => ({ x, i })).sort((a, b) => b.x.found.localeCompare(a.x.found) || a.i - b.i).map(({ x }) => {
      const profit = x.price ? x.price * (1 - p.fee_rate) - p.per_order_fee - p.default_label_cost - p.default_material_cost : 0;
      return { ...x, theirRevenue: Math.round(x.sold * x.price), profit: Math.round(profit * 100) / 100, margin: x.price ? Math.round(profit / x.price * 100) : 0 };
    });
  const productList = withNumbers(allProducts.filter((x) => !HIDDEN(x.decision) && !JUNK.test(x.title))); // no toys / gun parts
  const hiddenList = withNumbers(allProducts.filter((x) => HIDDEN(x.decision)));

  // All-time numbers.
  const months = new Map<string, { m: string; orders: number; rev: number }>();
  const itemAll = new Map<string, { title: string; units: number; rev: number }>();
  let allRev = 0, allUnits = 0, first = Infinity;
  for (const o of all) {
    const t = Date.parse(o.created); first = Math.min(first, t);
    const m = dayKey(t).slice(0, 7);
    const e = months.get(m) || { m, orders: 0, rev: 0 }; e.orders++; e.rev += o.total; months.set(m, e);
    allRev += o.total;
    for (const it of o.items) {
      allUnits += it.quantity;
      const r = itemAll.get(it.item_id) || { title: it.title, units: 0, rev: 0 };
      r.units += it.quantity; r.rev += it.total || 0; itemAll.set(it.item_id, r);
    }
  }
  const monthList = [...months.values()].sort((a, b) => a.m.localeCompare(b.m));
  const best = monthList.reduce((b, x) => (!b || x.rev > b.rev ? x : b), null as null | { m: string; orders: number; rev: number });
  const activeMonths = Math.max(1, monthList.length);
  const now = Date.now();
  const cap = cfg.marketing.max_ad_rate ?? 5;
  const byId = new Map(listings.map((l) => [l.item_id, l]));
  const late = unshipped.filter((o) => o.ship_by && Date.parse(o.ship_by) < now);
  const lowStock = listings.filter((l) => l.quantity_available > 0 && l.quantity_available < cfg.inventory.restock_below);
  const soldOut = listings.filter((l) => l.quantity_available === 0);
  const adVals = [...ads.entries()].filter(([id]) => byId.has(id));
  const above = adVals.filter(([id, r]) => r > cap + 0.001 && !byId.get(id)?.protected);

  // Sales: last 30 days by day, plus 7-day totals and top sellers.
  const days: { d: string; orders: number; rev: number }[] = [];
  for (let i = 29; i >= 0; i--) days.push({ d: dayKey(now - i * 86400_000), orders: 0, rev: 0 });
  const idx = new Map(days.map((x, i) => [x.d, i]));
  const units = new Map<string, number>();
  let rev7 = 0, orders7 = 0, rev30 = 0;
  for (const o of month) {
    const t = Date.parse(o.created);
    const i = idx.get(dayKey(t));
    if (i !== undefined) { days[i].orders++; days[i].rev += o.total; }
    rev30 += o.total;
    if (now - t < 7 * 86400_000) { orders7++; rev7 += o.total; }
    o.items.forEach((it) => units.set(it.title, (units.get(it.title) || 0) + it.quantity));
  }
  const today = dayKey(now);
  const todays = month.filter((o) => dayKey(Date.parse(o.created)) === today);
  const recent = [...month].sort((a, b) => Date.parse(b.created) - Date.parse(a.created)).slice(0, 25).map((o) => ({
    id: o.order_id, time: Date.parse(o.created), total: o.total, shipped: o.status === "FULFILLED",
    items: o.items.map((i) => ({ title: i.title, qty: i.quantity })),
  }));
  const top = [...units.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([title, n]) => ({ title, units: n }));

  const queue = new Map<string, number>();
  unshipped.forEach((o) => o.items.forEach((i) => queue.set(i.title, (queue.get(i.title) || 0) + i.quantity)));

  const slots = [...cfg.run_hours_local].sort((a, b) => a - b);
  const h = hourIn();
  const nextH = slots.find((x) => x > h) ?? slots[0];
  const nextRunInH = ((nextH - h + 24) % 24) || 24;
  const minsNow = new Date().getUTCMinutes();
  const nextRunAt = now + (nextRunInH * 60 - minsNow) * 60_000;

  const lastFinder = runs.find((r) => r.message.includes("PRODUCT IDEAS") || r.message.includes("Product finder"));
  const lastRun = runs[0];
  const brain = !!process.env.ANTHROPIC_API_KEY;
  const queueUnits = [...queue.values()].reduce((a, b) => a + b, 0);
  const avgAd = adVals.length ? adVals.reduce((a, [, r]) => a + r, 0) / adVals.length : 0;

  const bots = [
    { name: "Inventory", icon: "◈", state: lowStock.length ? "warn" : "ok",
      line: `${listings.length} live · ${lowStock.length} low · ${soldOut.length} sold out`, detail: `Restocks under ${cfg.inventory.restock_below} up to ${cfg.inventory.restock_to}. Sold-out-by-choice kept at 0.` },
    { name: "Pricing", icon: "◇", state: "ok",
      line: `${Object.keys(cfg.pricing.rules).length}${brain ? "+AI" : ""} tracked · floor ${Math.round(cfg.pricing.min_margin * 100)}% margin`, detail: `Beats cheaper rivals by 1¢ (cuts ≤ $${cfg.pricing.small_cut_max ?? 0}). Raises/big cuts every ${cfg.pricing.cooldown_days ?? 5} days per listing.` },
    { name: "Marketing", icon: "◎", state: above.length ? "warn" : "ok",
      line: `${adVals.length} ads · avg ${avgAd.toFixed(1)}% · ${above.length} over ${cap}%`, detail: `Sellers boosted to ${cfg.marketing.boost_sellers_rate ?? 0}%. Your own rates kept. Cap ${cap}%.` },
    { name: "Customer care", icon: "◉", state: late.length ? "bad" : "ok",
      line: `${unshipped.length} to ship · ${late.length} late`, detail: "Watches buyer messages, feedback and ship-by dates." },
    { name: "Production", icon: "▣", state: queueUnits ? "busy" : "ok",
      line: `${queueUnits} part${queueUnits === 1 ? "" : "s"} in print queue`, detail: "Builds the print list from unshipped orders." },
    { name: "Product finders ×8", icon: "✦", state: "ok",
      line: lastFinder ? `last scan ${new Date(lastFinder.time).toLocaleString("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit" })}` : "scans every morning",
      detail: "Make-it (parts Claude can build), Gears & Brackets, Auto & Boat, Premium, Keyword, Competitor, Category, CAD-first. No toys or gun parts." },
    { name: "AI brain", icon: "⬡", state: brain ? "ok" : "off",
      line: brain ? "online · daily brief + reply drafts" : "offline (add ANTHROPIC_API_KEY)", detail: "Verifies competitors and CAD matches, writes the morning plan." },
  ];

  return {
    now, dry: cfg.dry_run, nextRunAt, nextRunLabel: `${nextH % 12 || 12}${nextH < 12 ? "AM" : "PM"}`,
    lastRunAt: lastRun?.time ?? null,
    kpis: { listings: listings.length, unshipped: unshipped.length, late: late.length, lowStock: lowStock.length, above: above.length, cap },
    sales: { ordersToday: todays.length, revToday: todays.reduce((a, o) => a + o.total, 0), orders7, rev7, orders30: month.length, rev30, days, top, recent },
    bots,
    runs: runs.slice(0, 20),
    ideas: lastFinder ? { time: lastFinder.time, message: lastFinder.message } : null,
    products: { ok: sheet.ok, total: productList.length, list: productList.slice(0, 60), hidden: hiddenList.slice(0, 60), hiddenCount: hiddenList.length },
    allTime: {
      rev: allRev, orders: all.length, units: allUnits, first: isFinite(first) ? first : null,
      avgOrder: all.length ? allRev / all.length : 0, perMonth: allRev / activeMonths,
      best, months: monthList, listingsSold: itemAll.size,
      top: [...itemAll.values()].sort((a, b) => b.rev - a.rev || b.units - a.units).slice(0, 12),
    },
    queue: [...queue.entries()].map(([title, qty]) => ({ title, qty })).sort((a, b) => b.qty - a.qty),
    pricing: Object.entries(cfg.pricing.rules).map(([id, rule]) => {
      const l = byId.get(id);
      return { title: l?.title || id, price: l?.price ?? null, min: rule.min ?? null, max: rule.max ?? null, ad: ads.get(id) ?? null, qty: l?.quantity_available ?? null };
    }),
  };
}

async function getData(force = false) {
  if (force) memo.clear();
  return buildData();
}
export function invalidateDashboard() { memo.delete("runs"); memo.delete("listings"); memo.delete("ads"); memo.delete("sheet"); memo.delete("alltime"); }

export function registerDashboard(app: Express, secret: string, isRunning: () => boolean = () => false, deepStatus: () => any = () => null) {
  // X button on a product: "added" (you listed it) or "dismissed" (not interested); "" restores it.
  app.post(`/dashboard/${secret}/decide`, async (req, res) => {
    try {
      const b = (req.body && typeof req.body === "object" ? req.body : {}) as any;
      const ebay = String(b.ebay || ""); const decision = String(b.decision || "");
      if (!ebay) throw new Error("missing listing");
      localDecisions.set(ebay, decision);
      const p = b.row || {};
      const j = await hook({ action: "decide", ebay_url: ebay, decision: decision ? `${decision} ${new Date().toISOString().slice(0, 10)}` : "",
        row: { found: p.found, title: p.title, seller: p.seller, sold: p.sold, price: p.price, ebay_url: ebay, cad_url: p.cad, cad_license: p.license, cad_name: p.cadName, status: p.status } });
      memo.delete("sheet");
      res.json({ ok: !!j.ok, error: j.error });
    } catch (e) { res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
  });
  app.get(`/dashboard/${secret}/data`, async (req, res) => {
    try {
      const d = await getData(req.query.fresh === "1");
      res.set("Cache-Control", "no-store").json({ ...d, running: isRunning(), deep: deepStatus() });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
  app.get(`/dashboard/${secret}`, (_req, res) => {
    res.set("Cache-Control", "no-store").type("html").send(PAGE.replaceAll("__SECRET__", secret));
  });
}

const PAGE = String.raw`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexa Command</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
/* Matches nexamfgco.com: void black, carbon panels, hairline grid, Nexa blue + red accents, General Sans + JetBrains Mono. */
:root{--bg:#05070A;--carbon:#080B10;--panel:#0D1117;--panel2:#11161E;--line:#1A212C;--line2:#28313F;--ink:#EDF1F7;--ink2:#B7C1CF;--mute:#6F7B8C;--mute2:#4A5563;
--cy:#2F62FF;--cyd:#1B3FBF;--mg:#E8362B;--ok:#3BE08A;--warn:#F2B23A;--bad:#E8362B;--off:#4A5563;--glow:0 0 22px rgba(47,98,255,.45);
--fd:'General Sans','Inter','Helvetica Neue',Arial,sans-serif;--fm:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;--ease:cubic-bezier(.16,1,.3,1)}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 var(--fd);min-height:100%;-webkit-font-smoothing:antialiased}
body:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:120px 120px;opacity:.35;mask-image:radial-gradient(ellipse at 50% 0%,#000 20%,transparent 75%)}
.wrap{position:relative;max-width:1400px;margin:0 auto;padding:0 clamp(16px,3vw,40px) 64px}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:12px 0;margin-bottom:0;background:rgba(5,7,10,.85);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:12px}
.logo{width:34px;height:34px;border-radius:2px;display:block;box-shadow:0 0 16px rgba(47,98,255,.35)}
h1{font:600 17px var(--fd);letter-spacing:-.01em;margin:0;color:var(--ink)}h1 span{font-weight:400;color:var(--ink2)}
.tag{font:500 10px var(--fm);letter-spacing:.2em;color:var(--mute);text-transform:uppercase}
.hud{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.chip{font:500 11px var(--fm);letter-spacing:.14em;text-transform:uppercase;padding:8px 10px;color:var(--mute);display:flex;gap:8px;align-items:center;white-space:nowrap}
.chip b,#next,#clock{color:var(--ink);font-weight:500}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 8px var(--ok);animation:pulse 2s ease-in-out infinite;flex:none}
.dot.warn{background:var(--warn);box-shadow:0 0 8px var(--warn)}.dot.bad{background:var(--bad);box-shadow:0 0 8px var(--bad)}.dot.off{background:var(--off);box-shadow:none;animation:none}.dot.busy{background:var(--cy);box-shadow:0 0 8px var(--cy)}
.btn{font:500 13px var(--fd);padding:10px 16px;border-radius:2px;border:1px solid var(--cy);background:var(--cy);color:#fff;cursor:pointer;box-shadow:0 0 24px rgba(47,98,255,.35);transition:background .2s var(--ease),transform .2s var(--ease)}
.btn:hover{background:#4672ff;transform:translateY(-1px)}.btn.mg{background:transparent;border-color:var(--line2);color:var(--ink);box-shadow:none}.btn.mg:hover{border-color:var(--ink2);background:rgba(255,255,255,.03)}
.btn[disabled]{opacity:.55;cursor:wait;transform:none}
.marquee{overflow:hidden;border-bottom:1px solid var(--line);background:var(--carbon);margin:0 calc(-1*clamp(16px,3vw,40px)) 28px;white-space:nowrap}
.marquee div{display:inline-flex;gap:40px;padding:11px 0;animation:mq 60s linear infinite;font:500 11px var(--fm);letter-spacing:.16em;text-transform:uppercase;color:var(--ink2)}
.marquee span:before{content:"◆";color:var(--cy);margin-right:12px;font-size:8px;vertical-align:2px}
.hero{display:flex;justify-content:space-between;align-items:end;gap:20px;flex-wrap:wrap;margin:8px 0 26px}
.eyebrow{font:500 11px var(--fm);letter-spacing:.2em;text-transform:uppercase;color:var(--cy);display:flex;align-items:center;gap:12px;margin-bottom:12px}
.eyebrow:before{content:"";width:28px;height:1px;background:var(--mg)}
.hero h2.big{font:500 clamp(34px,5.4vw,76px)/1.0 var(--fd);letter-spacing:-.035em;text-transform:none;margin:0;color:var(--ink);display:block}.hero h2.big:before{display:none}
.hero h2.big em{font-style:normal;font-weight:400;color:var(--mute)}
.spec{font:500 11px var(--fm);letter-spacing:.16em;text-transform:uppercase;color:var(--mute);text-align:right;line-height:2}.spec b{color:var(--ink);font-weight:500}
.grid{display:grid;gap:1px;background:var(--line);border:1px solid var(--line)}
.kpis{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:28px}
.panel{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:2px;padding:22px;overflow:hidden}
.grid>.panel{border:0;border-radius:0}
.k{padding:20px 22px}.k .v{font:500 clamp(26px,2.8vw,40px)/1.1 var(--fd);letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.k .l{font:500 10px var(--fm);letter-spacing:.2em;text-transform:uppercase;color:var(--mute);margin-top:8px}
.k .idx{position:absolute;top:14px;right:16px;font:500 10px var(--fm);color:var(--mute2)}
.k.ok .v{color:var(--ok)}.k.warn .v{color:var(--warn)}.k.bad .v{color:var(--bad)}.k.cy .v{color:var(--ink)}
h2{font:500 11px var(--fm);letter-spacing:.2em;text-transform:uppercase;margin:0 0 18px;color:var(--cy);display:flex;align-items:center;gap:12px}
h2:before{content:"";width:28px;height:1px;background:var(--mg);flex:none}
h2 small{font:500 10.5px var(--fm);letter-spacing:.12em;color:var(--mute);margin-left:auto;text-align:right}
.main{grid-template-columns:1.25fr 1fr;margin-bottom:28px}
.bots{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:1px;background:var(--line);border:1px solid var(--line)}
.bot{padding:16px;background:var(--panel2);position:relative;transition:background .25s var(--ease)}.bot:hover{background:#141a24}
.bot .top{display:flex;align-items:center;gap:10px}.bot .ic{font:500 10px var(--fm);color:var(--mute2);width:auto}
.bot .n{font:500 15px var(--fd);letter-spacing:-.01em}.bot .dot{margin-left:auto}
.bot .ln{font:500 12px var(--fm);margin-top:10px;color:var(--ink)}.bot .dt{font-size:12.5px;color:var(--mute);margin-top:4px;line-height:1.5}
.bot.warn{box-shadow:inset 2px 0 0 var(--warn)}.bot.bad{box-shadow:inset 2px 0 0 var(--bad)}.bot.busy{box-shadow:inset 2px 0 0 var(--cy)}
.sales .big{display:flex;gap:28px;flex-wrap:wrap;margin-bottom:14px}
.sales .big div b{display:block;font:500 30px/1.1 var(--fd);letter-spacing:-.03em;color:var(--ink)}.sales .big div span{font:500 10px var(--fm);letter-spacing:.18em;color:var(--mute);text-transform:uppercase}
.chart{width:100%;height:150px;display:block}
.top5{margin-top:14px;display:grid;gap:8px}
.bar{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;font-size:13px;color:var(--ink2)}
.bar .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bar .track{grid-column:1/-1;height:2px;background:var(--line);overflow:hidden}
.bar .fill{height:100%;background:var(--cy)}.bar b{font:500 12px var(--fm);color:var(--ink)}
.three{grid-template-columns:1.2fr 1fr 1fr;margin-bottom:28px}
.feed{max-height:520px;overflow:auto;padding-right:6px}
.ev{border-left:1px solid var(--line2);padding:2px 0 14px 16px;position:relative}
.ev:before{content:"";position:absolute;left:-4px;top:8px;width:7px;height:7px;background:var(--cy);transform:rotate(45deg)}
.ev.u:before{background:var(--bad)}
.ev .h{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;cursor:pointer}.ev .h b{font:500 14px var(--fd)}.ev time{font:500 10.5px var(--fm);color:var(--mute);letter-spacing:.08em}
.ev pre{white-space:pre-wrap;margin:8px 0 0;font:12px/1.6 var(--fm);color:var(--ink2);max-height:0;overflow:hidden;transition:max-height .35s var(--ease)}
.ev.open pre{max-height:2000px}
.ideas pre{white-space:pre-wrap;margin:0;font:12px/1.65 var(--fm);color:var(--ink2)}
.ideas a,.ev a{color:#7d9bff}
.q{display:flex;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--line);font-size:13.5px;color:var(--ink2)}.q:first-child{border-top:0}
.q b{font:500 13px var(--fm);color:var(--ink);min-width:34px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:11px 8px;border-top:1px solid var(--line);vertical-align:middle;color:var(--ink2)}
th{font:500 10px var(--fm);letter-spacing:.18em;text-transform:uppercase;color:var(--mute);border-top:0}
td.m{font-family:var(--fm);white-space:nowrap;color:var(--ink)}.t2{max-width:360px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink)!important}
.range{position:relative;height:2px;width:120px;background:var(--line2)}.range i{position:absolute;top:-4px;width:10px;height:10px;background:var(--cy);transform:translateX(-50%) rotate(45deg);box-shadow:0 0 10px rgba(47,98,255,.6)}
.ad{font:500 11px var(--fm);padding:3px 8px;border:1px solid var(--line2);border-radius:2px;color:var(--ink)}
.empty{color:var(--mute);font-size:13.5px}
.scroll{overflow-x:auto}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(140px);background:var(--panel2);border:1px solid var(--line2);border-left:2px solid var(--ok);padding:13px 18px;border-radius:2px;font:500 13px var(--fd);transition:transform .45s var(--ease);z-index:9;max-width:calc(100% - 32px);box-shadow:0 20px 50px rgba(0,0,0,.5)}
.toast.on{transform:translateX(-50%) translateY(0)}
.scan{height:1px;background:linear-gradient(90deg,transparent,var(--cy),transparent);position:absolute;left:0;right:0;top:0;animation:scan 2.4s linear infinite;opacity:0}.running .scan{opacity:1}
.live{margin-bottom:28px}.ticker{display:grid;gap:1px;background:var(--line);border:1px solid var(--line);max-height:340px;overflow:auto}
.sale{display:grid;grid-template-columns:96px 1fr auto 96px;gap:14px;align-items:center;padding:12px 14px;background:var(--panel2);font-size:13.5px}
.sale .amt{font:500 16px var(--fd);letter-spacing:-.01em;color:var(--ink)}.sale .what{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink2)}
.sale .st{font:500 10px var(--fm);letter-spacing:.14em;text-transform:uppercase;padding:3px 8px;border:1px solid rgba(242,178,58,.45);color:var(--warn);border-radius:2px}.sale .st.ok{border-color:rgba(59,224,138,.4);color:var(--ok)}
.sale time{font:500 10.5px var(--fm);color:var(--mute);text-align:right;letter-spacing:.06em}
.sale.new{animation:newsale 2.6s var(--ease)}
.live.flash{box-shadow:inset 0 0 0 1px var(--ok)}
#prodp{margin-bottom:28px}.prods{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);max-height:600px;overflow:auto}
.prod{padding:16px;background:var(--panel2);display:grid;gap:10px;align-content:start;transition:background .25s var(--ease)}.prod:hover{background:#141a24}
.prod .pt a{color:var(--ink);text-decoration:none;font:500 14.5px/1.4 var(--fd)}.prod .pt a:hover{color:#7d9bff}
.prod .pm{display:flex;gap:14px;flex-wrap:wrap;font:500 11.5px var(--fm);color:var(--mute)}.prod .pm b{color:var(--ink);font-weight:500}.prod .fd{margin-left:auto}
.prod .pc{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12.5px}.prod .cad{font:500 12px var(--fd);color:#fff;background:var(--cy);padding:6px 11px;border-radius:2px;text-decoration:none}
.prod .cad:hover{background:#4672ff}.prod .cn{color:var(--mute)}
.tagc{font:500 10px var(--fm);letter-spacing:.1em;text-transform:uppercase;padding:3px 8px;border:1px solid var(--line2);border-radius:2px;color:var(--ink2);margin-right:6px}
.tagc.ok{border-color:rgba(59,224,138,.4);color:var(--ok)}.tagc.mk{border-color:rgba(47,98,255,.7);color:#9db4ff;background:rgba(47,98,255,.12);text-transform:none;letter-spacing:.02em}.tagc.warn{border-color:rgba(242,178,58,.45);color:var(--warn)}.tagc.bad{border-color:rgba(232,54,43,.5);color:#ff6a60}
#pcount a{color:#7d9bff}
input[type=checkbox]{accent-color:var(--cy);vertical-align:-2px}
#allp{margin-bottom:28px}.atk{grid-template-columns:repeat(6,1fr);margin-bottom:22px}.atk .k .v{font-size:clamp(20px,2vw,30px)}
.atwrap{display:grid;grid-template-columns:1fr 1.1fr;gap:28px}.sub2{font:500 10px var(--fm);letter-spacing:.18em;text-transform:uppercase;color:var(--mute);margin-bottom:10px}
.chart.tall{height:200px}.mlabels{display:flex;font:500 10px var(--fm);color:var(--mute);margin-top:6px}.mlabels span{text-align:center;white-space:nowrap}
.track2{height:2px;background:var(--line2)}.track2 i{display:block;height:100%;background:var(--cy)}
.prod .ph{display:flex;justify-content:space-between;font:500 10px var(--fm);color:var(--mute2);letter-spacing:.1em}.prod .pn{color:var(--cy)}
.prod .pt{color:var(--ink);font:500 14.5px/1.4 var(--fd)}
.pnums{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border:1px solid var(--line)}
.pnums div{background:var(--panel);padding:8px 8px 7px}.pnums b{display:block;font:500 15px var(--fd);letter-spacing:-.01em;color:var(--ink)}.pnums span{font:500 9px var(--fm);letter-spacing:.1em;text-transform:uppercase;color:var(--mute)}
.pnums b.g{color:var(--ok)}.pnums b.y{color:var(--warn)}.pnums b.r{color:#ff6a60}
.pseller{font-size:12px;color:var(--mute)}.pseller b{color:var(--ink2);font-weight:500}.lic{font:500 10px var(--fm);border:1px solid var(--line2);padding:1px 6px;border-radius:2px;color:var(--ink2);margin-left:4px}
.pbtns{display:grid;grid-template-columns:1fr 1fr;gap:8px}.pb{font:500 12.5px var(--fd);text-align:center;padding:9px 10px;border-radius:2px;text-decoration:none;border:1px solid var(--line2);color:var(--ink)}
.pb.eb:hover{border-color:var(--ink2)}.pb.cd{background:var(--cy);border-color:var(--cy);color:#fff}.pb.cd:hover{background:#4672ff}.pb.no{color:var(--mute);border-style:dashed}
@media (max-width:1100px){.atk{grid-template-columns:repeat(3,1fr)}.atwrap{grid-template-columns:1fr}}
@media (max-width:640px){.atk{grid-template-columns:repeat(2,1fr)}.pnums{grid-template-columns:repeat(2,1fr)}}
.prod{position:relative}.px{margin-left:10px;background:none;border:1px solid var(--line2);color:var(--mute);width:24px;height:24px;border-radius:2px;cursor:pointer;font-size:12px;line-height:1}
.px:hover{color:var(--ink);border-color:var(--ink2);background:rgba(232,54,43,.12)}.prod .ph{align-items:center}
.pask{display:none;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;color:var(--ink2);padding:10px;border:1px dashed var(--line2)}
.prod.asking .pask{display:flex}.prod.asking .pbtns{display:none}
.pb.ok2{border-color:rgba(59,224,138,.5);color:var(--ok);background:none;cursor:pointer;flex:1}.pb.no2{border-color:rgba(232,54,43,.5);color:#ff6a60;background:none;cursor:pointer;flex:1}
.pb.ok2:hover{background:rgba(59,224,138,.1)}.pb.no2:hover{background:rgba(232,54,43,.1)}
.lnk{background:none;border:0;color:#7d9bff;cursor:pointer;font:inherit;padding:0;text-decoration:underline;text-underline-offset:3px}
h2 small .lnk{font:500 10.5px var(--fm);letter-spacing:.12em;text-transform:uppercase}
.pb.mkb{border-color:rgba(47,98,255,.6);color:#9db4ff;background:rgba(47,98,255,.1)}.pb.fc{background:none;cursor:pointer;color:var(--ink);border-style:dashed}.pb.fc:hover{border-color:var(--ink2)}
.pfind{display:none;grid-template-columns:1fr 1fr;gap:6px;padding:10px;border:1px solid var(--line2);background:var(--panel)}.prod.finding .pfind{display:grid}
.pfind a{font:500 12px var(--fd);color:#7d9bff;text-decoration:none;padding:6px 8px;border:1px solid var(--line);border-radius:2px}.pfind a:hover{border-color:var(--ink2);color:var(--ink)}
.pfind .fq,.pfind .fnote{grid-column:1/-1;font-size:11.5px;color:var(--mute)}.pfind .fq b{color:var(--ink2);font-weight:500}.pfind .fnote b{color:var(--ink2)}
.lnk.small{font-size:12px;justify-self:start}
.deepbar{display:flex;flex-direction:column;gap:6px;margin:-6px 0 14px;font:500 11px var(--fm);letter-spacing:.06em;color:var(--ink2)}.deepbar:empty{display:none}
.dtrack{height:2px;background:var(--line2)}.dtrack i{display:block;height:100%;background:var(--cy);box-shadow:0 0 10px rgba(47,98,255,.6);transition:width .6s var(--ease)}
@keyframes pulse{50%{opacity:.35}}@keyframes scan{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}@keyframes mq{to{transform:translateX(-50%)}}
@keyframes newsale{0%{background:rgba(59,224,138,.18)}100%{background:var(--panel2)}}
@media (max-width:1100px){.kpis{grid-template-columns:repeat(3,1fr)}.main,.three{grid-template-columns:1fr}}
@media (max-width:640px){.kpis{grid-template-columns:repeat(2,1fr)}.hud{width:100%}.btn{flex:1}.chip.hide{display:none}.spec{text-align:left}
.sale{grid-template-columns:80px 1fr;row-gap:6px}.sale .st{justify-self:start}.sale time{text-align:left}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body><div class="wrap" id="app">
<header>
  <div class="brand"><img class="logo" src="https://nexamfgco.com/assets/img/nexa-logo.png" alt=""><div><h1>NEXA <span>Command</span></h1><div class="tag">nexamfgco · store operations</div></div></div>
  <div class="hud">
    <span class="chip"><span class="dot" id="sysdot"></span><span id="sys">CONNECTING</span></span>
    <span class="chip hide" id="clock">--:--:--</span>
    <span class="chip hide">NEXT RUN <span id="next">--</span></span>
    <button class="btn mg" id="find">Find products</button>
    <button class="btn mg" id="mkscan">🛠 Make-it scan</button>
    <button class="btn mg" id="deep">Deep scan</button>
    <button class="btn" id="run">Run bots →</button>
  </div>
</header>
<div class="marquee"><div id="mq"></div></div>
<div class="hero"><div><div class="eyebrow">NEXA-MFG // eBay · nexamfgco</div><h2 class="big">Store operations,<br><em>running on autopilot.</em></h2></div>
<div class="spec">Bots <b>7</b> online<br>Schedule <b>7AM · 1PM · 7PM</b><br>Status <b id="spec">—</b></div></div>
<div class="grid kpis" id="kpis"></div>
<div class="grid main">
  <section class="panel"><div class="scan"></div><h2>Bot fleet <small id="lastrun"></small></h2><div class="bots" id="bots"></div></section>
  <section class="panel sales"><h2>Sales · 30 days</h2><div class="big" id="big"></div><svg class="chart" id="chart" viewBox="0 0 600 150" preserveAspectRatio="none"></svg><div class="top5" id="top"></div></section>
</div>
<section class="panel" id="allp"><div class="scan"></div><h2>Total sales ever <small id="since"></small></h2>
<div class="grid atk" id="atk"></div>
<div class="atwrap"><div><div class="sub2">Revenue by month</div><svg class="chart tall" id="mchart" viewBox="0 0 600 190" preserveAspectRatio="none"></svg><div class="mlabels" id="mlabels"></div></div>
<div><div class="sub2">Best sellers, all time</div><div class="scroll"><table id="attop"></table></div></div></div></section>
<section class="panel live" id="livep"><h2>Live sales · eBay <small><span class="dot" style="display:inline-block;vertical-align:middle"></span> updating every 20s · <label style="cursor:pointer"><input type="checkbox" id="chime"> chime on new sale</label></small></h2><div class="ticker" id="ticker"></div></section>
<section class="panel" id="prodp"><h2>Products found <small id="pcount"></small></h2><div class="deepbar" id="deepbar"></div><div class="prods" id="prods"></div></section>
<div class="grid three">
  <section class="panel"><h2>Live activity <small>tap an entry to expand</small></h2><div class="feed" id="feed"></div></section>
  <section class="panel ideas"><h2>Product radar <small id="ideatime"></small></h2><div id="ideas"></div></section>
  <section class="panel"><h2>Print queue <small id="qcount"></small></h2><div id="queue"></div></section>
</div>
<section class="panel"><h2>Price watch <small>bot-tracked listings</small></h2><div class="scroll"><table id="price"></table></div></section>
</div>
<div class="toast" id="toast"></div>
<script>
const S="__SECRET__";const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money=n=>n==null?"—":"$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtT=t=>new Date(t).toLocaleString("en-US",{weekday:"short",hour:"numeric",minute:"2-digit"});
let D=null,open=new Set(),seen=null,showHidden=false,makeOnly=false,CUR=[];
// Search links for a CAD file, free and paid. A paid file must still allow selling prints (commercial license).
function cadQuery(t){const stop=/^(3d|3-d|printed|print|printing|replacement|replace|part|parts|new|upgraded|heavy|duty|pack|set|of|for|the|and|with|fits|fit|compatible|model|type|black|white|oem|obsolete|reproduction|from|\d+x|x\d+)$/i;
 return t.replace(/[^a-z0-9\/ -]/gi," ").split(/\s+/).filter(w=>w&&!stop.test(w)).slice(0,5).join(" ")}
function findLinks(x){const q=encodeURIComponent(cadQuery(x.title));const S=[["Cults3D (free + paid)","https://cults3d.com/en/search?q="+q],["Printables (free + store)","https://www.printables.com/search/models?q="+q],["MakerWorld","https://makerworld.com/en/search/models?keyword="+q],["Thingiverse","https://www.thingiverse.com/search?q="+q+"&type=things"],["MyMiniFactory","https://www.myminifactory.com/search/?query="+q],["CGTrader (paid)","https://www.cgtrader.com/3d-print-models?keywords="+q],["Etsy STL files (paid)","https://www.etsy.com/search?q="+q+"%20stl%20file"]];
 return '<div class="fq">Searching: <b>'+esc(decodeURIComponent(q))+'</b></div>'+S.map(([n,u])=>'<a target="_blank" rel="noopener" href="'+u+'">'+n+' ↗</a>').join("")+'<div class="fnote">Paid files: buy one whose license allows <b>commercial use</b> / selling prints (Cults “CU”, not “PU” private use). None out there? Model it, or hire a designer.</div>'}
async function decide(x,d){if(!x)return;const P=D.products;
 // move it locally right away, then save
 if(d){P.list=P.list.filter(y=>y.ebay!==x.ebay);x.decision=d;P.hidden=[x,...P.hidden.filter(y=>y.ebay!==x.ebay)];P.hiddenCount=P.hidden.length;P.total=P.list.length}
 else{P.hidden=P.hidden.filter(y=>y.ebay!==x.ebay);x.decision="";P.list=[x,...P.list];P.hiddenCount=P.hidden.length;P.total=P.list.length}
 render();
 try{const r=await fetch("/dashboard/"+S+"/decide",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ebay:x.ebay,decision:d,row:x})});const j=await r.json();if(!j.ok)throw new Error(j.error||r.status);
  toastUndo(d==="added"?"Marked as added: hidden from the list":d==="dismissed"?"Not interested: hidden for good":"Restored to the list",d?()=>decide(x,""):null)}
 catch(e){toast("Couldn't save that choice: "+e.message)}}
function toastUndo(m,undo){const t=$("toast");t.innerHTML=esc(m)+(undo?' <button class="lnk" id="undo">undo</button>':'');t.classList.add("on");if(undo)$("undo").onclick=()=>{t.classList.remove("on");undo()};clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove("on"),8000)}
function chime(){try{const a=new (window.AudioContext||window.webkitAudioContext)();[880,1320].forEach((f,i)=>{const o=a.createOscillator(),g=a.createGain();o.frequency.value=f;o.type="sine";g.gain.setValueAtTime(.0001,a.currentTime+i*.14);g.gain.exponentialRampToValueAtTime(.25,a.currentTime+i*.14+.02);g.gain.exponentialRampToValueAtTime(.0001,a.currentTime+i*.14+.35);o.connect(g);g.connect(a.destination);o.start(a.currentTime+i*.14);o.stop(a.currentTime+i*.14+.4)})}catch(e){}}
try{document.addEventListener("DOMContentLoaded",()=>{const c=document.getElementById("chime");c.checked=localStorage.getItem("nexaChime")==="1";c.onchange=()=>{try{localStorage.setItem("nexaChime",c.checked?"1":"0")}catch(e){};if(c.checked)chime()}})}catch(e){}
function toast(m){const t=$("toast");t.textContent=m;t.classList.add("on");clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove("on"),12000)}
function tick(){const n=new Date();$("clock").textContent=n.toLocaleTimeString("en-US",{hour12:false});
 if(D){const s=Math.max(0,Math.round((D.nextRunAt-Date.now())/1000));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;$("next").textContent=D.nextRunLabel+" · T-"+(h?h+"h ":"")+String(m).padStart(2,"0")+"m "+String(x).padStart(2,"0")+"s"}}
setInterval(tick,1000);
function linkify(s){return esc(s).replace(/(https?:\/\/[^\s)]+|www\.[^\s)]+)/g,u=>'<a target="_blank" rel="noopener" href="'+(u.startsWith("http")?u:"https://"+u)+'">'+u+'</a>')}
function render(){
 const k=D.kpis,s=D.sales;
 const issues=k.late+(k.above?1:0);
 $("sysdot").className="dot"+(D.running?" busy":k.late?" bad":k.lowStock||k.above?" warn":"");
 $("sys").textContent=D.running?"BOTS RUNNING":D.dry?"TEST MODE":k.late?"ATTENTION NEEDED":(k.lowStock||k.above)?"MONITORING":"ALL SYSTEMS NOMINAL";
 document.getElementById("app").classList.toggle("running",!!D.running);
 const K=[["Total sales ever",money(D.allTime.rev),"cy"],["Sales today",money(s.revToday),"cy"],["Orders today",s.ordersToday,""],["Revenue 7d",money(s.rev7),""],["To ship",k.unshipped,k.unshipped?"":"ok"],["Late",k.late,k.late?"bad":"ok"],["Low stock",k.lowStock,k.lowStock?"warn":"ok"]].filter(x=>x[0]!=="Late"||k.late);
 const ago=t=>{const m=Math.round((Date.now()-t)/60000);return m<1?"just now":m<60?m+"m ago":m<1440?Math.floor(m/60)+"h "+(m%60)+"m ago":fmtT(t)};
 const fresh=new Set(s.recent.filter(o=>seen&&!seen.has(o.id)).map(o=>o.id));
 $("ticker").innerHTML=s.recent.length?s.recent.map(o=>'<div class="sale'+(fresh.has(o.id)?" new":"")+'"><span class="amt">'+money(o.total)+'</span><span class="what">'+o.items.map(i=>(i.qty>1?i.qty+"× ":"")+esc(i.title)).join(" + ")+'</span><span class="st '+(o.shipped?"ok":"")+'">'+(o.shipped?"shipped":"to ship")+'</span><time>'+ago(o.time)+'</time></div>').join(""):'<p class="empty">No orders in the last 30 days.</p>';
 if(fresh.size){const f=s.recent.find(o=>fresh.has(o.id));toast("💰 New sale · "+money(f.total)+" · "+f.items[0].title.slice(0,50));if($("chime").checked)chime();$("livep").classList.add("flash");setTimeout(()=>$("livep").classList.remove("flash"),2500)}
 seen=new Set(s.recent.map(o=>o.id));
 $("kpis").innerHTML=K.map(([l,v,c],i)=>'<div class="panel k '+c+'"><span class="idx">0'+(i+1)+'</span><div class="v">'+esc(v)+'</div><div class="l">'+esc(l)+'</div></div>').join("");
 const M=["Total sales ever "+money(D.allTime.rev),"Sales today "+money(s.revToday),s.ordersToday+" orders today",money(s.rev7)+" last 7 days",money(s.rev30)+" last 30 days",k.unshipped+" to ship",k.late+" late",k.listings+" live listings",(D.products&&D.products.total||0)+" product ideas","Ads capped at "+k.cap+"%","Next run "+D.nextRunLabel];
 $("mq").innerHTML=[...M,...M].map(x=>'<span>'+esc(x)+'</span>').join("");
 $("spec").textContent=$("sys").textContent;
 $("bots").innerHTML=D.bots.map(b=>'<div class="bot '+b.state+'"><div class="top"><span class="ic">'+esc(b.icon)+'</span><span class="n">'+esc(b.name)+'</span><span class="dot '+b.state+'"></span></div><div class="ln">'+esc(b.line)+'</div><div class="dt">'+esc(b.detail)+'</div></div>').join("");
 $("lastrun").textContent=D.lastRunAt?"last report "+fmtT(D.lastRunAt):"waiting for first scheduled run";
 $("big").innerHTML='<div><b>'+money(s.rev30)+'</b><span>revenue 30d</span></div><div><b>'+s.orders30+'</b><span>orders 30d</span></div><div><b>'+(s.orders30?money(s.rev30/s.orders30):"—")+'</b><span>avg order</span></div>';
 const mx=Math.max(1,...s.days.map(d=>d.rev)),w=600/s.days.length;
 let bars="",pts=[];
 s.days.forEach((d,i)=>{const h=Math.round(d.rev/mx*120);bars+='<rect x="'+(i*w+2)+'" y="'+(140-h)+'" width="'+(w-4)+'" height="'+h+'" rx="2" fill="url(#g)"><title>'+esc(d.d)+": "+money(d.rev)+" · "+d.orders+' orders</title></rect>';pts.push((i*w+w/2)+","+(140-h))});
 $("chart").innerHTML='<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2F62FF" stop-opacity=".95"/><stop offset="1" stop-color="#2F62FF" stop-opacity=".12"/></linearGradient></defs><line x1="0" y1="140" x2="600" y2="140" stroke="#28313F"/>'+bars+'<polyline points="'+pts.join(" ")+'" fill="none" stroke="#EDF1F7" stroke-width="1" opacity=".5"/>';
 const tmx=Math.max(1,...s.top.map(t=>t.units));
 $("top").innerHTML=s.top.length?s.top.map(t=>'<div class="bar"><span class="t">'+esc(t.title)+'</span><b>'+t.units+'</b><div class="track"><div class="fill" style="width:'+(t.units/tmx*100)+'%"></div></div></div>').join(""):'<p class="empty">No orders in 30 days.</p>';
 $("feed").innerHTML=D.runs.length?D.runs.map((r,i)=>{const id=r.time+r.title;return '<div class="ev'+(r.urgent?" u":"")+(open.has(id)||i===0?" open":"")+'" data-id="'+esc(id)+'"><div class="h"><b>'+esc(r.title)+'</b><time>'+fmtT(r.time)+'</time></div><pre>'+linkify(r.message)+'</pre></div>'}).join(""):'<p class="empty">No reports in the last 12 hours. Bot reports appear here after each run (7am · 1pm · 7pm).</p>';
 document.querySelectorAll(".ev .h").forEach(h=>h.onclick=()=>{const e=h.parentNode;e.classList.toggle("open");e.classList.contains("open")?open.add(e.dataset.id):open.delete(e.dataset.id)});
 if(D.ideas){$("ideatime").textContent=fmtT(D.ideas.time);$("ideas").innerHTML='<pre>'+linkify(D.ideas.message.replace(/^.*?PRODUCT IDEAS[^\n]*\n/s,""))+'</pre>'}
 else{$("ideatime").textContent="";$("ideas").innerHTML='<p class="empty">No scan in the last 12 hours. Hit “Find products” to scan now. Results list under Products found.</p>'}
 const DP=D.deep;$("deepbar").innerHTML=DP&&(DP.running||Date.now()-DP.finished<600000)&&DP.total?'<div class="dtrack"><i style="width:'+Math.round(DP.done/DP.total*100)+'%"></i></div><span>'+(DP.running?"Deep scan running: batch "+DP.done+" of "+DP.total+" done"+(DP.bot?" · now: "+DP.bot:""):"Deep scan finished")+" · "+DP.checked+" new listings checked · "+DP.found+" new products added"+(DP.running?" · new products appear below as they're found":"")+'</span>':"";
 $("deep").disabled=!!D.running;$("deep").textContent=DP&&DP.running?"Scanning… "+DP.done+"/"+DP.total:"Deep scan";
 const P=D.products,PL0=showHidden?P.hidden:P.list,PL=makeOnly?PL0.filter(x=>/claude can make/i.test(x.status)):PL0;CUR=PL;
 $("pcount").innerHTML=(showHidden?P.hiddenCount+" hidden · ":P.total+" products · newest first · ")+'<button class="lnk" id="hidtog">'+(showHidden?"← back to list":"hidden ("+P.hiddenCount+")")+'</button> · <button class="lnk" id="mktog">'+(makeOnly?"show all":"🛠 Claude can make ("+P.list.filter(x=>/claude can make/i.test(x.status)).length+")")+'</button>';
 $("hidtog").onclick=()=>{showHidden=!showHidden;render()};$("mktog").onclick=()=>{makeOnly=!makeOnly;render()};
 const cls=st=>/claude can make/i.test(st)?"mk":/same part/i.test(st)?"ok":/no free cad/i.test(st)?"bad":"warn";
 const n0=v=>Number(v||0).toLocaleString("en-US");
 $("prods").innerHTML=PL.length?PL.map((x,i)=>'<div class="prod" data-i="'+i+'"><div class="ph"><span class="pn">'+String(i+1).padStart(2,"0")+'</span><span class="fd">'+esc(x.found)+'</span>'+(showHidden?'':'<button class="px" title="Hide: added it / not interested" data-x="'+i+'">✕</button>')+'</div><div class="pt">'+esc(x.title)+'</div><div class="pnums"><div><b>'+n0(x.sold)+'</b><span>sold</span></div><div><b>'+money(x.price)+'</b><span>their price</span></div><div><b>$'+n0(x.theirRevenue)+'</b><span>their sales</span></div><div><b class="'+(x.margin>=40?"g":x.margin>=25?"y":"r")+'">'+money(x.profit)+'</b><span>est. profit · '+x.margin+'%</span></div></div><div class="pseller">seller <b>'+esc(x.seller)+'</b>'+(x.cadName?' · CAD: '+esc(x.cadName)+' <span class="lic">'+esc(x.license)+'</span>':'')+'</div><div class="pbtns"><a class="pb eb" target="_blank" rel="noopener" href="'+esc(x.ebay)+'">eBay listing ↗</a>'+(x.cad?'<a class="pb cd" target="_blank" rel="noopener" href="'+esc(x.cad)+'">CAD file ↗</a>':/claude can make/i.test(x.status)?'<span class="pb mkb">🛠 Send to Claude to build</span>':'<button class="pb fc" data-f="'+i+'">Find CAD (free + paid) ↓</button>')+'</div><div class="pfind">'+findLinks(x)+'</div><div class="pask"><span>Hide this product:</span><button class="pb ok2" data-d="added" data-i="'+i+'">✓ Added it</button><button class="pb no2" data-d="dismissed" data-i="'+i+'">✕ Not interested</button><button class="lnk" data-c="'+i+'">cancel</button></div><div class="ps">'+(showHidden?'<span class="tagc '+(/^added/i.test(x.decision)?"ok":"bad")+'">'+esc(/^added/i.test(x.decision)?"added it":"not interested")+'</span><button class="lnk" data-r="'+i+'">restore</button>':'<span class="tagc '+cls(x.status)+'">'+esc((x.status||"new").replace(/no free cad.*$/i,"No free CAD found · try paid"))+'</span>')+'</div></div>').join(""):'<p class="empty">'+(showHidden?"Nothing hidden.":"No products yet. Hit “Find products” and they’ll list here.")+'</p>';
 document.querySelectorAll("#prods [data-f]").forEach(b=>b.onclick=()=>b.closest(".prod").classList.toggle("finding"));
 document.querySelectorAll("#prods [data-x]").forEach(b=>b.onclick=()=>b.closest(".prod").classList.add("asking"));
 document.querySelectorAll("#prods [data-c]").forEach(b=>b.onclick=()=>b.closest(".prod").classList.remove("asking"));
 document.querySelectorAll("#prods [data-d]").forEach(b=>b.onclick=()=>decide(CUR[+b.dataset.i],b.dataset.d));
 document.querySelectorAll("#prods [data-r]").forEach(b=>b.onclick=()=>decide(CUR[+b.dataset.r],""));
 const A=D.allTime;$("since").textContent=A.first?"since "+new Date(A.first).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}):"";
 const AK=[["Total sales ever",money(A.rev)],["Total orders ever",n0(A.orders)],["Units sold",n0(A.units)],["Avg order",money(A.avgOrder)],["Avg per month",money(A.perMonth)],["Best month",A.best?money(A.best.rev)+" · "+A.best.m:"—"]];
 $("atk").innerHTML=AK.map(([l,v],i)=>'<div class="panel k"><span class="idx">0'+(i+1)+'</span><div class="v">'+esc(v)+'</div><div class="l">'+esc(l)+'</div></div>').join("");
 const mm=A.months,mmax=Math.max(1,...mm.map(x=>x.rev)),mw=600/Math.max(1,mm.length);
 $("mchart").innerHTML='<line x1="0" y1="170" x2="600" y2="170" stroke="#28313F"/>'+mm.map((x,i)=>{const h=Math.round(x.rev/mmax*150);return '<rect x="'+(i*mw+mw*.15)+'" y="'+(170-h)+'" width="'+(mw*.7)+'" height="'+h+'" fill="'+(A.best&&x.m===A.best.m?"#3BE08A":"#2F62FF")+'"><title>'+esc(x.m)+": "+money(x.rev)+" · "+x.orders+' orders</title></rect>'}).join("");
 const step=Math.ceil(mm.length/8);$("mlabels").innerHTML=mm.map((x,i)=>'<span style="width:'+(100/mm.length)+'%">'+(i%step===0?esc(new Date(x.m+"-15").toLocaleDateString("en-US",{month:"short",year:"2-digit"})):"")+'</span>').join("");
 const tr=Math.max(1,...A.top.map(t=>t.rev));
 $("attop").innerHTML='<tr><th>#</th><th>Listing</th><th>Units</th><th>Revenue</th><th></th></tr>'+A.top.map((t,i)=>'<tr><td class="m">'+(i+1)+'</td><td class="t2">'+esc(t.title)+'</td><td class="m">'+n0(t.units)+'</td><td class="m">'+money(t.rev)+'</td><td style="width:90px"><div class="track2"><i style="width:'+(t.rev/tr*100)+'%"></i></div></td></tr>').join("");
 const qu=D.queue.reduce((a,q)=>a+q.qty,0);$("qcount").textContent=qu?qu+" parts":"";
 $("queue").innerHTML=D.queue.length?D.queue.map(q=>'<div class="q"><b>'+q.qty+'×</b><span>'+esc(q.title)+'</span></div>').join(""):'<p class="empty">Queue clear. Nothing to print.</p>';
 $("price").innerHTML='<tr><th>Listing</th><th>Price</th><th>Range</th><th>Position</th><th>Ad</th><th>Stock</th></tr>'+D.pricing.map(p=>{const lo=p.min??(p.price?p.price*.8:0),hi=p.max??(p.price?p.price*1.2:1);const pos=p.price==null?50:Math.max(0,Math.min(100,(p.price-lo)/((hi-lo)||1)*100));
  return '<tr><td class="t2">'+esc(p.title)+'</td><td class="m">'+money(p.price)+'</td><td class="m">'+(p.min!=null?money(p.min):"floor")+' – '+(p.max!=null?money(p.max):"—")+'</td><td><div class="range"><i style="left:'+pos+'%"></i></div></td><td>'+(p.ad!=null?'<span class="ad">'+p.ad+'%</span>':'<span class="empty">—</span>')+'</td><td class="m">'+(p.qty??"—")+'</td></tr>'}).join("");
 tick();
}
async function load(fresh){try{const r=await fetch("/dashboard/"+S+"/data"+(fresh?"?fresh=1":""),{cache:"no-store"});if(!r.ok)throw new Error(r.status);D=await r.json();if(D.error)throw new Error(D.error);render()}catch(e){$("sys").textContent="LINK LOST · RETRYING";$("sysdot").className="dot bad"}}
async function run(only,btn,label){btn.disabled=true;const old=btn.textContent;btn.textContent=label;document.getElementById("app").classList.add("running");
 try{const r=await fetch("/bots/run/"+S+(only?"?only="+only:"?force=1"),{method:"POST"});const j=await r.json();
  toast(!j.ok?("Not run: "+(j.error||r.status)):j.finder?((j.finder.bot?j.finder.bot+": ":"")+"searched "+j.finder.searched.length+" ("+j.finder.searched.slice(0,2).join(", ").replace(/3d printed /g,"")+"…) · checked "+j.finder.checked+" printed listings · "+j.finder.found+" with 50+ sold"+(j.finder.makeable?" · "+j.finder.makeable+" Claude can make":"")+(j.finder.fresh?" · "+j.finder.fresh+" NEW on the board":"")):("Done in "+j.seconds+"s · "+j.changes+" changes · "+j.urgent+" alerts"));if(j.finder)setTimeout(()=>document.getElementById("prodp").scrollIntoView({behavior:"smooth"}),600)}catch(e){toast("Run failed: "+e.message)}
 btn.disabled=false;btn.textContent=old;load(true)}
$("run").onclick=e=>run("",e.currentTarget,"Running…");
$("find").onclick=e=>run("finder",e.currentTarget,"Searching eBay… (1–3 min)");
$("mkscan").onclick=e=>run("finder&strategy=makeit",e.currentTarget,"Finding parts Claude can make…");
$("deep").onclick=async e=>{const b=e.currentTarget;b.disabled=true;try{const r=await fetch("/bots/deep/"+S,{method:"POST"});const j=await r.json();toast(j.ok?"Deep scan started: "+j.total+" batches (~"+Math.round(j.total*1.5)+" min). New products appear in the list as they're found. You can leave this page.":"Not started: "+(j.error||r.status))}catch(err){toast("Deep scan failed to start: "+err.message)}load(true)};
load();setInterval(()=>load(false),20000);
</script></body></html>`;
