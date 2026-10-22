// Listing & inventory bot: keeps print-on-demand listings stocked so they never
// end as "out of stock" (which kills search ranking), and flags dead listings.
import { BotConfig, Listing, Report, setPriceQty, short } from "./shared.js";

export async function inventoryBot(cfg: BotConfig, listings: Listing[], r: Report, traffic?: Map<string, Traffic>) {
  const { restock_below, restock_to } = cfg.inventory;
  const restock: { item_id: string; title: string; quantity: number }[] = [];

  for (const l of listings) {
    if (l.quantity_available >= restock_below) continue;
    if (l.protected) {
      r.urgent.push(`Burr holder stock low (${l.quantity_available} left): ${short(l.title)}. Restock it yourself; the bots never touch it.`);
      continue;
    }
    if (l.has_variations) {
      r.info.push(`Low stock on a variation listing, restock by hand: ${short(l.title)}`);
      continue;
    }
    restock.push({ item_id: l.item_id, title: l.title, quantity: restock_to });
  }

  if (restock.length) {
    const warn = await setPriceQty(cfg, restock);
    for (const c of restock) r.changes.push(`Restocked to ${c.quantity}: ${short(c.title)}`);
    warn.forEach((w) => r.info.push(`eBay note: ${w}`));
  }

  // Dead listings: seen in search but nobody buys (morning run only, traffic passed in).
  if (traffic) {
    const dead = listings
      .filter((l) => !l.protected)
      .map((l) => ({ l, t: traffic.get(l.item_id) }))
      .filter((x) => x.t && x.t.views >= 25 && x.t.sold === 0)
      .sort((a, b) => b.t!.views - a.t!.views)
      .slice(0, 5);
    if (dead.length) {
      r.info.push(
        "Views but no sales in 30 days (check price/photos): " +
          dead.map((d) => `${short(d.l.title, 28)} (${d.t!.views} views)`).join("; "),
      );
    }
  }
}

export type Traffic = { impressions: number; views: number; sold: number };
