#!/usr/bin/env node
/** Read-only provider benchmark. Never invoked by the scheduler; live calls only with --live. */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fetchEbay,fetchKleinanzeigen,normalizeFacebook } from '../src/providers.js';

const fields=['externalId','title','url','priceEur','publishedAt','imageUrl','shippingEur','condition'];
const pct=(values,p)=>{if(!values.length)return null;const s=[...values].sort((a,b)=>a-b);return s[Math.max(0,Math.ceil(p/100*s.length)-1)];};

/** One log record per call. Keeps listing facts only: no description, no seller data. */
export function callRecord({provider,variant,query,run,startedAt,latencyMs,items,error}){
  const usable=(items||[]).filter(Boolean);
  const ts=usable.map(i=>Date.parse(i.publishedAt)).filter(Number.isFinite);
  return {provider,variant,query,run,startedAt,latencyMs,ok:!error,error:error?String(error).slice(0,200):null,
    count:usable.length,invalid:(items||[]).length-usable.length,
    duplicateIds:usable.length-new Set(usable.map(i=>i.externalId)).size,
    completeness:Object.fromEntries(fields.map(f=>[f,usable.length?Math.round(100*usable.filter(i=>i[f]!==null&&i[f]!==undefined&&i[f]!=='').length/usable.length):0])),
    newestAgeMinutes:ts.length?Math.round((Date.parse(startedAt)-Math.max(...ts))/60000):null,
    items:usable.map(i=>({id:i.externalId,title:i.title,url:i.url,price:i.priceEur,shipping:i.shippingEur,publishedAt:i.publishedAt,offerType:i.offerType??null}))};
}

export function summarize(records){
  const ok=records.filter(r=>r.ok);
  const latencies=records.map(r=>r.latencyMs);
  const all=ok.flatMap(r=>r.items);
  const ids=new Set(all.map(i=>i.id));
  // Stable IDs: IDs of run 1 that reappear in a later run of the same query/variant.
  const byKey=Map.groupBy(ok,r=>`${r.variant}|${r.query}`);
  let firstRunIds=0,stableIds=0;
  for(const runs of byKey.values()){
    const first=runs.find(r=>r.run===1);if(!first||runs.length<2)continue;
    const later=new Set(runs.filter(r=>r.run>1).flatMap(r=>r.items.map(i=>i.id)));
    firstRunIds+=first.items.length;stableIds+=first.items.filter(i=>later.has(i.id)).length;
  }
  const valid=all.filter(i=>i.id&&i.title&&/^https:\/\//.test(i.url||'')&&Number.isFinite(i.price));
  return {calls:records.length,successRatePct:records.length?Math.round(100*ok.length/records.length):0,
    latencyMs:{p50:pct(latencies,50),p95:pct(latencies,95)},
    listings:all.length,uniqueIds:ids.size,validPct:all.length?Math.round(100*valid.length/all.length):0,
    missingPublishedAtPct:all.length?Math.round(100*all.filter(i=>!i.publishedAt).length/all.length):0,
    stableIdPct:firstRunIds?Math.round(100*stableIds/firstRunIds):null,
    offerTypes:Object.fromEntries([...Map.groupBy(all,i=>i.offerType??'n/a')].map(([k,v])=>[k,v.length])),
    errors:records.filter(r=>!r.ok).map(r=>`${r.variant}|${r.query}: ${r.error}`),
    sampleTooSmall:ids.size<100};
}

function plan(provider){
  const queries=(process.env.PROBE_QUERIES||'RTX 4070 Super|RTX 5080|Grafikkarte defekt').split('|').map(x=>x.trim()).filter(Boolean);
  const repeat=Number(process.env.PROBE_REPEAT||2);
  const calls=[];
  if(provider==='facebook'){for(let run=1;run<=repeat;run++)calls.push({variant:'apify',query:'(FB_ACTOR_INPUT_JSON)',run});return calls;}
  const variants=provider==='ebay'?['default','auction']:['default'];
  for(let run=1;run<=repeat;run++)for(const query of queries)for(const variant of variants)calls.push({variant,query,run});
  return calls;
}

async function fetchApify(){
  const token=process.env.APIFY_TOKEN,id=process.env.FB_ACTOR_ID,input=process.env.FB_ACTOR_INPUT_JSON;
  if(!token||!id||!input)throw Error('Missing APIFY_TOKEN / FB_ACTOR_ID / FB_ACTOR_INPUT_JSON');
  // Actors have different input schemas: run only the explicit user-configured actor and input.
  const response=await fetch(`https://api.apify.com/v2/acts/${encodeURIComponent(id)}/run-sync-get-dataset-items`,{
    method:'POST',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify(JSON.parse(input)),signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw Error(`Apify HTTP ${response.status} ${String(await response.text()).slice(0,200)}`);
  const data=await response.json();
  if(!Array.isArray(data))throw Error('Apify response not an array; inspect actor output schema');
  return data.map(normalizeFacebook);
}

function fetcher(provider){
  const env=process.env;
  if(provider==='ebay'){
    if(!env.EBAY_APP_ID||!env.EBAY_CLIENT_SECRET)throw Error('Missing EBAY_APP_ID / EBAY_CLIENT_SECRET');
    return ({query,variant})=>fetchEbay(query,{ebayAppId:env.EBAY_APP_ID,ebayClientSecret:env.EBAY_CLIENT_SECRET},{auction:variant==='auction'});
  }
  if(provider==='kleinanzeigen'){
    if(!env.KLAZ_API_KEY)throw Error('Missing KLAZ_API_KEY');
    return ({query})=>fetchKleinanzeigen(query,{klazKey:env.KLAZ_API_KEY,klazLocationId:env.KLAZ_LOCATION_ID||'',klazRadiusKm:env.KLAZ_RADIUS_KM||''});
  }
  return fetchApify;
}

async function main(){
  const provider=process.argv[2];
  if(!['ebay','kleinanzeigen','facebook'].includes(provider))throw Error('Usage: npm run probe -- ebay|kleinanzeigen|facebook [--live]');
  const calls=plan(provider);
  const maxCalls=Number(process.env.PROBE_MAX_CALLS||12);
  console.log(`Plan: ${calls.length} Provider-Calls (Budget PROBE_MAX_CALLS=${maxCalls})`);
  if(calls.length>maxCalls)throw Error('Geplante Calls überschreiten PROBE_MAX_CALLS; nichts ausgeführt');
  if(!process.argv.includes('--live')){console.log('Dry run; no requests, no charges. Use --live with own credentials to execute a real provider test.');return;}
  const fetchItems=fetcher(provider);
  const log=`data/probes/${provider}-${new Date().toISOString().slice(0,10)}.jsonl`;
  fs.mkdirSync('data/probes',{recursive:true});
  const records=[];
  for(const call of calls){
    const startedAt=new Date().toISOString(),start=Date.now();
    let items=[],error=null;
    try{items=await fetchItems(call);}catch(e){error=e.message;}
    const record=callRecord({provider,...call,startedAt,latencyMs:Date.now()-start,items,error});
    records.push(record);fs.appendFileSync(log,JSON.stringify(record)+'\n');
    console.log(`${record.ok?'ok ':'ERR'} run ${call.run} ${call.variant} "${call.query}": ${record.count} Treffer, ${record.latencyMs} ms${error?` – ${error}`:''}`);
  }
  const summary=summarize(records);
  fs.appendFileSync(log,JSON.stringify({summary})+'\n');
  console.log(JSON.stringify(summary,null,2),`\nLog: ${log}`);
  if(!summary.successRatePct)process.exitCode=2;
}

if(import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error('Probe failed:',e.message);process.exitCode=1;});
