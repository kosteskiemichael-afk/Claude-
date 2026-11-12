// Nexa eBay connector: a remote MCP server Claude connects to as a custom connector.
// The connector URL contains a long secret so only you (via Claude) can use it.
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash } from "node:crypto";
import { registerTools } from "./tools.js";
import { invalidateDashboard, registerDashboard } from "./dashboard.js";
import { loadConfig } from "./bots/shared.js";
import { DEEP_PLAN, STRATEGY_NAMES } from "./bots/finder.js";
import { push } from "./bots/notify.js";
import { runBots, localHour } from "./bots/run.js";
import { API_BASE, SANDBOX, USER_SCOPES, trading, tradingWarnings } from "./ebay.js";
import { isProtected } from "./bots/shared.js";

const SECRET = process.env.CONNECTOR_SECRET || "";
if (SECRET.length < 32) {
  console.error("CONNECTOR_SECRET must be set to a random string of at least 32 characters.");
  process.exit(1);
}
for (const v of ["EBAY_APP_ID", "EBAY_CERT_ID", "EBAY_RUNAME", "EBAY_REFRESH_TOKEN"]) {
  if (!process.env[v]) console.warn(`Warning: ${v} is not set; eBay calls will fail until it is.`);
}

function buildServer() {
  const server = new McpServer({ name: "nexa-ebay", version: "1.0.0" });
  registerTools(server);
  return server;
}

const app = express();
app.use(express.json({ limit: "20mb" })); // listing-draft photos are sent as base64

app.get("/", (_req, res) => { res.type("text").send("Nexa eBay connector is running."); });

const MCP_PATH = `/mcp/${SECRET}`;

app.post(MCP_PATH, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const notAllowed: express.RequestHandler = (_req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
};
app.get(MCP_PATH, notAllowed);
app.delete(MCP_PATH, notAllowed);

// ---------------- One-time eBay sign-in (no Terminal needed) ----------------
// 1) Open https://<your-app>.onrender.com/auth/<CONNECTOR_SECRET>/start
// 2) Agree on eBay. eBay sends you back to /auth/callback.
// 3) The page shows your refresh token to paste into Render > Environment.
const STATE = createHash("sha256").update(SECRET).digest("hex").slice(0, 24);

app.get(`/auth/${SECRET}/start`, (_req, res) => {
  const ruName = process.env.EBAY_RUNAME;
  const appId = process.env.EBAY_APP_ID;
  if (!ruName || !appId) {
    res.status(400).type("text").send("Set EBAY_APP_ID and EBAY_RUNAME in Render > Environment first.");
    return;
  }
  const u = new URL(SANDBOX ? "https://auth.sandbox.ebay.com/oauth2/authorize" : "https://auth.ebay.com/oauth2/authorize");
  u.searchParams.set("client_id", appId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", ruName);
  u.searchParams.set("scope", USER_SCOPES.join(" "));
  u.searchParams.set("state", STATE);
  res.redirect(u.toString());
});

app.get("/auth/callback", async (req, res) => {
  const code = String(req.query.code || "");
  if (req.query.state !== STATE || !code) {
    res.status(400).type("text").send("Sign-in link invalid or expired. Start again from your /auth/.../start link.");
    return;
  }
  try {
    const basic = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString("base64");
    const r = await fetch(`${API_BASE}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: process.env.EBAY_RUNAME || "" }),
    });
    const j: any = await r.json();
    if (!r.ok) throw new Error(j.error_description || JSON.stringify(j));
    process.env.EBAY_REFRESH_TOKEN = j.refresh_token; // works right away until the next restart
    const days = Math.round(j.refresh_token_expires_in / 86400);
    res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>eBay connected</title>
<body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5">
<h1>✅ eBay connected</h1>
<p>Last step, so it keeps working after Render restarts:</p>
<ol>
<li>Click <b>Copy</b> below.</li>
<li>In Render, open this service &gt; <b>Environment</b>.</li>
<li>Set <b>EBAY_REFRESH_TOKEN</b> to the copied value and click <b>Save Changes</b>.</li>
</ol>
<p><b>Keep this private.</b> Don't paste it into chats or emails. It's valid for about ${days} days.</p>
<textarea id="t" readonly style="width:100%;height:120px">${j.refresh_token}</textarea>
<p><button onclick="navigator.clipboard.writeText(document.getElementById('t').value);this.textContent='Copied'">Copy</button></p>
</body>`);
  } catch (e) {
    res.status(500).type("text").send(`eBay sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
  }
});

// Bot runs: the Render cron job (or the dashboard's Run now button) POSTs here.
let botsRunning = false;
// Deep scan: runs the product finder through every batch of searches, in the background.
const deep = { running: false, done: 0, total: 0, found: 0, checked: 0, started: 0, finished: 0, bot: "" };
registerDashboard(app, SECRET, () => botsRunning, () => deep);

app.post(`/bots/deep/${SECRET}`, async (_req, res) => {
  if (botsRunning) { res.status(409).json({ ok: false, error: "A bot run is already in progress." }); return; }
  Object.assign(deep, { running: true, done: 0, total: DEEP_PLAN.length, found: 0, checked: 0, started: Date.now(), finished: 0, bot: "" });
  botsRunning = true;
  res.json({ ok: true, total: deep.total });
  try {
    for (let k = 0; k < deep.total; k++) {
      try {
        deep.bot = STRATEGY_NAMES[DEEP_PLAN[k]];
        const r = await runBots({ only: ["finder"], silent: true, strategy: DEEP_PLAN[k] });
        const f = (r as any).finder; if (f) { deep.found += f.fresh || 0; deep.checked += f.checked || 0; }
      } catch (e) { console.error("Deep scan batch failed", e); }
      deep.done = k + 1; invalidateDashboard();
    }
    await push("Nexa deep scan done", `All 8 finder bots ran: checked ${deep.checked} new printed listings, ${deep.found} new products added to your dashboard.`, false).catch(() => {});
  } finally { deep.running = false; deep.finished = Date.now(); botsRunning = false; invalidateDashboard(); }
});

// What the last bot run did (price changes with profit per sale, alerts, notes).
const lastRun: { at?: string; r?: any } = {};
app.get(`/bots/last/${SECRET}`, (_req, res) => { res.json({ at: lastRun.at, changes: lastRun.r?.changes || [], urgent: lastRun.r?.urgent || [], info: lastRun.r?.info || [] }); });

// Built-in schedule: runs every bot at run_hours_local (7am / 1pm / 7pm Indianapolis) while the server is awake,
// so pricing reacts to competitors and demand without anyone pressing Run.
let lastSlot = "";
setInterval(async () => {
  try {
    const cfg = loadConfig();
    const h = localHour(cfg.timezone);
    const day = new Date().toLocaleDateString("en-US", { timeZone: cfg.timezone });
    const slot = `${day} ${h}`;
    if (!cfg.run_hours_local.includes(h) || slot === lastSlot || botsRunning || deep.running) return;
    lastSlot = slot; botsRunning = true;
    try { lastRun.r = await runBots(); lastRun.at = new Date().toISOString(); }
    finally { botsRunning = false; invalidateDashboard(); }
  } catch (e) { console.error("Scheduled bot run failed", e); }
}, 5 * 60_000);

app.post(`/bots/run/${SECRET}`, async (req, res) => {
  if (botsRunning) { res.status(409).json({ ok: false, error: "A bot run is already in progress." }); return; }
  botsRunning = true;
  const started = Date.now();
  try {
    const only = String(req.query.only || "").split(",").map((x) => x.trim()).filter(Boolean);
    const strategy = String(req.query.strategy || "") as any;
    const r = lastRun.r = await runBots({ only, force: req.query.force === "1", ...(strategy && STRATEGY_NAMES[strategy as keyof typeof STRATEGY_NAMES] ? { strategy } : {}) });
    lastRun.at = new Date().toISOString();
    res.json({ ok: true, seconds: Math.round((Date.now() - started) / 1000), changes: r.changes.length, urgent: r.urgent.length, finder: (r as any).finder || null });
  } catch (e) {
    console.error("Bot run failed", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  } finally { botsRunning = false; invalidateDashboard(); }
});

// Title changes Claude makes for you (burr holders refused). Body: {changes:[{item_id,title}]}
// Burr holder V2 relaunch (Michael approved on Nov 12): new title + a note put at the top of the description.
// Only these listings, only when Michael asks; the bots stay locked out of them.
const BURR_V2_ALLOWED = new Set(["206531844850", "206612334348", "206453290362", "206595114694", "206612358806"]);
app.post(`/listing/burr-v2/${SECRET}`, async (req, res) => {
  const { trading } = await import("./ebay.js");
  const out: any[] = [];
  for (const m of (req.body?.items || []).slice(0, 5)) {
    const id = String(m.item_id);
    if (!BURR_V2_ALLOWED.has(id)) { out.push({ id, ok: false, error: "not a burr holder listing" }); continue; }
    try {
      const Item: any = { ItemID: id };
      if (m.title) Item.Title = String(m.title).slice(0, 80);
      if (m.prepend_html) Item.Description = String(m.prepend_html);
      await trading("ReviseFixedPriceItem", { Item, ...(m.prepend_html ? { DescriptionReviseMode: "Prepend" } : {}) });
      out.push({ id, ok: true });
    } catch (e) { out.push({ id, ok: false, error: (e as Error).message.slice(0, 300) }); }
  }
  res.json({ ok: out.every((x) => x.ok), results: out });
});

app.post(`/listing/titles/${SECRET}`, async (req, res) => {
  const out: any[] = [];
  for (const c of (req.body?.changes || []) as { item_id: string; title: string }[]) {
    const id = String(c.item_id || ""), title = String(c.title || "").trim();
    if (!id || !title || title.length > 80) { out.push({ id, ok: false, error: "bad id or title (max 80 chars)" }); continue; }
    try {
      const cur = await trading("GetItem", { ItemID: id });
      const it = Array.isArray(cur.Item) ? cur.Item[0] : cur.Item;
      const old = String(it?.Title?.["#text"] ?? it?.Title ?? "");
      if (isProtected(id, old) || isProtected(id, title)) { out.push({ id, ok: false, error: "protected listing" }); continue; }
      const r = await trading("ReviseFixedPriceItem", { Item: { ItemID: id, Title: title } });
      out.push({ id, ok: true, from: old, to: title, warnings: tradingWarnings(r) });
    } catch (e) { out.push({ id, ok: false, error: (e as Error).message.slice(0, 200) }); }
  }
  invalidateDashboard();
  res.json({ ok: true, results: out });
});

// Split finder: which options of multi-option listings deserve their own listing. Read-only.
let splitJob: { running: boolean; started?: string; finished?: string; log: string[]; rows?: any[]; error?: string } = { running: false, log: [] };
app.post(`/report/splits/${SECRET}`, async (_req, res) => {
  if (splitJob.running) return res.json({ ok: true, already_running: true });
  splitJob = { running: true, started: new Date().toISOString(), log: [] };
  res.json({ ok: true, started: true });
  try {
    const { findSplits } = await import("./bots/splits.js");
    const { trafficMap } = await import("./bots/run.js");
    const traffic = await trafficMap().catch(() => undefined);
    splitJob.rows = await findSplits(traffic, (s) => splitJob.log.push(s));
  } catch (e) { splitJob.error = (e as Error).message; }
  splitJob.running = false; splitJob.finished = new Date().toISOString();
});
app.get(`/report/splits/${SECRET}`, (_req, res) => { res.json(splitJob); });

// Price report for every listing (read-only).
let priceJob: { running: boolean; started?: string; finished?: string; log: string[]; rows?: any[]; error?: string } = { running: false, log: [] };
app.post(`/report/prices/${SECRET}`, async (_req, res) => {
  if (priceJob.running) return res.json({ ok: true, already_running: true });
  priceJob = { running: true, started: new Date().toISOString(), log: [] };
  res.json({ ok: true, started: true });
  try { const { priceReport } = await import("./bots/pricereport.js"); priceJob.rows = await priceReport((s) => priceJob.log.push(s)); }
  catch (e) { priceJob.error = (e as Error).message; }
  priceJob.running = false; priceJob.finished = new Date().toISOString();
});
app.get(`/report/prices/${SECRET}`, (_req, res) => { res.json(priceJob); });

// Split an option of a multi-option listing into its own listing (asked for by you). Body: {items:[SplitReq]}
app.post(`/listing/split/${SECRET}`, async (req, res) => {
  const { splitOption } = await import("./split.js");
  const out: any[] = [];
  for (const q of (req.body?.items || [])) {
    try { out.push({ option: q.option, ...(await splitOption(q)) }); }
    catch (e) { out.push({ option: q.option, ok: false, error: (e as Error).message.slice(0, 400) }); }
  }
  invalidateDashboard();
  res.json({ ok: true, results: out });
});

// Raise low options on multi-option listings. Body: {items:[{item_id, min}]}
app.post(`/pricing/options/${SECRET}`, async (req, res) => {
  const { raiseOptions } = await import("./split.js");
  const out: any[] = [];
  for (const q of (req.body?.items || [])) {
    try { out.push({ item_id: q.item_id, ...(await raiseOptions(String(q.item_id), Number(q.min))) }); }
    catch (e) { out.push({ item_id: q.item_id, ok: false, error: (e as Error).message.slice(0, 300) }); }
  }
  invalidateDashboard();
  res.json({ ok: true, results: out });
});

// Large-envelope free shipping for small flat parts (asked for). Body: {items:[{item_id, price?}]}
app.post(`/shipping/envelope/${SECRET}`, async (req, res) => {
  try { const { toEnvelope } = await import("./envelope.js"); res.json(await toEnvelope(req.body?.items || [])); invalidateDashboard(); }
  catch (e) { res.status(500).json({ ok: false, error: (e as Error).message.slice(0, 500) }); }
});

// Listing drafts ("Add these next" gears written as full listings; Michael adds photos and submits).
app.get(`/drafts/${SECRET}/data`, async (_req, res) => {
  try { const { listDrafts } = await import("./drafts.js"); res.set("Cache-Control", "no-store").json({ ok: true, drafts: await listDrafts() }); }
  catch (e) { res.status(500).json({ ok: false, error: (e as Error).message.slice(0, 400) }); }
});
app.post(`/drafts/${SECRET}/photo`, async (req, res) => {
  try { const { uploadPhoto } = await import("./drafts.js"); res.json({ ok: true, url: await uploadPhoto(String(req.body?.data || ""), String(req.body?.name || "photo.jpg")) }); }
  catch (e) { res.status(500).json({ ok: false, error: (e as Error).message.slice(0, 400) }); }
});
app.post(`/drafts/${SECRET}/submit`, async (req, res) => {
  try { const { submitDraft } = await import("./drafts.js"); const r = await submitDraft(req.body || {}); if (!req.body?.verify_only) invalidateDashboard(); res.json(r); }
  catch (e) { res.status(500).json({ ok: false, error: (e as Error).message.slice(0, 600) }); }
});

// Message buyers through eBay messages (order partners): {items:[{item_id, buyer, subject, body}]}.
app.post(`/buyers/message/${SECRET}`, async (req, res) => {
  const { trading } = await import("./ebay.js");
  const out: any[] = [];
  for (const m of (req.body?.items || []).slice(0, 20)) {
    try {
      await trading("AddMemberMessageAAQToPartner", { ItemID: String(m.item_id), MemberMessage: {
        Subject: String(m.subject).slice(0, 100), Body: String(m.body).slice(0, 2000),
        QuestionType: "General", RecipientID: String(m.buyer) } });
      out.push({ buyer: m.buyer, ok: true });
    } catch (e) { out.push({ buyer: m.buyer, ok: false, error: (e as Error).message.slice(0, 300) }); }
  }
  res.json({ ok: out.every((x) => x.ok), results: out });
});

// Listings board: every listing with price, shipping, status, ads, traffic, profit and competition.
app.get(`/listings/${SECRET}/data`, async (req, res) => {
  try { const { listingRows } = await import("./listingspage.js"); res.json(await listingRows(req.query.fresh === "1")); }
  catch (e) { res.status(500).json({ error: (e as Error).message }); }
});
app.get(`/listings/${SECRET}`, async (_req, res) => {
  const { listingsPage } = await import("./listingspage.js");
  res.set("Cache-Control", "no-store").type("html").send(listingsPage(SECRET));
});

// Competition watch + listing doctor (read-only). POST starts a run, GET returns JSON, /compete/:secret is the page.
app.post(`/report/compete/${SECRET}`, async (_req, res) => {
  const { competeJob, runCompete } = await import("./bots/compete.js");
  if (competeJob.running) return res.json({ ok: true, already_running: true });
  res.json({ ok: true, started: true });
  const { trafficMap } = await import("./bots/run.js");
  runCompete(await trafficMap().catch(() => undefined)).catch(() => {});
});
app.get(`/report/compete/${SECRET}`, async (_req, res) => {
  const { competeJob, summary } = await import("./bots/compete.js");
  res.json({ ...competeJob, summary: competeJob.rows ? summary(competeJob.rows) : null });
});
app.get(`/photos/${SECRET}`, async (_req, res) => {
  const { photoPage } = await import("./photopage.js");
  res.type("html").send(photoPage(SECRET));
});
app.get(`/compete/${SECRET}`, async (_req, res) => {
  const { competePage } = await import("./competepage.js");
  res.type("html").send(competePage(SECRET));
});

// Match the cheapest seller of the same part right now, never below the profit floor. Body: {items:[item_id]}
app.post(`/pricing/match/${SECRET}`, async (req, res) => {
  try {
    const { loadConfig, activeListings, setPriceQty } = await import("./bots/shared.js");
    const { decidePrice } = await import("./bots/pricing.js");
    const { shipInfo, adRates, profitAt } = await import("./bots/profit.js");
    const { keywordCompetitors } = await import("./bots/pricereport.js");
    const cfg = loadConfig();
    const fast = { ...cfg, pricing: { ...cfg.pricing, max_step_pct: 1 } } as typeof cfg; // full move now, floors still apply
    const want = new Set(((req.body?.items || []) as string[]).map(String));
    const ls = (await activeListings()).filter((l) => want.has(l.item_id));
    const ships = await shipInfo(cfg, ls); const ads = await adRates().catch(() => new Map<string, number>());
    const out: any[] = []; const changes: { item_id: string; title: string; price: number }[] = [];
    for (const l of ls) {
      if (l.protected || l.has_variations || l.on_sale) { out.push({ id: l.item_id, skipped: l.protected ? "protected" : l.on_sale ? "in sale event" : "has options" }); continue; }
      const sh = ships.get(l.item_id)!; const ad = ads.get(l.item_id) ?? 0;
      const comps = await keywordCompetitors(cfg, l.title).catch(() => []);
      const d = decidePrice(fast, { query: "", max: l.price }, l, comps, sh, ad);
      const before = profitAt(cfg, l.item_id, l.price, sh, ad);
      if (!d || d.price >= l.price) { out.push({ id: l.item_id, title: l.title.slice(0, 50), held: true, price: l.price, cheapest: comps[0]?.total ?? null, profit: +before.profit.toFixed(2) }); continue; }
      const after = profitAt(cfg, l.item_id, d.price, sh, ad);
      changes.push({ item_id: l.item_id, title: l.title, price: d.price });
      out.push({ id: l.item_id, title: l.title.slice(0, 50), from: l.price, to: d.price, ship: sh.buyer, delivered: +(d.price + sh.buyer).toFixed(2), cheapest: comps[0]?.total ?? null, profit_before: +before.profit.toFixed(2), profit_after: +after.profit.toFixed(2), margin_after: Math.round(after.margin * 100), floor_hit: d.price <= after.floor + 0.01 });
    }
    const warn = changes.length ? await setPriceQty(cfg, changes) : [];
    invalidateDashboard();
    res.json({ ok: true, changed: changes.length, results: out, warnings: warn });
  } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

// Set exact prices Claude was asked to set (burr holders refused). Body: {changes:[{item_id, price}]}
app.post(`/pricing/set/${SECRET}`, async (req, res) => {
  try {
    const { loadConfig, activeListings, setPriceQty } = await import("./bots/shared.js");
    const cfg = loadConfig(); const ls = await activeListings();
    const changes: { item_id: string; title: string; price: number }[] = []; const out: any[] = [];
    for (const c of (req.body?.changes || []) as { item_id: string; price: number }[]) {
      const l = ls.find((x) => x.item_id === String(c.item_id));
      if (!l) { out.push({ id: c.item_id, ok: false, error: "not active" }); continue; }
      if (l.protected) { out.push({ id: c.item_id, ok: false, error: "protected listing" }); continue; }
      if (!(c.price > 0)) { out.push({ id: c.item_id, ok: false, error: "bad price" }); continue; }
      changes.push({ item_id: l.item_id, title: l.title, price: Math.round(c.price * 100) / 100 });
      out.push({ id: l.item_id, ok: true, from: l.price, to: c.price });
    }
    const warn = changes.length ? await setPriceQty(cfg, changes) : [];
    invalidateDashboard();
    res.json({ ok: true, results: out, warnings: warn });
  } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

// Anything else (wrong secret) looks like it doesn't exist.
app.use((_req, res) => { res.status(404).send("Not found"); });

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Nexa eBay connector listening on port ${port}`));
