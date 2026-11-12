// Photo studio: turns renders (or photos on a plain background) into eBay-ready images:
// product recolored black (shading kept), pure white background, centered, square, 1600 x 1600.
// Runs entirely in the browser, so it never touches eBay's API limits.
export function photoPage(secret: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexa Photo Studio</title>
<style>
:root{--bg:#0b0e14;--panel:#121722;--line:#263042;--ink:#e8edf5;--mute:#8a96a8;--ok:#3fb950;--acc:#58a6ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:16px}h1{font-size:20px;margin:0 0 4px}.mut{color:var(--mute);font-size:13px}
.bar{display:flex;gap:12px;flex-wrap:wrap;align-items:center;background:var(--panel);border:1px solid var(--line);padding:12px;margin:14px 0;border-radius:4px}
.bar label{font-size:12px;color:var(--mute);display:flex;flex-direction:column;gap:4px}
input[type=range]{width:150px}button,.file{background:var(--panel);color:var(--ink);border:1px solid var(--line);padding:10px 14px;border-radius:4px;font:inherit;cursor:pointer}
.file{border-color:var(--acc)}button.go{border-color:var(--ok);color:var(--ok)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);padding:8px;border-radius:4px}.card canvas{width:100%;height:auto;display:block;background:#fff}
.card .row{display:flex;gap:6px;margin-top:8px}.card .row button{flex:1;padding:8px;font-size:13px}.card .nm{font-size:12px;color:var(--mute);margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
a{color:var(--acc)}
</style></head><body><div class="wrap">
<h1>📸 Photo studio</h1>
<script src="/vendor/three.min.js"></script><script src="/vendor/STLLoader.js"></script>
<div class="mut">Add an STL to get the part rendered from every angle, or add renders / photos taken on a plain background. Each one comes out with the part in black on pure white, centered, 1600 × 1600 (eBay's recommended size). Nothing is uploaded: it all happens on this device. <a href="/dashboard/${secret}">← Nexa Command</a></div>
<div class="bar">
 <label class="file">＋ Add STL (every angle)<input id="stl" type="file" accept=".stl" hidden></label>
 <label class="file">＋ Add images<input id="f" type="file" accept="image/*" multiple hidden></label>
 <label>Background cut-out <input id="tol" type="range" min="8" max="120" value="40"></label>
 <label>Black level <input id="dark" type="range" min="0" max="80" value="18"></label>
 <label>Shading <input id="shade" type="range" min="0" max="140" value="70"></label>
 <label><span><input id="holes" type="checkbox" checked> Clear holes</span></label>
 <label>Margin <input id="pad" type="range" min="2" max="30" value="10"></label>
 <button class="go" id="all">⬇ Download all</button>
</div>
<div class="grid" id="g"></div>
<p class="mut">Tips: renders on a solid background work best. If parts of the background stay grey, raise "Background cut-out". If parts of the product disappear, lower it. Shading keeps the edges and details visible on a black part.</p>
</div>
<script>
const $=id=>document.getElementById(id);const items=[];
function process(it){if(it.render)return;
 const img=it.img,W0=img.naturalWidth,H0=img.naturalHeight,sc=Math.min(1,2000/Math.max(W0,H0));
 const W=Math.round(W0*sc),H=Math.round(H0*sc);const c=document.createElement('canvas');c.width=W;c.height=H;const x=c.getContext('2d');x.drawImage(img,0,0,W,H);
 const d=x.getImageData(0,0,W,H),p=d.data,tol=+$('tol').value,dark=+$('dark').value,shade=+$('shade').value;
 // background colour = median of the border pixels
 const bs=[];for(let i=0;i<W;i++){bs.push(i,(H-1)*W+i)}for(let j=0;j<H;j++){bs.push(j*W,j*W+W-1)}
 const ch=k=>{const v=bs.map(i=>p[i*4+k]).sort((a,b)=>a-b);return v[v.length>>1]};const br=ch(0),bg=ch(1),bb=ch(2);
 const near=i=>{const r=p[i*4]-br,g=p[i*4+1]-bg,b=p[i*4+2]-bb;return Math.sqrt(r*r+g*g+b*b)<tol};
 // flood fill the background from every edge pixel (keeps holes inside the part only if they touch the edge)
 const bgm=new Uint8Array(W*H),st=[];for(const i of bs)if(!bgm[i]&&near(i)){bgm[i]=1;st.push(i)}
 while(st.length){const i=st.pop(),cx=i%W,cy=(i-cx)/W;for(const n of [cx>0?i-1:-1,cx<W-1?i+1:-1,cy>0?i-W:-1,cy<H-1?i+W:-1])if(n>=0&&!bgm[n]&&near(n)){bgm[n]=1;st.push(n)}}
 // enclosed holes (like the middle of a ring): only big, very close-coloured patches, so faces of the part stay
 if($('holes').checked){const ht=tol*0.45,seen=new Uint8Array(W*H),minA=W*H*0.004;
  const close=i=>{const r=p[i*4]-br,g=p[i*4+1]-bg,b=p[i*4+2]-bb;return Math.sqrt(r*r+g*g+b*b)<ht};
  for(let s0=0;s0<W*H;s0++){if(bgm[s0]||seen[s0]||!close(s0))continue;const comp=[s0],q=[s0];seen[s0]=1;
   while(q.length){const i=q.pop(),cx=i%W,cy=(i-cx)/W;for(const n of [cx>0?i-1:-1,cx<W-1?i+1:-1,cy>0?i-W:-1,cy<H-1?i+W:-1])if(n>=0&&!seen[n]&&!bgm[n]&&close(n)){seen[n]=1;q.push(n);comp.push(n)}}
   if(comp.length>minA)for(const i of comp)bgm[i]=1}}
 let x0=W,y0=H,x1=0,y1=0;
 for(let i=0;i<W*H;i++){const o=i*4;if(bgm[i]){p[o]=p[o+1]=p[o+2]=255;p[o+3]=255;continue}
  const cx=i%W,cy=(i-cx)/W;if(cx<x0)x0=cx;if(cx>x1)x1=cx;if(cy<y0)y0=cy;if(cy>y1)y1=cy;
  const L=0.299*p[o]+0.587*p[o+1]+0.114*p[o+2];const v=Math.min(255,dark+L/255*shade);
  // soften the edge: pixels next to background blend toward white a little
  let e=0;for(const n of [i-1,i+1,i-W,i+W])if(n>=0&&n<W*H&&bgm[n])e++;const m=e?0.35*e/4:0;const out=v*(1-m)+255*m;
  p[o]=p[o+1]=p[o+2]=out;p[o+3]=255}
 x.putImageData(d,0,0);
 const S=1600,o=it.out;o.width=S;o.height=S;const y=o.getContext('2d');y.fillStyle='#fff';y.fillRect(0,0,S,S);
 if(x1<=x0||y1<=y0){y.drawImage(c,0,0,S,S);return}
 const bw=x1-x0+1,bh=y1-y0+1,pad=+$('pad').value/100,fit=S*(1-2*pad)/Math.max(bw,bh);
 y.imageSmoothingQuality='high';y.drawImage(c,x0,y0,bw,bh,(S-bw*fit)/2,(S-bh*fit)/2,bw*fit,bh*fit);
}
function save(it){it.out.toBlob(b=>{const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=it.name.replace(/\\.[^.]+$/,'')+'_ebay.jpg';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),4000)},'image/jpeg',0.92)}
function add(file){const it={name:file.name,img:new Image(),out:document.createElement('canvas')};
 const card=document.createElement('div');card.className='card';card.appendChild(it.out);
 const nm=document.createElement('div');nm.className='nm';nm.textContent=file.name;card.appendChild(nm);
 const row=document.createElement('div');row.className='row';const dl=document.createElement('button');dl.textContent='⬇ Download';dl.onclick=()=>save(it);
 const rm=document.createElement('button');rm.textContent='✕';rm.onclick=()=>{card.remove();items.splice(items.indexOf(it),1)};row.append(dl,rm);card.appendChild(row);$('g').appendChild(card);
 it.img.onload=()=>process(it);it.img.src=URL.createObjectURL(file);items.push(it)}
$('f').onchange=e=>{[...e.target.files].forEach(add);e.target.value=''};
// STL -> black part on white, from every angle, 1600 x 1600 each.
const VIEWS=[["front-right",45,25],["front-left",-45,25],["back",180,20],["top",0,89],["side",90,0],["bottom",30,-60]];
function card(it){const card=document.createElement('div');card.className='card';card.appendChild(it.out);const nm=document.createElement('div');nm.className='nm';nm.textContent=it.name;card.appendChild(nm);
 const row=document.createElement('div');row.className='row';const dl=document.createElement('button');dl.textContent='⬇ Download';dl.onclick=()=>save(it);const rm=document.createElement('button');rm.textContent='✕';rm.onclick=()=>{card.remove();items.splice(items.indexOf(it),1)};row.append(dl,rm);card.appendChild(row);$('g').appendChild(card);items.push(it)}
function renderSTL(buf,base){
 const T=THREE,geo=new T.STLLoader().parse(buf);geo.computeVertexNormals();geo.center();geo.computeBoundingSphere();
 const r=geo.boundingSphere.radius,S=1600;
 const ren=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});ren.setSize(S,S);ren.setPixelRatio(1);ren.setClearColor(0xffffff,1);
 const sc=new T.Scene();const mat=new T.MeshStandardMaterial({color:0x1c1c1c,roughness:0.55,metalness:0.15});
 const mesh=new T.Mesh(geo,mat);mesh.rotation.x=-Math.PI/2;sc.add(mesh); // STLs are Z-up; show them upright
 sc.add(new T.HemisphereLight(0xffffff,0x444444,0.9));const k=new T.DirectionalLight(0xffffff,1.1);sc.add(k);const fill=new T.DirectionalLight(0xffffff,0.45);sc.add(fill);
 const cam=new T.PerspectiveCamera(30,1,r/100,r*100);const pad=1+(+$('pad').value)/100*2;const dist=r*pad/Math.sin(30/2*Math.PI/180);
 for(const [nm,az,el] of VIEWS){const a=az*Math.PI/180,e=el*Math.PI/180;cam.position.set(dist*Math.cos(e)*Math.sin(a),dist*Math.sin(e),dist*Math.cos(e)*Math.cos(a));cam.up.set(0,el>80?0:1,el>80?-1:0);cam.lookAt(0,0,0);
  k.position.copy(cam.position).add(new T.Vector3(r*2,r*3,r));fill.position.set(-cam.position.x,cam.position.y*0.3,-cam.position.z);
  ren.render(sc,cam);const out=document.createElement('canvas');out.width=S;out.height=S;out.getContext('2d').drawImage(ren.domElement,0,0);
  card({name:base+'_'+nm,render:true,out})}
 ren.dispose();}
$('stl').onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{try{renderSTL(r.result,f.name.replace(/\.stl$/i,''))}catch(err){alert('Could not read that STL: '+err.message)}};r.readAsArrayBuffer(f);e.target.value=''};
['tol','dark','shade','pad','holes'].forEach(k=>{$(k).oninput=()=>items.forEach(process);$(k).onchange=()=>items.forEach(process)});
$('all').onclick=()=>items.forEach((it,i)=>setTimeout(()=>save(it),i*400));
</script></body></html>`;
}
