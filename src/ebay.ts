// eBay API client: OAuth token handling, Trading API (XML) and REST calls.
import { XMLBuilder, XMLParser } from "fast-xml-parser";

export const SANDBOX = process.env.EBAY_ENV === "sandbox";
export const API_BASE = SANDBOX ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
export const MARKETPLACE = process.env.EBAY_MARKETPLACE || "EBAY_US";

// Scopes requested when refreshing the user token. Must be a subset of the
// scopes you consented to when creating the refresh token.
export const USER_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.marketing",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
];

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

type Cached = { token: string; expiresAt: number } | null;
let userCache: Cached = null;
let appCache: Cached = null;

async function mintToken(body: URLSearchParams): Promise<{ token: string; expiresAt: number }> {
  const basic = Buffer.from(`${env("EBAY_APP_ID")}:${env("EBAY_CERT_ID")}`).toString("base64");
  const r = await fetch(`${API_BASE}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`eBay token error ${r.status}: ${j.error_description || JSON.stringify(j)}`);
  return { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
}

/** Seller (user) access token, refreshed from the long-lived refresh token. */
export async function userToken(): Promise<string> {
  if (userCache && Date.now() < userCache.expiresAt - 60_000) return userCache.token;
  userCache = await mintToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env("EBAY_REFRESH_TOKEN"),
      scope: USER_SCOPES.join(" "),
    }),
  );
  return userCache.token;
}

/** Application token (client credentials) for public Browse API searches. */
export async function appToken(): Promise<string> {
  if (appCache && Date.now() < appCache.expiresAt - 60_000) return appCache.token;
  appCache = await mintToken(
    new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }),
  );
  return appCache.token;
}

// ---------------- Trading API (works with listings made in Seller Hub) ----------------
const ARRAY_TAGS = new Set([
  "Item", "Variation", "NameValueList", "Value", "Errors", "ShippingServiceOptions",
  "PictureURL", "InventoryStatus", "Order", "Transaction",
]);
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ARRAY_TAGS.has(name),
  parseTagValue: false,
});
const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "@_", suppressEmptyNode: true });

export async function trading(call: string, inner: Record<string, unknown>): Promise<any> {
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<${call}Request xmlns="urn:ebay:apis:eBLBaseComponents">` +
    builder.build(inner) +
    `<ErrorLanguage>en_US</ErrorLanguage><WarningLevel>High</WarningLevel>` +
    `</${call}Request>`;
  const r = await fetch(`${API_BASE}/ws/api.dll`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-CALL-NAME": call,
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1271",
      "X-EBAY-API-IAF-TOKEN": await userToken(),
    },
    body: xml,
  });
  const text = await r.text();
  const parsed = parser.parse(text);
  const resp = parsed[`${call}Response`];
  if (!resp) throw new Error(`Unexpected Trading API response (${r.status}): ${text.slice(0, 300)}`);
  if (resp.Ack === "Failure") {
    const errs = (resp.Errors || []).map((e: any) => e.LongMessage || e.ShortMessage).join(" | ");
    throw new Error(`eBay ${call} failed: ${errs}`);
  }
  return resp;
}

/** Warnings returned on a successful Trading call (e.g. ReviseItem notices). */
export function tradingWarnings(resp: any): string[] {
  return (resp?.Errors || [])
    .filter((e: any) => e.SeverityCode === "Warning")
    .map((e: any) => e.LongMessage || e.ShortMessage);
}

// ---------------- REST APIs ----------------
export async function rest(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { query?: Record<string, string>; body?: unknown; app?: boolean; timeoutMs?: number } = {},
): Promise<any> {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(opts.query || {})) url.searchParams.set(k, v);
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${opts.app ? await appToken() : await userToken()}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60000),
  });
  if (r.status === 204) return {};
  const text = await r.text();
  let j: any;
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!r.ok) {
    const msg = (j.errors || []).map((e: any) => e.longMessage || e.message).join(" | ") || text.slice(0, 300);
    throw new Error(`eBay ${method} ${path} failed (${r.status}): ${msg}`);
  }
  return j;
}
