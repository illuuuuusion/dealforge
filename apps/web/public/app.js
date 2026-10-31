const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const eur=v=>new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(v||0);
const names={ebay:'eBay',kleinanzeigen:'Kleinanzeigen',facebook:'Facebook'};
const views={all:'Übersicht',schnapper:'Schnapper',deal:'Preisalarme',repair:'Repair Lab'};
let mode='all',lastIds=null,state={},busy=false;
const toast=(m)=>{const el=$('#toast');el.textContent=m;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),3300);};
async function api(path,{method='GET',data}={}){
  const headers={'Accept':'application/json','X-Dealforge-Action':'1',...(data===undefined?{}:{'Content-Type':'application/json'})};
  const res=await fetch(`/api/v1${path}`,{method,credentials:'same-origin',headers,body:data===undefined?undefined:JSON.stringify(data)});
  const obj=res.status===204?{}:await res.json();
  if(res.status===401&&path!=='/auth/login'){$('#login').hidden=false;throw new Error('Bitte anmelden');}
  if(!res.ok)throw new Error(obj.message||`HTTP ${res.status}`);
  return obj;
}
function timeAgo(when){if(!when)return 'Zeit unbekannt';const d=Date.parse(when);if(!Number.isFinite(d))return 'Zeit unbekannt';const m=Math.round((Date.now()-d)/60000);return m<1?'gerade eben':m<60?`vor ${m} Min.`:m<1440?`vor ${Math.floor(m/60)} Std.`:`vor ${Math.floor(m/1440)} Tagen`;}
function badges(a){const badges=[];if(a.alerts.includes('SCHNAPPER'))badges.push('<span class="tag schnapper">ϟ SCHNAPPER</span>');if(a.alerts.includes('DEAL'))badges.push('<span class="tag deal">↓ PREISALARM</span>');if(a.needsPriceCheck)badges.push('<span class="tag risk">€? PREIS PRÜFEN</span>');if(a.offerType==='AUCTION')badges.push('<span class="tag risk">⚖ AUKTION</span>');if(a.health==='defect')badges.push('<span class="tag repair">⚒ REPAIR</span>');if(a.health==='unknown')badges.push('<span class="tag risk">? UNGEPRÜFT</span>');if(a.repairScore!==null&&a.repairScore<30)badges.push('<span class="tag risk">HOHES RISIKO</span>');return badges.join('');}
function dealCard(item){const a=item.assessment,kind=names[item.source]||item.source;const demo=item.externalId.startsWith('demo-');const img=item.imageUrl&&/^https:\/\//.test(item.imageUrl)?`<img src="${esc(item.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`:esc(item.watchlistName.slice(0,2).toUpperCase());const link=demo?`<span>${esc(item.title)}</span>`:`<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)} ↗</a>`;
  const msg=a.reasons.slice(0,2).map(esc).join(' · ');
  return `<article class="deal-card"><div class="deal-thumb">${img}</div><div class="deal-main"><div class="deal-title">${link}</div><div class="deal-sub">${esc(kind)} · ${esc(a.model?`${a.model}${a.vramGb?` ${a.vramGb} GB`:''}`:item.watchlistName)} · ${esc(item.publishedAt?'':'erstmals gesehen ')}${esc(timeAgo(item.publishedAt||item.firstSeenAt))}${demo?' · Beispieldaten':''}</div><div class="badges">${badges(a)}</div><div class="deal-reasons">${msg}${a.health==='defect'?` · Reparierbarkeit: ${a.repairScore}/100 (${esc(a.repairConfidence)})`:''}</div></div><div class="deal-right"><div class="price">${eur(a.allIn)}<small>${a.offerType==='AUCTION'?'Gebot · ':''}${a.shippingKnown?'Inkl. Versand':'zzgl. unbekanntem Versand'}</small></div><div class="score">Priorität ${a.priority}/100</div><div class="action-row"><button class="action ${item.status==='saved'?'saved':''}" data-action="saved" data-id="${item.id}" aria-label="Merken">${item.status==='saved'?'✓ Gemerkt':'☆ Merken'}</button><button class="action" data-action="dismissed" data-id="${item.id}">Ausblenden</button></div></div></article>`;
}
async function loadFeed({notify=false}={}){
  const source=$('#source-filter').value, watch=$('#watch-filter').value;
  const p=new URLSearchParams({mode,source});if(watch)p.set('watchlistId',watch);
  const {items}=await api(`/listings?${p}`);
  const visible=items.filter(x=>x.status!=='dismissed');
  const newIds=new Set(items.map(x=>`${x.source}:${x.externalId}`));
  if(notify && lastIds!==null && 'Notification' in window && Notification.permission==='granted'){
    const fresh=visible.filter(x=>!lastIds.has(`${x.source}:${x.externalId}`) && x.assessment.alerts.length);
    for(const x of fresh.slice(0,3)){new Notification(`DealForge: ${x.assessment.alerts[0]}`,{body:`${x.title} · ${eur(x.assessment.allIn)}`,tag:`dealforge-${x.source}-${x.externalId}`});}
  }
  lastIds=newIds;
  $('#feed').innerHTML=visible.length?visible.map(dealCard).join(''):'<div class="empty">Keine passenden Anzeigen. Ändere den Filter oder starte einen Scan.</div>';
  $('#last-update').textContent=`Aktualisiert ${new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}`;
  $('#footer-sync').textContent=`${items.length} passende Einträge im Feed`;
}
const stateLabel={ok:'● LIVE',degraded:'◐ GESTÖRT',down:'✕ AUSFALL',idle:'○ WARTET AUF ERSTEN LAUF'};
function providerRow(p,status){
  const label=p.live?stateLabel[p.state]:p.source==='facebook'?'○ IMPORT':!p.approved?'○ NICHT FREIGEGEBEN':!p.ready?'○ KEIN ZUGANG':'○ AUSGESCHALTET';
  const q=p.queue;
  const usage=p.source==='facebook'?'':`<small>Heute ${p.callsToday}/${status.limits.daily} · Monat ${p.callsMonth}/${status.limits.monthly} Abfragen${p.budgetExhausted?` · <b>${esc(p.budgetExhausted)}</b>`:''}</small>
    <small>Letzter Erfolg ${esc(p.lastSuccessAt?timeAgo(p.lastSuccessAt):'nie')} · Fehlerquote 24 h ${p.errorRatePct??0}% (${p.errors24h}/${p.runs24h})${p.lastError?` · zuletzt: ${esc(`${p.lastError.code??''} ${p.lastError.message??''}`.trim().slice(0,90))}`:''}</small>
    ${q?`<small>Queue ${q.waiting} wartend · ${q.active} aktiv${q.rateLimitedMs?` · gedrosselt ${Math.ceil(q.rateLimitedMs/1000)} s`:''}</small>`:''}`;
  const toggle=p.ready&&p.approved?`<button class="action" data-provider="${esc(p.source)}" data-enabled="${p.enabled}">${p.enabled?'Ausschalten':'Einschalten'}</button>`:'';
  return `<div class="provider"><div><strong>${esc(names[p.source])}</strong><small>${esc(p.status)}</small>${usage}${toggle}</div><span class="status ${p.live&&p.state==='ok'?'ok':''}">${label}</span></div>`;
}
async function loadState(){
  const [base,{items:watches},status]=await Promise.all([api('/state'),api('/watchlists'),api('/providers/status')]);
  state={...base,watchlists:watches,status};
  $('#demo-pill').hidden=!state.demoMode;
  $('#stat-total').textContent=state.stats.total;
  $('#stat-saved').textContent=state.stats.saved;
  $('#stat-repair').textContent=state.stats.repairCandidates;
  $('#stat-watches').textContent=state.watchlists.filter(x=>x.active).length;
  const running=status.providers.reduce((n,p)=>n+(p.queue?.active??0)+(p.queue?.waiting??0),0);
  $('#runtime-state').textContent=!status.worker.online?'Worker offline':running?`Scan läuft (${running})`:'Bereit';
  const selected=$('#watch-filter').value;
  $('#watch-filter').innerHTML='<option value="">Alle Profile</option>'+state.watchlists.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('');
  $('#watch-filter').value=selected;
  $('#models').innerHTML=state.models.map(m=>`<option value="${esc(m)}">`).join('');
  $('#watchlist').innerHTML=state.watchlists.map(x=>`<div class="watch-item ${x.active?'':'inactive'}"><div><strong>${esc(x.name)}</strong><p>${eur(x.maxWorking)} intakt · ${eur(x.maxDefect)} defekt · ${esc(x.sourceList.map(s=>names[s]).join(', '))}${x.allowUnknownShipping?' · Versand unbekannt ok':''}</p></div><div class="watch-buttons"><button title="Aktivieren/deaktivieren" data-watch="toggle" data-active="${x.active}" data-id="${x.id}">${x.active?'◉':'○'}</button><button title="Löschen" data-watch="delete" data-id="${x.id}">✕</button></div></div>`).join('');
  const worker=status.worker.online?'':`<div class="provider"><div><strong>Worker</strong><small>Kein Heartbeat${status.worker.lastHeartbeatAt?` seit ${esc(timeAgo(status.worker.lastHeartbeatAt))}`:''} – keine Abfragen möglich</small></div><span class="status">✕ AUSFALL</span></div>`;
  $('#provider-list').innerHTML=worker+status.providers.map(p=>providerRow(p,status)).join('');
}
async function refresh(notify=false){if(busy)return;busy=true;try{await loadState();await loadFeed({notify});}catch(e){if(e.message!=='Bitte anmelden')toast(e.message);}finally{busy=false;}}
$('#login-form').addEventListener('submit',async e=>{e.preventDefault();try{await api('/auth/login',{method:'POST',data:{password:$('#password').value}});$('#login').hidden=true;$('#password').value='';await refresh();}catch(ex){$('#login-error').textContent=ex.message;}});
$('#scan').addEventListener('click',async()=>{if(busy)return;$('#scan').disabled=true;$('#scan').textContent='Wird geprüft …';try{const r=await api('/admin/scans',{method:'POST',data:{source:'all'}});toast(`${r.queued.length} Abfragen eingeplant${r.deduplicated.length?`, ${r.deduplicated.length} laufen bereits`:''}`);await refresh();}catch(e){toast(e.message);}finally{$('#scan').disabled=false;$('#scan').textContent='↻ Jetzt prüfen';}});
$('#notify').addEventListener('click',async()=>{if(!('Notification'in window)){toast('Benachrichtigungen werden hier nicht unterstützt');return;}try{const result=await Notification.requestPermission();toast(result==='granted'?'Browser-Alerts aktiv solange die WebApp geöffnet ist':'Benachrichtigungen nicht erlaubt');}catch(e){toast(e.message);}});
document.querySelectorAll('.nav [data-view]').forEach(el=>el.addEventListener('click',()=>{mode=el.dataset.view;document.querySelectorAll('.nav [data-view]').forEach(x=>x.classList.toggle('active',x===el));$('#current-view').textContent=views[mode];loadFeed().catch(e=>toast(e.message));}));
$('#focus-watchlists').addEventListener('click',()=>$('#watch-panel').scrollIntoView({behavior:'smooth'}));
$('#source-filter').addEventListener('change',()=>loadFeed().catch(e=>toast(e.message)));
$('#watch-filter').addEventListener('change',()=>loadFeed().catch(e=>toast(e.message)));
$('#watch-form').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);try{const input={name:f.get('name'),query:f.get('query'),maxWorking:Number(f.get('maxWorking')),maxDefect:Number(f.get('maxDefect')),expectedResale:f.get('expectedResale')?Number(f.get('expectedResale')):null,repairBudget:Number(f.get('repairBudget')),sourceList:f.getAll('sourceList'),allowUnknownShipping:f.get('allowUnknownShipping')==='on'};await api('/watchlists',{method:'POST',data:input});e.target.reset();toast('Profil erstellt');await refresh();}catch(e){toast(e.message);}});
$('#watchlist').addEventListener('click',async e=>{const btn=e.target.closest('[data-watch]');if(!btn)return;const id=Number(btn.dataset.id);try{if(btn.dataset.watch==='toggle')await api(`/watchlists/${id}`,{method:'PATCH',data:{active:btn.dataset.active!=='true'}});else if(confirm('Suchprofil wirklich löschen?'))await api(`/watchlists/${id}`,{method:'DELETE'});await refresh();}catch(e){toast(e.message);}});
$('#feed').addEventListener('click',async e=>{const btn=e.target.closest('[data-action]');if(!btn)return;try{await api(`/listings/${Number(btn.dataset.id)}/user-state`,{method:'PATCH',data:{status:btn.dataset.action}});await refresh();}catch(e){toast(e.message);}});
$('#import').addEventListener('click',async()=>{try{const json=JSON.parse($('#import-json').value);const rows=Array.isArray(json)?json:(Array.isArray(json.items)?json.items:null);if(!rows)throw Error('JSON-Array erwartet');const r=await api('/import/facebook',{method:'POST',data:{items:rows}});$('#import-message').textContent=`${r.normalized} Datensätze validiert, ${r.inserted} neue Inserate gespeichert`;await refresh();}catch(e){toast(e.message);}});
$('#provider-list').addEventListener('click',async e=>{const btn=e.target.closest('[data-provider]');if(!btn)return;try{await api(`/providers/${btn.dataset.provider}`,{method:'PATCH',data:{enabled:btn.dataset.enabled!=='true'}});await refresh();}catch(e){toast(e.message);}});
refresh();setInterval(()=>refresh(true),15000);
