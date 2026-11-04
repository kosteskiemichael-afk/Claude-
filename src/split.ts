// Turn one option of a multi-option listing (e.g. "32 Tooth" in a gear set) into its own single listing.
// Copies the parent's photos (option photos first), item specifics, description, category, condition,
// shipping/return/payment policies and location. Burr holders are refused.
import { trading } from "./ebay.js";
import { isProtected, val } from "./bots/shared.js";

const arr = (x: any) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const txt = (x: any) => String(val(x) ?? "");

export type SplitReq = { parent_item_id: string; option: string; title: string; price: number; quantity?: number; verify_only?: boolean };

export async function splitOption(q: SplitReq) {
  const r = await trading("GetItem", { ItemID: q.parent_item_id, DetailLevel: "ReturnAll", IncludeItemSpecifics: "true" });
  const it = Array.isArray(r.Item) ? r.Item[0] : r.Item;
  const parentTitle = txt(it.Title);
  if (isProtected(q.parent_item_id, parentTitle) || isProtected("", q.title)) throw new Error("protected listing");
  if (!q.title || q.title.length > 80) throw new Error("title missing or over 80 characters");
  // Find the option.
  const want = q.option.toLowerCase().replace(/\s+/g, " ").trim();
  const vars = arr(it.Variations?.Variation);
  const v = vars.find((x: any) => arr(x.VariationSpecifics?.NameValueList).some((nv: any) => arr(nv.Value).some((y: any) => txt(y).toLowerCase().trim() === want)))
    || vars.find((x: any) => arr(x.VariationSpecifics?.NameValueList).some((nv: any) => arr(nv.Value).some((y: any) => txt(y).toLowerCase().includes(want))));
  if (!v) throw new Error(`option "${q.option}" not found; options: ${vars.map((x: any) => arr(x.VariationSpecifics?.NameValueList).map((nv: any) => arr(nv.Value).map(txt).join("/")).join(" ")).slice(0, 40).join(", ")}`);
  const vSpecs = arr(v.VariationSpecifics?.NameValueList).map((nv: any) => ({ Name: txt(nv.Name), Value: arr(nv.Value).map(txt) }));
  // Photos: this option's own photos first, then the listing's photos (max 24).
  const vPics: string[] = [];
  for (const set of arr(it.Variations?.Pictures?.VariationSpecificPictureSet)) {
    if (vSpecs.some((s: any) => s.Value.includes(txt(set.VariationSpecificValue)))) vPics.push(...arr(set.PictureURL).map(txt));
  }
  const pics = [...new Set([...vPics, ...arr(it.PictureDetails?.PictureURL).map(txt)])].filter(Boolean).slice(0, 24);
  // Item specifics: the listing's, with this option's values written in.
  const specs = new Map<string, string[]>();
  for (const nv of arr(it.ItemSpecifics?.NameValueList)) specs.set(txt(nv.Name), arr(nv.Value).map(txt));
  for (const s of vSpecs) specs.set(s.Name, s.Value);
  const sold = Number(txt(v.SellingStatus?.QuantitySold) || 0);
  const qty = q.quantity ?? Math.max(3, Math.min(10, Number(txt(v.Quantity) || 0) - sold));
  const item: any = {
    Title: q.title,
    Description: txt(it.Description) || parentTitle,
    PrimaryCategory: { CategoryID: txt(it.PrimaryCategory?.CategoryID) },
    StartPrice: q.price.toFixed(2),
    Quantity: qty,
    Currency: "USD", Country: txt(it.Country) || "US", Site: "US",
    Location: txt(it.Location) || undefined, PostalCode: txt(it.PostalCode) || undefined,
    ListingType: "FixedPriceItem", ListingDuration: "GTC",
    ConditionID: txt(it.ConditionID) || "1000",
    DispatchTimeMax: txt(it.DispatchTimeMax) || "3",
    PictureDetails: pics.length ? { PictureURL: pics } : undefined,
    ItemSpecifics: { NameValueList: [...specs.entries()].map(([Name, Value]) => ({ Name, Value })) },
    SKU: txt(v.SKU) ? `${txt(v.SKU)}-S` : undefined,
  };
  const prof = it.SellerProfiles;
  if (prof?.SellerShippingProfile?.ShippingProfileID) {
    item.SellerProfiles = {
      SellerShippingProfile: { ShippingProfileID: txt(prof.SellerShippingProfile.ShippingProfileID) },
      SellerReturnProfile: prof.SellerReturnProfile ? { ReturnProfileID: txt(prof.SellerReturnProfile.ReturnProfileID) } : undefined,
      SellerPaymentProfile: prof.SellerPaymentProfile ? { PaymentProfileID: txt(prof.SellerPaymentProfile.PaymentProfileID) } : undefined,
    };
  } else {
    item.ShippingDetails = it.ShippingDetails; item.ReturnPolicy = it.ReturnPolicy; item.ShippingPackageDetails = it.ShippingPackageDetails;
  }
  const verify = await trading("VerifyAddFixedPriceItem", { Item: item });
  const fees = arr(verify.Fees?.Fee).filter((f: any) => Number(txt(f.Fee) || 0) > 0).map((f: any) => `${txt(f.Name)} $${txt(f.Fee)}`);
  if (q.verify_only) return { ok: true, verified: true, fees, photos: pics.length, specifics: specs.size, quantity: qty };
  const add = await trading("AddFixedPriceItem", { Item: item });
  return { ok: true, item_id: txt(add.ItemID), url: `https://www.ebay.com/itm/${txt(add.ItemID)}`, fees, photos: pics.length, specifics: specs.size, quantity: qty };
}
