const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const eur=v=>new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(v||0);
const names={ebay:'eBay',kleinanzeigen:'Kleinanzeigen',facebook:'Facebook'};
const views={all:'Übersicht',schnapper:'Schnapper',deal:'Preisalarme',repair:'Repair Lab'};
let mode='all',lastList=[],lastIds=null,state={},busy=false;
const toast=(m)=>{const el=$('#toast');el.textContent=m;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),3300);};
async function api(url,{method='GET',data}={}){
  const res=await fetch(url,{method,credentials:'same-origin',headers:{'Accept':'application/json','Content-Type':'application/json','X-Dealforge-Action':'1'},body:data===undefined?undefined:JSON.stringify(data)});
  const obj=await res.json();
  if(res.status===401){$('#login').hidden=false;throw new Error('Bitte anmelden');}
  if(!res.ok)throw new Error(obj.error||`HTTP ${res.status}`);
  return obj;
}
function timeAgo(when){if(!when)return 'Zeit unbekannt';const d=Date.parse(when);if(!Number.isFinite(d))return 'Zeit unbekannt';const m=Math.round((Date.now()-d)/60000);return m<1?'gerade eben':m<60?`vor ${m} Min.`:m<1440?`vor ${Math.floor(m/60)} Std.`:`vor ${Math.floor(m/1440)} Tagen`;}
function badges(a){const badges=[];if(a.alerts.includes('SCHNAPPER'))badges.push('<span class="tag schnapper">ϟ SCHNAPPER</span>');if(a.alerts.includes('DEAL'))badges.push('<span class="tag deal">↓ PREISALARM</span>');if(a.health==='defect')badges.push('<span class="tag repair">⚒ REPAIR</span>');if(a.health==='unknown')badges.push('<span class="tag risk">? UNGEPRÜFT</span>');if(a.repairScore!==null&&a.repairScore<30)badges.push('<span class="tag risk">HOHES RISIKO</span>');return badges.join('');}
function dealCard(item){const a=item.assessment,kind=names[item.source]||item.source;const demo=item.externalId.startsWith('demo-');const img=item.imageUrl&&/^https:\/\//.test(item.imageUrl)?`<img src="${esc(item.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`:esc(item.watchlistName.slice(0,2).toUpperCase());const link=demo?`<span>${esc(item.title)}</span>`:`<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)} ↗</a>`;
  const msg=a.reasons.slice(0,2).map(esc).join(' · ');
  return `<article class="deal-card"><div class="deal-thumb">${img}</div><div class="deal-main"><div class="deal-title">${link}</div><div class="deal-sub">${esc(kind)} · ${esc(item.watchlistName)} · ${esc(timeAgo(item.publishedAt||item.firstSeenAt))}${demo?' · Beispieldaten':''}</div><div class="badges">${badges(a)}</div><div class="deal-reasons">${msg}${a.health==='defect'?` · Reparierbarkeit: ${a.repairScore}/100 (${esc(a.repairConfidence)})`:''}</div></div><div class="deal-right"><div class="price">${eur(a.allIn)}<small>${a.shippingKnown?'Inkl. Versand':'zzgl. unbekanntem Versand'}</small></div><div class="score">Priorität ${a.priority}/100</div><div class="action-row"><button class="action ${item.status==='saved'?'saved':''}" data-action="saved" data-id="${item.id}" aria-label="Merken">${item.status==='saved'?'✓ Gemerkt':'☆ Merken'}</button><button class="action" data-action="dismissed" data-id="${item.id}">Ausblenden</button></div></div></article>`;
}
async function loadFeed({notify=false}={}){
  const source=$('#source-filter').value, watch=$('#watch-filter').value;
  const p=new URLSearchParams({mode,source});if(watch)p.set('watchlistId',watch);
  const {items}=await api(`/api/deals?${p}`);
  const visible=items.filter(x=>x.status!=='dismissed');
  const newIds=new Set(items.map(x=>`${x.source}:${x.externalId}`));
  if(notify && lastIds!==null && 'Notification' in window && Notification.permission==='granted'){
    const fresh=visible.filter(x=>!lastIds.has(`${x.source}:${x.externalId}`) && x.assessment.alerts.length);
    for(const x of fresh.slice(0,3)){new Notification(`DealForge: ${x.assessment.alerts[0]}`,{body:`${x.title} · ${eur(x.assessment.allIn)}`,tag:`dealforge-${x.source}-${x.externalId}`});}
  }
  lastIds=newIds;lastList=items;
  $('#feed').innerHTML=visible.length?visible.map(dealCard).join(''):'<div class="empty">Keine passenden Anzeigen. Ändere den Filter oder starte einen Scan.</div>';
  $('#last-update').textContent=`Aktualisiert ${new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}`;
  $('#footer-sync').textContent=`${items.length} passende Einträge im Feed`;
}
async function loadState(){
  state=await api('/api/state');
  $('#demo-pill').hidden=!state.demoMode;
  $('#stat-total').textContent=state.stats.total;
  $('#stat-saved').textContent=state.stats.saved;
  $('#stat-repair').textContent=state.stats.repairCandidates;
  $('#stat-watches').textContent=state.watchlists.filter(x=>x.active).length;
  $('#runtime-state').textContent=state.scanning?'Scan läuft':'Bereit';
  const selected=$('#watch-filter').value;
  $('#watch-filter').innerHTML='<option value="">Alle Profile</option>'+state.watchlists.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('');
  $('#watch-filter').value=selected;
  $('#watchlist').innerHTML=state.watchlists.map(x=>`<div class="watch-item ${x.active?'':'inactive'}"><div><strong>${esc(x.name)}</strong><p>${eur(x.maxWorking)} intakt · ${eur(x.maxDefect)} defekt · ${esc(x.sourceList.map(s=>names[s]).join(', '))}</p></div><div class="watch-buttons"><button title="Aktivieren/deaktivieren" data-watch="toggle" data-active="${x.active}" data-id="${x.id}">${x.active?'◉':'○'}</button><button title="Löschen" data-watch="delete" data-id="${x.id}">✕</button></div></div>`).join('');
  $('#provider-list').innerHTML=Object.entries(state.providers).map(([name,v])=>`<div class="provider"><div><strong>${esc(names[name])}</strong><small>${esc(v.status)}</small></div><span class="status ${v.ready?'ok':''}">${v.ready?'● KONFIGURIERT':name==='facebook'?'○ IMPORT':'○ OFFLINE'}</span></div>`).join('');
}
async function refresh(notify=false){if(busy)return;busy=true;try{await loadState();await loadFeed({notify});}catch(e){if(e.message!=='Bitte anmelden')toast(e.message);}finally{busy=false;}}
$('#login-form').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/login',{method:'POST',data:{password:$('#password').value}});$('#login').hidden=true;$('#password').value='';await refresh();}catch(ex){$('#login-error').textContent=ex.message;}});
$('#scan').addEventListener('click',async()=>{if(busy)return;$('#scan').disabled=true;$('#scan').textContent='Wird geprüft …';try{const r=await api('/api/scan',{method:'POST',data:{source:'all'}});toast(`${r.results.length} Abfragen abgeschlossen, ${r.results.filter(x=>!x.ok).length} Fehler`);await refresh();}catch(e){toast(e.message);}finally{$('#scan').disabled=false;$('#scan').textContent='↻ Jetzt prüfen';}});
$('#notify').addEventListener('click',async()=>{if(!('Notification'in window)){toast('Benachrichtigungen werden hier nicht unterstützt');return;}try{const result=await Notification.requestPermission();toast(result==='granted'?'Browser-Alerts aktiv solange die WebApp geöffnet ist':'Benachrichtigungen nicht erlaubt');}catch(e){toast(e.message);}});
document.querySelectorAll('.nav [data-view]').forEach(el=>el.addEventListener('click',()=>{mode=el.dataset.view;document.querySelectorAll('.nav [data-view]').forEach(x=>x.classList.toggle('active',x===el));$('#current-view').textContent=views[mode];loadFeed().catch(e=>toast(e.message));}));
$('#focus-watchlists').addEventListener('click',()=>$('#watch-panel').scrollIntoView({behavior:'smooth'}));
$('#source-filter').addEventListener('change',()=>loadFeed().catch(e=>toast(e.message)));
$('#watch-filter').addEventListener('change',()=>loadFeed().catch(e=>toast(e.message)));
$('#watch-form').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);try{const input={name:f.get('name'),query:f.get('query'),maxWorking:Number(f.get('maxWorking')),maxDefect:Number(f.get('maxDefect')),expectedResale:f.get('expectedResale')||null,repairBudget:Number(f.get('repairBudget')),sourceList:f.getAll('sourceList')};await api('/api/watchlists',{method:'POST',data:input});e.target.reset();toast('Profil erstellt');await refresh();}catch(e){toast(e.message);}});
$('#watchlist').addEventListener('click',async e=>{const btn=e.target.closest('[data-watch]');if(!btn)return;const id=Number(btn.dataset.id);try{if(btn.dataset.watch==='toggle')await api(`/api/watchlists/${id}`,{method:'PATCH',data:{active:btn.dataset.active!=='true'}});else if(confirm('Suchprofil wirklich löschen?'))await api(`/api/watchlists/${id}`,{method:'DELETE'});await refresh();}catch(e){toast(e.message);}});
$('#feed').addEventListener('click',async e=>{const btn=e.target.closest('[data-action]');if(!btn)return;try{await api(`/api/listings/${Number(btn.dataset.id)}/status`,{method:'PATCH',data:{status:btn.dataset.action}});await refresh();}catch(e){toast(e.message);}});
$('#import').addEventListener('click',async()=>{try{const json=JSON.parse($('#import-json').value);const rows=Array.isArray(json)?json:(Array.isArray(json.items)?json.items:null);if(!rows)throw Error('JSON-Array erwartet');const r=await api('/api/import/facebook',{method:'POST',data:{items:rows}});$('#import-message').textContent=`${r.normalized} Datensätze validiert, ${r.inserted} neue Inserate gespeichert`;await refresh();}catch(e){toast(e.message);}});
refresh();setInterval(()=>refresh(true),15000);
