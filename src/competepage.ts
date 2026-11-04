// Competition page: store-wide comparison + every listing's fixes, biggest opportunity first.
export function competePage(secret: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexa Competition</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--line:#2b3340;--tx:#e6edf3;--mut:#8b98a5;--acc:#3fb950;--warn:#d29922;--bad:#f85149;--blue:#58a6ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
.wrap{max-width:1200px;margin:0 auto;padding:16px}h1{font-size:20px;margin:0 0 4px}.mut{color:var(--mut)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0}
button,select,input{background:var(--card);color:var(--tx);border:1px solid var(--line);border-radius:8px;padding:8px 12px;font:inherit}
button{cursor:pointer}button.go{background:#238636;border-color:#2ea043}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.k{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.k b{display:block;font-size:20px}
.k .vs{font-size:12px;color:var(--mut)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin:10px 0}
.card h3{font-size:15px;margin:0 0 6px}.tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);margin-right:6px;color:var(--mut)}
.st-selling{color:var(--acc);border-color:var(--acc)}.st-not{color:var(--bad);border-color:var(--bad)}.st-shown{color:var(--warn);border-color:var(--warn)}.st-clicked{color:var(--blue);border-color:var(--blue)}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}td,th{padding:5px 6px;border-top:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--mut);font-weight:500}.fix{margin:6px 0;padding-left:10px;border-left:3px solid var(--line)}
.who-bot{border-color:var(--acc)}.who-you{border-color:var(--warn)}.who-claude{border-color:var(--blue)}
.fix b{font-weight:600}.fix small{display:block;color:var(--mut)}a{color:var(--blue)}
.better{color:var(--acc)}.worse{color:var(--bad)}
@media(max-width:640px){td,th{font-size:12px;padding:4px}}
</style></head><body><div class="wrap">
<h1>🏁 Competition watch</h1><div class="mut" id="status">Loading…</div>
<div class="row"><button class="go" id="run">Run competition check now</button>
<select id="stage"><option value="">All stages</option><option>not shown (search)</option><option>shown, not clicked</option><option>clicked, not bought</option><option>low traffic</option><option>selling</option></select>
<select id="who"><option value="">All fixes</option><option value="bot">Bots do it</option><option value="claude">Claude does it</option><option value="you">You do it</option></select>
<input id="q" placeholder="Search titles"></div>
<div class="grid" id="sum"></div>
<div id="fixmix" class="mut" style="margin-top:8px"></div>
<div id="list"></div></div>
<script>
const S=${JSON.stringify(secret)};const $=id=>document.getElementById(id);let D=null;
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const m=n=>n==null?"–":"$"+Number(n).toFixed(2);
function cmp(a,b,hi){if(a==null||b==null)return "";return (hi?a>=b:a<=b)?"better":"worse"}
function stageCls(s){return s.startsWith("selling")?"st-selling":s.startsWith("not")?"st-not":s.startsWith("shown")?"st-shown":"st-clicked"}
function render(){
 if(!D)return; const s=D.summary;
 $("status").textContent=D.running?"Checking listings… "+(D.log.slice(-1)[0]||""):D.finished?("Last checked "+new Date(D.finished).toLocaleString()+" · "+(D.rows||[]).length+" listings"):"No check yet. Press Run.";
 if(s){ $("sum").innerHTML=[
  ["Free shipping",s.you_free_ship_pct+"%",s.top_free_ship_pct+"%"],
  ["Photos per listing",s.you_photos,s.top_photos],
  ["Item specifics",s.you_specifics,s.top_specifics],
  ["Description words",s.you_desc_words,s.top_desc_words],
  ["You're cheaper delivered",s.you_cheaper_pct+"%",""],
  ["Not shown in search",(s.stages["not shown (search)"]||0),""],
  ["Shown, not clicked",(s.stages["shown, not clicked"]||0),""],
  ["Clicked, not bought",(s.stages["clicked, not bought"]||0),""]
 ].map(([k,a,b])=>'<div class="k"><span class="mut">'+k+'</span><b>'+a+'</b>'+(b!==""?'<span class="vs">top sellers: '+b+'</span>':'<span class="vs">listings</span>')+'</div>').join("");
 $("fixmix").textContent="Most common fixes: "+s.most_common_fixes.map(([k,n])=>k+" ("+n+")").join(" · ");}
 const st=$("stage").value,who=$("who").value,q=$("q").value.toLowerCase();
 const rows=(D.rows||[]).filter(r=>(!st||r.stage===st)&&(!q||r.title.toLowerCase().includes(q))&&(!who||r.fixes.some(f=>f.who===who)));
 $("list").innerHTML=rows.slice(0,200).map(r=>{const M=r.mine,T=r.top,C=r.cheapest;
  const line=(lab,f,hi,fmt)=>'<tr><th>'+lab+'</th><td>'+(M?fmt(M[f]):"–")+'</td><td class="'+(M&&T?cmp(M[f],T[f],hi):"")+'">'+(T?fmt(T[f]):"–")+'</td><td>'+(C&&C!==T?fmt(C[f]):"")+'</td></tr>';
  const id=x=>x, yn=x=>x?"yes":"no";
  return '<div class="card"><h3><a href="https://www.ebay.com/itm/'+r.item_id+'" target="_blank">'+esc(r.title)+'</a></h3>'+
  '<span class="tag '+stageCls(r.stage)+'">'+esc(r.stage)+'</span><span class="tag">'+r.impressions+' shown · '+r.views+' clicks ('+r.ctr+'%) · '+r.sold30+' sold /30d</span>'+
  '<span class="tag">profit '+m(r.profit)+'/sale</span>'+(r.demand?'<span class="tag">top rival sold '+r.demand+'</span>':'')+(r.protected?'<span class="tag">protected – no changes</span>':'')+(r.on_sale?'<span class="tag">in sale event</span>':'')+
  (T||C?'<table><tr><th></th><th>You</th><th>Top seller'+(T?' <a href="'+esc(T.url)+'" target="_blank">'+esc(T.seller)+'</a> ('+T.sold+' sold)':'')+'</th><th>'+(C&&C!==T?'Cheapest <a href="'+esc(C.url)+'" target="_blank">'+esc(C.seller)+'</a>':'')+'</th></tr>'+
   line("Delivered","delivered",false,m)+line("Free ship","freeShip",true,yn)+line("Photos","photos",true,id)+line("Specifics","specifics",true,id)+line("Desc words","descWords",true,id)+line("Returns","returns",true,yn)+line("Delivery days","deliveryDays",false,x=>x??"–")+'</table>':'<div class="mut">No other seller found for this exact part.</div>')+
  r.fixes.map(f=>'<div class="fix who-'+f.who+'"><b>'+esc(f.what)+'</b> <span class="tag">'+(f.who==="bot"?"bots do it":f.who==="claude"?"Claude can do it":"you")+'</span><small>'+esc(f.why)+'</small></div>').join("")+'</div>'}).join("")||'<div class="mut" style="margin-top:12px">Nothing matches.</div>';
}
async function load(){try{D=await (await fetch("/report/compete/"+S,{cache:"no-store"})).json();render();if(D.running)setTimeout(load,5000)}catch(e){$("status").textContent="Couldn't load: "+e.message}}
$("run").onclick=async()=>{await fetch("/report/compete/"+S,{method:"POST"});setTimeout(load,1500)};
["stage","who"].forEach(i=>$(i).onchange=render);$("q").oninput=render;load();
</script></body></html>`;
}
