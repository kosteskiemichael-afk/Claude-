// Listings board: every active listing in one table — price, shipping, status, ads, traffic, profit,
// and the competition (top seller + cheapest) from the latest competition check. Cached so it can
// refresh every minute without burning eBay's daily call limits.
import { activeListings, loadConfig, saleListingIds, Listing } from "./bots/shared.js";
import { adRates, floorPrice, profitAt, shipInfo, Ship } from "./bots/profit.js";

type Row = {
  id: string; title: string; price: number; qty: number; sold_total: number; variations: boolean; protected: boolean; on_sale: boolean;
  ship_kind: string; ship_buyer: number; delivered: number; ad: number | null;
  impressions: number; views: number; ctr: number; sold30: number; conv: number;
  profit: number; margin: number; floor: number; stage: string;
  photos: number | null; top: any; cheapest: any; competitors: number; gap: number | null; fixes: string[]; checked: string | null;
};

let cache: { at: number; rows: Row[]; listingsAt: number } | null = null;
let listingsCache: { at: number; ls: Listing[] } | null = null;
let trafficCache: { at: number; t: Map<string, any> } | null = null;
let adsCache: { at: number; a: Map<string, number> } | null = null;
let saleCache: { at: number; s: Set<string> } | null = null;
const fresh = (c: { at: number } | null, ms: number) => !!c && Date.now() - c.at < ms;

export async function listingRows(force = false): Promise<{ at: number; listingsAt: number; rows: Row[] }> {
  if (!force && fresh(cache, 60_000)) return cache!;
  const cfg = loadConfig();
  if (force || !fresh(listingsCache, 5 * 60_000)) { const { listingsFetchedAt } = await import("./bots/shared.js"); const ls = await activeListings(force ? 60_000 : 5 * 60_000); listingsCache = { at: listingsFetchedAt() || Date.now(), ls }; } // shared, max 1 eBay call / 5 min
  if (!fresh(trafficCache, 60 * 60_000)) { const { trafficMap } = await import("./bots/run.js"); trafficCache = { at: Date.now(), t: await trafficMap().catch(() => new Map()) }; } // traffic: hourly
  if (!fresh(adsCache, 30 * 60_000)) adsCache = { at: Date.now(), a: await adRates().catch(() => new Map()) };
  if (!fresh(saleCache, 60 * 60_000)) saleCache = { at: Date.now(), s: await saleListingIds().catch(() => new Set<string>()) };
  const ls = listingsCache!.ls;
  const ships = await shipInfo(cfg, ls).catch(() => new Map<string, Ship>());
  const { competeJob } = await import("./bots/compete.js");
  const comp = new Map((competeJob.rows || []).map((r) => [r.item_id, r]));
  const rows: Row[] = ls.map((l) => {
    const sh = ships.get(l.item_id) || { kind: "calculated", buyer: cfg.pricing.calc_ship_estimate ?? 5.51 } as Ship;
    const ad = adsCache!.a.has(l.item_id) ? adsCache!.a.get(l.item_id)! : null;
    const t = trafficCache!.t.get(l.item_id) || { impressions: 0, views: 0, sold: 0 };
    const p = profitAt(cfg, l.item_id, l.price, sh, ad ?? 0);
    const c = comp.get(l.item_id);
    const delivered = Math.round((l.price + sh.buyer) * 100) / 100;
    const best = c?.top || c?.cheapest;
    const stage = c?.stage || (t.impressions < 150 ? "not shown (search)" : t.views && t.impressions && t.views / t.impressions < 0.008 ? "shown, not clicked" : t.views >= 12 && !t.sold ? "clicked, not bought" : t.sold ? "selling" : "low traffic");
    return {
      id: l.item_id, title: l.title, price: l.price, qty: l.quantity_available, sold_total: l.sold, variations: l.has_variations, protected: l.protected,
      on_sale: saleCache!.s.has(l.item_id) || !!l.on_sale, ship_kind: sh.kind, ship_buyer: sh.buyer, delivered, ad,
      impressions: t.impressions, views: t.views, ctr: t.impressions ? Math.round((t.views / t.impressions) * 1000) / 10 : 0, sold30: t.sold,
      conv: t.views ? Math.round((t.sold / t.views) * 1000) / 10 : 0,
      profit: Math.round(p.profit * 100) / 100, margin: Math.round(p.margin * 100), floor: floorPrice(cfg, l.item_id, sh, ad ?? 0), stage,
      photos: c?.mine ? c.mine.photos : null,
      top: c?.top ? { seller: c.top.seller, delivered: c.top.delivered, sold: c.top.sold, free: c.top.freeShip, photos: c.top.photos, url: c.top.url } : null,
      cheapest: c?.cheapest ? { seller: c.cheapest.seller, delivered: c.cheapest.delivered, sold: c.cheapest.sold, free: c.cheapest.freeShip, url: c.cheapest.url } : null,
      competitors: c?.competitors ?? 0, gap: best ? Math.round((delivered - best.delivered) * 100) / 100 : null,
      fixes: (c?.fixes || []).slice(0, 3).map((f) => f.what), checked: competeJob.finished || null,
    };
  });
  cache = { at: Date.now(), rows, listingsAt: listingsCache!.at };
  return cache;
}

export function listingsPage(secret: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexa Listings</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--line:#2b3340;--tx:#e6edf3;--mut:#8b98a5;--acc:#3fb950;--warn:#d29922;--bad:#f85149;--blue:#58a6ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}
.wrap{padding:14px}h1{font-size:20px;margin:0 0 2px}.mut{color:var(--mut)}a{color:var(--blue);text-decoration:none}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}
button,select,input{background:var(--card);color:var(--tx);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font:inherit}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:8px 0}
.k{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px}.k b{display:block;font-size:18px}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;min-width:1500px}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{position:sticky;top:0;background:#1c2330;color:var(--mut);font-weight:500;cursor:pointer;user-select:none}
td.t{white-space:normal;min-width:260px;max-width:340px}tr:hover td{background:#1a2029}
.pill{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11px;border:1px solid var(--line);color:var(--mut)}
.g{color:var(--acc)}.y{color:var(--warn)}.r{color:var(--bad)}.b{color:var(--blue)}
.fx{font-size:11px;color:var(--mut);white-space:normal;max-width:280px}
</style></head><body><div class="wrap">
<h1>📋 All listings</h1><div class="mut" id="status">Loading…</div>
<div class="kpis" id="kpis"></div>
<div class="row">
<input id="q" placeholder="Search title or item #" size="28">
<select id="stage"><option value="">All stages</option><option>selling</option><option>not shown (search)</option><option>shown, not clicked</option><option>clicked, not bought</option><option>low traffic</option></select>
<select id="ship"><option value="">All shipping</option><option value="free">Free shipping</option><option value="calculated">Calculated</option><option value="flat">Flat</option></select>
<select id="comp"><option value="">All</option><option value="over">More expensive than competition</option><option value="under">Cheaper than competition</option><option value="none">No competitor</option></select>
<select id="ads"><option value="">All ads</option><option value="on">Promoted</option><option value="off">Not promoted</option></select>
<button id="refresh">Refresh from eBay now</button><a href="/compete/${secret}" target="_blank"><button>🏁 Competition details</button></a>
</div>
<div class="tw"><table><thead><tr>
<th data-k="title">Listing</th><th data-k="price">Price</th><th data-k="ship_buyer">Shipping</th><th data-k="delivered">Delivered</th>
<th data-k="qty">Qty</th><th data-k="stage">Status</th><th data-k="ad">Ad %</th>
<th data-k="impressions">Shown 30d</th><th data-k="views">Clicks</th><th data-k="ctr">CTR %</th><th data-k="sold30">Sold 30d</th><th data-k="conv">Conv %</th><th data-k="sold_total">Sold all</th>
<th data-k="profit">Profit/sale</th><th data-k="margin">Margin</th>
<th data-k="topd">Top seller</th><th data-k="cheapd">Cheapest</th><th data-k="gap">You vs best</th><th>Fixes</th>
</tr></thead><tbody id="tb"></tbody></table></div></div>
<script>
const S=${JSON.stringify(secret)};const $=id=>document.getElementById(id);let D=null,sortK="sold30",sortDir=-1;
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const m=n=>n==null?"–":"$"+Number(n).toFixed(2);
const stCls=s=>s.startsWith("selling")?"g":s.startsWith("not")?"r":s.startsWith("shown")?"y":"b";
function rowsF(){const q=$("q").value.toLowerCase(),st=$("stage").value,sh=$("ship").value,cp=$("comp").value,ad=$("ads").value;
 return (D.rows||[]).filter(r=>(!q||r.title.toLowerCase().includes(q)||r.id.includes(q))&&(!st||r.stage===st)&&(!sh||r.ship_kind===sh)
 &&(!cp||(cp==="over"?r.gap>0.5:cp==="under"?r.gap!=null&&r.gap<=0:r.gap==null))&&(!ad||(ad==="on"?r.ad>0:!(r.ad>0))))}
function val(r,k){return k==="topd"?(r.top?r.top.delivered:1e9):k==="cheapd"?(r.cheapest?r.cheapest.delivered:1e9):k==="gap"?(r.gap??-1e9):k==="ad"?(r.ad??-1):r[k]}
function render(){if(!D)return;const all=D.rows||[];
 $("status").textContent="Listing data from eBay: "+new Date(D.listingsAt).toLocaleTimeString()+" · traffic hourly · competition: "+(all.find(r=>r.checked)?new Date(all.find(r=>r.checked).checked).toLocaleString():"not checked yet (runs 7am daily)")+" · auto-refreshes every minute";
 const n=all.length,sell=all.filter(r=>r.sold30>0).length,free=all.filter(r=>r.ship_kind==="free").length,prom=all.filter(r=>r.ad>0).length,over=all.filter(r=>r.gap>0.5).length,s30=all.reduce((a,r)=>a+r.sold30,0);
 $("kpis").innerHTML=[["Active listings",n],["Sold something (30d)",sell+" ("+Math.round(sell/n*100)+"%)"],["Units sold (30d)",s30],["Free shipping",free],["Promoted",prom],["Pricier than competition",over],["Not shown in search",all.filter(r=>r.stage.startsWith("not")).length],["Clicked, not bought",all.filter(r=>r.stage.startsWith("clicked")).length]].map(([k,v])=>'<div class="k"><span class="mut">'+k+'</span><b>'+v+'</b></div>').join("");
 const rs=rowsF().sort((a,b)=>{const x=val(a,sortK),y=val(b,sortK);return (typeof x==="string"?x.localeCompare(y):x-y)*sortDir});
 $("tb").innerHTML=rs.map(r=>'<tr><td class="t"><a href="https://www.ebay.com/itm/'+r.id+'" target="_blank">'+esc(r.title)+'</a><div class="mut">#'+r.id+(r.variations?' · options':'')+(r.protected?' · <span class="y">protected</span>':'')+(r.on_sale?' · <span class="b">in sale</span>':'')+'</div></td>'+
  '<td>'+m(r.price)+'</td><td>'+(r.ship_kind==="free"?'<span class="g">FREE</span>':r.ship_kind==="calculated"?'calc ~'+m(r.ship_buyer):m(r.ship_buyer))+'</td><td>'+m(r.delivered)+'</td>'+
  '<td class="'+(r.qty<=2?"y":"")+'">'+r.qty+'</td><td><span class="pill '+stCls(r.stage)+'">'+esc(r.stage)+'</span></td><td>'+(r.ad>0?r.ad+'%':'<span class="mut">off</span>')+'</td>'+
  '<td>'+r.impressions+'</td><td>'+r.views+'</td><td>'+r.ctr+'</td><td class="'+(r.sold30?"g":"")+'">'+r.sold30+'</td><td>'+r.conv+'</td><td>'+r.sold_total+'</td>'+
  '<td class="'+(r.profit<2.5?"r":"")+'">'+m(r.profit)+'</td><td>'+r.margin+'%</td>'+
  '<td>'+(r.top?'<a href="'+esc(r.top.url)+'" target="_blank">'+esc(r.top.seller)+'</a><br>'+m(r.top.delivered)+(r.top.free?' <span class="g">free</span>':'')+' · '+r.top.sold+' sold':'<span class="mut">–</span>')+'</td>'+
  '<td>'+(r.cheapest?'<a href="'+esc(r.cheapest.url)+'" target="_blank">'+esc(r.cheapest.seller)+'</a><br>'+m(r.cheapest.delivered)+(r.cheapest.free?' <span class="g">free</span>':''):'<span class="mut">–</span>')+'</td>'+
  '<td class="'+(r.gap==null?"mut":r.gap>0.5?"r":"g")+'">'+(r.gap==null?"–":(r.gap>0?"+":"")+m(r.gap).replace("$-","-$"))+'</td>'+
  '<td class="fx">'+esc(r.fixes.join(" · "))+'</td></tr>').join("");}
async function load(force){try{D=await (await fetch("/listings/"+S+"/data"+(force?"?fresh=1":""),{cache:"no-store"})).json();if(D.error)throw new Error(D.error);render()}catch(e){$("status").textContent="Couldn't load: "+e.message}}
document.querySelectorAll("th[data-k]").forEach(th=>th.onclick=()=>{const k=th.dataset.k;sortDir=sortK===k?-sortDir:-1;sortK=k;render()});
["stage","ship","comp","ads"].forEach(i=>$(i).onchange=render);$("q").oninput=render;$("refresh").onclick=()=>load(true);
load();setInterval(()=>load(false),60000);
</script></body></html>`;
}
