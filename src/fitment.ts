// Vehicle fitment (asked for by Michael, Nov 21): adds eBay's "Compatible vehicles" table to car-part listings.
// bots.config.json "fitment": { itemId: [{ make, models: [..], years: [from, to] }] }.
// Every Year/Make/Model is checked against eBay's own Motors vehicle list first; anything eBay doesn't know
// is reported and left out, so nothing invalid is ever sent. dry=1 only reports.
import { rest, trading } from "./ebay.js";

type Fit = { make: string; models: string[]; years: [number, number] };
const TREE = "100"; // eBay Motors US

async function values(cat: string, prop: string, filter: Record<string, string>): Promise<string[]> {
  const f = Object.entries(filter).map(([k, v]) => `${k}:${v.replace(/,/g, "\\,")}`).join(",");
  const j = await rest("GET", `/commerce/taxonomy/v1/category_tree/${TREE}/get_compatibility_property_values`, {
    app: true, query: { category_id: cat, compatibility_property: prop, ...(f ? { filter: f } : {}) },
  });
  return (j.compatibilityPropertyValues || []).map((x: any) => String(x.value));
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export async function applyFitment(map: Record<string, Fit[]>, dry: boolean) {
  const out: any[] = [];
  for (const [id, fits] of Object.entries(map)) {
    const row: any = { id, added: 0, notes: [] as string[] };
    try {
      const g: any = await trading("GetItem", { ItemID: id });
      const one = (x: any) => (Array.isArray(x) ? x[0] : x);
      const txt = (x: any) => { x = one(x); return x && typeof x === "object" ? String(x["#text"] ?? "") : String(x ?? ""); };
      const item = one(g?.Item) || {};
      const cat = txt(one(item.PrimaryCategory)?.CategoryID);
      row.title = txt(item.Title).slice(0, 60); row.category = cat; row.catName = txt(one(item.PrimaryCategory)?.CategoryName).slice(-50);
      const props = await rest("GET", `/commerce/taxonomy/v1/category_tree/${TREE}/get_compatibility_properties`, { app: true, query: { category_id: cat } }).catch(() => null);
      if (!props || !(props.compatibilityProperties || []).length) { row.notes.push("category does not take vehicle fitment (needs an eBay Motors parts category)"); out.push(row); continue; }
      const list: any[] = [];
      for (const f of fits) {
        const makes = await values(cat, "Make", {});
        const make = makes.find((m) => norm(m) === norm(f.make));
        if (!make) { row.notes.push(`make not in eBay list: ${f.make}`); continue; }
        const models = await values(cat, "Model", { Make: make });
        for (const want of f.models) {
          const model = models.find((m) => norm(m) === norm(want));
          if (!model) { row.notes.push(`${make}: model "${want}" not in eBay list`); continue; }
          const years = (await values(cat, "Year", { Make: make, Model: model })).map(Number);
          const ok = years.filter((y) => y >= f.years[0] && y <= f.years[1]).sort();
          if (!ok.length) { row.notes.push(`${make} ${model}: no eBay years in ${f.years.join("-")}`); continue; }
          for (const y of ok) list.push({ NameValueList: [{ Name: "Year", Value: String(y) }, { Name: "Make", Value: make }, { Name: "Model", Value: model }] });
        }
      }
      row.added = list.length;
      if (!list.length || dry) { out.push(row); continue; }
      await trading("ReviseFixedPriceItem", { Item: { ItemID: id, ItemCompatibilityList: { ReplaceAll: "true", Compatibility: list } } });
      row.done = true;
    } catch (e) { row.notes.push(`error: ${(e as Error).message.slice(0, 200)}`); }
    out.push(row);
  }
  return out;
}
