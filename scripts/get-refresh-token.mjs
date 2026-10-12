// One-time helper: run on YOUR computer to get the eBay refresh token.
// Your keys stay on your machine. Nothing is sent anywhere except eBay.
//
//   EBAY_APP_ID=... EBAY_CERT_ID=... EBAY_RUNAME=... node scripts/get-refresh-token.mjs
//
import readline from "node:readline/promises";

const { EBAY_APP_ID, EBAY_CERT_ID, EBAY_RUNAME } = process.env;
if (!EBAY_APP_ID || !EBAY_CERT_ID || !EBAY_RUNAME) {
  console.error("Set EBAY_APP_ID, EBAY_CERT_ID and EBAY_RUNAME first (see README step 2).");
  process.exit(1);
}

const SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.marketing",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
].join(" ");

const consent = new URL("https://auth.ebay.com/oauth2/authorize");
consent.searchParams.set("client_id", EBAY_APP_ID);
consent.searchParams.set("response_type", "code");
consent.searchParams.set("redirect_uri", EBAY_RUNAME);
consent.searchParams.set("scope", SCOPES);

console.log("\n1) Open this link, sign in to your eBay SELLER account, and click Agree:\n");
console.log(consent.toString());
console.log("\n2) After you agree, copy the full address from your browser's address bar.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pasted = (await rl.question("Paste that address here and press Enter: ")).trim();
rl.close();

let code;
try { code = new URL(pasted).searchParams.get("code"); } catch { code = pasted; }
if (!code) { console.error("Couldn't find a code in that address."); process.exit(1); }

const basic = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT_ID}`).toString("base64");
const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: EBAY_RUNAME }),
});
const j = await r.json();
if (!r.ok) { console.error("eBay refused:", j); process.exit(1); }

const days = Math.round(j.refresh_token_expires_in / 86400);
console.log("\nSuccess. Put this value in Render as EBAY_REFRESH_TOKEN (keep it private):\n");
console.log(j.refresh_token);
console.log(`\nIt stays valid for about ${days} days. Re-run this script before then.\n`);
