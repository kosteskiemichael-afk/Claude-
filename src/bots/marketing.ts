// Marketing bot: caps Promoted Listings ad rates. It never lowers an ad you set
// at or below max_ad_rate (default 5%). Ads above the cap are brought down to it.
// Listings that sold in the last 30 days are raised to boost_sellers_rate (4%) for more
// visibility. Per-listing rates in marketing.ad_rates are set exactly. Burr holders are never touched.
import { rest } from "../ebay.js";
import { BotConfig, Listing, Report, short } from "./shared.js";
import type { Traffic } from "./inventory.js";

export async function marketingBot(cfg: BotConfig, listings: Listing[], r: Report, traffic?: Map<string, Traffic>) {
  const target = cfg.marketing.target_ad_rate;
  const cap = cfg.marketing.max_ad_rate ?? 5;
  const fixed = cfg.marketing.ad_rates || {};
  const boost = Math.min(cfg.marketing.boost_sellers_rate ?? 0, cap);
  const byId = new Map(listings.map((l) => [l.item_id, l]));
  const j = await rest("GET", "/sell/marketing/v1/ad_campaign", { query: { limit: "100" } });
  const campaigns = (j.campaigns || []).filter(
    (c: any) => c.campaignStatus === "RUNNING" && (c.fundingStrategy?.fundingModel ?? "COST_PER_SALE") === "COST_PER_SALE",
  );
  if (!campaigns.length) { r.info.push("No running Promoted Listings (cost-per-sale) campaign found."); return; }

  const promoted = new Set<string>();
  let lowered = 0;
  for (const c of campaigns) {
    if (c.fundingStrategy?.adRateStrategy === "DYNAMIC") {
      r.urgent.push(`Ad campaign "${c.campaignName}" uses eBay's dynamic ad rate, which bots can't lower. In Seller Hub > Advertising, switch it to a fixed ${target}% rate.`);
    }
    const ads: any[] = [];
    for (let offset = 0; offset < 5000; offset += 500) {
      const a = await rest("GET", `/sell/marketing/v1/ad_campaign/${c.campaignId}/ad`, {
        query: { limit: "500", offset: String(offset) },
      });
      ads.push(...(a.ads || []));
      if ((a.ads || []).length < 500) break;
    }
    for (const ad of ads) {
      const id = String(ad.listingId);
      promoted.add(id);
      const l = byId.get(id);
      if (!l || l.protected) continue;
      const rate = Number(ad.bidPercentage);
      if (!isFinite(rate)) continue;
      const selling = (traffic?.get(id)?.sold ?? 0) > 0;
      // Your fixed rate wins; else cap at max; else raise listings that sold in the last 30 days to the boost rate.
      const want = fixed[id] !== undefined ? Number(fixed[id]) : rate > cap + 0.001 ? cap : selling && rate < boost - 0.001 ? boost : rate;
      if (Math.abs(want - rate) < 0.001) continue;
      if (!cfg.dry_run) {
        try {
          await rest("POST", `/sell/marketing/v1/ad_campaign/${c.campaignId}/ad/${ad.adId}/update_bid`, {
            body: { bidPercentage: want.toFixed(1) },
          });
        } catch (e) {
          r.info.push(`Couldn't change ad on ${short(l.title)}: ${(e as Error).message.slice(0, 100)}`);
          continue;
        }
      }
      lowered++;
      r.changes.push(`Ad rate ${rate}% → ${want}%: ${short(l.title)}`);
    }
  }

  if (cfg.marketing.add_unpromoted) {
    const missing = listings.filter((l) => !l.protected && !promoted.has(l.item_id));
    const c = campaigns.find((x: any) => x.fundingStrategy?.adRateStrategy !== "DYNAMIC");
    if (c && missing.length) {
      if (!cfg.dry_run) {
        await rest("POST", `/sell/marketing/v1/ad_campaign/${c.campaignId}/bulk_create_ads_by_listing_id`, {
          body: { requests: missing.slice(0, 500).map((l) => ({ listingId: l.item_id, bidPercentage: target.toFixed(1) })) },
        });
      }
      r.changes.push(`Promoted ${missing.length} new listing(s) at ${target}%.`);
    }
  }
  if (lowered === 0) r.info.push(`No ad rate changes needed (cap ${cap}%; your own rates kept).`);
}
