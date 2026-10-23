// Private live dashboard ("Nexa Command"): https://<service>.onrender.com/dashboard/<CONNECTOR_SECRET>
// The page is a static shell; it pulls /dashboard/<secret>/data every 30 seconds and redraws.
// Read-only, except the two Run buttons, which call the same run endpoint the cron job uses.
import type { Express } from "express";
import { rest } from "./ebay.js";
import { activeListings, loadConfig, recentOrders } from "./bots/shared.js";
import { todaysQueries } from "./bots/finder.js";

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

const TZ = "America/Indianapolis";
const hourIn = (d = new Date()) => Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: TZ }).format(d));
const dayKey = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(t));

async function buildData() {
  const cfg = loadConfig();
  const [runs, listings, unshipped, month, ads] = await Promise.all([
    botRuns().catch(() => [] as Run[]),
    activeListings().catch(() => []),
    recentOrders(30, true).catch(() => []),
    recentOrders(30, false).catch(() => []),
    adRates().catch(() => new Map<string, number>()),
  ]);
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
    { name: "Product finder", icon: "✦", state: "ok",
      line: lastFinder ? `last scan ${new Date(lastFinder.time).toLocaleString("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit" })}` : "scans every morning",
      detail: `Today: ${todaysQueries(cfg).slice(0, 4).join(" · ")}…` },
    { name: "AI brain", icon: "⬡", state: brain ? "ok" : "off",
      line: brain ? "online · daily brief + reply drafts" : "offline (add ANTHROPIC_API_KEY)", detail: "Verifies competitors and CAD matches, writes the morning plan." },
  ];

  return {
    now, dry: cfg.dry_run, nextRunAt, nextRunLabel: `${nextH % 12 || 12}${nextH < 12 ? "AM" : "PM"}`,
    lastRunAt: lastRun?.time ?? null,
    kpis: { listings: listings.length, unshipped: unshipped.length, late: late.length, lowStock: lowStock.length, above: above.length, cap },
    sales: { orders7, rev7, orders30: month.length, rev30, days, top },
    bots,
    runs: runs.slice(0, 20),
    ideas: lastFinder ? { time: lastFinder.time, message: lastFinder.message } : null,
    queue: [...queue.entries()].map(([title, qty]) => ({ title, qty })).sort((a, b) => b.qty - a.qty),
    pricing: Object.entries(cfg.pricing.rules).map(([id, rule]) => {
      const l = byId.get(id);
      return { title: l?.title || id, price: l?.price ?? null, min: rule.min ?? null, max: rule.max ?? null, ad: ads.get(id) ?? null, qty: l?.quantity_available ?? null };
    }),
  };
}

let cache: { at: number; data: any } | null = null;
let building: Promise<any> | null = null;
async function getData(force = false) {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.data;
  if (!building) building = buildData().then((d) => { cache = { at: Date.now(), data: d }; return d; }).finally(() => { building = null; });
  return building;
}
export function invalidateDashboard() { cache = null; }

export function registerDashboard(app: Express, secret: string, isRunning: () => boolean = () => false) {
  app.get(`/dashboard/${secret}/data`, async (req, res) => {
    try {
      const d = await getData(req.query.fresh === "1");
      res.set("Cache-Control", "no-store").json({ ...d, running: isRunning() });
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
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=JetBrains+Mono:wght@400;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#04060c;--panel:rgba(12,20,36,.72);--line:rgba(80,220,255,.16);--line2:rgba(80,220,255,.32);--ink:#dff6ff;--mute:#7f9bb3;
--cy:#38f3ff;--mg:#ff3fd8;--ok:#5dffa8;--warn:#ffc94a;--bad:#ff4d6d;--off:#5b6b7d;--glow:0 0 18px rgba(56,243,255,.35)}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 Inter,system-ui,sans-serif;min-height:100%}
body{background:radial-gradient(1200px 600px at 80% -10%,rgba(255,63,216,.12),transparent 60%),radial-gradient(900px 500px at -10% 10%,rgba(56,243,255,.12),transparent 60%),var(--bg)}
body:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(rgba(56,243,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(56,243,255,.05) 1px,transparent 1px);background-size:44px 44px;mask-image:radial-gradient(ellipse at center,#000 30%,transparent 85%)}
body:after{content:"";position:fixed;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(255,255,255,.018) 0 1px,transparent 1px 3px)}
.wrap{position:relative;max-width:1320px;margin:0 auto;padding:18px 16px 60px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:14px}
.logo{width:44px;height:44px;border:1.5px solid var(--cy);border-radius:10px;display:grid;place-items:center;font:900 18px Orbitron;color:var(--cy);box-shadow:var(--glow),inset 0 0 14px rgba(56,243,255,.25);position:relative}
.logo:after{content:"";position:absolute;inset:-6px;border:1px solid rgba(255,63,216,.4);border-radius:14px;animation:spin 8s linear infinite;border-style:dashed}
h1{font:900 clamp(18px,3vw,26px) Orbitron;letter-spacing:.18em;margin:0;background:linear-gradient(90deg,var(--cy),#9ef9ff 40%,var(--mg));-webkit-background-clip:text;background-clip:text;color:transparent}
.tag{font:500 11px "JetBrains Mono";letter-spacing:.2em;color:var(--mute);text-transform:uppercase}
.hud{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.chip{font:600 12px "JetBrains Mono";padding:7px 11px;border:1px solid var(--line2);border-radius:999px;background:rgba(8,14,26,.7);color:var(--ink);display:flex;gap:8px;align-items:center;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 10px var(--ok);animation:pulse 1.8s ease-in-out infinite}
.dot.warn{background:var(--warn);box-shadow:0 0 10px var(--warn)}.dot.bad{background:var(--bad);box-shadow:0 0 10px var(--bad)}.dot.off{background:var(--off);box-shadow:none;animation:none}.dot.busy{background:var(--cy);box-shadow:0 0 10px var(--cy)}
.btn{font:700 12px Orbitron;letter-spacing:.12em;text-transform:uppercase;padding:11px 16px;border-radius:10px;border:1px solid var(--cy);background:linear-gradient(180deg,rgba(56,243,255,.18),rgba(56,243,255,.04));color:var(--ink);cursor:pointer;box-shadow:var(--glow);transition:transform .15s,box-shadow .15s}
.btn:hover{transform:translateY(-1px);box-shadow:0 0 26px rgba(56,243,255,.55)}.btn.mg{border-color:var(--mg);background:linear-gradient(180deg,rgba(255,63,216,.2),rgba(255,63,216,.04));box-shadow:0 0 18px rgba(255,63,216,.35)}
.btn[disabled]{opacity:.55;cursor:wait;transform:none}
.grid{display:grid;gap:14px}
.kpis{grid-template-columns:repeat(6,1fr);margin-bottom:14px}
.panel{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;backdrop-filter:blur(8px);overflow:hidden}
.panel:before,.panel:after{content:"";position:absolute;width:14px;height:14px;border:2px solid var(--cy);opacity:.7}
.panel:before{top:-1px;left:-1px;border-right:0;border-bottom:0;border-top-left-radius:14px}.panel:after{bottom:-1px;right:-1px;border-left:0;border-top:0;border-bottom-right-radius:14px}
.k .v{font:700 clamp(22px,2.6vw,32px) "JetBrains Mono";font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.k .l{font:500 10.5px "JetBrains Mono";letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
.k.ok .v{color:var(--ok);text-shadow:0 0 14px rgba(93,255,168,.35)}.k.warn .v{color:var(--warn)}.k.bad .v{color:var(--bad);text-shadow:0 0 14px rgba(255,77,109,.4)}.k.cy .v{color:var(--cy);text-shadow:var(--glow)}
h2{font:700 12px Orbitron;letter-spacing:.2em;text-transform:uppercase;margin:0 0 14px;color:var(--cy);display:flex;align-items:center;gap:10px}
h2 small{font:500 11px "JetBrains Mono";letter-spacing:.08em;color:var(--mute);text-transform:none;margin-left:auto}
h2:before{content:"";width:6px;height:6px;background:var(--mg);box-shadow:0 0 10px var(--mg);transform:rotate(45deg)}
.main{grid-template-columns:1.25fr 1fr;margin-bottom:14px}
.bots{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.bot{border:1px solid var(--line);border-radius:12px;padding:12px;background:linear-gradient(160deg,rgba(56,243,255,.06),transparent 60%);position:relative}
.bot .top{display:flex;align-items:center;gap:10px}.bot .ic{font-size:18px;color:var(--cy);text-shadow:var(--glow);width:22px;text-align:center}
.bot .n{font:700 12px Orbitron;letter-spacing:.1em;text-transform:uppercase}.bot .dot{margin-left:auto}
.bot .ln{font:600 12px "JetBrains Mono";margin-top:8px;color:var(--ink)}.bot .dt{font-size:12px;color:var(--mute);margin-top:4px}
.bot.warn{border-color:rgba(255,201,74,.4)}.bot.bad{border-color:rgba(255,77,109,.5)}
.sales .big{display:flex;gap:22px;flex-wrap:wrap;margin-bottom:10px}
.sales .big div b{display:block;font:700 26px "JetBrains Mono";color:var(--ink)}.sales .big div span{font:500 10.5px "JetBrains Mono";letter-spacing:.14em;color:var(--mute);text-transform:uppercase}
.chart{width:100%;height:150px;display:block}
.top5{margin-top:10px;display:grid;gap:6px}
.bar{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;font-size:12.5px}
.bar .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bar .track{grid-column:1/-1;height:4px;background:rgba(56,243,255,.1);border-radius:4px;overflow:hidden}
.bar .fill{height:100%;background:linear-gradient(90deg,var(--cy),var(--mg));box-shadow:var(--glow)}
.bar b{font:600 12px "JetBrains Mono";color:var(--cy)}
.three{grid-template-columns:1.2fr 1fr 1fr;margin-bottom:14px}
.feed{max-height:520px;overflow:auto;padding-right:6px}
.ev{border-left:2px solid var(--line2);padding:4px 0 12px 14px;position:relative}
.ev:before{content:"";position:absolute;left:-5px;top:9px;width:8px;height:8px;border-radius:50%;background:var(--cy);box-shadow:var(--glow)}
.ev.u:before{background:var(--bad);box-shadow:0 0 10px var(--bad)}
.ev .h{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.ev .h b{font:600 13px Inter}.ev time{font:500 11px "JetBrains Mono";color:var(--mute)}
.ev pre{white-space:pre-wrap;margin:6px 0 0;font:12px/1.55 "JetBrains Mono";color:#b9d4e6;max-height:0;overflow:hidden;transition:max-height .3s}
.ev.open pre{max-height:2000px}.ev .h{cursor:pointer}
.ideas pre{white-space:pre-wrap;margin:0;font:12px/1.6 "JetBrains Mono";color:#cfe7f5}
.ideas a,.ev a{color:var(--cy)}
.q{display:flex;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--line);font-size:13px}.q:first-child{border-top:0}
.q b{font:700 13px "JetBrains Mono";color:var(--mg);min-width:34px}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:9px 6px;border-top:1px solid var(--line);vertical-align:middle}
th{font:500 10.5px "JetBrains Mono";letter-spacing:.14em;text-transform:uppercase;color:var(--mute);border-top:0}
td.m{font-family:"JetBrains Mono";white-space:nowrap}.t2{max-width:340px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.range{position:relative;height:6px;width:120px;background:rgba(56,243,255,.12);border-radius:6px}.range i{position:absolute;top:-3px;width:12px;height:12px;border-radius:50%;background:var(--mg);box-shadow:0 0 10px var(--mg);transform:translateX(-50%)}
.ad{font:600 11px "JetBrains Mono";padding:2px 8px;border-radius:999px;border:1px solid var(--line2)}
.empty{color:var(--mute);font-size:13px}
.scroll{overflow-x:auto}
.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(120px);background:rgba(8,14,26,.95);border:1px solid var(--cy);box-shadow:var(--glow);padding:12px 18px;border-radius:12px;font:600 13px "JetBrains Mono";transition:transform .3s;z-index:9;max-width:calc(100% - 32px)}
.toast.on{transform:translateX(-50%) translateY(0)}
.scan{height:2px;background:linear-gradient(90deg,transparent,var(--cy),transparent);position:absolute;left:0;right:0;top:0;animation:scan 3s linear infinite;opacity:.0}.running .scan{opacity:1}
@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{50%{opacity:.35}}@keyframes scan{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
@media (max-width:1100px){.kpis{grid-template-columns:repeat(3,1fr)}.main,.three{grid-template-columns:1fr}}
@media (max-width:560px){.kpis{grid-template-columns:repeat(2,1fr)}.hud{width:100%}.btn{flex:1}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body><div class="wrap" id="app">
<header>
  <div class="brand"><div class="logo">N</div><div><h1>NEXA COMMAND</h1><div class="tag">nexamfgco · autonomous store ops</div></div></div>
  <div class="hud">
    <span class="chip"><span class="dot" id="sysdot"></span><span id="sys">CONNECTING</span></span>
    <span class="chip" id="clock">--:--:--</span>
    <span class="chip">NEXT RUN <span id="next">--</span></span>
    <button class="btn" id="run">▶ Run bots</button>
    <button class="btn mg" id="find">✦ Find products</button>
  </div>
</header>
<div class="grid kpis" id="kpis"></div>
<div class="grid main">
  <section class="panel"><div class="scan"></div><h2>Bot fleet <small id="lastrun"></small></h2><div class="bots" id="bots"></div></section>
  <section class="panel sales"><h2>Sales · 30 days</h2><div class="big" id="big"></div><svg class="chart" id="chart" viewBox="0 0 600 150" preserveAspectRatio="none"></svg><div class="top5" id="top"></div></section>
</div>
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
let D=null,open=new Set();
function toast(m){const t=$("toast");t.textContent=m;t.classList.add("on");clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove("on"),5000)}
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
 const K=[["Revenue 7d",money(s.rev7),"cy"],["Orders 7d",s.orders7,"cy"],["To ship",k.unshipped,k.unshipped?"":"ok"],["Late",k.late,k.late?"bad":"ok"],["Low stock",k.lowStock,k.lowStock?"warn":"ok"],["Live listings",k.listings,""]];
 $("kpis").innerHTML=K.map(([l,v,c])=>'<div class="panel k '+c+'"><div class="v">'+esc(v)+'</div><div class="l">'+esc(l)+'</div></div>').join("");
 $("bots").innerHTML=D.bots.map(b=>'<div class="bot '+b.state+'"><div class="top"><span class="ic">'+esc(b.icon)+'</span><span class="n">'+esc(b.name)+'</span><span class="dot '+b.state+'"></span></div><div class="ln">'+esc(b.line)+'</div><div class="dt">'+esc(b.detail)+'</div></div>').join("");
 $("lastrun").textContent=D.lastRunAt?"last report "+fmtT(D.lastRunAt):"waiting for first scheduled run";
 $("big").innerHTML='<div><b>'+money(s.rev30)+'</b><span>revenue 30d</span></div><div><b>'+s.orders30+'</b><span>orders 30d</span></div><div><b>'+(s.orders30?money(s.rev30/s.orders30):"—")+'</b><span>avg order</span></div>';
 const mx=Math.max(1,...s.days.map(d=>d.rev)),w=600/s.days.length;
 let bars="",pts=[];
 s.days.forEach((d,i)=>{const h=Math.round(d.rev/mx*120);bars+='<rect x="'+(i*w+2)+'" y="'+(140-h)+'" width="'+(w-4)+'" height="'+h+'" rx="2" fill="url(#g)"><title>'+esc(d.d)+": "+money(d.rev)+" · "+d.orders+' orders</title></rect>';pts.push((i*w+w/2)+","+(140-h))});
 $("chart").innerHTML='<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#38f3ff" stop-opacity=".9"/><stop offset="1" stop-color="#ff3fd8" stop-opacity=".15"/></linearGradient></defs><line x1="0" y1="140" x2="600" y2="140" stroke="rgba(56,243,255,.25)"/>'+bars+'<polyline points="'+pts.join(" ")+'" fill="none" stroke="#9ef9ff" stroke-width="1.5" opacity=".7"/>';
 const tmx=Math.max(1,...s.top.map(t=>t.units));
 $("top").innerHTML=s.top.length?s.top.map(t=>'<div class="bar"><span class="t">'+esc(t.title)+'</span><b>'+t.units+'</b><div class="track"><div class="fill" style="width:'+(t.units/tmx*100)+'%"></div></div></div>').join(""):'<p class="empty">No orders in 30 days.</p>';
 $("feed").innerHTML=D.runs.length?D.runs.map((r,i)=>{const id=r.time+r.title;return '<div class="ev'+(r.urgent?" u":"")+(open.has(id)||i===0?" open":"")+'" data-id="'+esc(id)+'"><div class="h"><b>'+esc(r.title)+'</b><time>'+fmtT(r.time)+'</time></div><pre>'+linkify(r.message)+'</pre></div>'}).join(""):'<p class="empty">No reports in the last 12 hours. Bot reports appear here after each run (7am · 1pm · 7pm).</p>';
 document.querySelectorAll(".ev .h").forEach(h=>h.onclick=()=>{const e=h.parentNode;e.classList.toggle("open");e.classList.contains("open")?open.add(e.dataset.id):open.delete(e.dataset.id)});
 if(D.ideas){$("ideatime").textContent=fmtT(D.ideas.time);$("ideas").innerHTML='<pre>'+linkify(D.ideas.message.replace(/^.*?PRODUCT IDEAS[^\n]*\n/s,""))+'</pre>'}
 else{$("ideatime").textContent="";$("ideas").innerHTML='<p class="empty">No scan in the last 12 hours. Hit “Find products” to scan now. Every idea also goes to your Google Sheet.</p>'}
 const qu=D.queue.reduce((a,q)=>a+q.qty,0);$("qcount").textContent=qu?qu+" parts":"";
 $("queue").innerHTML=D.queue.length?D.queue.map(q=>'<div class="q"><b>'+q.qty+'×</b><span>'+esc(q.title)+'</span></div>').join(""):'<p class="empty">Queue clear. Nothing to print.</p>';
 $("price").innerHTML='<tr><th>Listing</th><th>Price</th><th>Range</th><th>Position</th><th>Ad</th><th>Stock</th></tr>'+D.pricing.map(p=>{const lo=p.min??(p.price?p.price*.8:0),hi=p.max??(p.price?p.price*1.2:1);const pos=p.price==null?50:Math.max(0,Math.min(100,(p.price-lo)/((hi-lo)||1)*100));
  return '<tr><td class="t2">'+esc(p.title)+'</td><td class="m">'+money(p.price)+'</td><td class="m">'+(p.min!=null?money(p.min):"floor")+' – '+(p.max!=null?money(p.max):"—")+'</td><td><div class="range"><i style="left:'+pos+'%"></i></div></td><td>'+(p.ad!=null?'<span class="ad">'+p.ad+'%</span>':'<span class="empty">—</span>')+'</td><td class="m">'+(p.qty??"—")+'</td></tr>'}).join("");
 tick();
}
async function load(fresh){try{const r=await fetch("/dashboard/"+S+"/data"+(fresh?"?fresh=1":""),{cache:"no-store"});if(!r.ok)throw new Error(r.status);D=await r.json();if(D.error)throw new Error(D.error);render()}catch(e){$("sys").textContent="LINK LOST · RETRYING";$("sysdot").className="dot bad"}}
async function run(only,btn,label){btn.disabled=true;const old=btn.textContent;btn.textContent=label;document.getElementById("app").classList.add("running");
 try{const r=await fetch("/bots/run/"+S+(only?"?only="+only:""),{method:"POST"});const j=await r.json();
  toast(j.ok?("Done in "+j.seconds+"s · "+j.changes+" changes · "+j.urgent+" alerts"):("Not run: "+(j.error||r.status)))}catch(e){toast("Run failed: "+e.message)}
 btn.disabled=false;btn.textContent=old;load(true)}
$("run").onclick=e=>run("",e.currentTarget,"Running…");
$("find").onclick=e=>run("finder",e.currentTarget,"Scanning eBay…");
load();setInterval(()=>load(false),30000);
</script></body></html>`;
