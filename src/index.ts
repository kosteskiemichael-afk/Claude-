// Nexa eBay connector: a remote MCP server Claude connects to as a custom connector.
// The connector URL contains a long secret so only you (via Claude) can use it.
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash } from "node:crypto";
import { registerTools } from "./tools.js";
import { invalidateDashboard, registerDashboard } from "./dashboard.js";
import { runBots } from "./bots/run.js";
import { API_BASE, SANDBOX, USER_SCOPES } from "./ebay.js";

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
app.use(express.json({ limit: "1mb" }));

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
registerDashboard(app, SECRET, () => botsRunning);

app.post(`/bots/run/${SECRET}`, async (req, res) => {
  if (botsRunning) { res.status(409).json({ ok: false, error: "A bot run is already in progress." }); return; }
  botsRunning = true;
  const started = Date.now();
  try {
    const only = String(req.query.only || "").split(",").map((x) => x.trim()).filter(Boolean);
    const r = await runBots({ only });
    res.json({ ok: true, seconds: Math.round((Date.now() - started) / 1000), changes: r.changes.length, urgent: r.urgent.length, finder: (r as any).finder || null });
  } catch (e) {
    console.error("Bot run failed", e);
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  } finally { botsRunning = false; invalidateDashboard(); }
});

// Anything else (wrong secret) looks like it doesn't exist.
app.use((_req, res) => { res.status(404).send("Not found"); });

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Nexa eBay connector listening on port ${port}`));
