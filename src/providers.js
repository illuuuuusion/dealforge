/** Only eBay uses an official read API. Kleinanzeigen Agent is a third-party pilot. */
const timeoutMs=14000;
async function jsonFetch(url, options={}) {
  const response=await fetch(url,{...options,signal:AbortSignal.timeout(timeoutMs)});
  const text=await response.text();
  if(!response.ok)throw Error(`Provider HTTP ${response.status}: ${text.slice(0,180)}`);
  try{return JSON.parse(text);}catch{throw Error(`Provider returned invalid JSON (${response.status})`);}
}
let ebayToken=null,ebayTokenExpiry=0;
async function getEbayToken(cfg){
  if(ebayToken && Date.now()+60000<ebayTokenExpiry)return ebayToken;
  if(!cfg.ebayAppId||!cfg.ebayClientSecret)throw Error('eBay OAuth Zugang fehlt');
  const body=new URLSearchParams({grant_type:'client_credentials',scope:'https://api.ebay.com/oauth/api_scope'});
  const response=await jsonFetch('https://api.ebay.com/identity/v1/oauth2/token',{
    method:'POST',headers:{'Authorization':'Basic '+Buffer.from(`${cfg.ebayAppId}:${cfg.ebayClientSecret}`).toString('base64'),
      'Content-Type':'application/x-www-form-urlencoded'},body:body.toString()});
  if(!response.access_token)throw Error('eBay OAuth: no access_token');
  ebayToken=response.access_token;ebayTokenExpiry=Date.now()+(Number(response.expires_in)||3600)*1000;
  return ebayToken;
}
const first=(...items)=>items.find(x=>x!==null&&x!==undefined&&x!=='');
function sumShipping(row){
  const s=first(row.shippingOptions?.[0]?.shippingCost?.value, row.shippingCost?.value);
  return s===undefined?null:Number(s);
}
export function normalizeEbay(row){
  const id=first(row.itemId,row.legacyItemId);
  const url=first(row.itemWebUrl,row.itemAffiliateWebUrl);
  const price=Number(row.price?.value);
  if(!id||!url||!Number.isFinite(price)|| (row.price?.currency && row.price.currency!=='EUR'))return null;
  return {source:'ebay',externalId:String(id),title:row.title||'',description:row.shortDescription||'',
    url, imageUrl:row.image?.imageUrl??null,priceEur:price,shippingEur:sumShipping(row),
    condition:row.condition||'',publishedAt:row.itemOriginDate||null,
    offerType:row.buyingOptions?.includes('AUCTION')?'AUCTION':row.buyingOptions?.includes('FIXED_PRICE')?'FIXED_PRICE':'OTHER',
    auctionEndsAt:row.itemEndDate??null,bidCount:row.bidCount??null};
}
export async function fetchEbay(query,cfg,{auction=false}={}){
  const token=await getEbayToken(cfg);
  const params=new URLSearchParams({q:query,limit:'50',sort:'newlyListed'});
  if(auction)params.set('filter','buyingOptions:{AUCTION}');
  const payload=await jsonFetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,{
    headers:{'Authorization':`Bearer ${token}`,'X-EBAY-C-MARKETPLACE-ID':'EBAY_DE','Accept-Language':'de-DE'}});
  return (payload.itemSummaries||[]).map(normalizeEbay).filter(Boolean);
}
export function normalizeKlaz(row){
  const id=first(row.ad_id,row.id,row.adId);
  const url=first(row.ad_url,row.url,row.link);
  const p=first(row.price?.amount,row.price?.value,typeof row.price==='number'?row.price:null);
  if(!id||!url||p===undefined||!Number.isFinite(Number(p))||(row.price?.currency_code&&row.price.currency_code!=='EUR'))return null;
  const shipping=first(row.shipping?.amount,row.shipping_cost?.amount,row.shipping_cost);
  return {source:'kleinanzeigen',externalId:String(id),title:row.title??'',description:row.description??'',url,
    imageUrl:first(row.images?.[0]?.url,row.images?.[0]?.image_url,row.image_url,null),
    priceEur:Number(p),shippingEur:shipping===undefined||!Number.isFinite(Number(shipping))?null:Number(shipping),
    condition:String(first(row.condition?.label,typeof row.condition==='string'?row.condition:null,'')||''),publishedAt:first(row.created_at,row.published_at,null)};
}
export async function fetchKleinanzeigen(query,cfg){
  if(!cfg.klazKey)throw Error('Kleinanzeigen Agent API-Key fehlt');
  const u=new URL('https://api.kleinanzeigen-agent.de/api/v2/kleinanzeigen/search');
  u.searchParams.set('q',query);u.searchParams.set('size','100');
  if(cfg.klazLocationId)u.searchParams.set('location_id',cfg.klazLocationId);
  if(cfg.klazRadiusKm && cfg.klazLocationId)u.searchParams.set('distance',cfg.klazRadiusKm);
  const payload=await jsonFetch(u,{headers:{'klaz_key':cfg.klazKey}});
  if(payload.success===false)throw Error('Kleinanzeigen Agent meldet success=false');
  const ads=payload?.data?.ads;
  if(!Array.isArray(ads))throw Error('Kleinanzeigen Agent: unerwartetes data.ads-Schema');
  return ads.map(normalizeKlaz).filter(Boolean);
}
export function normalizeFacebook(row) {
  const url=first(row.url,row.listingUrl,row.itemUrl,row.item_url,row.listing_url);
  let parsed;try{parsed=new URL(url);}catch{return null;}
  if(parsed.protocol!=='https:' || !['facebook.com','www.facebook.com','m.facebook.com'].includes(parsed.hostname))return null;
  const id=first(row.id,row.listingId,row.listing_id,row.itemId,parsed.pathname.match(/\/item\/(\d+)/)?.[1]);
  const price=first(row.priceAmount,row.price_amount,row.price?.amount,row.price?.value,typeof row.price==='number'?row.price:null);
  if(!id || price===undefined || !Number.isFinite(Number(price)))return null;
  return {source:'facebook',externalId:String(id),title:String(first(row.title,row.name,'')).slice(0,500),
    description:String(first(row.description,row.body,'')),url:parsed.href,
    imageUrl:first(row.imageUrl,row.image_url,row.photoUrl,row.photo_url,null),
    priceEur:Number(price),shippingEur:null,condition:first(row.condition,null),
    publishedAt:first(row.createdAt,row.created_at,row.listedAt,row.publishedAt,null)};
}
/** ready = credentials present; approved = documented GO; only both together allow live calls. */
export const providerReady = cfg=>{
  const approved=name=>!!cfg.approvedProviders?.includes(name);
  const entry=(ready,name,kind,status)=>({ready,approved:approved(name),live:ready&&approved(name),kind,status});
  return {
    ebay:entry(!!(cfg.ebayAppId && cfg.ebayClientSecret),'ebay','official','Offizielle Browse API · GO LIMITED (Standardquelle)'),
    kleinanzeigen:entry(!!cfg.klazKey,'kleinanzeigen','third-party','Drittanbieter · NO GO bis Nutzungsfreigabe'),
    // Facebook is import-only: never live, regardless of APPROVED_PROVIDERS.
    facebook:{ready:false,approved:false,live:false,kind:'manual-import',status:'Nur manueller Import · NO GO für Live-Suche'}
  };
};
export async function fetchSource(source,query,cfg){
  if(source==='ebay')return fetchEbay(query,cfg);
  if(source==='kleinanzeigen')return fetchKleinanzeigen(query,cfg);
  throw Error('Automatische Quelle nicht freigegeben');
}
