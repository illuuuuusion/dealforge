import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {detectModel,resolveWatchTargets,profiles} from '../src/gpu.js';
import {classify,matchesWatchlist,scoreListing} from '../src/scoring.js';
import {planScan,providerReady} from '../src/providers.js';
import {openDatabase,ingestListings,listDeals,createWatchlist} from '../src/db.js';

// Real eBay titles (31.10.2026 scan) plus plan cases T-01..T-08 and gpu-search regressions.
const fixtures=JSON.parse(readFileSync(new URL('../fixtures/gpu-listings.json',import.meta.url),'utf8'));
test('GPU listing fixtures: model, VRAM and health',()=>{
 assert.ok(fixtures.length>=40);
 for(const f of fixtures){
  const m=detectModel(f);
  assert.equal(m?.model??null,f.model,f.title);
  if(f.vramGb)assert.equal(m.vramGb,f.vramGb,f.title);
  assert.equal(classify(f),f.health,f.title);
 }
});

const watch=(query,extra={})=>({query,maxWorking:450,maxDefect:130,repairBudget:50,...extra});
test('T-02/T-03: model variants and VRAM never cross-match',()=>{
 assert.equal(matchesWatchlist({title:'MSI RTX 4070 Ti Gaming X Trio 12GB'},watch('RTX 4070')),false);
 assert.equal(matchesWatchlist({title:'ZOTAC RTX 4070 Ti Super Trinity'},watch('RTX 4070 Super')),false);
 assert.equal(matchesWatchlist({title:'MSI RTX 3060 Ventus 8GB'},watch('RTX 3060 12GB')),false);
 assert.equal(matchesWatchlist({title:'ASUS RTX 3060 12GB Dual'},watch('RTX 3060 12GB')),true);
 // Family query accepts every VRAM variant and listings without VRAM; the 12GB-only query does not.
 assert.equal(matchesWatchlist({title:'Gigabyte RTX 3060 Gaming OC'},watch('RTX 3060')),true);
 assert.equal(matchesWatchlist({title:'Gigabyte RTX 3060 Gaming OC'},watch('RTX 3060 12GB')),false);
 assert.equal(matchesWatchlist({title:'K&N 66-3080 Luftfilter'},watch('RTX 3080')),false);
 // Free-text queries without a GPU profile keep token matching.
 assert.equal(matchesWatchlist({title:'Steam Deck OLED 1TB'},watch('steam deck')),true);
});
test('Every watchlist model in the form resolves to profiles',()=>{
 for(const p of profiles)assert.ok(resolveWatchTargets(p.family??p.name.replace(/ Repair$/,'')),p.name);
});

const fresh={firstSeenAt:new Date().toISOString(),shippingEur:6};
test('T-09: unknown shipping never yields a confirmed deal',()=>{
 const a=scoreListing({...fresh,title:'RTX 4070 Super',priceEur:300,shippingEur:null},watch('RTX 4070 Super',{maxWorking:400}));
 assert.deepEqual(a.alerts,[]);assert.equal(a.needsPriceCheck,true);assert.equal(a.knownTotalEur,null);
 const pickup=scoreListing({...fresh,title:'RTX 4070 Super',priceEur:300,shippingEur:null},watch('RTX 4070 Super',{maxWorking:400,allowUnknownShipping:true}));
 assert.ok(pickup.alerts.includes('DEAL'));assert.equal(pickup.needsPriceCheck,false);
});
test('T-10: missing source timestamp is labelled first-seen',()=>{
 const a=scoreListing({...fresh,title:'RTX 4070 Super',priceEur:300,firstSeenAt:new Date(Date.now()-120000).toISOString()},watch('RTX 4070 Super'));
 assert.equal(a.timestampBasis,'first-seen');assert.ok(a.reasons[0].includes('erstmals entdeckt'));
});
test('Auctions count as deal only shortly before they end',()=>{
 const auction=hours=>({...fresh,title:'RTX 4070 Super',priceEur:200,offerType:'AUCTION',bidCount:3,auctionEndsAt:new Date(Date.now()+hours*3600000).toISOString()});
 const early=scoreListing(auction(48),watch('RTX 4070 Super'));
 assert.deepEqual(early.alerts,[]);assert.ok(early.reasons.some(r=>r.startsWith('Auktion: aktuelles Gebot, 3 Gebote')));
 assert.ok(scoreListing(auction(2),watch('RTX 4070 Super')).alerts.includes('DEAL'));
});

test('DF-104: eBay GPU watchlists share buckets, free text stays separate',()=>{
 const ready=providerReady({ebayAppId:'a',ebayClientSecret:'b',klazKey:'k',approvedProviders:['ebay','kleinanzeigen']});
 const w=(query,sourceList=['ebay'])=>({query,sourceList,active:true});
 const plan=planScan([w('RTX 4070 Super'),w('RTX 4070'),w('RTX 4080 Super'),w('RTX 3080'),w('steam deck'),w('RTX 5080',['kleinanzeigen'])],ready);
 assert.deepEqual(plan.map(x=>x.label),['nvidia-ada','nvidia-ampere','steam deck','RTX 5080']);
 assert.equal(planScan([w('RTX 4070 Super')],providerReady({ebayAppId:'a',ebayClientSecret:'b'})).length,0);
});

test('T-13/DF-102: a listing that stops matching loses its stale match',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dealforge-test-'));
 try{const db=openDatabase(join(dir,'app.sqlite'));
  const row={source:'ebay',externalId:'77',title:'MSI RTX 4070 Super Ventus 12GB',priceEur:300,shippingEur:5,url:'https://www.ebay.de/itm/77'};
  ingestListings(db,[row]);
  assert.ok(listDeals(db).some(d=>d.externalId==='77'));
  ingestListings(db,[{...row,title:'Gaming PC mit RTX 4070 Super'}]);
  assert.equal(listDeals(db).some(d=>d.externalId==='77'),false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM matches m JOIN listings l ON l.id=m.listing_id WHERE l.external_id='77'").get().n,0);
  db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Watchlist stores the unknown-shipping preference',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dealforge-test-'));
 try{const db=openDatabase(join(dir,'app.sqlite'));
  const id=createWatchlist(db,{name:'Abholung',query:'RTX 5080',maxWorking:900,maxDefect:200,sourceList:['facebook'],allowUnknownShipping:true});
  ingestListings(db,[{source:'facebook',externalId:'fb1',title:'RTX 5080 16GB',priceEur:700,shippingEur:null,url:'https://www.facebook.com/marketplace/item/1'}]);
  const deal=listDeals(db,{watchlistId:id})[0];
  assert.ok(deal.assessment.alerts.includes('DEAL'));db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
