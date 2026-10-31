import test from 'node:test';
import assert from 'node:assert/strict';
import {callRecord,summarize} from '../scripts/probe.ts';
const item=(id: string,extra={})=>({externalId:id,title:'RTX 5080',url:`https://www.ebay.de/itm/${id}`,priceEur:500,publishedAt:null,...extra});
test('Probe summary reports percentiles, stable IDs and errors',()=>{
 const at='2026-10-31T10:00:00Z';
 const records=[
  callRecord({provider:'ebay',variant:'default',query:'q',run:1,startedAt:at,latencyMs:100,items:[item('1'),item('2',{offerType:'AUCTION'}),null]}),
  callRecord({provider:'ebay',variant:'default',query:'q',run:2,startedAt:at,latencyMs:300,items:[item('1')]}),
  callRecord({provider:'ebay',variant:'default',query:'x',run:1,startedAt:at,latencyMs:900,error:'Provider HTTP 429: slow down'}),
 ];
 assert.equal(records[0].invalid,1);assert.ok(!('description' in records[0].items[0]));
 const s=summarize(records);
 assert.deepEqual(s.latencyMs,{p50:300,p95:900});
 assert.equal(s.successRatePct,67);assert.equal(s.uniqueIds,2);assert.equal(s.stableIdPct,50);
 assert.equal(s.missingPublishedAtPct,100);assert.equal(s.offerTypes.AUCTION,1);
 assert.equal(s.errors.length,1);assert.equal(s.sampleTooSmall,true);
});
