import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { createTestDb, seed, migrate, ingestListings, listDeals, watchlists, createWatchlist, updateWatchlist, deleteWatchlist,
  getListing, reserveProviderCall, budgetExhausted, importSqlite, recentAlerts, alertsAfter, latestAlertId, setListingStatus, createRepairProject,
  createPool, DEFAULT_DATABASE_URL, getOrCreateSecret, resealSecrets, openSecret, purgeExpired, audit, type Db } from '../src/index.ts';

let t: Awaited<ReturnType<typeof createTestDb>>, db: Db;
before(async () => { t = await createTestDb(); db = t.db; await seed(db); });
after(() => t.close());
const count = async (sql: string, ...params: unknown[]) => (await db.query(sql, params)).rows[0].n as number;
const snapshots = (externalId: string) => count('SELECT count(*) AS n FROM listing_snapshots s JOIN listings l ON l.id = s.listing_id WHERE l.external_id = $1', externalId);

test('dedup and price history persist between scans', async () => {
  assert.ok((await watchlists(db)).length > 0);
  const row = { source: 'ebay', externalId: '123', title: 'RTX 5080 used', priceEur: 700, shippingEur: null, url: 'https://www.ebay.de/itm/123' };
  assert.equal((await ingestListings(db, [row])).inserted, 1);
  assert.equal((await ingestListings(db, [row])).inserted, 0);
  assert.equal((await ingestListings(db, [{ ...row, priceEur: 650 }])).priceChanges, 1);
  assert.equal(await snapshots('123'), 2);
  assert.ok((await listDeals(db)).length > 0);
});

test('T-13/DF-102: a listing that stops matching loses its stale match', async () => {
  const row = { source: 'ebay', externalId: '77', title: 'MSI RTX 4070 Super Ventus 12GB', priceEur: 300, shippingEur: 5, url: 'https://www.ebay.de/itm/77' };
  await ingestListings(db, [row]);
  assert.ok((await listDeals(db)).some(d => d.externalId === '77'));
  await ingestListings(db, [{ ...row, title: 'Gaming PC mit RTX 4070 Super' }]);
  assert.equal((await listDeals(db)).some(d => d.externalId === '77'), false);
  assert.equal(await count("SELECT count(*) AS n FROM watchlist_matches m JOIN listings l ON l.id = m.listing_id WHERE l.external_id = '77'"), 0);
});

test('Watchlist stores the unknown-shipping preference', async () => {
  const id = await createWatchlist(db, { name: 'Abholung', query: 'RTX 5080', maxWorking: 900, maxDefect: 200, sourceList: ['facebook'], allowUnknownShipping: true });
  await ingestListings(db, [{ source: 'facebook', externalId: 'fb1', title: 'RTX 5080 16GB', priceEur: 700, shippingEur: null, url: 'https://www.facebook.com/marketplace/item/1' }]);
  const deal = (await listDeals(db, { watchlistId: id }))[0];
  assert.ok(deal.assessment.alerts.includes('DEAL'));
});

test('DF-208/T-11: replays create no duplicate listings or snapshots; timestamps are never invented', async () => {
  const row = { source: 'ebay', externalId: 'replay-1', title: 'ASUS RTX 3080 10GB TUF', priceEur: 260, shippingEur: 6.99, url: 'https://www.ebay.de/itm/9' };
  const fetchedAt = '2026-10-31T10:00:00.000Z';
  for (let i = 0; i < 5; i++) await ingestListings(db, [row], { fetchedAt });
  // Re-polls with a newer fetch time but unchanged content: last seen moves, history does not grow.
  for (const m of [1, 2, 3]) await ingestListings(db, [row], { fetchedAt: `2026-10-31T10:0${m}:00.000Z` });
  assert.equal(await count("SELECT count(*) AS n FROM listings WHERE external_id = 'replay-1'"), 1);
  assert.equal(await snapshots('replay-1'), 1);
  // An out-of-order replay of an older fetch must not overwrite newer data.
  assert.equal((await ingestListings(db, [{ ...row, priceEur: 999 }], { fetchedAt: '2026-10-31T09:00:00.000Z' })).priceChanges, 0);
  const l = (await db.query("SELECT * FROM listings WHERE external_id = 'replay-1'")).rows[0];
  assert.equal(l.price_eur, 260);
  assert.equal(l.fetched_at, '2026-10-31T10:03:00.000Z');
  assert.equal(l.published_at, null);
  assert.ok(Date.parse(l.first_seen_at) <= Date.parse(l.last_seen_at));
  // Shipping change is a new observation; price history detail shows both.
  await ingestListings(db, [{ ...row, shippingEur: 0 }], { fetchedAt: '2026-10-31T11:00:00.000Z' });
  const detail = await getListing(db, l.id);
  assert.deepEqual(detail?.snapshots.map(s => s.shippingEur), [6.99, 0]);
});

test('Invalid listings are dropped at the trust boundary', async () => {
  const base = { source: 'ebay', title: 'RTX 4070 Super', priceEur: 300, url: 'https://www.ebay.de/itm/1' };
  const r = await ingestListings(db, [{ ...base, externalId: 'bad-1', url: 'http://www.ebay.de/itm/1' }, { ...base, externalId: 'bad-2', priceEur: 'NaN' },
    { ...base, externalId: 'bad-3', source: 'evil' }, { ...base, externalId: 'bad-4', priceEur: 0 }, { ...base, externalId: 'ok-5', shippingEur: 'abc' }]);
  assert.equal(r.inserted, 1);
  assert.equal((await db.query("SELECT shipping_eur FROM listings WHERE external_id = 'ok-5'")).rows[0].shipping_eur, null);
});

test('Watchlist changes re-evaluate stored listings; deleting keeps listings and history', async () => {
  await ingestListings(db, [{ source: 'kleinanzeigen', externalId: 'k-1', title: 'Sapphire RX 7800 XT Pulse', priceEur: 300, shippingEur: 5, url: 'https://www.kleinanzeigen.de/s-anzeige/1' }]);
  const id = await createWatchlist(db, { name: 'Neu', query: 'RX 7800 XT', maxWorking: 400, maxDefect: 100, sourceList: ['kleinanzeigen'] });
  assert.ok((await listDeals(db, { watchlistId: id })).some(d => d.externalId === 'k-1'));
  await updateWatchlist(db, id, { query: 'RTX 5090' });
  assert.equal((await listDeals(db, { watchlistId: id })).length, 0);
  assert.equal(await updateWatchlist(db, 999999, { active: false }), null);
  assert.ok(await deleteWatchlist(db, id));
  assert.equal(await count("SELECT count(*) AS n FROM listings WHERE external_id = 'k-1'"), 1);
  assert.equal(await snapshots('k-1'), 1);
});

test('DF-206: hard budget per day, month and search filter', async () => {
  const limits = { daily: 3, monthly: 5, perQueryDaily: 2 };
  const day1 = new Date('2026-10-10T12:00:00Z'), day2 = new Date('2026-10-11T12:00:00Z'), nextMonth = new Date('2026-11-01T00:00:00Z');
  const book = (key: string, at: Date) => reserveProviderCall(db, 'ebay', key, limits, at);
  assert.equal(await book('q1', day1), null);
  assert.equal(await book('q1', day1), null);
  assert.equal(await book('q1', day1), 'Tagesbudget für diesen Suchfilter erreicht');
  assert.equal(await book('q2', day1), null);
  assert.equal(await book('q3', day1), 'Tagesbudget erreicht');
  assert.equal(await book('q1', day2), null);
  assert.equal(await book('q2', day2), null);
  assert.equal(await book('q3', day2), 'Monatsbudget erreicht');
  assert.equal(await budgetExhausted(db, 'ebay', limits, day2), 'Monatsbudget erreicht');
  assert.equal(await book('q1', nextMonth), null);
});

test('DF-206: parallel reservations never overshoot the limit', async () => {
  const limits = { daily: 5, monthly: 100, perQueryDaily: 100 };
  const results = await Promise.all(Array.from({ length: 20 }, () => reserveProviderCall(db, 'kleinanzeigen', 'q', limits)));
  assert.equal(results.filter(r => r === null).length, 5);
});

test('DF-304/T-11/T-12: one first alert per kind, one PRICE_DROP per price level, replays add nothing', async () => {
  const id = await createWatchlist(db, { name: 'Alerts 4070S', query: 'RTX 4070 Super', maxWorking: 470, maxDefect: 120, sourceList: ['ebay'] });
  const row = { source: 'ebay', externalId: 'alert-1', title: 'MSI RTX 4070 Super Ventus 12GB', priceEur: 300, shippingEur: 5,
    url: 'https://www.ebay.de/itm/alert-1', publishedAt: new Date().toISOString() };
  const kinds = async () => (await recentAlerts(db, 200)).filter(a => a.url === row.url && a.watchlistId === id).map(a => a.kind).sort();
  assert.ok((await ingestListings(db, [row])).alerts >= 2);
  for (let i = 0; i < 3; i++) assert.equal((await ingestListings(db, [row])).alerts, 0);
  assert.deepEqual(await kinds(), ['DEAL', 'SCHNAPPER']);
  await ingestListings(db, [{ ...row, priceEur: 290 }]); // −3 %: below the drop threshold
  await ingestListings(db, [{ ...row, priceEur: 250 }]);
  await ingestListings(db, [{ ...row, priceEur: 250 }]);
  assert.deepEqual(await kinds(), ['DEAL', 'PRICE_DROP', 'SCHNAPPER']);
  const drop = (await recentAlerts(db, 200)).find(a => a.kind === 'PRICE_DROP' && a.watchlistId === id);
  assert.match(drop?.reasons[0] ?? '', /von 290 € auf 250 €/);
  const after = await alertsAfter(db, drop!.id - 1);
  assert.equal(after[0].id, drop!.id);
  // A new watchlist does not alert on old listings; deleting one keeps its alert history.
  const before = await latestAlertId(db);
  await createWatchlist(db, { name: 'Alerts 4070S #2', query: 'RTX 4070 Super', maxWorking: 470, maxDefect: 120, sourceList: ['ebay'] });
  assert.equal(await latestAlertId(db), before);
  await deleteWatchlist(db, id);
  assert.equal((await recentAlerts(db, 200)).filter(a => a.url === row.url && a.watchlistId === null).length, 3);
});

test('Migrations are versioned and idempotent', async () => {
  assert.deepEqual(await migrate(db), []);
  assert.equal(await count("SELECT count(*) AS n FROM schema_migrations WHERE version = '001_init.sql'"), 1);
});

test('DF-605: a migration dry run applies all pending migrations and rolls them back', async () => {
  const schema = `dry_${randomBytes(4).toString('hex')}`;
  await db.query(`CREATE SCHEMA ${schema}`);
  const empty = createPool(process.env.DATABASE_URL || DEFAULT_DATABASE_URL, { schema });
  try {
    const pending = await migrate(empty, { dryRun: true });
    assert.ok(pending.includes('001_init.sql') && pending.includes('006_ops.sql'));
    assert.equal((await empty.query("SELECT to_regclass('watchlists') AS t")).rows[0].t, null, 'nothing committed');
    assert.deepEqual(await migrate(db, { dryRun: true }), [], 'up-to-date database: nothing pending');
  } finally { await empty.end(); await db.query(`DROP SCHEMA ${schema} CASCADE`); }
});

test('DF-603: app secrets are encrypted at rest and re-encrypted on key rotation', async () => {
  const oldKeys = { secretsKey: 'old-key-0123456789abcdef0123456789', secretsKeyPrevious: '' };
  const stored = async () => (await db.query("SELECT value FROM app_secrets WHERE name = 'rot'")).rows[0].value as string;
  assert.equal(await getOrCreateSecret(db, 'rot', () => 'private-vapid', oldKeys), 'private-vapid');
  assert.match(await stored(), /^enc:v1:[0-9a-f]{8}:/); assert.doesNotMatch(await stored(), /private-vapid/);
  assert.equal(await getOrCreateSecret(db, 'rot', () => 'other', oldKeys), 'private-vapid', 'created once');
  const newKeys = { secretsKey: 'new-key-abcdef0123456789abcdef0123', secretsKeyPrevious: oldKeys.secretsKey };
  assert.ok(await resealSecrets(db, newKeys) >= 1);
  assert.equal(await resealSecrets(db, newKeys), 0, 'already under the new key');
  assert.equal(openSecret({ ...newKeys, secretsKeyPrevious: '' }, await stored()), 'private-vapid', 'old key no longer needed');
  const rotated = await stored();
  assert.throws(() => openSecret(oldKeys, rotated), /SECRETS_KEY/, 'the old key alone cannot read it');
  await db.query("INSERT INTO app_secrets (name, value) VALUES ('plain', 'legacy') ON CONFLICT DO NOTHING");
  await resealSecrets(db, newKeys);
  assert.match((await db.query("SELECT value FROM app_secrets WHERE name = 'plain'")).rows[0].value, /^enc:v1:/, 'plain rows from before SECRETS_KEY get encrypted');
});

test('DF-607: retention purges old logs and long-unseen listings, keeps what the user works with', async () => {
  const old = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
  const row = (externalId: string) => ({ source: 'ebay', externalId, title: 'RTX 3080 defekt', priceEur: 50, shippingEur: 5, url: `https://www.ebay.de/itm/${externalId}` });
  await ingestListings(db, ['ret-old', 'ret-saved', 'ret-repair', 'ret-recent'].map(row));
  await db.query("UPDATE listings SET last_seen_at = $1 WHERE external_id IN ('ret-old', 'ret-saved', 'ret-repair')", [old(401)]);
  const id = async (externalId: string) => (await db.query('SELECT id FROM listings WHERE external_id = $1', [externalId])).rows[0]?.id as number | undefined;
  await setListingStatus(db, (await id('ret-saved'))!, 'saved');
  await createRepairProject(db, (await id('ret-repair'))!);
  await audit(db, { method: 'POST', path: '/x', status: 200, ip: null, userAgent: null, requestId: null });
  await db.query("INSERT INTO audit_log (at, method, path, status) VALUES ($1, 'POST', '/old', 200)", [old(91)]);
  await db.query("INSERT INTO sessions (token_hash, password_tag, expires_at) VALUES ('expired', 't', $1)", [old(1)]);
  const purged = await purgeExpired(db);
  assert.equal(purged.listings, 1); assert.equal(purged.auditLog, 1); assert.equal(purged.sessions, 1);
  assert.equal(await id('ret-old'), undefined);
  for (const kept of ['ret-saved', 'ret-repair', 'ret-recent']) assert.ok(await id(kept), kept);
  assert.equal(await count("SELECT count(*) AS n FROM audit_log WHERE path = '/x'"), 1);
});

const legacySchema = `CREATE TABLE watchlists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, query TEXT NOT NULL, max_working REAL NOT NULL, max_defect REAL NOT NULL,
    expected_resale REAL, repair_budget REAL NOT NULL DEFAULT 0, sources TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, allow_unknown_shipping INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE listings (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, url TEXT NOT NULL, image_url TEXT,
    price_eur REAL NOT NULL, shipping_eur REAL, condition TEXT, published_at TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
    offer_type TEXT NOT NULL DEFAULT 'FIXED_PRICE', auction_ends_at TEXT, bid_count INTEGER, UNIQUE(source, external_id));
  CREATE TABLE matches (listing_id INTEGER NOT NULL, watchlist_id INTEGER NOT NULL, assessment TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(listing_id, watchlist_id));
  CREATE TABLE price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, listing_id INTEGER NOT NULL, price_eur REAL NOT NULL, observed_at TEXT NOT NULL);
  CREATE TABLE source_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, ok INTEGER NOT NULL, fetched INTEGER NOT NULL, inserted INTEGER NOT NULL, message TEXT, happened_at TEXT NOT NULL);`;

test('DF-203: SQLite import keeps IDs, watchlists and history sums', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dealforge-legacy-'));
  const target = await createTestDb();
  try {
    const lite = new DatabaseSync(join(dir, 'legacy.sqlite'));
    lite.exec(legacySchema);
    const at = '2026-10-31T10:00:00.000Z';
    lite.exec(`INSERT INTO watchlists VALUES (3, 'RTX 3080', 'RTX 3080', 270, 85, 330, 55, '["ebay","kleinanzeigen"]', 1, '${at}', 0), (7, 'Steam Deck', 'steam deck', 300, 100, NULL, 0, '["ebay"]', 0, '${at}', 1);
      INSERT INTO listings (id, source, external_id, title, url, price_eur, shipping_eur, first_seen_at, last_seen_at, status) VALUES
        (10, 'ebay', 'e10', 'RTX 3080 10GB', 'https://www.ebay.de/itm/10', 250, 7.5, '${at}', '${at}', 'saved'), (12, 'facebook', 'f12', 'RTX 3080 defekt', 'https://www.facebook.com/marketplace/item/12', 60.5, NULL, '${at}', '${at}', 'new');
      INSERT INTO matches VALUES (10, 3, '{"health":"working"}', '${at}');
      INSERT INTO price_history (listing_id, price_eur, observed_at) VALUES (10, 280, '${at}'), (10, 250, '${at}'), (12, 60.5, '${at}');
      INSERT INTO source_runs (source, ok, fetched, inserted, message, happened_at) VALUES ('ebay', 1, 2, 1, NULL, '${new Date().toISOString()}'), ('ebay', 0, 0, 0, 'HTTP 500', '2026-09-30T10:00:00.000Z');`);
    lite.close();
    await seed(target.db);
    await assert.rejects(importSqlite(target.db, join(dir, 'legacy.sqlite')), /nicht leer/);
    const report = await importSqlite(target.db, join(dir, 'legacy.sqlite'), { replace: true });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(report.after.priceHistory, { count: 3, priceSum: 590.5 });
    assert.deepEqual((await watchlists(target.db)).map(w => [w.id, w.active, w.sourceList]), [[3, true, ['ebay', 'kleinanzeigen']], [7, false, ['ebay']]]);
    // Identity sequences continue after the imported IDs; legacy calls still count against today's budget.
    assert.ok(await createWatchlist(target.db, { name: 'x', query: 'RTX 5080', maxWorking: 1, maxDefect: 1 }) > 7);
    assert.equal((await target.db.query("SELECT sum(calls) AS n FROM provider_usage WHERE provider = 'ebay' AND day = current_date")).rows[0].n, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); await target.close(); }
});
