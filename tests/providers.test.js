import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEbay,normalizeKlaz,normalizeFacebook,providerReady} from '../src/providers.js';
test('eBay listing normalization',()=>{
 const row=normalizeEbay({itemId:'1',title:'RTX 5080',itemWebUrl:'https://www.ebay.de/itm/123',price:{value:'650'},shippingOptions:[{shippingCost:{value:'7.99'}}]});
 assert.equal(row.priceEur,650);assert.equal(row.shippingEur,7.99);assert.equal(row.source,'ebay');
});
test('Kleinanzeigen Agent docs schema normalization',()=>{
 const row=normalizeKlaz({ad_id:'42',title:'RTX 3080',ad_url:'https://www.kleinanzeigen.de/s-anzeige/foo/42',price:{amount:90,currency_code:'EUR'},created_at:'2026-10-31T10:00:00Z'});
 assert.equal(row.externalId,'42');assert.equal(row.priceEur,90);assert.equal(row.shippingEur,null);
});
test('Facebook import rejects non-Facebook URL',()=>{
 assert.equal(normalizeFacebook({id:'10',title:'GPU',priceAmount:90,url:'https://evil.example/item/10'}),null);
 assert.equal(normalizeFacebook({id:'10',title:'GPU',priceAmount:90,url:'https://www.facebook.com/marketplace/item/10'}).externalId,'10');
});
test('Unverified Facebook live integration is never marked ready',()=>{
 assert.equal(providerReady({ebayAppId:'a',ebayClientSecret:'b',klazKey:''}).facebook.ready,false);
});
