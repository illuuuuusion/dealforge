import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEbay,normalizeKlaz,normalizeFacebook,providerReady,planScan,requestJson,backoffMs,parseRetryAfter,ProviderError} from '../src/index.ts';
test('eBay listing normalization',()=>{
 const row=normalizeEbay({itemId:'1',title:'RTX 5080',itemWebUrl:'https://www.ebay.de/itm/123',price:{value:'650'},shippingOptions:[{shippingCost:{value:'7.99'}}]});
 assert.ok(row);assert.equal(row.priceEur,650);assert.equal(row.shippingEur,7.99);assert.equal(row.source,'ebay');
});
test('Kleinanzeigen Agent docs schema normalization',()=>{
 const row=normalizeKlaz({ad_id:'42',title:'RTX 3080',ad_url:'https://www.kleinanzeigen.de/s-anzeige/foo/42',price:{amount:90,currency_code:'EUR'},created_at:'2026-10-31T10:00:00Z'});
 assert.ok(row);assert.equal(row.externalId,'42');assert.equal(row.priceEur,90);assert.equal(row.shippingEur,null);
});
test('Facebook import rejects non-Facebook URL',()=>{
 assert.equal(normalizeFacebook({id:'10',title:'GPU',priceAmount:90,url:'https://evil.example/item/10'}),null);
 assert.equal(normalizeFacebook({id:'10',title:'GPU',priceAmount:90,url:'https://www.facebook.com/marketplace/item/10'})?.externalId,'10');
});
test('Unverified Facebook live integration is never marked ready',()=>{
 assert.equal(providerReady({ebayAppId:'a',ebayClientSecret:'b',klazKey:''}).facebook.ready,false);
});
test('eBay offer type distinguishes auctions from fixed price',()=>{
 const base={itemId:'2',title:'RTX 5080',itemWebUrl:'https://www.ebay.de/itm/2',price:{value:'500'}};
 assert.equal(normalizeEbay({...base,buyingOptions:['AUCTION'],itemEndDate:'2026-11-01T10:00:00Z',bidCount:3})?.offerType,'AUCTION');
 assert.equal(normalizeEbay({...base,buyingOptions:['FIXED_PRICE','BEST_OFFER']})?.offerType,'FIXED_PRICE');
});
test('Configured but unapproved providers never go live',()=>{
 const cfg={ebayAppId:'a',ebayClientSecret:'b',klazKey:'k'};
 assert.equal(providerReady(cfg).ebay.live,false);
 assert.equal(providerReady(cfg).kleinanzeigen.live,false);
 const approved=providerReady({...cfg,approvedProviders:['ebay','facebook']});
 assert.equal(approved.ebay.live,true);assert.equal(approved.kleinanzeigen.live,false);assert.equal(approved.facebook.live,false);
});

test('DF-104: eBay GPU watchlists share buckets, free text stays separate',()=>{
 const ready=providerReady({ebayAppId:'a',ebayClientSecret:'b',klazKey:'k',approvedProviders:['ebay','kleinanzeigen']});
 const w=(query: string,sourceList=['ebay'])=>({query,sourceList,active:true});
 const plan=planScan([w('RTX 4070 Super'),w('RTX 4070'),w('RTX 4080 Super'),w('RTX 3080'),w('steam deck'),w('RTX 5080',['kleinanzeigen'])],ready);
 assert.deepEqual(plan.map(x=>x.label),['nvidia-ada','nvidia-ampere','steam deck','RTX 5080']);
 assert.equal(planScan([w('RTX 4070 Super')],providerReady({ebayAppId:'a',ebayClientSecret:'b',klazKey:''})).length,0);
});

const noSleep=async()=>{};
const fail=(p: Promise<unknown>)=>p.then(()=>{throw Error('expected rejection');},(e: ProviderError)=>e);
test('DF-205: network errors and 5xx retry with capped, jittered exponential backoff',async()=>{
 const waits: number[]=[];let calls=0;
 const fetch=async()=>{calls++;if(calls===1)throw new TypeError('fetch failed');if(calls===2)return new Response('down',{status:503});return new Response('{"ok":1}');};
 assert.deepEqual(await requestJson('https://x.test',{},{fetch,sleep:async ms=>{waits.push(ms);},random:()=>1,baseDelayMs:100,maxDelayMs:150}),{ok:1});
 assert.equal(calls,3);assert.deepEqual(waits,[100,150]);
 assert.equal(backoffMs(3,1000,30000,()=>0.5),4000);assert.equal(backoffMs(10,1000,30000,()=>0.5),15000);
 const last=await fail(requestJson('https://x.test',{},{fetch:async()=>new Response('x',{status:502}),sleep:noSleep,attempts:2}));
 assert.equal(last.code,'HTTP');assert.equal(last.httpStatus,502);
});
test('DF-205/T-14: 429 is never retried in-process and carries the provider wait time',async()=>{
 let calls=0;
 const err=await fail(requestJson('https://x.test',{},{fetch:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'7'}});},sleep:noSleep}));
 assert.equal(err.code,'RATE_LIMIT');assert.equal(err.retryAfterMs,7000);assert.equal(calls,1);
 assert.ok((parseRetryAfter(new Date(Date.now()+5000).toUTCString())??0)>3000);
 assert.equal((await fail(requestJson('https://x.test',{},{fetch:async()=>new Response('',{status:429}),sleep:noSleep}))).retryAfterMs,60000);
});
test('DF-206/T-17: the budget hook runs before every attempt and stops further requests',async()=>{
 let calls=0,reserved=0;
 const err=await fail(requestJson('https://x.test',{},{fetch:async()=>{calls++;return new Response('x',{status:503});},sleep:noSleep,
  beforeRequest:async()=>{if(++reserved>2)throw new ProviderError('QUOTA','Tagesbudget erreicht');}}));
 assert.equal(err.code,'QUOTA');assert.equal(calls,2);
});
test('Provider errors are classified for the status page',async()=>{
 assert.equal((await fail(requestJson('https://x.test',{},{fetch:async()=>new Response('no',{status:401}),sleep:noSleep}))).code,'AUTH');
 assert.equal((await fail(requestJson('https://x.test',{},{fetch:async()=>new Response('<html>'),sleep:noSleep}))).code,'SCHEMA_CHANGE');
 assert.equal((await fail(requestJson('https://x.test',{},{fetch:async()=>{throw new TypeError('ECONNRESET');},sleep:noSleep,attempts:1}))).code,'NETWORK');
});
test('DF-207: runtime switch turns an approved provider off without touching others',()=>{
 const cfg={ebayAppId:'a',ebayClientSecret:'b',klazKey:'k',approvedProviders:['ebay','kleinanzeigen']};
 const r=providerReady(cfg,new Set(['ebay']));
 assert.equal(r.ebay.live,false);assert.equal(r.ebay.enabled,false);assert.equal(r.kleinanzeigen.live,true);
});
