// Price report: for EVERY active listing, what the buyer pays (item + shipping) vs the cheapest
// verified competitor selling the same printed part. Read-only: it never changes a price.
import { matchCompetitors, MatchInput, planSearches, brainOn } from "./brain.js";
import { findCompetitors, Competitor } from "./pricing.js";
import { profitAt, shipInfo, adRates, Ship } from "./profit.js";
import { activeListings, loadConfig } from "./shared.js";

export type PriceRow = {
  item_id: string; title: string; protected: boolean; variations: boolean;
  price: number; buyer_ship: number; ship_kind: string; delivered: number;
  profit: number; margin: number;
  competitors: number; cheapest: number | null; cheapest_seller: string; cheapest_title: string;
  gap: number | null; verdict: string;
};

export async function priceReport(log: (s: string) => void = () => {}): Promise<PriceRow[]> {
  const cfg = loadConfig();
  const listings = await activeListings();
  const ships = await shipInfo(cfg, listings);
  const ads = await adRates().catch(() => new Map<string, number>());
  const shipOf = (id: string): Ship => ships.get(id) || { kind: "calculated", buyer: cfg.pricing.calc_ship_estimate ?? 5.51 };
  log(`${listings.length} listings`);
  const comps = new Map<string, Competitor[]>();

  // Hand-written rules first, then the brain plans searches for the rest.
  for (const [id, rule] of Object.entries(cfg.pricing.rules)) {
    if (!listings.find((l) => l.item_id === id)) continue;
    try { comps.set(id, (await findCompetitors(cfg, rule)).sort((a, b) => a.total - b.total)); } catch { /* skip */ }
  }
  if (brainOn()) {
    const rest = listings.filter((l) => !cfg.pricing.rules[l.item_id]);
    for (let i = 0; i < rest.length; i += 40) {
      const chunk = rest.slice(i, i + 40);
      const plans = (await planSearches(chunk.map((l) => ({ item_id: l.item_id, title: l.title })))).filter((p) => !p.skip);
      const inputs: MatchInput[] = []; const pools = new Map<string, Competitor[]>();
      for (const p of plans) {
        const l = chunk.find((x) => x.item_id === String(p.item_id)); if (!l) continue;
        const words = (p.must_include || []).map(String);
        try {
          const pool = (await findCompetitors(cfg, { query: p.query, must_include: words }, Math.ceil(words.length / 2)))
            .sort((a, b) => a.total - b.total).slice(0, 25);
          if (!pool.length) continue;
          pools.set(l.item_id, pool);
          inputs.push({ item_id: l.item_id, title: l.title, pack_qty: p.pack_qty || 1, candidates: pool.map((c, j) => ({ i: j, title: c.title, total: c.total })) });
        } catch { /* skip */ }
      }
      const matched = await matchCompetitors(inputs).catch(() => new Map());
      for (const inp of inputs) {
        const m = matched.get(inp.item_id); const pool = pools.get(inp.item_id)!;
        if (!m) continue;
        comps.set(inp.item_id, (m.matches || []).filter((x: any) => pool[x.i])
          .map((x: any) => ({ ...pool[x.i], total: (pool[x.i].total / Math.max(1, x.their_pack_qty || 1)) * inp.pack_qty }))
          .sort((a: Competitor, b: Competitor) => a.total - b.total));
      }
      log(`checked ${Math.min(i + 40, rest.length)}/${rest.length}`);
    }
  }

  const rows: PriceRow[] = listings.map((l) => {
    const sh = shipOf(l.item_id); const ad = ads.get(l.item_id) ?? 0;
    const pr = profitAt(cfg, l.item_id, l.price, sh, ad);
    const delivered = Math.round((l.price + sh.buyer) * 100) / 100;
    const c = comps.get(l.item_id) || [];
    const low = c[0];
    const gap = low ? Math.round((delivered - low.total) * 100) / 100 : null;
    const verdict = !low ? "No matching competitor found" : gap! <= 0 ? "Cheapest" : gap! <= 1 ? "Within $1" : gap! <= 3 ? `$${gap!.toFixed(2)} higher` : `OVERPRICED by $${gap!.toFixed(2)}`;
    return { item_id: l.item_id, title: l.title, protected: l.protected, variations: l.has_variations,
      price: l.price, buyer_ship: sh.buyer, ship_kind: sh.kind, delivered,
      profit: Math.round(pr.profit * 100) / 100, margin: Math.round(pr.margin * 100),
      competitors: c.length, cheapest: low ? Math.round(low.total * 100) / 100 : null,
      cheapest_seller: low?.seller || "", cheapest_title: low?.title || "", gap, verdict };
  });
  rows.sort((a, b) => (b.gap ?? -99) - (a.gap ?? -99));
  return rows;
}
