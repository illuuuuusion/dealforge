const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const eur=v=>new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(v||0);
const names={ebay:'eBay',kleinanzeigen:'Kleinanzeigen',facebook:'Facebook'};
const views={all:'Übersicht',schnapper:'Schnapper',deal:'Preisalarme',repair:'Repair Lab'};
// ponytail: hand-drawn 16×16 pixel icons as ASCII art; '#' = currentColor, '+' = 35% tint.
const ICONS={
anvil:`
................
................
................
...+++++++++++++
################
..##############
.....###########
.......#######..
........#####...
........#####...
.......#######..
.....###########
.....###########
................
................
................`,
crt:`
................
.##############.
.#++++++++++++#.
.#++++++++++#+#.
.#+++++++++#++#.
.#++#+++++#+++#.
.#+#+#+++#++++#.
.#++++#+#+++++#.
.#+++++#++++++#.
.#++++++++++++#.
.##############.
......####......
.....######.....
...##########...
................
................`,
bolt:`
................
.........####...
........####....
.......####.....
......####......
.....####.......
....##########..
....#########...
.......#####....
......#####.....
.....####.......
....####........
...###..........
..##............
................
................`,
bell:`
.......##.......
......####......
.....######.....
....##++####....
....#++#####....
....#+######....
...##+#######...
...##########...
...##########...
..############..
.##############.
.##############.
................
......####......
.......##.......
................`,
wrench:`
...........###..
..........###...
..........###.##
..........######
...........####.
.........###....
........###.....
.......###......
......###.......
.....###........
....###.........
...###..........
..###...........
.###............
.##.............
................`,
lens:`
................
....######......
...########.....
..###....###....
..##.++...##....
..##.+....##....
..##......##....
..##......##....
..###....###....
...#########....
....#########...
..........####..
...........####.
............####
.............###
................`,
eye:`
................
................
................
.....######.....
...##......##...
..#...####...#..
.#...######...#.
#...##+#####...#
#...########...#
.#...######...#.
..#...####...#..
...##......##...
.....######.....
................
................
................`,
target:`
.......##.......
.......##.......
.....######.....
....#..##..#....
...#...##...#...
..#....##....#..
..#..........#..
######.++.######
######.++.######
..#..........#..
..#....##....#..
...#...##...#...
....#..##..#....
.....######.....
.......##.......
.......##.......`,
floppy:`
................
.#############..
.##++++++++###..
.##++++##++####.
.##++++##++####.
.##++++++++####.
.##############.
.##############.
.#++++++++++++#.
.#++++++++++++#.
.#+##########+#.
.#++++++++++++#.
.#+########+++#.
.#++++++++++++#.
.##############.
................`,
tv:`
...#........#...
....#......#....
.....#....#.....
......####......
################
#++++++++++#####
#++++++++++##+##
#++++++++++#####
#++++++++++##+##
#++++++++++#####
#++++++++++#####
################
.##..........##.
................
................
................`,
play:`
................
................
...##...........
...####.........
...######.......
...########.....
...##########...
...############.
...############.
...##########...
...########.....
...######.......
...####.........
...##...........
................
................`,
close:`
................
................
................
...##......##...
...###....###...
....###..###....
.....######.....
......####......
......####......
.....######.....
....###..###....
...###....###...
...##......##...
................
................
................`};
const icon=n=>{const d={'#':'','+':''};ICONS[n].trim().split('\n').forEach((row,y)=>[...row].forEach((c,x)=>{if(c in d)d[c]+=`M${x} ${y}h1v1h-1z`;}));return `<svg class="px" viewBox="0 0 16 16" aria-hidden="true"><path d="${d['#']}"/><path d="${d['+']}" opacity=".35"/></svg>`;};
document.querySelectorAll('[data-icon]').forEach(el=>el.insertAdjacentHTML('afterbegin',icon(el.dataset.icon)));
let mode='all',state={},busy=false;
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
function badges(a){const badges=[];if(a.alerts.includes('SCHNAPPER'))badges.push('<span class="tag schnapper">SCHNAPPER</span>');if(a.alerts.includes('DEAL'))badges.push('<span class="tag deal">PREISALARM</span>');if(a.needsPriceCheck)badges.push('<span class="tag risk">PREIS PRÜFEN</span>');if(a.offerType==='AUCTION')badges.push('<span class="tag risk">AUKTION</span>');if(a.health==='defect')badges.push('<span class="tag repair">REPAIR</span>');if(a.health==='unknown')badges.push('<span class="tag risk">UNGEPRÜFT</span>');if(a.repairScore!==null&&a.repairScore<30)badges.push('<span class="tag risk">HOHES RISIKO</span>');return badges.join('');}
function dealCard(item){const a=item.assessment,kind=names[item.source]||item.source;const demo=item.externalId.startsWith('demo-');const img=item.imageUrl&&/^https:\/\//.test(item.imageUrl)?`<img src="${esc(item.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`:esc(item.watchlistName.slice(0,2).toUpperCase());const link=demo?`<span>${esc(item.title)}</span>`:`<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>`;
  const msg=a.reasons.slice(0,2).map(esc).join(' · ');
  return `<article class="deal-card"><div class="deal-thumb">${img}</div><div class="deal-main"><div class="deal-title">${link}</div><div class="deal-sub">${esc(kind)} · ${esc(a.model?`${a.model}${a.vramGb?` ${a.vramGb} GB`:''}`:item.watchlistName)} · ${esc(item.publishedAt?'':'erstmals gesehen ')}${esc(timeAgo(item.publishedAt||item.firstSeenAt))}${demo?' · Beispieldaten':''}</div><div class="badges">${badges(a)}</div><div class="deal-reasons">${msg}${a.health==='defect'?` · Reparierbarkeit: ${a.repairScore}/100 (${esc(a.repairConfidence)}) · Fehlerbild: ${a.repairFaults.map(f=>esc(faultNames[f])).join(', ')}`:''}</div>${[...(a.repairConflicts||[]),...(a.repairWarnings||[])].map(w=>`<div class="deal-warn">${esc(w)}</div>`).join('')}</div><div class="deal-right"><div class="price">${eur(a.allIn)}<small>${a.offerType==='AUCTION'?'Gebot · ':''}${a.shippingKnown?'Inkl. Versand':'zzgl. unbekanntem Versand'}</small></div><div class="score" style="--p:${Number(a.priority)||0}">Priorität ${a.priority}/100</div><div class="action-row"><button class="action ${item.status==='saved'?'saved':''}" data-action="saved" data-id="${item.id}" aria-label="Merken">${icon('floppy')}${item.status==='saved'?'Gemerkt':'Merken'}</button><button class="action" data-action="dismissed" data-id="${item.id}">${icon('close')}Ausblenden</button>${['defect','unknown'].includes(a.health)?`<button class="action" data-repair="${item.id}">${icon('wrench')}Repair Lab</button>`:''}</div></div></article>`;
}
// ponytail: "Neu" is read from the free-text condition; defect always wins via the scorer's health.
const condition=x=>x.assessment.health==='defect'?'defect':/^\s*(neu|new|brandneu)\b/i.test(x.condition??'')?'new':'used';
const when=x=>Date.parse(x.publishedAt||x.firstSeenAt)||0;
const sorters={priority:(a,b)=>b.assessment.priority-a.assessment.priority,newest:(a,b)=>when(b)-when(a),priceAsc:(a,b)=>a.assessment.allIn-b.assessment.allIn,
  priceDesc:(a,b)=>b.assessment.allIn-a.assessment.allIn,discount:(a,b)=>(b.assessment.discountPct??-1e9)-(a.assessment.discountPct??-1e9)};
function syncFilterLabels(){
  for(const d of $('#feed-filters').querySelectorAll('details')){
    const inputs=[...d.querySelectorAll('input')],on=inputs.filter(i=>i.checked).map(i=>i.parentElement.textContent.trim());
    d.querySelector('summary').textContent=d.dataset.label?`${d.dataset.label}: ${!on.length||on.length===inputs.length?'Alle':on.join(', ')}`:on[0]??'';
  }
}
async function loadFeed(){
  const f=new FormData($('#feed-filters')),source=f.get('source'),watch=f.get('watch'),offer=f.getAll('offer'),cond=f.getAll('cond');
  const p=new URLSearchParams({mode,source});if(watch)p.set('watchlistId',watch);
  const {items}=await api(`/listings?${p}`);
  const visible=items.filter(x=>x.status!=='dismissed');
  const shown=visible.filter(x=>(!offer.length||offer.includes(x.assessment.offerType==='AUCTION'?'auction':'fixed'))&&(!cond.length||cond.includes(condition(x)))).sort(sorters[f.get('sort')]);
  $('#feed').innerHTML=shown.length?shown.map(dealCard).join(''):'<div class="empty">Keine passenden Anzeigen. Ändere den Filter oder starte einen Scan.</div>';
  $('#last-update').textContent=`Aktualisiert ${new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}`;
  $('#footer-sync').textContent=`${items.length} passende Einträge im Feed`;
}
const stateLabel={ok:'<i class="live"></i>LIVE',degraded:'GESTÖRT',down:'AUSFALL',idle:'WARTET AUF ERSTEN LAUF'};
function providerRow(p,status){
  const label=p.live?stateLabel[p.state]:p.source==='facebook'?'IMPORT':!p.approved?'NICHT FREIGEGEBEN':!p.ready?'KEIN ZUGANG':'AUSGESCHALTET';
  const q=p.queue;
  const usage=p.source==='facebook'?'':`<small>Heute ${p.callsToday}/${status.limits.daily} · Monat ${p.callsMonth}/${status.limits.monthly} Abfragen${p.budgetExhausted?` · <b>${esc(p.budgetExhausted)}</b>`:''}</small>
    <small>Letzter Erfolg ${esc(p.lastSuccessAt?timeAgo(p.lastSuccessAt):'nie')} · Fehlerquote 24 h ${p.errorRatePct??0}% (${p.errors24h}/${p.runs24h})${p.lastError?` · zuletzt: ${esc(`${p.lastError.code??''} ${p.lastError.message??''}`.trim().slice(0,90))}`:''}</small>
    ${q?`<small>Queue ${q.waiting} wartend · ${q.active} aktiv${q.rateLimitedMs?` · gedrosselt ${Math.ceil(q.rateLimitedMs/1000)} s`:''}</small>`:''}`;
  const toggle=p.ready&&p.approved?`<button class="action" data-provider="${esc(p.source)}" data-enabled="${p.enabled}">${p.enabled?'Ausschalten':'Einschalten'}</button>`:'';
  return `<div class="provider"><div><strong>${esc(names[p.source])}</strong><small>${esc(p.status)}${p.fast?` · Schnellquelle alle ${status.scheduler.fastPollSeconds} s`:''}</small>${usage}${toggle}</div><span class="status ${p.live&&p.state==='ok'?'ok':''}">${label}</span></div>`;
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
  $('#worker-live').classList.toggle('off',!status.worker.online);
  $('#runtime-state').textContent=!status.worker.online?'Worker offline':running?`Scan läuft (${running})`:'Bereit';
  const selected=new FormData($('#feed-filters')).get('watch'),opt=(v,label)=>`<label><input type="radio" name="watch" value="${v}"${String(v)===selected?' checked':''}> ${esc(label)}</label>`;
  $('#watch-filter').innerHTML=opt('','Alle Profile')+state.watchlists.map(x=>opt(x.id,x.name)).join('');
  if(!$('#watch-filter :checked'))$('#watch-filter input').checked=true;
  syncFilterLabels();
  $('#models').innerHTML=state.models.map(m=>`<option value="${esc(m)}">`).join('');
  $('#watchlist').innerHTML=state.watchlists.map(x=>`<div class="watch-item ${x.active?'':'inactive'}"><div><strong>${esc(x.name)}</strong><p>${eur(x.maxWorking)} intakt · ${eur(x.maxDefect)} defekt · ${esc(x.sourceList.map(s=>names[s]).join(', '))}${x.allowUnknownShipping?' · Versand unbekannt ok':''}${x.fast?' · Schnell-Modus':''}</p></div><div class="watch-buttons"><button title="Aktivieren/deaktivieren" data-watch="toggle" data-active="${x.active}" data-id="${x.id}">${x.active?'Pausieren':'Aktivieren'}</button><button title="Löschen" data-watch="delete" data-id="${x.id}">Löschen</button></div></div>`).join('');
  const worker=status.worker.online?'':`<div class="provider"><div><strong>Worker</strong><small>Kein Heartbeat${status.worker.lastHeartbeatAt?` seit ${esc(timeAgo(status.worker.lastHeartbeatAt))}`:''} – keine Abfragen möglich</small></div><span class="status">AUSFALL</span></div>`;
  $('#provider-list').innerHTML=worker+status.providers.map(p=>providerRow(p,status)).join('');
}
const alertLabel={SCHNAPPER:'SCHNAPPER',DEAL:'PREISALARM',REPAIR:'REPAIR',PRICE_DROP:'PREISSTURZ'};
// Pipeline latency: alert time minus listing time (published, else first seen).
const latency=a=>{const s=Math.round((Date.parse(a.createdAt)-Date.parse(a.publishedAt||a.firstSeenAt))/1000);return Number.isFinite(s)&&s>=0?` · ${s<120?s+' s':Math.round(s/60)+' Min.'} nach ${a.publishedAt?'Inserat':'Fund'}`:'';};
async function loadAlerts(){
  const [{items},latencyData,deliveries]=await Promise.all([api('/alerts?limit=8'),api('/alerts/latency'),api('/push/deliveries?limit=5')]);
  $('#alert-list').innerHTML=items.length?items.map(a=>`<div class="provider"><div><strong><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a></strong><small>${eur(a.priceEur)} · ${esc(names[a.source])}${a.watchlistName?` · ${esc(a.watchlistName)}`:''} · ${esc(timeAgo(a.createdAt))}${latency(a)}</small><small>${a.reasons.slice(0,2).map(esc).join(' · ')}</small>${a.push.sent||a.push.failed?`<small>Push: ${a.push.sent} versandt · ${a.push.shown} angezeigt${a.push.failed?` · ${a.push.failed} fehlgeschlagen`:''}</small>`:''}</div><span class="status">${alertLabel[a.kind]}</span></div>`).join(''):'<div class="helper">Noch keine Alerts.</div>';
  const fmt=p=>p.p50===null?'–':`${p.p50}/${p.p95}`;
  $('#latency').innerHTML=latencyData.items.length?latencyData.items.map(x=>`<div><b>${esc(names[x.source])}</b> (${x.samples} Alerts): Inserat→Fund ${fmt(x.discovery)} · Abruf→Alert ${fmt(x.ingest)} · Alert→Push ${fmt(x.push)} · Alert→angezeigt ${fmt(x.shown)}</div>`).join(''):'Noch keine Messwerte.';
  const status={pending:'wartet',sent:'versandt',failed:'fehlgeschlagen',gone:'Abo abgelaufen'};
  $('#delivery-list').innerHTML=deliveries.items.slice(0,5).map(d=>`<div>${d.alertId?`Alert #${d.alertId}`:'Test'} · ${status[d.status]}${d.httpStatus?` (${d.httpStatus})`:''}${d.shownAt?' · angezeigt':''} · ${esc(timeAgo(d.createdAt))}${d.error?` · ${esc(d.error)}`:''}</div>`).join('');
}
// Live alerts via SSE; EventSource reconnects on its own and resumes with Last-Event-ID.
let feedTimer=null;
function connectEvents(){
  const es=new EventSource('/api/v1/events');
  es.addEventListener('alert',e=>{
    const a=JSON.parse(e.data);
    if(!pushActive&&'Notification' in window&&Notification.permission==='granted')new Notification(`DealForge: ${alertLabel[a.kind]}`,{body:`${a.title} · ${eur(a.priceEur)}`,tag:`dealforge-alert-${a.id}`});
    toast(`${alertLabel[a.kind]}: ${a.title}`);
    clearTimeout(feedTimer);feedTimer=setTimeout(()=>refresh(),500);
  });
  // A 401 (not logged in yet) closes the stream for good: try again later.
  es.onerror=()=>{if(es.readyState===EventSource.CLOSED)setTimeout(connectEvents,10000);};
}
async function refresh(){if(busy)return;busy=true;try{await loadState();await Promise.all([loadFeed(),loadAlerts(),mode==='repair'?loadRepair():null]);}catch(e){if(e.message!=='Bitte anmelden')toast(e.message);}finally{busy=false;}}
$('#login-form').addEventListener('submit',async e=>{e.preventDefault();try{await api('/auth/login',{method:'POST',data:{password:$('#password').value}});$('#login').hidden=true;$('#password').value='';await refresh();syncPush().catch(()=>{});}catch(ex){$('#login-error').textContent=ex.message;}});
$('#scan').addEventListener('click',async()=>{if(busy)return;$('#scan').disabled=true;$('#scan span').textContent='Wird geprüft …';try{const r=await api('/admin/scans',{method:'POST',data:{source:'all'}});toast(`${r.queued.length} Abfragen eingeplant${r.deduplicated.length?`, ${r.deduplicated.length} laufen bereits`:''}`);await refresh();}catch(e){toast(e.message);}finally{$('#scan').disabled=false;$('#scan span').textContent='Jetzt prüfen';}});
// Web Push: the service worker shows alerts even when no DealForge tab is open. Without Push API only in-page notifications.
const pushOk='serviceWorker' in navigator&&'PushManager' in window;
let pushActive=false;
const b64url=s=>Uint8Array.from(atob((s+'='.repeat((4-s.length%4)%4)).replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const swReg=()=>navigator.serviceWorker.register('/sw.js');
async function syncPush(){
  const sub=pushOk?await swReg().then(r=>r.pushManager.getSubscription()).catch(()=>null):null;
  pushActive=!!sub;
  // Re-register on every load (idempotent): the server may have lost or expired the subscription.
  if(sub){const {id}=await api('/push-subscriptions',{method:'POST',data:sub.toJSON()});localStorage.setItem('df-push-id',id);}
  $('#notify span').textContent=pushActive?'Push aus':'Push-Alerts';
  $('#push-test').disabled=!pushActive;
  $('#push-state').textContent=!pushOk?'Dieser Browser unterstützt kein Web Push; Benachrichtigungen nur bei geöffneter Seite.':pushActive?'Push aktiv auf diesem Gerät.':'Push auf diesem Gerät aus.';
}
$('#notify').addEventListener('click',async()=>{try{
  if(!pushOk){if(!('Notification'in window)){toast('Benachrichtigungen werden hier nicht unterstützt');return;}const r=await Notification.requestPermission();toast(r==='granted'?'Browser-Alerts aktiv solange die WebApp geöffnet ist':'Benachrichtigungen nicht erlaubt');return;}
  const reg=await swReg();let sub=await reg.pushManager.getSubscription();
  if(sub){const id=localStorage.getItem('df-push-id');if(id)await api(`/push-subscriptions/${Number(id)}`,{method:'DELETE'}).catch(()=>{});await sub.unsubscribe();localStorage.removeItem('df-push-id');toast('Push-Alerts aus');}
  else{
    if(await Notification.requestPermission()!=='granted'){toast('Benachrichtigungen nicht erlaubt');return;}
    const {publicKey}=await api('/push/public-key');
    sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64url(publicKey)});
    toast('Push-Alerts aktiv – auch ohne geöffneten Tab');
  }
  await syncPush();
}catch(e){toast(e.message);}});
$('#push-test').addEventListener('click',async()=>{try{const r=await api('/push/test',{method:'POST'});toast(`Test-Push: ${r.sent} versandt${r.failed?`, ${r.failed} fehlgeschlagen`:''}${r.gone?`, ${r.gone} Abo abgelaufen`:''}`);setTimeout(()=>loadAlerts().catch(()=>{}),3000);}catch(e){toast(e.message);}});
document.querySelectorAll('.nav [data-view]').forEach(el=>el.addEventListener('click',()=>{mode=el.dataset.view;document.querySelectorAll('.nav [data-view]').forEach(x=>x.classList.toggle('active',x===el));$('#current-view').textContent=views[mode];$('#repair-lab').hidden=mode!=='repair';loadFeed().catch(e=>toast(e.message));if(mode==='repair')loadRepair().catch(e=>toast(e.message));}));
$('#focus-watchlists').addEventListener('click',()=>$('#watch-panel').scrollIntoView({behavior:'smooth'}));
$('#feed-filters').addEventListener('change',e=>{if(e.target.type==='radio')e.target.closest('details').open=false;syncFilterLabels();loadFeed().catch(e=>toast(e.message));});
document.addEventListener('click',e=>document.querySelectorAll('.dd[open]').forEach(d=>{if(!d.contains(e.target))d.open=false;}));
$('#watch-form').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);try{const input={name:f.get('name'),query:f.get('query'),maxWorking:Number(f.get('maxWorking')),maxDefect:Number(f.get('maxDefect')),expectedResale:f.get('expectedResale')?Number(f.get('expectedResale')):null,repairBudget:Number(f.get('repairBudget')),sourceList:f.getAll('sourceList'),allowUnknownShipping:f.get('allowUnknownShipping')==='on',fast:f.get('fast')==='on'};await api('/watchlists',{method:'POST',data:input});e.target.reset();toast('Profil erstellt');await refresh();}catch(e){toast(e.message);}});
$('#watchlist').addEventListener('click',async e=>{const btn=e.target.closest('[data-watch]');if(!btn)return;const id=Number(btn.dataset.id);try{if(btn.dataset.watch==='toggle')await api(`/watchlists/${id}`,{method:'PATCH',data:{active:btn.dataset.active!=='true'}});else if(confirm('Suchprofil wirklich löschen?'))await api(`/watchlists/${id}`,{method:'DELETE'});await refresh();}catch(e){toast(e.message);}});
$('#feed').addEventListener('click',async e=>{const rep=e.target.closest('[data-repair]');if(rep){try{const {id}=await api('/repair/projects',{method:'POST',data:{listingId:Number(rep.dataset.repair)}});await openProject(id);loadRepair().catch(()=>{});}catch(ex){toast(ex.message);}return;}const btn=e.target.closest('[data-action]');if(!btn)return;try{await api(`/listings/${Number(btn.dataset.id)}/user-state`,{method:'PATCH',data:{status:btn.dataset.action}});await refresh();}catch(e){toast(e.message);}});
$('#import').addEventListener('click',async()=>{try{const json=JSON.parse($('#import-json').value);const rows=Array.isArray(json)?json:(Array.isArray(json.items)?json.items:null);if(!rows)throw Error('JSON-Array erwartet');const r=await api('/import/facebook',{method:'POST',data:{items:rows}});$('#import-message').textContent=`${r.normalized} Datensätze validiert, ${r.inserted} neue Inserate gespeichert`;await refresh();}catch(e){toast(e.message);}});
$('#provider-list').addEventListener('click',async e=>{const btn=e.target.closest('[data-provider]');if(!btn)return;try{await api(`/providers/${btn.dataset.provider}`,{method:'PATCH',data:{enabled:btn.dataset.enabled!=='true'}});await refresh();}catch(e){toast(e.message);}});
// Repair Lab: projects, own statistics and cost assumptions. Margins are scenarios; actual numbers only from closed projects.
const faultNames={NO_DISPLAY:'Kein Bild',ARTIFACTS:'Artefakte',DRIVER_CRASH:'Treiberabsturz',NO_POWER:'Startet nicht',WATER_DAMAGE:'Wasserschaden',BURN_DAMAGE:'Brandschaden',PARTS_MISSING:'Teile fehlen',UNKNOWN:'Fehler unbekannt'};
const repairStatus={candidate:'KANDIDAT',purchased:'GEKAUFT',repairing:'IN REPARATUR',repaired:'REPARIERT',sold:'VERKAUFT',abandoned:'AUFGEGEBEN'};
const signed=v=>v===null?'–':`${v>0?'+':''}${eur(v)}`;
const numOrNull=v=>v===''||v===null?null:Number(v);
let settingsShown=false;
function costRow(c={fault:'UNKNOWN',model:'',partsMin:0,partsMax:0,hoursMin:0,hoursMax:0}){
  const n=(k,step)=>`<td><input name="${k}" type="number" min="0" step="${step}" value="${esc(c[k])}" required></td>`;
  return `<tr><td><select name="fault">${Object.entries(faultNames).map(([k,v])=>`<option value="${k}"${k===c.fault?' selected':''}>${v}</option>`).join('')}</select></td><td><input name="model" list="models" placeholder="alle Modelle" value="${esc(c.model)}" maxlength="120"></td>${n('partsMin','0.01')}${n('partsMax','0.01')}${n('hoursMin','0.25')}${n('hoursMax','0.25')}<td><button type="button" class="action" data-cost-remove aria-label="Regel entfernen">${icon('close')}</button></td></tr>`;
}
function showSettings(s){
  const f=$('#repair-settings');for(const k of ['hourlyRateEur','saleFeePct','resaleShippingEur'])f.elements[k].value=s[k];
  $('#cost-rows').innerHTML=s.costs.map(costRow).join('');settingsShown=true;
}
function projectSummary(p){
  if(p.actual)return `Tatsächliche Marge ${signed(p.actual.marginEur)} (inkl. Arbeit ${signed(p.actual.marginInclLaborEur)})`;
  const [worst,,best]=p.plan.scenarios;
  return best.marginEur===null?`Worst Case ${signed(worst.marginEur)} · Wiederverkaufswert fehlt`:`Szenarien ${signed(worst.marginEur)} bis ${signed(best.marginEur)}`;
}
async function loadRepair(){
  const [{items},stats,{item:settings}]=await Promise.all([api('/repair/projects'),api('/repair/stats'),api('/repair/settings')]);
  $('#repair-projects').innerHTML=items.length?items.map(p=>`<div class="provider"><div><strong><a href="#" data-project="${p.id}">${esc(p.title)}</a></strong><small>${esc(p.faults.map(f=>faultNames[f]).join(', '))}${p.model?` · ${esc(p.model)}`:''} · Kauf ${eur(p.purchasePriceEur)}</small><small>${esc(projectSummary(p))}</small></div><span class="status ${p.status==='sold'?'ok':''}">${repairStatus[p.status]}</span></div>`).join(''):'<div class="helper">Noch keine Projekte. Im Feed bei einem defekten Inserat „Repair Lab“ wählen.</div>';
  $('#repair-min').textContent=stats.minSample;
  const done=stats.items.filter(x=>x.n>0);
  $('#repair-stats').innerHTML=done.length?`<table class="grid"><thead><tr><th>Fehlerklasse</th><th>n</th><th>Erfolg</th><th>teilw.</th><th>gescheitert</th><th>Erfolgsquote</th><th>Ø Marge</th></tr></thead><tbody>${done.map(x=>`<tr><td>${x.fault==='ALL'?'Alle':esc(faultNames[x.fault])}</td><td>${x.n}</td><td>${x.success}</td><td>${x.partial}</td><td>${x.failed}</td><td>${x.successRatePct===null?`ab ${stats.minSample}`:x.successRatePct+' %'}</td><td>${x.avgMarginEur===null?'–':`${signed(x.avgMarginEur)} (n=${x.marginSamples})`}</td></tr>`).join('')}</tbody></table>`:'<p class="helper">Noch keine abgeschlossenen Projekte.</p>';
  if(!settingsShown)showSettings(settings);
}
let openId=null;
function fillProject(p){
  openId=p.id;const f=$('#repair-form');
  $('#rp-title').textContent=p.title;
  $('#rp-sub').innerHTML=`${p.url?`<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">Original öffnen</a> · `:''}angelegt ${esc(timeAgo(p.createdAt))}`;
  for(const k of ['status','outcome','purchasePriceEur','salvageEstimateEur','hoursSpent','notes'])f.elements[k].value=p[k];
  for(const k of ['model','purchaseShippingEur','purchasedAt','resaleEstimateEur','soldPriceEur','soldFeesEur','soldShippingEur','soldAt'])f.elements[k].value=p[k]??'';
  f.elements.parts.value=p.parts.map(x=>`${x.name}; ${String(x.costEur).replace('.',',')}`).join('\n');
  $('#rp-faults').innerHTML=Object.entries(faultNames).map(([k,v])=>`<label><input type="checkbox" name="faults" value="${k}"${p.faults.includes(k)?' checked':''}> ${v}</label>`).join('');
  $('#rp-scenarios').innerHTML=`<table class="grid"><thead><tr><th>Szenario</th><th>Teile</th><th>Arbeit</th><th>Investition</th><th>Erlös netto</th><th>Marge</th></tr></thead><tbody>${p.plan.scenarios.map(s=>`<tr class="${s.key}"><td>${esc(s.label)}</td><td>${eur(s.partsEur)}</td><td>${s.hours} h · ${eur(s.laborEur)}</td><td>${p.plan.shippingKnown?'':'≥ '}${eur(s.investmentEur)}</td><td>${s.revenueEur===null?'–':eur(s.revenueEur)}</td><td><b>${signed(s.marginEur)}</b></td></tr>`).join('')}</tbody></table>`;
  $('#rp-assumptions').innerHTML=p.plan.assumptions.map(a=>`<li>${esc(a)}</li>`).join('');
  $('#rp-actual').innerHTML=p.actual?`<strong>Tatsächliches Ergebnis</strong><p>Kosten ${eur(p.actual.costsEur)} · Erlös netto ${eur(p.actual.revenueEur)} · Marge <b>${signed(p.actual.marginEur)}</b> · mit Arbeitszeit (${eur(p.actual.laborEur)}) ${signed(p.actual.marginInclLaborEur)}</p>`:'<strong>Tatsächliches Ergebnis</strong><p>Erscheint, sobald der Status „Verkauft“ oder „Aufgegeben“ ist.</p>';
}
async function openProject(id){fillProject((await api(`/repair/projects/${Number(id)}`)).item);const d=$('#repair-dialog');if(!d.open)d.showModal();}
const parseParts=text=>text.split('\n').map(l=>l.trim()).filter(Boolean).map(l=>{const m=l.match(/^(.+?)\s*[;:]\s*(\d+(?:[.,]\d{1,2})?)\s*€?$/);if(!m)throw Error(`Teile-Zeile ungültig: „${l}“ (Name; Kosten)`);return {name:m[1],costEur:Number(m[2].replace(',','.'))};});
$('#repair-form').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);try{
  const data={status:f.get('status'),outcome:f.get('outcome'),model:f.get('model').trim()||null,faults:f.getAll('faults'),purchasePriceEur:Number(f.get('purchasePriceEur')),
    purchaseShippingEur:numOrNull(f.get('purchaseShippingEur')),purchasedAt:f.get('purchasedAt')||null,parts:parseParts(f.get('parts')),hoursSpent:Number(f.get('hoursSpent')),
    resaleEstimateEur:numOrNull(f.get('resaleEstimateEur')),salvageEstimateEur:Number(f.get('salvageEstimateEur')),soldPriceEur:numOrNull(f.get('soldPriceEur')),
    soldFeesEur:numOrNull(f.get('soldFeesEur')),soldShippingEur:numOrNull(f.get('soldShippingEur')),soldAt:f.get('soldAt')||null,notes:f.get('notes')};
  if(!data.faults.length)throw Error('Mindestens eine Fehlerklasse wählen');
  fillProject((await api(`/repair/projects/${openId}`,{method:'PATCH',data})).item);toast('Projekt gespeichert');loadRepair().catch(()=>{});
}catch(ex){toast(ex.message);}});
$('#rp-close').addEventListener('click',()=>$('#repair-dialog').close());
$('#rp-delete').addEventListener('click',async()=>{if(!confirm('Reparaturprojekt löschen? Das Inserat bleibt erhalten.'))return;try{await api(`/repair/projects/${openId}`,{method:'DELETE'});$('#repair-dialog').close();toast('Projekt gelöscht');await loadRepair();}catch(e){toast(e.message);}});
$('#repair-projects').addEventListener('click',e=>{const a=e.target.closest('[data-project]');if(!a)return;e.preventDefault();openProject(a.dataset.project).catch(ex=>toast(ex.message));});
$('#cost-add').addEventListener('click',()=>$('#cost-rows').insertAdjacentHTML('beforeend',costRow()));
$('#cost-rows').addEventListener('click',e=>{const b=e.target.closest('[data-cost-remove]');if(b)b.closest('tr').remove();});
$('#repair-settings').addEventListener('submit',async e=>{e.preventDefault();const f=e.target;try{
  const costs=[...$('#cost-rows').rows].map(r=>{const v=k=>r.querySelector(`[name="${k}"]`).value;return {fault:v('fault'),model:v('model').trim(),partsMin:Number(v('partsMin')),partsMax:Number(v('partsMax')),hoursMin:Number(v('hoursMin')),hoursMax:Number(v('hoursMax'))};});
  const {item}=await api('/repair/settings',{method:'PUT',data:{hourlyRateEur:Number(f.elements.hourlyRateEur.value),saleFeePct:Number(f.elements.saleFeePct.value),resaleShippingEur:Number(f.elements.resaleShippingEur.value),costs}});
  showSettings(item);toast('Annahmen gespeichert');await loadRepair();
}catch(ex){toast(ex.message);}});
syncFilterLabels();refresh().then(()=>{connectEvents();syncPush().catch(e=>toast(e.message));});setInterval(refresh,15000);
