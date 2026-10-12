// MCP tools exposed to Claude. Write tools preview by default and only change
// eBay when called with confirm: true. Protected listings can never be changed.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MARKETPLACE, rest, trading, tradingWarnings } from "./ebay.js";

// ---------------- helpers ----------------
const val = (x: any): string | undefined =>
  x === undefined || x === null ? undefined : typeof x === "object" ? x["#text"] : String(x);
const num = (x: any): number | undefined => {
  const v = val(x);
  return v === undefined || v === "" ? undefined : Number(v);
};
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

const PROTECTED_IDS = new Set(
  (process.env.PROTECTED_ITEM_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
);
const PROTECTED_WORDS = (process.env.PROTECTED_TITLE_KEYWORDS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

function assertWritable(itemId: string, title?: string) {
  if (PROTECTED_IDS.has(itemId)) throw new Error(`Listing ${itemId} is protected and can't be changed.`);
  const t = (title || "").toLowerCase();
  const hit = PROTECTED_WORDS.find((w) => t.includes(w));
  if (hit) throw new Error(`Listing ${itemId} ("${title}") matches protected keyword "${hit}" and can't be changed.`);
}

async function getItem(itemId: string): Promise<any> {
  const r = await trading("GetItem", {
    ItemID: itemId,
    DetailLevel: "ReturnAll",
    IncludeItemSpecifics: "true",
  });
  return r.Item?.[0] ?? r.Item;
}

function summarize(item: any) {
  const ship = (item.ShippingDetails?.ShippingServiceOptions || []).map((o: any) => ({
    service: o.ShippingService,
    cost: num(o.ShippingServiceCost),
    free: o.FreeShipping === "true",
  }));
  const specifics = Object.fromEntries(
    (item.ItemSpecifics?.NameValueList || []).map((nv: any) => [nv.Name, (nv.Value || []).map(String)]),
  );
  const variations = (item.Variations?.Variation || []).map((v: any) => ({
    sku: v.SKU,
    price: num(v.StartPrice),
    quantity: num(v.Quantity),
    sold: num(v.SellingStatus?.QuantitySold),
    specifics: Object.fromEntries(
      (v.VariationSpecifics?.NameValueList || []).map((nv: any) => [nv.Name, (nv.Value || []).join(", ")]),
    ),
  }));
  return {
    item_id: item.ItemID,
    title: item.Title,
    url: item.ListingDetails?.ViewItemURL,
    price: num(item.StartPrice),
    current_price: num(item.SellingStatus?.CurrentPrice),
    quantity: num(item.Quantity),
    sold: num(item.SellingStatus?.QuantitySold),
    watchers: num(item.WatchCount),
    handling_days: num(item.DispatchTimeMax),
    best_offer: item.BestOfferDetails?.BestOfferEnabled === "true",
    shipping_type: item.ShippingDetails?.ShippingType,
    shipping: ship,
    photos: (item.PictureDetails?.PictureURL || []).length,
    category: item.PrimaryCategory?.CategoryName,
    item_specifics: specifics,
    variations: variations.length ? variations : undefined,
    protected: (() => { try { assertWritable(String(item.ItemID), item.Title); return false; } catch { return true; } })(),
  };
}

function ymd(d: Date) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// ---------------- tools ----------------
export function registerTools(server: McpServer) {
  server.registerTool(
    "list_active_listings",
    {
      title: "List active listings",
      description:
        "Lists the seller's active eBay listings with price, quantity available, quantity sold, watchers and shipping cost. Paginated (up to 200 per page).",
      inputSchema: {
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(200).default(200),
      },
    },
    async ({ page, per_page }) => {
      try {
        const r = await trading("GetMyeBaySelling", {
          ActiveList: { Include: "true", Pagination: { EntriesPerPage: per_page, PageNumber: page } },
          DetailLevel: "ReturnAll",
        });
        const al = r.ActiveList || {};
        const items = (al.ItemArray?.Item || []).map((it: any) => {
          const qty = num(it.Quantity);
          const avail = num(it.QuantityAvailable);
          const opt = it.ShippingDetails?.ShippingServiceOptions?.[0];
          return {
            item_id: it.ItemID,
            title: it.Title,
            sku: it.SKU,
            price: num(it.SellingStatus?.CurrentPrice ?? it.BuyItNowPrice ?? it.StartPrice),
            quantity_available: avail,
            sold: num(it.SellingStatus?.QuantitySold) ?? (qty !== undefined && avail !== undefined ? qty - avail : undefined),
            watchers: num(it.WatchCount),
            shipping_cost: opt ? num(opt.ShippingServiceCost) : undefined,
            has_variations: !!it.Variations,
            url: it.ListingDetails?.ViewItemURL,
          };
        });
        return ok({
          page,
          total_pages: num(al.PaginationResult?.TotalNumberOfPages),
          total_listings: num(al.PaginationResult?.TotalNumberOfEntries),
          listings: items,
        });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "get_listing",
    {
      title: "Get listing details",
      description:
        "Full details for one listing: price, quantity, sold, handling time, shipping options, item specifics, variations (with SKUs), photo count, and whether it is protected.",
      inputSchema: { item_id: z.string().describe("12-digit eBay item number") },
    },
    async ({ item_id }) => {
      try { return ok(summarize(await getItem(item_id))); } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "update_price_quantity",
    {
      title: "Update price / quantity",
      description:
        "Changes price and/or quantity on one or more listings (variation listings need the variation SKU). Without confirm: true it only returns a preview of current vs new values. Protected listings are refused.",
      inputSchema: {
        updates: z
          .array(
            z.object({
              item_id: z.string(),
              sku: z.string().optional().describe("Required for listings with variations"),
              price: z.number().positive().optional(),
              quantity: z.number().int().min(0).optional(),
            }),
          )
          .min(1)
          .max(50),
        confirm: z.boolean().default(false),
      },
    },
    async ({ updates, confirm }) => {
      try {
        const preview = [];
        for (const u of updates) {
          if (u.price === undefined && u.quantity === undefined) throw new Error(`Nothing to change for ${u.item_id}`);
          const s = summarize(await getItem(u.item_id));
          assertWritable(u.item_id, s.title);
          let curPrice = s.price, curQty = s.quantity;
          if (s.variations) {
            if (!u.sku) throw new Error(`${u.item_id} has variations; pass the variation sku (see get_listing).`);
            const v = s.variations.find((x: any) => x.sku === u.sku);
            if (!v) throw new Error(`SKU ${u.sku} not found on ${u.item_id}`);
            curPrice = v.price; curQty = v.quantity;
          }
          preview.push({ item_id: u.item_id, sku: u.sku, title: s.title,
            price: { from: curPrice, to: u.price ?? curPrice },
            quantity: { from: curQty, to: u.quantity ?? curQty } });
        }
        if (!confirm) return ok({ preview_only: true, note: "Call again with confirm: true to apply.", changes: preview });

        const results = [];
        for (let i = 0; i < updates.length; i += 4) {
          const chunk = updates.slice(i, i + 4);
          const r = await trading("ReviseInventoryStatus", {
            InventoryStatus: chunk.map((u) => ({
              ItemID: u.item_id,
              ...(u.sku ? { SKU: u.sku } : {}),
              ...(u.price !== undefined ? { StartPrice: u.price.toFixed(2) } : {}),
              ...(u.quantity !== undefined ? { Quantity: u.quantity } : {}),
            })),
          });
          results.push({ applied: chunk.map((c) => c.item_id), warnings: tradingWarnings(r) });
        }
        return ok({ applied: true, changes: preview, results });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "revise_listing",
    {
      title: "Revise listing details",
      description:
        "Changes title, handling time, Best Offer, and/or item specifics on one listing. Item specifics are merged with the existing ones (set a value to null to remove that specific). Without confirm: true it only returns a preview. Protected listings are refused.",
      inputSchema: {
        item_id: z.string(),
        title: z.string().max(80).optional(),
        handling_days: z.number().int().min(0).max(30).optional(),
        best_offer: z.boolean().optional(),
        item_specifics: z.record(z.array(z.string()).nullable()).optional()
          .describe('e.g. {"Brand":["Nexa"],"Compatible Brand":["Logan"],"Model Year":null}'),
        confirm: z.boolean().default(false),
      },
    },
    async ({ item_id, title, handling_days, best_offer, item_specifics, confirm }) => {
      try {
        const s = summarize(await getItem(item_id));
        assertWritable(item_id, s.title);
        let merged: Record<string, string[]> | undefined;
        if (item_specifics) {
          merged = { ...s.item_specifics } as Record<string, string[]>;
          for (const [k, v] of Object.entries(item_specifics)) {
            if (v === null || v.length === 0) delete merged[k];
            else merged[k] = v;
          }
        }
        const preview = {
          item_id, current_title: s.title,
          title: title !== undefined ? { from: s.title, to: title } : undefined,
          handling_days: handling_days !== undefined ? { from: s.handling_days, to: handling_days } : undefined,
          best_offer: best_offer !== undefined ? { from: s.best_offer, to: best_offer } : undefined,
          item_specifics: merged ? { from: s.item_specifics, to: merged } : undefined,
        };
        if (!confirm) return ok({ preview_only: true, note: "Call again with confirm: true to apply.", changes: preview });

        const Item: Record<string, unknown> = { ItemID: item_id };
        if (title !== undefined) Item.Title = title;
        if (handling_days !== undefined) Item.DispatchTimeMax = handling_days;
        if (best_offer !== undefined) Item.BestOfferDetails = { BestOfferEnabled: String(best_offer) };
        if (merged) {
          Item.ItemSpecifics = {
            NameValueList: Object.entries(merged).map(([Name, Value]) => ({ Name, Value })),
          };
        }
        const r = await trading("ReviseFixedPriceItem", { Item });
        return ok({ applied: true, changes: preview, warnings: tradingWarnings(r) });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "get_orders",
    {
      title: "Get recent orders",
      description: "Recent orders with items, quantities, totals and fulfillment status (no buyer addresses).",
      inputSchema: {
        days: z.number().int().min(1).max(90).default(30),
        limit: z.number().int().min(1).max(200).default(100),
      },
    },
    async ({ days, limit }) => {
      try {
        const since = new Date(Date.now() - days * 86400_000).toISOString();
        const j = await rest("GET", "/sell/fulfillment/v1/order", {
          query: { filter: `creationdate:[${since}..]`, limit: String(limit) },
        });
        const orders = (j.orders || []).map((o: any) => ({
          order_id: o.orderId,
          date: o.creationDate,
          status: o.orderFulfillmentStatus,
          total: Number(o.pricingSummary?.total?.value),
          shipping_charged: Number(o.pricingSummary?.deliveryCost?.value ?? 0),
          items: (o.lineItems || []).map((li: any) => ({
            item_id: li.legacyItemId, title: li.title, sku: li.sku,
            quantity: li.quantity, price: Number(li.lineItemCost?.value),
          })),
        }));
        return ok({ days, count: orders.length, total_available: j.total, orders });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "get_traffic_report",
    {
      title: "Listing traffic report",
      description:
        "Per-listing impressions, views, click-through rate, quantity sold and conversion rate for the last N days (max 90), ending yesterday.",
      inputSchema: {
        days: z.number().int().min(1).max(90).default(30),
        item_ids: z.array(z.string()).max(200).optional().describe("Limit to these listings"),
      },
    },
    async ({ days, item_ids }) => {
      try {
        const end = new Date(Date.now() - 86400_000);
        const start = new Date(end.getTime() - (days - 1) * 86400_000);
        let filter = `marketplace_ids:{${MARKETPLACE}},date_range:[${ymd(start)}..${ymd(end)}]`;
        if (item_ids?.length) filter += `,listing_ids:{${item_ids.join("|")}}`;
        const metrics = [
          "LISTING_IMPRESSION_TOTAL", "LISTING_VIEWS_TOTAL", "CLICK_THROUGH_RATE",
          "TRANSACTION", "SALES_CONVERSION_RATE",
        ];
        const j = await rest("GET", "/sell/analytics/v1/traffic_report", {
          query: { dimension: "LISTING", filter, metric: metrics.join(",") },
        });
        const keys: string[] = (j.header?.metrics || []).map((m: any) => m.key);
        const rows = (j.records || []).map((rec: any) => {
          const row: Record<string, unknown> = { item_id: rec.dimensionValues?.[0]?.value };
          keys.forEach((k, i) => { row[k.toLowerCase()] = rec.metricValues?.[i]?.value; });
          return row;
        });
        return ok({ from: ymd(start), to: ymd(end), listings: rows });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "search_market",
    {
      title: "Search competitor listings",
      description:
        "Searches live (active) eBay listings for competitor research: price, shipping cost, seller and feedback. eBay's API does not provide sold counts.",
      inputSchema: {
        query: z.string().min(2),
        limit: z.number().int().min(1).max(100).default(30),
        sort: z.enum(["best_match", "price", "-price", "newlyListed"]).default("best_match"),
      },
    },
    async ({ query, limit, sort }) => {
      try {
        const q: Record<string, string> = { q: query, limit: String(limit), filter: "buyingOptions:{FIXED_PRICE}" };
        if (sort !== "best_match") q.sort = sort;
        const j = await rest("GET", "/buy/browse/v1/item_summary/search", { query: q, app: true });
        const items = (j.itemSummaries || []).map((it: any) => ({
          title: it.title,
          price: Number(it.price?.value),
          shipping: it.shippingOptions?.[0]?.shippingCost ? Number(it.shippingOptions[0].shippingCost.value) : undefined,
          seller: it.seller?.username,
          seller_feedback_pct: it.seller?.feedbackPercentage,
          condition: it.condition,
          url: it.itemWebUrl,
        }));
        return ok({ query, total: j.total, results: items });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "get_promoted_listings",
    {
      title: "Promoted Listings campaigns and ad rates",
      description: "Lists Promoted Listings campaigns and, for each, the listings in it with their ad rate (%).",
      inputSchema: { include_ads: z.boolean().default(true) },
    },
    async ({ include_ads }) => {
      try {
        const j = await rest("GET", "/sell/marketing/v1/ad_campaign", { query: { limit: "50" } });
        const campaigns = [];
        for (const c of j.campaigns || []) {
          const entry: Record<string, unknown> = {
            campaign_id: c.campaignId, name: c.campaignName, status: c.campaignStatus,
            funding_model: c.fundingStrategy?.fundingModel,
            default_ad_rate: c.fundingStrategy?.bidPercentage,
          };
          if (include_ads && c.fundingStrategy?.fundingModel === "COST_PER_SALE") {
            const a = await rest("GET", `/sell/marketing/v1/ad_campaign/${c.campaignId}/ad`, { query: { limit: "500" } });
            entry.ads = (a.ads || []).map((ad: any) => ({
              ad_id: ad.adId, item_id: ad.listingId, ad_rate: ad.bidPercentage, status: ad.adStatus,
            }));
          }
          campaigns.push(entry);
        }
        return ok({ campaigns });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "update_ad_rate",
    {
      title: "Change Promoted Listings ad rate",
      description:
        "Sets the ad rate (%) for listings in a Promoted Listings (cost-per-sale) campaign. Without confirm: true it only returns a preview. Protected listings are refused.",
      inputSchema: {
        campaign_id: z.string(),
        updates: z.array(z.object({ item_id: z.string(), ad_rate: z.number().min(2).max(100) })).min(1).max(100),
        confirm: z.boolean().default(false),
      },
    },
    async ({ campaign_id, updates, confirm }) => {
      try {
        const a = await rest("GET", `/sell/marketing/v1/ad_campaign/${campaign_id}/ad`, { query: { limit: "500" } });
        const byItem = new Map<string, any>((a.ads || []).map((ad: any) => [String(ad.listingId), ad]));
        const plan = [];
        for (const u of updates) {
          const ad = byItem.get(u.item_id);
          if (!ad) throw new Error(`Listing ${u.item_id} is not in campaign ${campaign_id}`);
          const s = summarize(await getItem(u.item_id));
          assertWritable(u.item_id, s.title);
          plan.push({ item_id: u.item_id, title: s.title, ad_id: ad.adId, ad_rate: { from: ad.bidPercentage, to: u.ad_rate } });
        }
        if (!confirm) return ok({ preview_only: true, note: "Call again with confirm: true to apply.", changes: plan });
        for (const p of plan) {
          await rest("POST", `/sell/marketing/v1/ad_campaign/${campaign_id}/ad/${p.ad_id}/update_bid`, {
            body: { bidPercentage: p.ad_rate.to.toFixed(1) },
          });
        }
        return ok({ applied: true, changes: plan });
      } catch (e) { return fail(e); }
    },
  );
}
