// Listing drafts: the bot writes each "Add these next" gear as a full eBay listing, copied from one of
// your live listings in the same family (category, item specifics, location, returns). Michael checks it,
// adds photos and presses Submit. Nothing is listed without that press.
import { readFileSync, existsSync } from "fs";
import { trading, userToken, API_BASE } from "./ebay.js";
import { isProtected, loadConfig, val } from "./bots/shared.js";
import { floorPrice } from "./bots/profit.js";

const arr = (x: any) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const txt = (x: any) => String(val(x) ?? "");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// Family -> one of your live listings to copy settings from, and the gear spec line for the description.
const FAMILIES: Record<string, { template: string; specs: (n: number) => string }> = {
  "South Bend 9/10K": { template: "206662590793", specs: (n) => `${n} teeth · 18 diametral pitch · 14.5° pressure angle · 9/16" (0.5625") bore with 1/8" keyway · 3/8" face width · OD ${((n + 2) / 18).toFixed(3)}"` },
  "Atlas 618 / Craftsman 101": { template: "206670701158", specs: (n) => `${n} teeth · 24 diametral pitch · 14.5° pressure angle · 1/2" bore with two 1/8" keyways · 3/8" face width · OD ${((n + 2) / 24).toFixed(3)}"` },
  "Logan 9/10/11": { template: "206670915548", specs: (n) => `${n} teeth · 16 diametral pitch · 14.5° pressure angle · 5/8" bore with 5/32" keyway · ${n === 60 ? '5/8"' : '7/16"'} face width · OD ${((n + 2) / 16).toFixed(3)}"` },
  "Atlas 10/12": { template: "206674883733", specs: (n) => `${n} teeth · 16 diametral pitch · 14.5° pressure angle · 3/4" bore with two 3/16" keyways · 1/2" face width · OD ${((n + 2) / 16).toFixed(3)}"` },
  "Mini lathe 7x10 / 7x12": { template: "206663935567", specs: (n) => `${n ? n + " teeth · " : ""}Module 1 · 20° pressure angle · 12 mm bore with 3 mm keyway · 8 mm face width` },
  "Other gears": { template: "206588399218", specs: () => "Heavy-duty HD PETG replacement gear" },
};

type Item = { group: string; title: string; their: string; sold: number; price: number; cad: string; have?: string };
export type Draft = { key: string; group: string; title: string; price: number; floor: number; quantity: number; their: string; sold: number; specs: string; template: string; description: string };

function addNext(): Item[] {
  const p = process.env.ADDNEXT_FILE || "addnext.json";
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf8")).items || []; } catch { return []; }
}
const teeth = (t: string) => Number((t.match(/\b(\d{2,3})\s*(?:T\b|Tooth|\(\d+\s*Tooth)/i) || [])[1] || 0);

function describe(title: string, specs: string, note: string): string {
  return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;max-width:900px">
<h2>${esc(title)}</h2>
<p>Precision 3D-printed replacement gear in tough, engineering-grade HD PETG. Made in the USA by NEXA Manufacturing Co. and checked before it ships.</p>
<h3>Specifications</h3><p>${esc(specs)}</p>
<h3>Why HD PETG</h3><ul><li>Strong, impact resistant and dimensionally stable</li><li>Quiet running and kind to the other gears in your train</li><li>Engraved with the tooth count for easy identification</li></ul>
<p>Please compare the tooth count, bore and face width with your old gear before ordering.</p>${note}</div>`;
}

export async function listDrafts(): Promise<Draft[]> {
  const cfg = loadConfig() as any;
  const note = cfg.gear_note?.html || "";
  const out: Draft[] = [];
  for (const x of addNext()) {
    const fam = FAMILIES[x.group];
    if (!fam) continue; // products without a print file yet are not drafted
    const n = teeth(x.title);
    if (!n || x.group === "Other gears") continue; // only single gears with a known tooth count and a ready file
    const specs = fam.specs(n);
    const floor = floorPrice(cfg, "", { kind: "free", buyer: 0 }, cfg.marketing?.target_ad_rate ?? 2);
    out.push({ key: x.their, group: x.group, title: x.title.slice(0, 80), price: Math.max(x.price, Math.ceil(floor * 100) / 100), floor: Math.round(floor * 100) / 100,
      quantity: 10, their: x.their, sold: x.sold, specs, template: fam.template, description: describe(x.title, specs, note) });
  }
  return out;
}

const templates = new Map<string, any>();
async function template(id: string) {
  if (!templates.has(id)) {
    const r = await trading("GetItem", { ItemID: id, DetailLevel: "ReturnAll", IncludeItemSpecifics: "true" });
    templates.set(id, Array.isArray(r.Item) ? r.Item[0] : r.Item);
  }
  return templates.get(id);
}

export type DraftReq = { key: string; title?: string; price?: number; quantity?: number; photos?: string[]; verify_only?: boolean };

export async function submitDraft(q: DraftReq) {
  const d = (await listDrafts()).find((x) => x.key === q.key);
  if (!d) throw new Error("draft not found (it may already be listed)");
  const title = (q.title || d.title).trim();
  if (!title || title.length > 80) throw new Error("title missing or over 80 characters");
  if (isProtected("", title)) throw new Error("protected product");
  const price = Number(q.price ?? d.price);
  if (!(price > 0)) throw new Error("price missing");
  if (price < d.floor - 0.001) throw new Error(`$${price.toFixed(2)} is under your profit floor of $${d.floor.toFixed(2)} with free shipping`);
  const photos = (q.photos || []).filter(Boolean).slice(0, 24);
  if (!q.verify_only && !photos.length) throw new Error("add at least one photo before submitting");
  const it = await template(d.template);
  const specs = new Map<string, string[]>();
  for (const nv of arr(it.ItemSpecifics?.NameValueList)) specs.set(txt(nv.Name), arr(nv.Value).map(txt));
  const n = teeth(title);
  for (const k of [...specs.keys()]) if (/teeth|tooth/i.test(k) && n) specs.set(k, [String(n)]);
  for (const k of [...specs.keys()]) if (/^(mpn|manufacturer part number)$/i.test(k)) specs.set(k, ["Does Not Apply"]);
  const item: any = {
    Title: title,
    Description: d.description.replace(/<h2>[^<]*<\/h2>/, `<h2>${esc(title)}</h2>`),
    PrimaryCategory: { CategoryID: txt(it.PrimaryCategory?.CategoryID) },
    StartPrice: price.toFixed(2),
    Quantity: Math.max(1, Math.round(q.quantity ?? d.quantity)),
    Currency: "USD", Country: txt(it.Country) || "US", Site: "US",
    Location: txt(it.Location) || undefined, PostalCode: txt(it.PostalCode) || undefined,
    ListingType: "FixedPriceItem", ListingDuration: "GTC",
    ConditionID: txt(it.ConditionID) || "1000",
    DispatchTimeMax: txt(it.DispatchTimeMax) || "3",
    ItemSpecifics: { NameValueList: [...specs.entries()].map(([Name, Value]) => ({ Name, Value })) },
    ShippingDetails: { ShippingType: "Flat", ShippingServiceOptions: [{ ShippingServicePriority: 1, ShippingService: "USPSGroundAdvantage", ShippingServiceCost: "0.00", FreeShipping: "true" }] },
    ReturnPolicy: it.ReturnPolicy,
  };
  // Verify needs a photo; until real ones are added, check with the template's first photo (never listed).
  const verifyItem = { ...item, PictureDetails: { PictureURL: photos.length ? photos : arr(it.PictureDetails?.PictureURL).map(txt).slice(0, 1) } };
  const verify = await trading("VerifyAddFixedPriceItem", { Item: verifyItem });
  const fees = arr(verify.Fees?.Fee).filter((f: any) => Number(txt(f.Fee) || 0) > 0).map((f: any) => `${txt(f.Name)} $${txt(f.Fee)}`);
  if (q.verify_only) return { ok: true, verified: true, fees, specifics: specs.size };
  item.PictureDetails = { PictureURL: photos };
  const add = await trading("AddFixedPriceItem", { Item: item });
  return { ok: true, item_id: txt(add.ItemID), url: `https://www.ebay.com/itm/${txt(add.ItemID)}`, fees };
}

/** Upload one photo (base64) to eBay Picture Services; returns the hosted URL to use in the listing. */
export async function uploadPhoto(base64: string, name = "photo.jpg"): Promise<string> {
  const bytes = Buffer.from(base64.replace(/^data:[^,]+,/, ""), "base64");
  if (bytes.length > 12_000_000) throw new Error("photo over 12 MB");
  const xml = `<?xml version="1.0" encoding="utf-8"?><UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">` +
    `<PictureName>${esc(name.slice(0, 60))}</PictureName><PictureSet>Supersize</PictureSet></UploadSiteHostedPicturesRequest>`;
  const boundary = "NEXA" + Date.now();
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="XML Payload"\r\nContent-Type: text/xml;charset=utf-8\r\n\r\n${xml}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${name.replace(/"/g, "")}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const r = await fetch(`${API_BASE}/ws/api.dll`, { method: "POST", body, headers: {
    "Content-Type": `multipart/form-data; boundary=${boundary}`, "X-EBAY-API-CALL-NAME": "UploadSiteHostedPictures",
    "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1271", "X-EBAY-API-IAF-TOKEN": await userToken() } });
  const t = await r.text();
  const url = (t.match(/<FullURL>([^<]+)<\/FullURL>/) || [])[1];
  if (!url) throw new Error("eBay photo upload failed: " + ((t.match(/<LongMessage>([^<]+)/) || [])[1] || t.slice(0, 200)));
  return url;
}
