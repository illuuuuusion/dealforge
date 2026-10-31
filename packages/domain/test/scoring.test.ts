import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, repairAssessment, matchesWatchlist, scoreListing as score } from '../src/scoring.ts';
// Non-null for typing only: tests that expect null still see null.
const scoreListing=(...args: Parameters<typeof score>)=>score(...args)!;
const w={query:'RTX 4070 Super',maxWorking:450,maxDefect:130,expectedResale:500,repairBudget:50};
const base={title:'RTX 4070 Super',priceEur:100,shippingEur:6,firstSeenAt:new Date().toISOString()};
test('Repair candidates are not rejected just because they are defective',()=>{
  const a=scoreListing({...base,title:'RTX 4070 Super defekt - kein Bild, Lüfter drehen',description:'unverbastelt'},w);
  assert.equal(a.health,'defect');assert.equal(a.alerts.includes('REPAIR'),true);
  assert.equal(a.alerts.includes('SCHNAPPER'),true);assert.ok((a.repairScore??0)>45);
});
test('High-risk damage reduces the repair score',()=>{
 const good=repairAssessment({title:'Kein Bild, Lüfter drehen',description:'unverbastelt'});
 const bad=repairAssessment({title:'Defekt, Wasserschaden, Reparaturversuch',description:'ohne GPU'});
 assert.ok(good.score>bad.score);assert.equal(bad.score,0);
});
test('Untested is unknown, not automatically working',()=>assert.equal(classify({...base,title:'RTX 4070 Super ungetestet'}),'unknown'));
test('Accessories are excluded',()=>assert.equal(classify({...base,title:'RTX 4070 Super Kühler'}),'excluded'));
test('Rapid deal and conventional deal are independent',()=>{
 const fresh=scoreListing(base,w),old=scoreListing({...base,publishedAt:new Date(Date.now()-6000000).toISOString()},w);
 assert.ok(fresh.alerts.includes('SCHNAPPER'));assert.ok(fresh.alerts.includes('DEAL'));
 assert.ok(!old.alerts.includes('SCHNAPPER'));assert.ok(old.alerts.includes('DEAL'));
});
test('Do not invent market average or free shipping',()=>{
 const a=scoreListing({...base,shippingEur:null},w);
 assert.equal(a.shippingKnown,false);assert.equal(a.knownTotalEur,null);
 assert.ok(a.reasons.includes('Versandkosten unbekannt – Gesamtpreis prüfen'));
});
test('One watchlist can detect titles case-insensitively',()=>{
 assert.ok(matchesWatchlist({title:'NVIDIA RTX 4070 SUPER OC'},w));
 assert.ok(!matchesWatchlist({title:'NVIDIA RTX 4060 SUPER OC'},w));
});
test('Giveaways count only when explicitly described as free',()=>{
 const free=scoreListing({...base,title:'RTX 4070 Super zu verschenken',priceEur:0,shippingEur:0},w);
 assert.ok(free.alerts.includes('SCHNAPPER'));
 assert.equal(scoreListing({...base,priceEur:0},w),null);
});
test('Base GPU model does not match a Ti variant',()=>{
 assert.equal(matchesWatchlist({title:'RTX 3080 Ti'}, {...w,query:'RTX 3080'}),false);
 assert.equal(matchesWatchlist({title:'RTX 3080 10GB'}, {...w,query:'RTX 3080'}),true);
});
