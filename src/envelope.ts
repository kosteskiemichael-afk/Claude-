// Move small flat parts to USPS First-Class large envelope with free shipping (you asked for this:
// you've shipped these as large envelopes before and they arrive fine). Also takes them out of any
// running sale event, since eBay won't take price changes on items in a sale.
import { rest, trading } from "./ebay.js";
import { isProtected, val } from "./bots/shared.js";

const POLICY = "Large Envelope - Free Shipping";
const arr = (x: any) => (x == null ? [] : Array.isArray(x) ? x : [x]);

async function envelopePolicyId(): Promise<string> {
  const j = await rest("GET", "/sell/account/v1/fulfillment_policy", { query: { marketplace_id: "EBAY_US" } });
  const have = (j.fulfillmentPolicies || []).find((p: any) => p.name === POLICY);
  if (have) return String(have.fulfillmentPolicyId);
  const base = (j.fulfillmentPolicies || [])[0];
  const c = await rest("POST", "/sell/account/v1/fulfillment_policy", { body: {
    name: POLICY, marketplaceId: "EBAY_US",
    categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }],
    handlingTime: base?.handlingTime || { value: 3, unit: "DAY" },
    shipToLocations: { regionIncluded: [{ regionName: "US" }] },
    shippingOptions: [{ optionType: "DOMESTIC", costType: "FLAT_RATE",
      shippingServices: [{ sortOrder: 1, shippingCarrierCode: "USPS", shippingServiceCode: "USPSFirstClass", freeShipping: true,
        shippingCost: { value: "0.0", currency: "USD" } }] }],
  } });
  return String(c.fulfillmentPolicyId);
}

async function removeFromSales(ids: Set<string>): Promise<string[]> {
  const notes: string[] = [];
  const j = await rest("GET", "/sell/marketing/v1/promotion", { query: { marketplace_id: "EBAY_US", promotion_type: "MARKDOWN_SALE", promotion_status: "RUNNING", limit: "50" } });
  for (const p of j.promotions || []) {
    const pid = String(p.promotionId || "").split("/").pop()!;
    const m = await rest("GET", `/sell/marketing/v1/item_price_markdown/${encodeURIComponent(pid)}`, {});
    let changed = false;
    for (const d of m.selectedInventoryDiscounts || []) {
      const ls: string[] = (d.inventoryCriterion?.listingIds || []).map(String);
      const keep = ls.filter((x) => !ids.has(x));
      if (keep.length !== ls.length) { d.inventoryCriterion.listingIds = keep; changed = true; }
    }
    if (!changed) continue;
    const body: any = { ...m };
    if (!body.description) body.description = body.name || "Sale";
    delete (body as any).promotionId; delete (body as any).promotionHref; delete (body as any).priority;
    await rest("PUT", `/sell/marketing/v1/item_price_markdown/${encodeURIComponent(pid)}`, { body });
    notes.push(`removed from sale "${m.name}"`);
  }
  return notes;
}

export async function toEnvelope(items: { item_id: string; price?: number }[]) {
  // Your account doesn't use business policies, so shipping is set on each listing.
  const policyId = await envelopePolicyId().catch(() => "");
  const saleNotes = await removeFromSales(new Set(items.map((i) => String(i.item_id)))).catch((e) => [`sale removal failed: ${(e as Error).message.slice(0, 160)}`]);
  const out: any[] = [];
  for (const q of items) {
    try {
      if (isProtected(q.item_id, "")) throw new Error("protected listing");
      // GetItem only to keep the package weight/size; if eBay's daily GetItem limit is hit, go without it.
      let it: any = {};
      try { const r = await trading("GetItem", { ItemID: q.item_id }); it = (Array.isArray(r.Item) ? r.Item[0] : r.Item) || {}; } catch { /* limit */ }
      if (isProtected(q.item_id, String(val(it.Title) || ""))) throw new Error("protected listing");
      const item: any = { ItemID: q.item_id,
        ShippingPackageDetails: { ...(it.ShippingPackageDetails || {}), ShippingPackage: "LargeEnvelope" } };
      if (policyId) item.SellerProfiles = { SellerShippingProfile: { ShippingProfileID: policyId } };
      else item.ShippingDetails = { ShippingType: "Flat",
        ShippingServiceOptions: [{ ShippingServicePriority: 1, ShippingService: "USPSFirstClass", ShippingServiceCost: "0.00", FreeShipping: "true" }] };
      if (q.price && !arr(it.Variations?.Variation).length) item.StartPrice = q.price.toFixed(2);
      await trading("ReviseFixedPriceItem", { Item: item });
      out.push({ item_id: q.item_id, ok: true, price: q.price });
    } catch (e) { out.push({ item_id: q.item_id, ok: false, error: (e as Error).message.slice(0, 300) }); }
  }
  return { ok: true, policy: POLICY, policyId, sale: saleNotes, results: out };
}
