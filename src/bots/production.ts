// Production bot: turns unshipped orders into a print queue, most urgent first.
import { Order, Report, short } from "./shared.js";

export function productionBot(unshipped: Order[], since: Date, fullQueue: boolean, r: Report) {
  const newOrders = unshipped.filter((o) => Date.parse(o.created) >= since.getTime());
  if (!fullQueue && !newOrders.length) return;

  const parts = new Map<string, { title: string; qty: number; shipBy: number }>();
  for (const o of unshipped) {
    const by = o.ship_by ? Date.parse(o.ship_by) : Infinity;
    for (const it of o.items) {
      const p = parts.get(it.item_id) || { title: it.title, qty: 0, shipBy: Infinity };
      p.qty += it.quantity;
      p.shipBy = Math.min(p.shipBy, by);
      parts.set(it.item_id, p);
    }
  }
  if (!parts.size) { if (fullQueue) r.info.push("Print queue empty: no unshipped orders."); return; }

  const day = (t: number) =>
    isFinite(t) ? new Date(t).toLocaleDateString("en-US", { weekday: "short", timeZone: "America/Indianapolis" }) : "?";
  const lines = [...parts.values()]
    .sort((a, b) => a.shipBy - b.shipBy)
    .map((p) => `${p.qty}× ${short(p.title, 34)} (ship ${day(p.shipBy)})`);
  const head = newOrders.length ? `${newOrders.length} new order(s). ` : "";
  r.info.unshift(`${head}PRINT QUEUE:\n` + lines.join("\n"));
}
