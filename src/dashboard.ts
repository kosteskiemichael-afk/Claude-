// Private live dashboard: https://<service>.onrender.com/dashboard/<CONNECTOR_SECRET>
// Shows every bot run (from the ntfy alert feed) plus live store numbers from eBay.
// Refreshes itself every 60 seconds. Read-only: it never changes anything.
import type { Express } from "express";
import { rest } from "./ebay.js";
import { activeListings, loadConfig, recentOrders } from "./bots/shared.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

async function botRuns(): Promise<{ time: number; title: string; message: string; urgent: boolean }[]> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return [];
  const server = process.env.NTFY_SERVER || "https://ntfy.sh";
  const r = await fetch(`${server}/${encodeURIComponent(topic)}/json?poll=1&since=all`);
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

export function registerDashboard(app: Express, secret: string) {
  app.get(`/dashboard/${secret}`, async (_req, res) => {
    const cfg = loadConfig();
    const [runs, listings, unshipped, ads] = await Promise.all([
      botRuns().catch(() => []),
      activeListings().catch(() => []),
      recentOrders(30, true).catch(() => []),
      adRates().catch(() => new Map<string, number>()),
    ]);
    const tz = "America/Indianapolis";
    const fmt = (t: number) => new Date(t).toLocaleString("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" });
    const above = [...ads.entries()].filter(([id, r]) => r > cfg.marketing.target_ad_rate + 0.001 && !listings.find((l) => l.item_id === id)?.protected);
    const lowStock = listings.filter((l) => l.quantity_available < cfg.inventory.restock_below);
    const late = unshipped.filter((o) => o.ship_by && Date.parse(o.ship_by) < Date.now());
    const byId = new Map(listings.map((l) => [l.item_id, l]));
    const ruleRows = Object.entries(cfg.pricing.rules).map(([id, rule]) => {
      const l = byId.get(id);
      return `<tr><td>${esc(l ? l.title.slice(0, 48) : id)}</td><td>${l ? "$" + l.price.toFixed(2) : "—"}</td><td>$${rule.min ?? "–"} – $${rule.max ?? "–"}</td><td>${ads.has(id) ? ads.get(id) + "%" : "—"}</td></tr>`;
    }).join("");
    const queue = new Map<string, number>();
    unshipped.forEach((o) => o.items.forEach((i) => queue.set(i.title, (queue.get(i.title) || 0) + i.quantity)));
    const nextRun = (() => {
      const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(new Date()));
      const n = cfg.run_hours_local.find((x) => x > h) ?? cfg.run_hours_local[0];
      return `${n % 12 || 12}${n < 12 ? "am" : "pm"}`;
    })();

    res.set("Cache-Control", "no-store").type("html").send(`<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60"><title>Nexa Bots Live</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1f;--mute:#6b6b70;--line:#e4e2dc;--ok:#1f7a4d;--bad:#b3261e;--accent:#2b5fd9}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1d1d20;--ink:#ececee;--mute:#9a9aa2;--line:#2c2c31;--ok:#4cc38a;--bad:#ff6b5e;--accent:#7aa2ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1000px;margin:0 auto;padding:20px 16px 48px}h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mute);font-size:13px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px}
.k{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.k b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.k span{color:var(--mute);font-size:12px}
.bad b{color:var(--bad)}.ok b{color:var(--ok)}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:14px}h2{font-size:15px;margin:0 0 10px}
.run{border-top:1px solid var(--line);padding:10px 0}.run:first-of-type{border-top:0}.run h3{font-size:14px;margin:0 0 4px;display:flex;gap:8px;flex-wrap:wrap}
.run time{color:var(--mute);font-weight:400}.run.u h3{color:var(--bad)}pre{white-space:pre-wrap;margin:0;font:13px/1.45 ui-monospace,Menlo,monospace;color:var(--ink)}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px 4px;border-top:1px solid var(--line)}th{color:var(--mute);font-weight:500;border-top:0}
.scroll{overflow-x:auto}.empty{color:var(--mute)}
</style></head><body><main>
<h1>Nexa bots · live</h1>
<div class="sub">Updated ${fmt(Date.now())} · refreshes every minute · next bot run ${nextRun}${cfg.dry_run ? " · TEST MODE (no changes)" : ""}</div>
<div class="grid">
<div class="k"><b>${listings.length}</b><span>active listings</span></div>
<div class="k ${unshipped.length ? "" : "ok"}"><b>${unshipped.length}</b><span>orders to ship</span></div>
<div class="k ${late.length ? "bad" : "ok"}"><b>${late.length}</b><span>late shipments</span></div>
<div class="k ${lowStock.length ? "bad" : "ok"}"><b>${lowStock.length}</b><span>low stock</span></div>
<div class="k ${above.length ? "bad" : "ok"}"><b>${above.length}</b><span>ads above ${cfg.marketing.target_ad_rate}%</span></div>
<div class="k"><b>${Object.keys(cfg.pricing.rules).length}${process.env.ANTHROPIC_API_KEY ? "+🧠" : ""}</b><span>items auto-priced</span></div>
</div>
<section><h2>Bot activity</h2>${runs.length ? runs.slice(0, 15).map((r) => `<div class="run${r.urgent ? " u" : ""}"><h3>${esc(r.title)} <time>${fmt(r.time)}</time></h3><pre>${esc(r.message)}</pre></div>`).join("") : `<p class="empty">No bot runs yet. They'll show up here after the first run (7am, 1pm, 7pm).</p>`}</section>
<section><h2>Print queue</h2>${queue.size ? `<table>${[...queue.entries()].map(([t, q]) => `<tr><td>${q}×</td><td>${esc(t)}</td></tr>`).join("")}</table>` : `<p class="empty">Nothing to print.</p>`}</section>
<section><h2>Auto-priced items</h2><div class="scroll"><table><tr><th>Listing</th><th>Price now</th><th>Allowed range</th><th>Ad rate</th></tr>${ruleRows}</table></div></section>
</main></body></html>`);
  });
}
