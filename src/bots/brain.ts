// The "business brain": Claude reads your store data and makes the judgment
// calls plain code can't (is this competitor really the same part? same pack
// size? what should I do today?). The bots still enforce every hard limit:
// profit floor, max move per run, burr holder lock. The brain only advises.
//
// Needs ANTHROPIC_API_KEY on Render. Without it, the bots run without the brain.
const API = "https://api.anthropic.com/v1/messages";
export const FAST_MODEL = process.env.BRAIN_FAST_MODEL || "claude-haiku-5-5";
export const SMART_MODEL = process.env.BRAIN_SMART_MODEL || "claude-sonnet-5-5";

export const brainOn = () => !!process.env.ANTHROPIC_API_KEY && process.env.BRAIN !== "off";

let spentIn = 0, spentOut = 0;
export function brainUsage() { return { input_tokens: spentIn, output_tokens: spentOut }; }

export async function ask(model: string, system: string, user: string, maxTokens = 2000): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(API, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    });
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); continue; }
    const j: any = await r.json();
    if (!r.ok) throw new Error(`Claude API ${r.status}: ${j?.error?.message || JSON.stringify(j).slice(0, 200)}`);
    spentIn += j.usage?.input_tokens || 0;
    spentOut += j.usage?.output_tokens || 0;
    return (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  }
  throw new Error("Claude API busy after 3 tries");
}

/** Ask for JSON and parse it, tolerating ```json fences or stray text. */
export async function askJson<T>(model: string, system: string, user: string, maxTokens = 4000): Promise<T> {
  const text = await ask(model, system + "\nRespond with ONLY valid JSON, no commentary.", user, maxTokens);
  const start = text.search(/[\[{]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start < 0 || end < start) throw new Error("Brain returned no JSON");
  return JSON.parse(text.slice(start, end + 1)) as T;
}

// ---------------- 1) search plans for every listing ----------------
export type SearchPlan = { item_id: string; query: string; pack_qty: number; must_include: string[]; skip?: boolean };

export async function planSearches(listings: { item_id: string; title: string }[]): Promise<SearchPlan[]> {
  const out: SearchPlan[] = [];
  for (let i = 0; i < listings.length; i += 60) {
    const chunk = listings.slice(i, i + 60);
    const res = await askJson<{ plans: SearchPlan[] }>(
      FAST_MODEL,
      "You help a seller of 3D-printed replacement parts find their true competitors on eBay. " +
        "For each listing write: query (3-6 word eBay search a buyer would type for this exact part), " +
        "pack_qty (how many pieces the listing includes; 1 if not stated), must_include (2-3 lowercase words " +
        "every true competitor title must contain, e.g. brand and part), skip (true if the item is too generic or custom to price-match).",
      JSON.stringify({ listings: chunk }) + '\nReturn {"plans":[{"item_id","query","pack_qty","must_include","skip"}]}',
      6000,
    );
    out.push(...(res.plans || []).filter((p) => chunk.some((c) => c.item_id === p.item_id)));
  }
  return out;
}

// ---------------- 2) competitor matching ----------------
export type MatchInput = {
  item_id: string; title: string; pack_qty: number;
  candidates: { i: number; title: string; total: number }[];
};
export type MatchResult = { item_id: string; matches: { i: number; their_pack_qty: number }[] };

export async function matchCompetitors(inputs: MatchInput[]): Promise<Map<string, MatchResult>> {
  const out = new Map<string, MatchResult>();
  for (let i = 0; i < inputs.length; i += 12) {
    const chunk = inputs.slice(i, i + 12);
    const res = await askJson<{ results: MatchResult[] }>(
      FAST_MODEL,
      "You compare eBay listings for replacement parts. For each of my listings, pick ONLY the candidate listings " +
        "that are the same part for the same machine/model (a buyer could use either one interchangeably). " +
        "Reject different parts, different models, accessories, full assemblies, bundles with extra parts, and genuine/OEM " +
        "listings priced like OEM. For each match, give their_pack_qty (pieces included). Be strict: when unsure, leave it out.",
      JSON.stringify({ my_listings: chunk }) + '\nReturn {"results":[{"item_id","matches":[{"i","their_pack_qty"}]}]}',
      4000,
    );
    for (const r of res.results || []) out.set(String(r.item_id), r);
  }
  return out;
}

// ---------------- 3) reply drafts for buyer messages ----------------
export async function draftReply(msg: { from: string; subject: string; body: string; item_title?: string }): Promise<string> {
  return (await ask(
    SMART_MODEL,
    "You are the customer service voice of Nexa Manufacturing Co, a small eBay shop selling 3D-printed replacement parts " +
      "(printed in PETG on a Creality K2 Plus, ships fast from Indiana). Write a short, friendly, professional reply " +
      "(under 70 words) the owner can paste into eBay. Never promise refunds, discounts or dates you can't know; if fit is " +
      "asked, ask for the model number. Sign off as 'Nexa Manufacturing Co'. Output only the reply text.",
    JSON.stringify(msg),
    400,
  )).trim();
}

// ---------------- 4) daily business brief ----------------
export async function dailyBrief(snapshot: unknown): Promise<string> {
  return (await ask(
    SMART_MODEL,
    "You are the business brain for Nexa Manufacturing Co, an eBay store of 3D-printed replacement parts. Goal: $15-20k/month " +
      "revenue at 40-60% profit after fees (~15%), ads (2%), labels (~$1.69 envelope / ~$5.05 box) and filament. The Baratza burr " +
      "holders are the top sellers and must never be changed. From today's data, give the owner the 3-5 highest-profit actions for " +
      "today, most valuable first. Be specific (item names, prices, numbers). Plain text, one line per action starting with '•', " +
      "under 650 characters total. No intro.",
    JSON.stringify(snapshot),
    700,
  )).trim();
}
