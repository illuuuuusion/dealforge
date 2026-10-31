#!/usr/bin/env node
/** Read-only provider smoke test. Never invoked by the scheduler. */
import { normalizeFacebook,fetchKleinanzeigen,normalizeKlaz } from '../src/providers.js';
const provider=process.argv[2];
const execute=process.argv.includes('--live');
const query=process.env.PROBE_QUERY||'RTX 4070 Super';
function inspect(items,start){
  const usable=items.filter(Boolean);
  const ts=usable.map(i=>Date.parse(i.publishedAt)).filter(Number.isFinite);
  const fields=['externalId','title','url','priceEur','publishedAt','imageUrl','description','shippingEur'];
  console.log(JSON.stringify({count:usable.length,invalid:items.length-usable.length,latencyMs:Date.now()-start,
    completeness:Object.fromEntries(fields.map(f=>[f,usable.length?Math.round(100*usable.filter(i=>i[f]!==null&&i[f]!==undefined&&i[f]!=='').length/usable.length):0])),
    newestAgeMinutes:ts.length?Math.round((Date.now()-Math.max(...ts))/60000):null,
    duplicateIds:usable.length-new Set(usable.map(i=>i.externalId)).size,
    sample:usable.slice(0,2).map(x=>({id:x.externalId,title:x.title,price:x.priceEur,publishedAt:x.publishedAt}))},null,2));
  if(!usable.length || usable.length<items.length/2)process.exitCode=2;
}
async function main(){
  if(!['kleinanzeigen','facebook'].includes(provider))throw Error('Usage: npm run probe -- kleinanzeigen|facebook [--live]');
  if(!execute){console.log('Dry run; no requests, no charges. Use --live with own credentials to execute a real provider test.');return;}
  const start=Date.now();
  if(provider==='kleinanzeigen'){
    if(!process.env.KLAZ_API_KEY)throw Error('Missing KLAZ_API_KEY');
    const items=await fetchKleinanzeigen(query,{klazKey:process.env.KLAZ_API_KEY,klazLocationId:process.env.KLAZ_LOCATION_ID||'',klazRadiusKm:process.env.KLAZ_RADIUS_KM||''});
    inspect(items,start);return;
  }
  const token=process.env.APIFY_TOKEN,id=process.env.FB_ACTOR_ID,input=process.env.FB_ACTOR_INPUT_JSON;
  if(!token||!id||!input)throw Error('Missing APIFY_TOKEN / FB_ACTOR_ID / FB_ACTOR_INPUT_JSON');
  // Actors have different input schemas: run only the explicit user-configured actor and input.
  const response=await fetch(`https://api.apify.com/v2/acts/${encodeURIComponent(id)}/run-sync-get-dataset-items`,{
    method:'POST',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify(JSON.parse(input)),signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw Error(`Apify HTTP ${response.status} ${String(await response.text()).slice(0,200)}`);
  const data=await response.json();
  if(!Array.isArray(data))throw Error('Apify response not an array; inspect actor output schema');
  inspect(data.map(normalizeFacebook),start);
}
main().catch(e=>{console.error('Probe failed:',e.message);process.exitCode=1;});
