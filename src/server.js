import http from 'node:http';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac, timingSafeEqual, scryptSync } from 'node:crypto';
import { config } from './config.js';
import { openDatabase, watchlists, createWatchlist, deleteWatchlist, toggleWatchlist, ingestListings, listDeals, listStats, setListingStatus, logSourceRun } from './db.js';
import { fetchSource,normalizeFacebook,providerReady } from './providers.js';
const root=join(dirname(fileURLToPath(import.meta.url)),'../public');
const db=openDatabase(config.dbPath,{demoMode:config.demoMode});
const secret=config.sessionSecret || randomBytes(32).toString('hex');
if((!config.demoMode || !['127.0.0.1','localhost'].includes(config.host)) && (!config.appPassword || config.appPassword.length<16)){
  throw Error('Public deployment requires APP_PASSWORD with at least 16 characters');
}
const passwordHash=config.appPassword?scryptSync(config.appPassword,'dealforge-v1',32):null;
const loginAttempts=new Map();
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml'};
const send=(res,status,body,headers={})=>{const data=typeof body==='string'?body:JSON.stringify(body);res.writeHead(status,{'Content-Type':typeof body==='string'?'text/plain; charset=utf-8':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(data);};
function sign(payload){return createHmac('sha256',secret).update(payload).digest('hex');}
function validSession(req){if(!config.appPassword)return true;
  const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('df_session='))?.slice(11);
  if(!cookie)return false;
  const [expiration,tag]=cookie.split('.');
  if(!/^\d{10,14}$/.test(expiration||'')||!/^[a-f0-9]{64}$/.test(tag||''))return false;
  const expected=Buffer.from(sign(expiration),'hex'),got=Buffer.from(tag,'hex');
  return expected.length===got.length && timingSafeEqual(expected,got) && Date.now()<Number(expiration);
}
function secureCookie(){return config.appOrigin.startsWith('https://')?'; Secure':'';}
async function bodyJson(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Error('JSON-Payload > 1 MB');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}
function mutationAllowed(req){if(req.headers['x-dealforge-action']!=='1')return false;
  const origin=req.headers.origin;
  if(!origin)return true; // scripts/curl require session and custom header
  const expected=config.appOrigin || `http://${req.headers.host}`;
  return origin===expected;
}
let scanning=false;
async function scan(source='all'){
  if(scanning)throw Error('Scan läuft bereits');
  scanning=true;
  const report=[];
  try{
    const ready=providerReady(config);
    const pairs=new Map();
    for(const watch of watchlists(db).filter(x=>x.active)){
      for(const platform of watch.sourceList){
        if(platform==='facebook'||(source!=='all' && source!==platform)||!ready[platform]?.ready)continue;
        pairs.set(`${platform}|${watch.query.toLowerCase()}`,{platform,query:watch.query});
      }
    }
    // Sequential calls to bound provider load. Scheduler defaults to 5 min.
    for(const {platform,query} of pairs.values()){
      try{const listings=await fetchSource(platform,query,config);const summary=ingestListings(db,listings);
        logSourceRun(db,platform,summary);report.push({platform,query,ok:true,...summary});}
      catch(e){logSourceRun(db,platform,null,e.message);report.push({platform,query,ok:false,error:e.message});}
    }
    return report;
  }finally{scanning=false;}
}
async function serve(req,res){
  const base=`http://${req.headers.host||'localhost'}`;
  let url;try{url=new URL(req.url,base);}catch{return send(res,400,{error:'Invalid request URL'});}
  if(req.method==='GET'&&url.pathname==='/health')return send(res,200,{ok:true,service:'dealforge'});
  if(req.method==='POST'&&url.pathname==='/api/login'){
    if(!mutationAllowed(req))return send(res,403,{error:'Origin/Header ungültig'});
    const ip=req.socket.remoteAddress||'unknown';let item=loginAttempts.get(ip)||{count:0,until:0};
    if(Date.now()<item.until)return send(res,429,{error:'Zu viele Login-Versuche'});
    let payload;try{payload=await bodyJson(req);}catch{return send(res,400,{error:'Invalid JSON'});}
    const candidate=String(payload.password||'');const candidateHash=scryptSync(candidate,'dealforge-v1',32);
    const ok=!passwordHash || timingSafeEqual(candidateHash,passwordHash);
    if(!ok){item.count++;item.until=item.count>=8?Date.now()+60000:0;loginAttempts.set(ip,item);return send(res,401,{error:'Falsches Passwort'});}
    loginAttempts.delete(ip);
    const expiry=String(Date.now()+7*24*3600000),token=`${expiry}.${sign(expiry)}`;
    return send(res,200,{ok:true}, {'Set-Cookie':`df_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secureCookie()}`});
  }
  if(req.method==='GET' && (url.pathname==='/' || /^\/(app\.js|styles\.css)$/.test(url.pathname))){
    const fname=url.pathname==='/'?'index.html':url.pathname.slice(1);
    const file=join(root,fname);let data;try{data=fs.readFileSync(file);}catch{return send(res,404,'Not found');}
    res.writeHead(200,{'Content-Type':mime['.'+fname.split('.').pop()]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'});
    return res.end(data);
  }
  if(!url.pathname.startsWith('/api/'))return send(res,404,{error:'Nicht gefunden'});
  if(!validSession(req))return send(res,401,{error:'Bitte anmelden',requiresLogin:true});
  if(req.method!=='GET'&&!mutationAllowed(req))return send(res,403,{error:'Origin/Header ungültig'});
  try{
    if(req.method==='GET'&&url.pathname==='/api/state')return send(res,200,{watchlists:watchlists(db),stats:listStats(db),providers:providerReady(config),demoMode:config.demoMode,scanning});
    if(req.method==='GET'&&url.pathname==='/api/deals'){
      const mode=url.searchParams.get('mode')||'all',source=url.searchParams.get('source')||'all';
      const watchlistId=url.searchParams.get('watchlistId');
      return send(res,200,{items:listDeals(db,{mode,source,watchlistId:watchlistId?Number(watchlistId):null})});
    }
    if(req.method==='POST'&&url.pathname==='/api/watchlists'){
      const id=createWatchlist(db,await bodyJson(req));return send(res,201,{id});
    }
    const watchMatch=url.pathname.match(/^\/api\/watchlists\/(\d+)$/);
    if(watchMatch && req.method==='DELETE')return send(res,200,{ok:deleteWatchlist(db,Number(watchMatch[1]))});
    if(watchMatch && req.method==='PATCH'){
      const body=await bodyJson(req);if(typeof body.active!=='boolean')return send(res,400,{error:'active boolean erforderlich'});
      return send(res,200,{ok:toggleWatchlist(db,Number(watchMatch[1]),body.active)});
    }
    const itemMatch=url.pathname.match(/^\/api\/listings\/(\d+)\/status$/);
    if(itemMatch&&req.method==='PATCH')return send(res,200,{ok:setListingStatus(db,Number(itemMatch[1]),(await bodyJson(req)).status)});
    if(req.method==='POST'&&url.pathname==='/api/scan'){
      const {source='all'}=await bodyJson(req);
      if(!['all','ebay','kleinanzeigen'].includes(source))return send(res,400,{error:'Ungültige Quelle'});
      return send(res,200,{results:await scan(source)});
    }
    if(req.method==='POST'&&url.pathname==='/api/import/facebook'){
      const payload=await bodyJson(req);
      if(!Array.isArray(payload.items)||payload.items.length>100)return send(res,400,{error:'Maximal 100 Einträge als items:[]'});
      const normalized=payload.items.map(normalizeFacebook).filter(Boolean);
      return send(res,200,{normalized:normalized.length,...ingestListings(db,normalized)});
    }
    return send(res,404,{error:'Endpunkt nicht vorhanden'});
  }catch(e){console.error('[dealforge]',e.message);return send(res,400,{error:e.message});}
}
const server=http.createServer((req,res)=>{serve(req,res).catch(e=>{console.error(e);if(!res.headersSent)send(res,500,{error:'Interner Fehler'});else res.end();});});
server.listen(config.port,config.host,()=>console.log(`DealForge at http://${config.host}:${config.port} | demo=${config.demoMode} | scheduler=${config.scheduler}`));
if(config.scheduler){
  setInterval(()=>scan().then(r=>console.log('[scan]',r.length,'queries')).catch(e=>console.error('[scan]',e.message)),config.pollSeconds*1000).unref();
}
