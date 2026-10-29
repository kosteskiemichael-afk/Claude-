// Product finder bots. Four strategies, all ending in the same check: a 3D-printed eBay listing
// with real sales (min_sold+), not something you already sell or already saw, plus a CAD file
// you're allowed to sell prints of (CC0 / CC BY / CC BY-SA / GPL...; never NC).
//   keywords     searches "3d printed <part type>" across a pool of 128 searches
//   competitors  mines the whole catalog of proven 3D-print sellers
//   categories   sweeps eBay's categories that hold the most 3D-printed parts
//   cadfirst     starts from sellable CAD files on Printables, then checks eBay demand for them
//   gears        gears, brackets, mounts, hinges, latches, bushings, pulleys
//   autoboat     car / truck / boat / marine / powersports / tractor parts, by make
//   premium      parts for expensive equipment (espresso machines, Vitamix, Dyson, Sub-Zero, Festool, Bose...)
//   makeit       gears / pulleys / spacers whose listing states the specs, so Claude can model them (unique products)
// Toys, collectibles, decor, firearm parts and printer accessories are filtered out everywhere.
import { rest } from "../ebay.js";
import { askJson, brainOn, FAST_MODEL } from "./brain.js";
import { storeCall, storedLinks } from "../store.js";
import { BotConfig, Listing, Report, money, short } from "./shared.js";

type Hit = { id: string; legacy: string; title: string; seller: string; price: number; sold?: number; text?: string };
type Cad = { url: string; name: string; license: string };

const STOP = new Set("new replacement part parts for the and with 3d printed printing print heavy duty pack of set fits fit compatible kit black white plastic gear free shipping usa made".split(" "));
const tokens = (t: string) =>
  [...new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)))];
const overlap = (a: string[], b: string[]) => { const s = new Set(b); return a.filter((w) => s.has(w)).length; };

// Licenses that allow selling prints. Anything NonCommercial (NC) is rejected.
const okLicense = (l: string) => !/NC/i.test(l) && /^(CC0|CC-BY|CC-BY-SA|CC-BY-ND|GPL|LGPL|AGPL|BSD|MIT)(\b|[- .\d]|$)/i.test(l.trim());

/** Split the search pool into even batches; batch k takes every k-th search, so each batch mixes categories. */
function batchOf(cfg: BotConfig, k: number): string[] {
  const all = cfg.finder.queries;
  const batches = Math.max(1, Math.ceil(all.length / Math.min(all.length, cfg.finder.queries_per_run || all.length)));
  return all.filter((_, i) => i % batches === ((k % batches) + batches) % batches);
}
const batchCount = (cfg: BotConfig) => Math.max(1, Math.ceil(cfg.finder.queries.length / Math.min(cfg.finder.queries.length, cfg.finder.queries_per_run || cfg.finder.queries.length)));

/** Today's batch (scheduled morning run). */
export function todaysQueries(cfg: BotConfig, day = Math.floor(Date.now() / 86400_000)): string[] {
  return batchOf(cfg, day);
}

// Each Find-products click moves on to the next batch, so every click looks somewhere new.
let clickBatch: number | null = null;
export function finderBatchCount(cfg: BotConfig) { return batchCount(cfg); }
export function nextQueries(cfg: BotConfig, manual: boolean): string[] {
  const day = Math.floor(Date.now() / 86400_000);
  if (!manual) return todaysQueries(cfg, day);
  clickBatch = ((clickBatch ?? (day + Math.floor(Math.random() * batchCount(cfg)))) + 1) % batchCount(cfg);
  return batchOf(cfg, clickBatch);
}

// Ideas found since the service started, newest first. The dashboard shows these on the product board.
export type FoundIdea = { found: string; title: string; seller: string; sold: number; price: number; ebay: string; cad: string; license: string; cadName: string; status: string; decision: string };
export const finds: FoundIdea[] = [];

const BROWSE = "/buy/browse/v1/item_summary/search";
// Not what Nexa sells: toys/collectibles, decor/crafts, firearm parts (eBay restricted), printer accessories.
export const JUNK = /\b(toys?|hasbro|kenner|mattel|lego|star wars|gi ?joe|action figures?|figurines?|funko|barbie|hot wheels|nerf|dolls?|playsets?|cosplay|props?|miniatures?|warhammer|dnd|keychains?|ornaments?|decor|vases?|planters?|fidget|statue|figures?|novelty|imaginext|power rangers|megazord|sanrio|hello kitty|godzilla|kaiju|marvel|disney|galaxy lamp|moon lamp|night light|lithophane|wall art|bobblehead|halloween|christmas|pokemon|transformers?|he-?man|vintage kenner|guns?|pistols?|rifles?|shotguns?|revolvers?|glock|walther|kel-?tec|sig sauer|ruger|smith ?& ?wesson|taurus|rossi|brawler|mossberg|remington|winchester|beretta|henry|savage arms|marlin|springfield|colt|ar-?15|ar15|ak-?47|ak47|holsters?|mag well|suppressor|forearm|handguard|stock adapter|picatinny|airsoft|paintball|ender ?3|bambu|prusa|creality|flashforge|anycubic|elegoo|3d printers?|3d printer parts?|printer enclosure|3d scanner|filament|sd card|1\/\d{2,3}|diorama|scale model|model kit|slot car)\b/i;
export const JUNK_CATEGORY = /\b(toys|collectibles|dolls|action figures|crafts|art|home d[eé]cor|holiday|guns|firearms?|hunting|airsoft|video games|3d printers?|3d printing)\b/i;
const BASE_FILTER = "buyingOptions:{FIXED_PRICE},itemLocationCountry:US,conditions:{NEW}";
/** Run Browse searches and keep 3D-printed listings from other sellers. */
async function collect(cfg: BotConfig, searches: { q: string; filter?: string; category?: string; keep?: number; must?: (title: string) => boolean }[]): Promise<Hit[]> {
  const mine = new Set(cfg.my_seller_ids.map((s) => s.toLowerCase()));
  const seen = new Map<string, Hit>();
  for (const sch of searches) {
    try {
      const query: Record<string, string> = { q: sch.q, limit: "200", filter: BASE_FILTER + (sch.filter ? "," + sch.filter : "") };
      if (sch.category) query.category_ids = sch.category;
      const j = await rest("GET", BROWSE, { app: true, query });
      let kept = 0;
      for (const it of j.itemSummaries || []) {
        if (kept >= (sch.keep ?? 50)) break;
        const title = String(it.title || "");
        const seller = String(it.seller?.username || "");
        if (!/3d|printed/i.test(title) || /not 3d printed/i.test(title) || mine.has(seller.toLowerCase())) continue;
        if (JUNK.test(title) || JUNK_CATEGORY.test(String(it.categories?.map((c: any) => c.categoryName).join(" ") || ""))) continue;
        if (Number(it.price?.value || 0) < (cfg.finder.min_price ?? 0)) continue;
        if (sch.must && !sch.must(title)) continue;
        const legacy = String(it.legacyItemId || it.itemId?.split("|")[1] || "");
        if (!legacy || seen.has(legacy)) continue;
        seen.set(legacy, { id: it.itemId, legacy, title, seller, price: Number(it.price?.value || 0) });
        kept++;
      }
    } catch { /* one bad search shouldn't stop the scan */ }
  }
  return [...seen.values()];
}

// ---------- Make-it check: parts Claude can model from published specs ----------
// Gears (tooth count + DP or module, ideally bore), pulleys, sprockets, spacers, shims, bushings, washers.
export type MakeSpecs = { kind: string; specs: string[] };
const num = String.raw`(\d+-\d+\/\d+|\d+\s*\/\s*\d+|\d+(?:\.\d+)?)`;
export function makeSpecs(title: string, text = ""): MakeSpecs | null {
  const all = `${title} ${text}`;
  const t = title.toLowerCase();
  const found: string[] = [];
  const grab = (re: RegExp, label: (m: RegExpMatchArray) => string) => { const m = all.match(re); if (m) found.push(label(m)); return !!m; };
  const isGear = /\bgears?\b|pinion|sprocket/i.test(t) && !/gear (shift|indicator|bag|holder|stand|organi[sz]er)|landing gear|game gear|gearbox cover/i.test(t);
  const isPulley = /\bpulley/i.test(t);
  const isSpacer = /\b(spacers?|shims?|washers?|bushings?|sleeves?|collars?)\b/i.test(t);
  if (!isGear && !isPulley && !isSpacer) return null;
  const teeth = grab(/\b(\d{2,3})\s*\/\s*(\d{2,3})\s*(?:t\b|teeth|tooth)?(?!\s*")/i, (m) => `${m[1]}/${m[2]}T`)   // compound, e.g. 80/63
    || grab(new RegExp(String.raw`\b(\d{1,3})\s*(?:t\b|teeth|tooth|-tooth)`, "i"), (m) => `${m[1]}T`);
  const pitch = grab(/\b(\d{1,2})\s*(?:dp\b|d\.p\.|diametral pitch|pitch\b)/i, (m) => `${m[1]} DP`)
    || grab(/diametral pitch\s*:?\s*(\d{1,2})/i, (m) => `${m[1]} DP`)
    || grab(/\b(?:module|mod\.?)\s*:?\s*(\d(?:\.\d+)?)\b|\bm(0\.\d+|\d(?:\.\d+)?)\s*gear/i, (m) => `module ${m[1] || m[2]}`);
  grab(new RegExp(String.raw`bore(?:\s*diameter)?\s*:?\s*${num}\s*("|in\b|inch|mm)?`, "i"), (m) => `bore ${m[1]}${m[2] ? (m[2] === '"' ? '"' : " " + m[2]) : ""}`);
  grab(new RegExp(String.raw`keyway\s*:?\s*${num}\s*("|in\b|inch|mm)?`, "i"), (m) => `keyway ${m[1]}${m[2] === '"' ? '"' : m[2] ? " " + m[2] : ""}`);
  grab(new RegExp(String.raw`(?:face width|width|thickness|thick)\s*:?\s*${num}\s*("|in\b|inch|mm)`, "i"), (m) => `width ${m[1]}${m[2] === '"' ? '"' : " " + m[2]}`);
  grab(/pressure angle\s*:?\s*(14\.5|20)/i, (m) => `${m[1]}° PA`);
  grab(/\b(gt2|gt3|htd\s*\d?m|mxl|xl|t5|t2\.5)\b/i, (m) => m[1].toUpperCase());
  grab(new RegExp(String.raw`\b${num}\s*(mm|")\s*(?:od|outer diameter|o\.d\.)`, "i"), (m) => `OD ${m[1]}${m[2] === '"' ? '"' : " mm"}`);
  if (isGear && teeth && pitch) return { kind: "gear", specs: found };
  if (isPulley && found.some((f) => /^bore/.test(f))) return { kind: "pulley", specs: found };
  if (isSpacer && found.some((f) => /^(bore|width|OD)/.test(f))) return { kind: "spacer", specs: found };
  return null;
}

// ---------- the strategies ----------
export type Strategy = "keywords" | "competitors" | "categories" | "cadfirst" | "gears" | "autoboat" | "premium" | "makeit";
export const STRATEGY_NAMES: Record<Strategy, string> = {
  keywords: "Keyword bot", competitors: "Competitor bot", categories: "Category bot", cadfirst: "CAD-first bot",
  gears: "Gears & Brackets bot", autoboat: "Auto & Boat bot", premium: "Premium Equipment bot", makeit: "Make-it bot",
};

// Focused search pools for the three specialist bots.
const POOLS: Record<"gears" | "autoboat" | "premium" | "makeit", string[]> = {
  // Make-it bot: parts Claude can model from specs (no physical part needed)
  makeit: [
    "lathe change gear", "change gear 16 dp", "change gear 18 dp", "change gear 20 dp", "change gear 24 dp", "metric transposing gear",
    "127 tooth gear", "lathe gear set", "atlas lathe gear", "south bend lathe gear", "logan lathe gear", "craftsman lathe gear",
    "clausing lathe gear", "sherline gear", "mini lathe gear", "mill power feed gear", "thread dial gear", "spur gear teeth bore",
    "module gear teeth", "replacement gear teeth bore", "gear 14.5 pressure angle", "worm gear teeth", "pinion gear teeth",
    "bevel gear teeth", "helical gear teeth", "nylon gear teeth bore", "sprocket teeth", "timing pulley gt2", "htd pulley",
    "v belt pulley bore", "step pulley bore", "motor pulley bore keyway", "pulley 5/8 bore", "pulley 1/2 bore",
    "spacer bore", "shim set", "bushing bore", "shaft collar", "washer set", "sleeve bore", "drill press gear",
    "bandsaw gear", "mixer gear teeth", "garage door opener gear teeth", "clock gear teeth", "sewing machine gear teeth",
    "projector gear teeth", "tape deck gear teeth", "turntable gear teeth", "printer gear teeth",
  ],
  gears: [
    "worm gear", "drive gear", "replacement gear", "gear set", "spur gear replacement", "gearbox gear", "motor gear", "pinion gear",
    "timing gear", "transmission gear", "nylon gear replacement", "helical gear", "bevel gear", "planetary gear", "idler gear",
    "actuator gear", "seat motor gear", "window regulator gear", "door lock actuator gear", "power mirror gear", "throttle body gear",
    "mixer gear", "stand mixer worm gear", "blender drive gear", "juicer gear", "bread machine gear", "garage door opener gear",
    "gate opener gear", "ice maker gear", "coffee grinder gear", "meat grinder gear", "pasta maker gear", "projector gear",
    "tape deck gear", "turntable gear", "vcr gear", "printer gear", "camera lens gear", "clock gear", "fishing reel gear",
    "lawn mower drive gear", "snow blower gear", "winch gear", "boat trim gear", "pump gear", "sprinkler gear",
    "bracket replacement", "mounting bracket", "motor mount bracket", "hinge replacement", "latch replacement", "lid hinge",
    "door hinge replacement", "bushing replacement", "pulley replacement", "sprocket replacement", "cam replacement", "lever replacement",
    "knob shaft replacement", "spacer replacement", "clip replacement", "retainer clip", "guide rail replacement", "roller replacement",
  ],
  autoboat: [
    "toyota part", "lexus part", "ford part", "chevy part", "gmc part", "dodge ram part", "jeep part", "honda part", "acura part",
    "nissan part", "infiniti part", "subaru part", "mazda part", "bmw part", "mercedes part", "audi part", "volkswagen part",
    "porsche part", "land rover part", "volvo part", "tesla part", "corvette part", "mustang part", "camaro part", "f150 part",
    "silverado part", "tacoma part", "tundra part", "4runner part", "wrangler part", "bronco part", "miata part", "mr2 part",
    "car interior trim clip", "car console part", "car vent clip", "car door handle", "sunroof part", "seat track part",
    "headlight adjuster", "tailgate part", "truck bed part", "classic car part", "obsolete car part",
    "boat part", "marine part", "boat hatch latch", "boat cleat", "boat hinge", "boat console part", "pontoon part",
    "yamaha waverunner part", "sea doo part", "jet ski part", "mercury outboard part", "yamaha outboard part",
    "johnson evinrude part", "minn kota part", "trolling motor part", "bayliner part", "sailboat part", "kayak part",
    "rv part", "camper part", "motorcycle part", "harley davidson part", "atv part", "polaris part", "can am part",
    "snowmobile part", "golf cart part", "tractor part", "john deere part", "kubota part", "zero turn mower part",
  ],
  premium: [
    "breville part", "delonghi part", "jura part", "saeco part", "gaggia part", "rancilio part", "rocket espresso part",
    "nespresso part", "vitamix part", "kitchenaid part", "thermomix part", "cuisinart part", "ninja part", "dyson part",
    "miele part", "bosch part", "sub zero part", "wolf range part", "viking range part", "thermador part", "ge profile part",
    "samsung refrigerator part", "lg refrigerator part", "whirlpool part", "frigidaire part", "maytag part", "speed queen part",
    "bose part", "bang olufsen part", "mcintosh part", "marantz part", "technics part", "pioneer part", "sonos part",
    "peloton part", "nordictrack part", "bowflex part", "concept2 part", "festool part", "dewalt part", "milwaukee part",
    "makita part", "bosch tool part", "snap-on part", "stihl part", "husqvarna part", "echo part", "ego power part",
    "traeger part", "weber grill part", "big green egg part", "blackstone part", "roomba part", "shark vacuum part",
    "herman miller part", "steelcase part", "leica part", "hasselblad part", "nikon part", "canon part", "generator part",
    "pool pump part", "hot tub part", "pentair part", "hayward part", "rheem part", "honeywell part", "nest thermostat part",
  ],
};
type Gathered = { hits: Hit[]; searched: string[]; presetCad: Map<string, Cad> };
const counters: Record<string, number> = {};
const nextK = (key: string, start = 0) => (counters[key] = (counters[key] ?? start - 1) + 1);

// Competitor bot: sellers already proven to move printed parts; scan their whole printed catalog.
async function gatherCompetitors(cfg: BotConfig): Promise<Gathered> {
  const counts = new Map<string, number>();
  const add = (s: string, w = 1) => { if (s && !cfg.my_seller_ids.includes(s.toLowerCase())) counts.set(s, (counts.get(s) || 0) + w); };
  try { const j = await storeCall({ action: "list" }); for (const x of j.rows || []) if (Number(x.sold) >= cfg.finder.min_sold) add(String(x.seller), 3); } catch { /* ignore */ }
  finds.forEach((f) => add(f.seller, 3));
  if (counts.size < 12) { // seed with whoever shows up most in broad printed-part searches
    for (const h of await collect(cfg, [{ q: "3d printed replacement part", keep: 200 }, { q: "3d printed replacement", keep: 200 }])) add(h.seller);
  }
  const sellers = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s).slice(0, 48);
  if (!sellers.length) return { hits: [], searched: [], presetCad: new Map() };
  const per = 6, batches = Math.ceil(sellers.length / per), k = nextK("competitors") % batches;
  const pick = sellers.slice(k * per, k * per + per);
  const hits = await collect(cfg, pick.flatMap((s) => [{ q: "3d printed", filter: `sellers:{${s}}`, keep: 200 }, { q: "printed", filter: `sellers:{${s}}`, keep: 200 }]));
  return { hits, searched: pick.map((s) => `seller ${s}`), presetCad: new Map() };
}

// Category bot: eBay's own category breakdown of printed parts; search inside each category.
let catCache: { at: number; cats: { id: string; name: string }[] } | null = null;
async function gatherCategories(cfg: BotConfig): Promise<Gathered> {
  if (!catCache || Date.now() - catCache.at > 86400_000) {
    const m = new Map<string, { id: string; name: string; n: number }>();
    for (const q of ["3d printed replacement", "3d printed part", "3d printed knob", "3d printed cover"]) {
      try {
        const j = await rest("GET", BROWSE, { app: true, query: { q, limit: "1", filter: BASE_FILTER, fieldgroups: "CATEGORY_REFINEMENTS" } });
        for (const c of j.refinement?.categoryDistributions || []) {
          const e = m.get(String(c.categoryId)) || { id: String(c.categoryId), name: String(c.categoryName), n: 0 };
          e.n += Number(c.matchCount || 0); m.set(e.id, e);
        }
      } catch { /* ignore */ }
    }
    catCache = { at: Date.now(), cats: [...m.values()].filter((c) => !JUNK_CATEGORY.test(c.name)).sort((a, b) => b.n - a.n).slice(0, 36) };
  }
  const cats = catCache.cats;
  if (!cats.length) return { hits: [], searched: [], presetCad: new Map() };
  const per = 6, batches = Math.ceil(cats.length / per), k = nextK("categories") % batches;
  const pick = cats.slice(k * per, k * per + per);
  const hits = await collect(cfg, pick.flatMap((c) => [{ q: "3d printed", category: c.id, keep: 80 }, { q: "3d printed replacement", category: c.id, keep: 80 }]));
  return { hits, searched: pick.map((c) => c.name), presetCad: new Map() };
}

// CAD-first bot: sellable CAD files first, then proof that printed copies sell on eBay.
const CAD_FIRST_QUERIES = ["replacement knob", "replacement clip", "battery cover", "replacement handle", "replacement gear",
  "replacement latch", "replacement cap", "replacement bracket", "replacement hinge", "replacement foot", "cup holder insert",
  "appliance replacement part", "car interior clip", "vacuum replacement part", "power tool replacement part", "obsolete part",
  "remote battery cover", "boat replacement part", "dishwasher part", "fridge part"];
async function gatherCadFirst(cfg: BotConfig): Promise<Gathered> {
  const per = 4, batches = Math.ceil(CAD_FIRST_QUERIES.length / per), k = nextK("cadfirst") % batches;
  const pick = CAD_FIRST_QUERIES.slice(k * per, k * per + per);
  const presetCad = new Map<string, Cad>();
  const all = new Map<string, Hit>();
  for (const q of pick) {
    const models = (await printables(q, 30).catch(() => [])).filter((m) => okLicense(m.license)).slice(0, 10);
    for (const m of models) {
      const mt = tokens(m.name);
      if (mt.length < 2) continue;
      const hits = await collect(cfg, [{ q: "3d printed " + mt.slice(0, 3).join(" "), keep: 15, must: (t) => overlap(tokens(t), mt) >= Math.min(3, mt.length) }]);
      for (const h of hits) if (!all.has(h.legacy)) {
        all.set(h.legacy, h);
        presetCad.set(h.legacy, { url: `https://www.printables.com/model/${m.id}`, name: m.name, license: m.license });
      }
    }
  }
  return { hits: [...all.values()], searched: pick.map((q) => `Printables: ${q}`), presetCad };
}

async function gatherPool(cfg: BotConfig, key: "gears" | "autoboat" | "premium" | "makeit"): Promise<Gathered> {
  const pool = POOLS[key], per = 18, batches = Math.ceil(pool.length / per), k = nextK(key) % batches;
  const pick = pool.filter((_, i) => i % batches === k).map((q) => "3d printed " + q);
  return { hits: await collect(cfg, pick.map((q) => ({ q }))), searched: pick, presetCad: new Map() };
}

async function gatherKeywords(cfg: BotConfig, manual: boolean): Promise<Gathered> {
  const queries = nextQueries(cfg, manual);
  return { hits: await collect(cfg, queries.map((q) => ({ q }))), searched: queries, presetCad: new Map() };
}

// Find-products clicks cycle through the four bots; the morning run does keywords + one other.
const ORDER: Strategy[] = ["makeit", "gears", "autoboat", "premium", "makeit", "keywords", "competitors", "gears", "makeit", "autoboat", "premium", "categories", "cadfirst"];
let clickStrategy = -1;
export function nextStrategy(): Strategy { clickStrategy = (clickStrategy + 1) % ORDER.length; return ORDER[clickStrategy]; }
const FOCUS: Strategy[] = ["makeit", "gears", "autoboat", "premium"];
const OTHERS: Strategy[] = ["competitors", "categories", "cadfirst", "keywords"];
export function morningFocus(day = Math.floor(Date.now() / 86400_000)): Strategy { return FOCUS[day % FOCUS.length]; }
export function morningExtra(day = Math.floor(Date.now() / 86400_000)): Strategy { return OTHERS[day % OTHERS.length]; }
export const DEEP_PLAN: Strategy[] = ["makeit", "gears", "autoboat", "premium", "makeit", "competitors", "gears", "autoboat", "premium", "makeit", "keywords", "categories", "cadfirst", "makeit", "gears", "autoboat", "premium", "makeit"];

/** eBay's Browse item details include an estimated sold quantity. */
async function addSoldCounts(hits: Hit[]) {
  const soldOf = (it: any) => Math.max(0, ...(it.estimatedAvailabilities || []).map((a: any) => Number(a.estimatedSoldQuantity || 0)));
  const one = async (h: Hit) => {
    try {
      const it = await rest("GET", `/buy/browse/v1/item/${encodeURIComponent(h.id)}`, { app: true, timeoutMs: 15000 });
      h.sold = soldOf(it);
      // keep the listing text so the Make-it check can read specs (teeth, DP, bore...)
      h.text = [it.shortDescription, it.description, ...(it.localizedAspects || []).map((a: any) => `${a.name}: ${a.value}`)]
        .join(" ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#\d+;|&\w+;/g, " ").replace(/\s+/g, " ").slice(0, 6000);
    }
    catch { /* skip */ }
  };
  // 6 lookups at a time keeps a full scan to a minute or two.
  for (let i = 0; i < hits.length; i += 6) await Promise.all(hits.slice(i, i + 6).map(one));
}

async function printables(query: string, limit = 10): Promise<{ id: string; name: string; license: string }[]> {
  const r = await fetch("https://api.printables.com/graphql/", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", origin: "https://www.printables.com", referer: "https://www.printables.com/" },
    body: JSON.stringify({
      query: "query($q:String!,$n:Int!){searchPrints2(query:$q,limit:$n){items{id name license{abbreviation}}}}",
      variables: { q: query, n: limit },
    }),
  });
  if (!r.ok) throw new Error(`Printables ${r.status}`);
  const j: any = await r.json();
  return (j.data?.searchPrints2?.items || []).map((i: any) => ({ id: String(i.id), name: String(i.name), license: String(i.license?.abbreviation || "") }));
}

// Thingiverse (optional): needs a free app token from thingiverse.com/developers in THINGIVERSE_TOKEN.
async function thingiverse(query: string): Promise<{ id: string; name: string; license: string }[]> {
  const tok = process.env.THINGIVERSE_TOKEN;
  if (!tok) return [];
  const h = { Authorization: `Bearer ${tok}` };
  const r = await fetch(`https://api.thingiverse.com/search/${encodeURIComponent(query)}?type=things&per_page=8`, { headers: h, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return [];
  const j: any = await r.json();
  const hits = (j.hits || j || []).slice(0, 8);
  const out: { id: string; name: string; license: string }[] = [];
  for (const t of hits) {
    try {
      const d: any = await (await fetch(`https://api.thingiverse.com/things/${t.id}`, { headers: h, signal: AbortSignal.timeout(15000) })).json();
      // Thingiverse license names look like "Creative Commons - Attribution - Share Alike".
      const L = String(d.license || "");
      const abbr = /public domain|cc0/i.test(L) ? "CC0"
        : /non-?commercial/i.test(L) ? "CC-BY-NC"
        : /no derivatives/i.test(L) ? "CC-BY-ND"
        : /share alike/i.test(L) ? "CC-BY-SA"
        : /attribution/i.test(L) ? "CC-BY"
        : /gnu|gpl/i.test(L) ? "GPL" : /bsd/i.test(L) ? "BSD" : L;
      out.push({ id: `tv:${t.id}`, name: String(d.name || t.name || ""), license: abbr });
    } catch { /* skip */ }
  }
  return out;
}

async function findCad(h: Hit): Promise<Cad | null> {
  const t = tokens(h.title);
  const tries = [t.slice(0, 4).join(" "), t.slice(0, 3).join(" "), t.slice(0, 2).join(" ")];
  for (const q of tries) {
    if (!q) continue;
    const pr = await printables(q).catch(() => []);
    const tv = await thingiverse(q).catch(() => []);
    const res = [...pr, ...tv].filter((x) => okLicense(x.license));
    const best = res.find((x) => overlap(t.slice(0, 8), tokens(x.name)) >= Math.min(3, t.length));
    if (best) {
      const url = best.id.startsWith("tv:") ? `https://www.thingiverse.com/thing:${best.id.slice(3)}` : `https://www.printables.com/model/${best.id}`;
      return { url, name: best.name, license: best.license };
    }
  }
  return null;
}

export type FinderSummary = { bot: string; searched: string[]; checked: number; found: number; fresh: number; makeable?: number };
export async function finderBot(cfg: BotConfig, myListings: Listing[], r: Report, manual = false, strategy: Strategy = "keywords"): Promise<FinderSummary> {
  const myTokens = myListings.map((l) => tokens(l.title));
  const g = strategy === "competitors" ? await gatherCompetitors(cfg)
    : strategy === "categories" ? await gatherCategories(cfg)
    : strategy === "cadfirst" ? await gatherCadFirst(cfg)
    : strategy === "gears" || strategy === "autoboat" || strategy === "premium" || strategy === "makeit" ? await gatherPool(cfg, strategy)
    : await gatherKeywords(cfg, manual);
  const queries = g.searched;
  const botName = STRATEGY_NAMES[strategy];
  const summary: FinderSummary = { bot: botName, searched: queries, checked: 0, found: 0, fresh: 0 };
  (r as any).finder = summary;
  let hits = g.hits;
  console.log(`Finder: ${hits.length} printed listings found`);
  // Skip parts you already sell.
  hits = hits.filter((h) => { const t = tokens(h.title).slice(0, 6); return !myTokens.some((m) => overlap(t, m) >= Math.min(4, t.length)); });
  console.log(`Finder: checking sold counts on ${hits.length} new-to-you listings`);
  // Only look at listings you haven't seen yet (already found, added or dismissed ones are skipped).
  const seenBefore = await storedLinks().catch(() => new Set<string>());
  finds.forEach((f) => seenBefore.add(f.ebay));
  hits = hits.filter((h) => !seenBefore.has(`https://www.ebay.com/itm/${h.legacy}`));
  summary.checked = hits.length;
  await addSoldCounts(hits);
  const make = new Map<string, MakeSpecs>();
  for (const h of hits) { const ms = makeSpecs(h.title, h.text); if (ms) make.set(h.legacy, ms); }
  let top = hits.filter((h) => (h.sold || 0) >= cfg.finder.min_sold && (strategy !== "makeit" || make.has(h.legacy)))
    .sort((a, b) => (b.sold || 0) - (a.sold || 0)).slice(0, 25);
  summary.makeable = top.filter((h) => make.has(h.legacy)).length;
  if (!top.length) { r.info.push(`🔎 ${botName}: checked ${hits.length} new printed listings, none with ${cfg.finder.min_sold}+ sold (searched: ${queries.slice(0, 4).join(", ")}…).`); return summary; }

  console.log(`Finder: ${top.length} with ${cfg.finder.min_sold}+ sold; checking CAD`);
  const withCad: { h: Hit; cad: Cad }[] = [];
  const noCad: Hit[] = [];
  let cadErrors = 0;
  for (const h of top) {
    if (make.has(h.legacy)) { noCad.push(h); continue; } // Claude builds these from the specs; no CAD hunt needed
    const pre = g.presetCad.get(h.legacy);
    if (pre) { withCad.push({ h, cad: pre }); continue; }
    try { const cad = await findCad(h); cad ? withCad.push({ h, cad }) : noCad.push(h); }
    catch { cadErrors++; noCad.push(h); }
  }

  // Brain double-checks that each CAD file is really the same part.
  let verified = withCad;
  if (brainOn() && withCad.length) {
    try {
      const res = await askJson<{ keep: number[] }>(
        FAST_MODEL,
        "You check whether a free 3D model is the same replacement part as an eBay listing (same device/model, same part). Be strict.",
        JSON.stringify(withCad.map((x, i) => ({ i, ebay_title: x.h.title, cad_name: x.cad.name }))) + '\nReturn {"keep":[indexes that match]}',
        800,
      );
      verified = withCad.filter((_, i) => (res.keep || []).includes(i));
      noCad.push(...withCad.filter((_, i) => !(res.keep || []).includes(i)).map((x) => x.h));
    } catch { /* keep unverified list */ }
  }

  const statusOf = (h: Hit, cad: Cad | null) => {
    const ms = make.get(h.legacy);
    if (ms) return `🛠 Claude can make it (${ms.kind}): ${ms.specs.join(", ")} · ${botName}`;
    return (cad ? (brainOn() ? "CAD checked - same part" : "Possible CAD - check it's the same part") : "No free CAD found - check paid") + ` · ${botName}`;
  };
  // Put every idea on the dashboard's product board right away.
  const today = new Date().toISOString().slice(0, 10);
  const known = new Set(finds.map((f) => f.ebay));
  const ideas: FoundIdea[] = [
    ...verified.map((x) => ({ h: x.h, cad: x.cad as Cad | null })),
    ...noCad.map((h) => ({ h, cad: null as Cad | null })),
  ].map(({ h, cad }) => ({
    found: today, title: h.title, seller: h.seller, sold: h.sold || 0, price: h.price,
    ebay: `https://www.ebay.com/itm/${h.legacy}`, cad: cad?.url || "", license: cad?.license || "", cadName: cad?.name || "",
    status: statusOf(h, cad),
    decision: "",
  }));
  summary.found = ideas.length;
  summary.fresh = ideas.filter((i) => !known.has(i.ebay)).length;
  for (const i of ideas.reverse()) { const k = finds.findIndex((f) => f.ebay === i.ebay); if (k >= 0) finds.splice(k, 1); finds.unshift(i); }
  finds.splice(200);

  // Log every idea to your Google Sheet (via the Apps Script web app in SHEETS_WEBHOOK_URL).
  const hook = process.env.SHEETS_WEBHOOK_URL;
  if (hook) {
    const rows = [
      ...verified.map((x) => ({ h: x.h, cad: x.cad })),
      ...noCad.map((h) => ({ h, cad: null as Cad | null })),
    ].map(({ h, cad }) => ({
      found: new Date().toISOString().slice(0, 10),
      title: h.title, seller: h.seller, sold: h.sold, price: h.price,
      ebay_url: `https://www.ebay.com/itm/${h.legacy}`,
      cad_url: cad?.url || "", cad_license: cad?.license || "", cad_name: cad?.name || "",
      status: statusOf(h, cad),
    }));
    try {
      const resp = await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows }), signal: AbortSignal.timeout(30000), redirect: "follow" });
      const t = await resp.text();
      r.info.push(resp.ok ? `💾 Saved to your product list: ${t.slice(0, 80)}` : `Saving products failed (${resp.status}).`);
    } catch (e) { r.info.push(`Google Sheet update failed: ${(e as Error).message.slice(0, 80)}`); }
  }

  const line = (h: Hit) => `"${short(h.title, 70)}" by ${h.seller}: ${h.sold} sold @ ${money(h.price)}`;
  const parts: string[] = [];
  const cadHead = brainOn()
    ? "WITH SELLABLE CAD (Claude checked it's the same part):\n"
    : "POSSIBLE SELLABLE CAD (keyword match only: open the link and confirm it's the same part):\n";
  if (verified.length) parts.push(cadHead + verified.slice(0, 10).map((x) => `• ${line(x.h)}\n   CAD: ${x.cad.url} (${x.cad.license}) – ${short(x.cad.name, 50)}`).join("\n"));
  if (noCad.length) parts.push("PROVEN SELLERS, NO FREE CAD (model it yourself):\n" + noCad.slice(0, 6).map((h) => `• ${line(h)}`).join("\n"));
  if (cadErrors) parts.push(`(CAD search failed for ${cadErrors} item(s); check Printables by hand.)`);
  r.info.unshift(`🔎 PRODUCT IDEAS (${botName})\n` + parts.join("\n\n"));
  return summary;
}
