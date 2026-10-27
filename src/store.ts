// Permanent product store: the Apps Script web app in SHEETS_WEBHOOK_URL (Google Sheet behind the scenes).
// Saves every product the finder finds and your "Added it" / "Not interested" choices.
export async function storeCall(body: unknown): Promise<any> {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url) throw new Error("SHEETS_WEBHOOK_URL not set");
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: "follow" });
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new Error(`store replied ${r.status}: ${t.slice(0, 80)}`); }
}

/** eBay links of every product already stored (seen before, added or dismissed). */
export async function storedLinks(): Promise<Set<string>> {
  const j = await storeCall({ action: "list" });
  return new Set<string>((j.rows || []).map((x: any) => String(x.ebay_url)));
}
