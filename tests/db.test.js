import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase,ingestListings,listDeals,watchlists} from '../src/db.js';
test('dedup and price history persist between scans',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dealforge-test-'));
 try{const db=openDatabase(join(dir,'app.sqlite'));
   assert.ok(watchlists(db).length>0);
   const row={source:'ebay',externalId:'123',title:'RTX 5080 used',priceEur:700,shippingEur:null,url:'https://www.ebay.de/itm/123'};
   assert.equal(ingestListings(db,[row]).inserted,1);
   assert.equal(ingestListings(db,[row]).inserted,0);
   assert.equal(ingestListings(db,[{...row,priceEur:650}]).priceChanges,1);
   assert.equal(db.prepare('SELECT COUNT(*) AS n FROM price_history').get().n,2);
   assert.ok(listDeals(db).length>0);db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
