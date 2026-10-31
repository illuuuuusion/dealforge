import fs from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scoreListing, matchesWatchlist } from './scoring.js';
const now = () => new Date().toISOString();
const seedWatches = [
  {name:'RTX 5080',query:'RTX 5080',maxWorking:880,maxDefect:275,expectedResale:1050,repairBudget:80,sourceList:['ebay','kleinanzeigen','facebook']},
  {name:'RTX 4070 Super',query:'RTX 4070 Super',maxWorking:470,maxDefect:125,expectedResale:550,repairBudget:60,sourceList:['ebay','kleinanzeigen','facebook']},
  {name:'RTX 3080',query:'RTX 3080',maxWorking:270,maxDefect:85,expectedResale:330,repairBudget:55,sourceList:['ebay','kleinanzeigen','facebook']},
  {name:'RX 7800 XT',query:'RX 7800 XT',maxWorking:350,maxDefect:220,expectedResale:420,repairBudget:50,sourceList:['ebay','kleinanzeigen','facebook']}
];
const demoData = [
  {source:'ebay',externalId:'demo-1',title:'NVIDIA RTX 5080 16GB – gebraucht, voll funktionsfähig',description:'Funktioniert einwandfrei.',url:'https://www.ebay.de/',priceEur:699,shippingEur:9.99,condition:'Gebraucht',publishedAt:new Date(Date.now()-4*60000).toISOString()},
  {source:'kleinanzeigen',externalId:'demo-2',title:'RTX 4070 Super – Kein Bild, Lüfter drehen',description:'Unverbastelt, mit Kühler, plötzlich kein Signal.',url:'https://www.kleinanzeigen.de/',priceEur:89,shippingEur:6.99,condition:'Defekt',publishedAt:new Date(Date.now()-3*60000).toISOString()},
  {source:'facebook',externalId:'demo-3',title:'RX 7800 XT Sapphire – guter Zustand',description:'Abholung möglich',url:'https://www.facebook.com/marketplace/',priceEur:269,shippingEur:null,condition:'Gebraucht',publishedAt:new Date(Date.now()-8*60000).toISOString()},
  {source:'ebay',externalId:'demo-4',title:'RTX 3080 defekt Wasserschaden, Reparaturversuch',description:'Es wurde bereits versucht sie zu reparieren.',url:'https://www.ebay.de/',priceEur:55,shippingEur:7.49,condition:'Defekt',publishedAt:new Date(Date.now()-32*60000).toISOString()},
  {source:'kleinanzeigen',externalId:'demo-5',title:'RTX 4070 Super Gaming PC',description:'Komplettrechner',url:'https://www.kleinanzeigen.de/',priceEur:400,shippingEur:0,condition:'Gebraucht',publishedAt:new Date().toISOString()},
];
export function openDatabase(path, {demoMode=false}={}) {
  fs.mkdirSync(dirname(path), {recursive:true});
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS watchlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, query TEXT NOT NULL,
      max_working REAL NOT NULL, max_defect REAL NOT NULL,
      expected_resale REAL, repair_budget REAL NOT NULL DEFAULT 0,
      sources TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, external_id TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT, url TEXT NOT NULL, image_url TEXT,
      price_eur REAL NOT NULL, shipping_eur REAL, condition TEXT, published_at TEXT,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
      UNIQUE(source, external_id)
    );
    CREATE TABLE IF NOT EXISTS matches (
      listing_id INTEGER NOT NULL, watchlist_id INTEGER NOT NULL, assessment TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(listing_id, watchlist_id),
      FOREIGN KEY(listing_id) REFERENCES listings(id),
      FOREIGN KEY(watchlist_id) REFERENCES watchlists(id)
    );
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, listing_id INTEGER NOT NULL, price_eur REAL NOT NULL,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, ok INTEGER NOT NULL,
      fetched INTEGER NOT NULL, inserted INTEGER NOT NULL, message TEXT, happened_at TEXT NOT NULL
    );
  `);
  const count=db.prepare('SELECT COUNT(*) AS n FROM watchlists').get().n;
  if(!count){ for (const item of seedWatches) createWatchlist(db,item); }
  if(demoMode && !db.prepare('SELECT COUNT(*) AS n FROM listings').get().n) ingestListings(db,demoData);
  if(!demoMode){
    // Never present synthetic demo rows as real marketplace offers after mode switch.
    db.exec(`DELETE FROM price_history WHERE listing_id IN (SELECT id FROM listings WHERE external_id LIKE 'demo-%');
      DELETE FROM matches WHERE listing_id IN (SELECT id FROM listings WHERE external_id LIKE 'demo-%');
      DELETE FROM listings WHERE external_id LIKE 'demo-%';`);
  }
  return db;
}
function watchFromRow(x) {return {id:x.id,name:x.name,query:x.query,maxWorking:x.max_working,maxDefect:x.max_defect,expectedResale:x.expected_resale,repairBudget:x.repair_budget,sourceList:JSON.parse(x.sources),active:!!x.active,createdAt:x.created_at};}
export function watchlists(db){return db.prepare('SELECT * FROM watchlists ORDER BY active DESC, id').all().map(watchFromRow);}
export function createWatchlist(db,input){
  const name=String(input.name ?? '').trim().slice(0,120);
  const query=String(input.query ?? '').trim().slice(0,120);
  const maxWorking=Number(input.maxWorking), maxDefect=Number(input.maxDefect), repairBudget=Number(input.repairBudget ?? 0);
  const resale=input.expectedResale === null || input.expectedResale === '' || input.expectedResale === undefined ? null : Number(input.expectedResale);
  const sources=(Array.isArray(input.sourceList)?input.sourceList:['ebay']).filter(x=>['ebay','kleinanzeigen','facebook'].includes(x));
  if(!name||!query||sources.length===0||[maxWorking,maxDefect,repairBudget].some(x=>!Number.isFinite(x)||x<0||x>100000)|| (resale!==null&&(!Number.isFinite(resale)||resale<0||resale>100000)))throw Error('Ungültiges Suchprofil: Name, Query, Quelle und Preise prüfen');
  const result=db.prepare(`INSERT INTO watchlists(name,query,max_working,max_defect,expected_resale,repair_budget,sources,active,created_at)
      VALUES(?,?,?,?,?,?,?,1,?)`).run(name,query,maxWorking,maxDefect,resale,repairBudget,JSON.stringify(sources),now());
  return Number(result.lastInsertRowid);
}
export function deleteWatchlist(db,id){
  db.prepare('DELETE FROM matches WHERE watchlist_id=?').run(id);
  return db.prepare('DELETE FROM watchlists WHERE id=?').run(id).changes>0;
}
export function toggleWatchlist(db,id,active){
  return db.prepare('UPDATE watchlists SET active=? WHERE id=?').run(active?1:0,id).changes>0;
}
function publicListing(row){return {id:row.id,source:row.source,externalId:row.external_id,title:row.title,description:row.description,url:row.url,imageUrl:row.image_url,priceEur:row.price_eur,shippingEur:row.shipping_eur,condition:row.condition,publishedAt:row.published_at,firstSeenAt:row.first_seen_at,lastSeenAt:row.last_seen_at,status:row.status};}
export function ingestListings(db,items){
  const allWatches=watchlists(db).filter(w=>w.active);
  const find=db.prepare('SELECT * FROM listings WHERE source=? AND external_id=?');
  const insert=db.prepare(`INSERT INTO listings(source,external_id,title,description,url,image_url,price_eur,shipping_eur,condition,published_at,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const update=db.prepare(`UPDATE listings SET title=?,description=?,url=?,image_url=?,price_eur=?,shipping_eur=?,condition=?,published_at=COALESCE(?,published_at),last_seen_at=? WHERE id=?`);
  const logPrice=db.prepare('INSERT INTO price_history(listing_id,price_eur,observed_at) VALUES(?,?,?)');
  const upsertMatch=db.prepare(`INSERT INTO matches(listing_id,watchlist_id,assessment,updated_at) VALUES(?,?,?,?) ON CONFLICT(listing_id,watchlist_id) DO UPDATE SET assessment=excluded.assessment,updated_at=excluded.updated_at`);
  let inserted=0, matched=0, priceChanges=0;
  // One transaction per batch: deduplication and price tracking stay consistent.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of items) {
      if(!['ebay','kleinanzeigen','facebook'].includes(item.source)) continue;
      if(typeof item.externalId!=='string'||!item.externalId||item.externalId.length>200)continue;
      if(typeof item.title!=='string'||!item.title.trim()||item.title.length>500)continue;
      const price=Number(item.priceEur);if(!Number.isFinite(price)||price<0||price>500000|| (price===0&&!/zu verschenken|gratis|kostenlos/i.test(item.title)))continue;
      let parsedUrl;try{parsedUrl=new URL(item.url);}catch{continue;}
      if(parsedUrl.protocol!=='https:')continue;
      const seenAt=now();
      const prior=find.get(item.source,item.externalId);
      let id;
      const args=[item.title,item.description??'',item.url,item.imageUrl??null,price,item.shippingEur===null||item.shippingEur===undefined?null:Number(item.shippingEur),item.condition??'',item.publishedAt??null];
      if(!prior){id=Number(insert.run(item.source,item.externalId,...args,seenAt,seenAt).lastInsertRowid);inserted++;logPrice.run(id,price,seenAt);}
      else{ id=prior.id;update.run(...args,seenAt,id);if(prior.price_eur!==price){logPrice.run(id,price,seenAt);priceChanges++;} }
      const listing={...item,firstSeenAt:prior?.first_seen_at??seenAt};
      for(const w of allWatches){if(!w.sourceList.includes(item.source)||!matchesWatchlist(listing,w))continue;
        const assessment=scoreListing(listing,w);
        if(!assessment)continue;
        upsertMatch.run(id,w.id,JSON.stringify(assessment),seenAt); matched++;
      }
    }
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {fetched:items.length,inserted,matched,priceChanges};
}
export function listDeals(db,{mode='all',source='all',watchlistId=null,limit=100}={}){
  const rows=db.prepare(`SELECT l.*,m.assessment,w.name AS watchlist_name,w.id AS watchlist_id, w.max_working,w.max_defect,w.expected_resale,w.repair_budget
    FROM matches m JOIN listings l ON l.id=m.listing_id JOIN watchlists w ON w.id=m.watchlist_id
    WHERE w.active=1 ORDER BY l.first_seen_at DESC LIMIT 500`).all();
  return rows.map(r=>({...publicListing(r),assessment:scoreListing(publicListing(r),{maxWorking:r.max_working,maxDefect:r.max_defect,expectedResale:r.expected_resale,repairBudget:r.repair_budget}),watchlistName:r.watchlist_name,watchlistId:r.watchlist_id})).filter(r=>r.assessment)
    .filter(r=>(source==='all'||r.source===source)&&(watchlistId===null||r.watchlistId===watchlistId)&&(mode==='all'||(mode==='schnapper'&&r.assessment.alerts.includes('SCHNAPPER'))||(mode==='deal'&&r.assessment.alerts.includes('DEAL'))||(mode==='repair'&&['defect','unknown'].includes(r.assessment.health))))
    .sort((a,b)=>b.assessment.priority-a.assessment.priority || b.firstSeenAt.localeCompare(a.firstSeenAt)).slice(0,limit);
}
export function setListingStatus(db,id,status){if(!['new','saved','dismissed','contacted'].includes(status))throw Error('Ungültiger Status');return db.prepare('UPDATE listings SET status=? WHERE id=?').run(status,id).changes>0;}
export function listStats(db){const r=db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='saved' THEN 1 ELSE 0 END) AS saved FROM listings`).get();
 const r2=db.prepare(`SELECT COUNT(DISTINCT listing_id) AS n FROM matches WHERE json_extract(assessment,'$.health') IN ('defect','unknown')`).get();
 const s=db.prepare(`SELECT source,MAX(happened_at) AS last_run,SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS errors,
   SUM(CASE WHEN substr(happened_at,1,10)=? THEN 1 ELSE 0 END) AS calls_today,
   (SELECT message FROM source_runs r WHERE r.source=source_runs.source AND ok=0 ORDER BY id DESC LIMIT 1) AS last_error
   FROM source_runs GROUP BY source`).all(now().slice(0,10));
 return {total:r.total,saved:r.saved||0,repairCandidates:r2.n||0,sources:s};}
export function providerCallsToday(db,source){return db.prepare('SELECT COUNT(*) AS n FROM source_runs WHERE source=? AND substr(happened_at,1,10)=?').get(source,now().slice(0,10)).n;}
export function logSourceRun(db,source,result,error=null){db.prepare('INSERT INTO source_runs(source,ok,fetched,inserted,message,happened_at) VALUES(?,?,?,?,?,?)').run(source,error?0:1,result?.fetched??0,result?.inserted??0,error?String(error).slice(0,200):null,now());}
