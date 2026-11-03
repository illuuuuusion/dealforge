import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '@dealforge/config';
import { routes, ErrorBody } from '@dealforge/contracts';
import { createTestDb, seed, reserveProviderCall, ingestListings, logSourceRun, savePushSubscription, type Db } from '@dealforge/db';
import { createQueues, redisConnection, checkIncidents, writeHeartbeat, type Queues } from '@dealforge/jobs';
import { buildApp } from '../src/app.ts';

const env = { APP_PASSWORD: 'correct-horse-battery', SECRETS_KEY: randomBytes(24).toString('base64'), APP_ORIGIN: 'http://localhost:3000', DEMO_MODE: 'false', APPROVED_PROVIDERS: 'ebay', EBAY_APP_ID: 'a', EBAY_CLIENT_SECRET: 'b',
  QUEUE_PREFIX: `test-${randomBytes(4).toString('hex')}`, REDIS_URL: process.env.REDIS_URL, PROVIDER_DAILY_CALL_LIMIT: '50' };
const config = loadConfig(env);
let t: Awaited<ReturnType<typeof createTestDb>>, db: Db, queues: Queues, built: ReturnType<typeof buildApp>, cookie = '';
before(async () => {
  t = await createTestDb(); db = t.db; await seed(db);
  queues = createQueues(redisConnection(config.redisUrl), config.queuePrefix);
  built = buildApp({ config, db, queues, push: async target => target.endpoint.endsWith('/gone') ? 410 : 201 });
});
after(async () => {
  for (const q of queues.all) await q.obliterate({ force: true });
  await built.app.close(); await queues.close(); await t.close();
});

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const match = (pattern: string, path: string) => new RegExp(`^${pattern.replace(/:\w+/g, '[^/]+')}$`).test(path);
/** Every response is checked against the contract of its route and status code. */
async function call(method: Method, url: string, body?: unknown, { auth = true, action = true } = {}) {
  const res = await built.app.inject({ method, url, payload: body as object,
    headers: { ...(auth ? { cookie } : {}), ...(action ? { 'x-dealforge-action': '1' } : {}) } });
  const path = url.split('?')[0];
  const contract = routes.find(r => r.method === method && match(r.path, path));
  assert.ok(contract, `no contract for ${method} ${path}`);
  assert.ok(res.statusCode in contract.responses || res.statusCode === 401 || res.statusCode === 403, `${method} ${url}: undocumented status ${res.statusCode} ${res.body}`);
  const schema = contract.responses[res.statusCode] ?? (res.statusCode >= 400 ? ErrorBody : null);
  if (schema) schema.parse(res.json()); else assert.equal(res.body, '');
  return { status: res.statusCode, body: res.body ? res.json() : null, headers: res.headers };
}

test('Every API route is documented in the OpenAPI contract and vice versa', async () => {
  assert.deepEqual([...new Set(built.apiRoutes)].sort(), routes.map(r => `${r.method} ${r.path}`).sort());
  await login();
  const doc = (await call('GET', '/api/v1/openapi.json')).body;
  assert.equal(doc.openapi, '3.1.0');
  assert.ok(doc.paths['/api/v1/watchlists/{id}'].patch.requestBody);
});

async function login() {
  const res = await built.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: config.appPassword }, headers: { 'x-dealforge-action': '1' } });
  assert.equal(res.statusCode, 200);
  cookie = String(res.headers['set-cookie']).split(';')[0];
}

test('Auth, CSRF header and error shape', async () => {
  const anon = await call('GET', '/api/v1/watchlists', undefined, { auth: false });
  assert.equal(anon.status, 401);
  assert.equal(anon.body.code, 'UNAUTHORIZED'); assert.ok(anon.body.requestId);
  assert.equal((await call('POST', '/api/v1/auth/login', { password: 'wrong-password-123' }, { auth: false })).status, 401);
  assert.equal((await call('POST', '/api/v1/watchlists', {}, { action: false })).status, 403);
  // Browser login: APP_ORIGIN and its loopback twin pass, foreign origins do not.
  const loginFrom = async (origin: string) => (await built.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: config.appPassword },
    headers: { 'x-dealforge-action': '1', origin } })).statusCode;
  assert.equal(await loginFrom('http://localhost:3000'), 200);
  assert.equal(await loginFrom('http://127.0.0.1:3000'), 200);
  assert.equal(await loginFrom('http://127.0.0.1:4000'), 403);
  assert.equal(await loginFrom('https://evil.example'), 403);
  assert.equal((await call('GET', '/api/v1/watchlists')).status, 200);
  assert.equal((await call('GET', '/api/v1/health/live', undefined, { auth: false })).status, 200);
  const ready = await call('GET', '/api/v1/health/ready', undefined, { auth: false });
  assert.equal(ready.status, 503); assert.deepEqual(ready.body, { ok: false, db: true, redis: true, worker: false });
  const page = await built.app.inject({ method: 'GET', url: '/' });
  assert.equal(page.statusCode, 200); assert.match(page.body, /DealForge/); assert.equal(page.headers['x-frame-options'], 'DENY');
});

test('Watchlist CRUD with validation', async () => {
  const bad = await call('POST', '/api/v1/watchlists', { name: '', query: 'RTX 4070', maxWorking: -1, maxDefect: 10 });
  assert.equal(bad.status, 400); assert.equal(bad.body.code, 'VALIDATION'); assert.match(bad.body.message, /maxWorking/);
  const created = await call('POST', '/api/v1/watchlists', { name: 'RTX 4070 Super', query: 'RTX 4070 Super', maxWorking: 450, maxDefect: 120, sourceList: ['ebay', 'facebook'] });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.ok((await call('GET', '/api/v1/watchlists')).body.items.some((w: { id: number }) => w.id === id));
  const patched = await call('PATCH', `/api/v1/watchlists/${id}`, { maxWorking: 500, active: false });
  assert.equal(patched.body.item.maxWorking, 500); assert.equal(patched.body.item.active, false);
  assert.equal((await call('PATCH', `/api/v1/watchlists/${id}`, {})).status, 400);
  assert.equal((await call('PATCH', '/api/v1/watchlists/999999', { active: true })).status, 404);
  assert.equal((await call('DELETE', `/api/v1/watchlists/${id}`)).status, 204);
  assert.equal((await call('DELETE', `/api/v1/watchlists/${id}`)).status, 404);
});

test('Facebook import, feed with cursor, listing detail and user state', async () => {
  const items = [1, 2, 3].map(i => ({ id: `90${i}`, title: `RTX 5080 16GB Nr ${i}`, priceAmount: 600 + i, url: `https://www.facebook.com/marketplace/item/90${i}` }));
  const imported = await call('POST', '/api/v1/import/facebook', { items: [...items, { id: 'x', title: 'GPU', priceAmount: 1, url: 'https://evil.example/item/1' }, null] });
  assert.equal(imported.status, 200); assert.equal(imported.body.normalized, 3); assert.equal(imported.body.inserted, 3);
  assert.equal((await call('POST', '/api/v1/import/facebook', { items: Array(101).fill({}) })).status, 400);
  const page1 = await call('GET', '/api/v1/listings?source=facebook&limit=2');
  assert.equal(page1.body.items.length, 2); assert.equal(page1.body.nextCursor, '2');
  const page2 = await call('GET', `/api/v1/listings?source=facebook&limit=2&cursor=${page1.body.nextCursor}`);
  assert.equal(page2.body.items.length, 1); assert.equal(page2.body.nextCursor, null);
  assert.equal((await call('GET', '/api/v1/listings?mode=bogus')).status, 400);
  const id = page1.body.items[0].id;
  const detail = await call('GET', `/api/v1/listings/${id}`);
  assert.equal(detail.body.item.snapshots.length, 1); assert.ok(detail.body.item.matches.length >= 1);
  assert.equal((await call('PATCH', `/api/v1/listings/${id}/user-state`, { status: 'saved' })).status, 200);
  assert.equal((await call('PATCH', `/api/v1/listings/${id}/user-state`, { status: 'stolen' })).status, 400);
  assert.equal((await call('GET', '/api/v1/listings/999999')).status, 404);
  assert.equal((await call('GET', '/api/v1/state')).body.stats.saved, 1);
});

test('System status, provider switch and manual scans (202, 409, 429)', async () => {
  const status = await call('GET', '/api/v1/providers/status');
  assert.equal(status.body.providers.find((p: { source: string }) => p.source === 'ebay').live, true);
  assert.equal(status.body.worker.online, false);
  const scan = await call('POST', '/api/v1/admin/scans', { source: 'ebay' });
  assert.equal(scan.status, 202); assert.ok(scan.body.queued.length > 0);
  assert.equal((await call('POST', '/api/v1/admin/scans', { source: 'ebay' })).status, 409);
  assert.equal((await call('PATCH', '/api/v1/providers/facebook', { enabled: true })).status, 400);
  assert.equal((await call('PATCH', '/api/v1/providers/ebay', { enabled: false })).status, 200);
  const off = await call('POST', '/api/v1/admin/scans', {});
  assert.deepEqual(off.body, { queued: [], deduplicated: [] });
  await call('PATCH', '/api/v1/providers/ebay', { enabled: true });
  for (let i = 0; i < config.limits.daily; i++) await reserveProviderCall(db, 'ebay', `fill-${i}`, config.limits);
  const blocked = await call('POST', '/api/v1/admin/scans', {});
  assert.equal(blocked.status, 429); assert.equal(blocked.body.code, 'BUDGET_EXHAUSTED');
  assert.equal((await call('GET', '/api/v1/providers/status')).body.providers[0].budgetExhausted, 'Tagesbudget erreicht');
});

test('DF-306: alert list and live SSE stream with Last-Event-ID resume', async () => {
  const gpu = (id: string) => ({ source: 'ebay', externalId: id, title: 'MSI RTX 4070 Super Ventus 12GB', priceEur: 300, shippingEur: 5,
    url: `https://www.ebay.de/itm/${id}`, publishedAt: new Date().toISOString() });
  assert.equal((await call('GET', '/api/v1/events', undefined, { auth: false })).status, 401);
  await ingestListings(db, [gpu('sse-1')]);
  const [first] = (await call('GET', '/api/v1/alerts?limit=5')).body.items;
  assert.equal(first.url, 'https://www.ebay.de/itm/sse-1');
  assert.equal((await call('GET', '/api/v1/alerts?limit=0')).status, 400);
  assert.ok((await call('GET', '/api/v1/state')).body.stats.alertsToday >= 1);

  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = built.app.server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/events`, { headers: { cookie, 'last-event-id': String(first.id - 1) } });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body!.getReader(), decoder = new TextDecoder();
  let text = '';
  const until = async (pattern: RegExp) => { while (!pattern.test(text)) text += decoder.decode((await reader.read()).value, { stream: true }); };
  await until(new RegExp(`id: ${first.id}\nevent: alert\n`));
  await ingestListings(db, [gpu('sse-2')]);
  await until(/event: alert\ndata: .*itm\/sse-2/);
  await reader.cancel();
});

test('DF-305/DF-307: push subscriptions, test push, receipts and delivery log', async () => {
  const key = (await call('GET', '/api/v1/push/public-key')).body.publicKey;
  assert.match(key, /^[A-Za-z0-9_-]{80,}$/);
  assert.equal((await call('GET', '/api/v1/push/public-key')).body.publicKey, key, 'VAPID key pair is generated once');
  const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'BPk', auth: 'xyz' } });
  // The server POSTs to the endpoint: anything but a known push service is rejected.
  for (const bad of ['https://evil.example/push', 'http://fcm.googleapis.com/fcm/send/x', 'https://fcm.googleapis.com.evil.example/x', 'nonsense']) {
    assert.equal((await call('POST', '/api/v1/push-subscriptions', sub(bad))).status, 400, bad);
  }
  const created = await call('POST', '/api/v1/push-subscriptions', sub('https://fcm.googleapis.com/fcm/send/abc'));
  assert.equal(created.status, 201);
  assert.equal((await call('POST', '/api/v1/push-subscriptions', sub('https://fcm.googleapis.com/fcm/send/abc'))).body.id, created.body.id, 'idempotent per endpoint');
  await call('POST', '/api/v1/push-subscriptions', sub('https://updates.push.services.mozilla.com/wpush/v2/gone'));
  const list = (await call('GET', '/api/v1/push-subscriptions')).body.items;
  assert.deepEqual(list.map((x: { host: string }) => x.host), ['fcm.googleapis.com', 'updates.push.services.mozilla.com']);
  assert.equal(JSON.stringify(list).includes('/fcm/send/abc'), false, 'endpoint is not echoed');

  assert.deepEqual((await call('POST', '/api/v1/push/test')).body, { sent: 1, failed: 0, gone: 1, skipped: 0 });
  assert.equal((await call('GET', '/api/v1/push-subscriptions')).body.items.length, 1, 'expired subscription removed');
  const [sent] = (await call('GET', '/api/v1/push/deliveries')).body.items.filter((d: { status: string }) => d.status === 'sent');
  assert.equal(sent.alertId, null); assert.equal(sent.shownAt, null);
  assert.equal((await call('POST', '/api/v1/push/receipts', { deliveryId: sent.id })).status, 204);
  assert.equal((await call('POST', '/api/v1/push/receipts', { deliveryId: 99999999 })).status, 404);
  assert.ok((await call('GET', '/api/v1/push/deliveries')).body.items.find((d: { id: number }) => d.id === sent.id).shownAt);

  assert.equal((await call('DELETE', `/api/v1/push-subscriptions/${created.body.id}`)).status, 204);
  assert.equal((await call('DELETE', `/api/v1/push-subscriptions/${created.body.id}`)).status, 404);
  assert.deepEqual((await call('POST', '/api/v1/push/test')).body, { sent: 0, failed: 0, gone: 0, skipped: 0 });
  const latency = await call('GET', '/api/v1/alerts/latency?days=7');
  assert.equal(latency.body.days, 7);
  assert.equal((await call('GET', '/api/v1/alerts/latency?days=0')).status, 400);
  const sw = await built.app.inject({ method: 'GET', url: '/sw.js' });
  assert.equal(sw.statusCode, 200); assert.match(sw.body, /push\/receipts/);
});

test('P4: repair project from a listing, settings, scenarios, actual margin and stats', async () => {
  await ingestListings(db, [{ source: 'ebay', externalId: 'rep-1', title: 'RTX 3080 defekt kein Bild, Lüfter drehen', description: 'unverbastelt',
    priceEur: 60, shippingEur: 7, url: 'https://www.ebay.de/itm/rep-1' }]);
  const listing = (await call('GET', '/api/v1/listings?mode=repair')).body.items.find((x: { externalId: string }) => x.externalId === 'rep-1');
  assert.deepEqual(listing.assessment.repairFaults, ['NO_DISPLAY']);
  const created = await call('POST', '/api/v1/repair/projects', { listingId: listing.id });
  assert.equal(created.status, 201);
  assert.deepEqual((await call('POST', '/api/v1/repair/projects', { listingId: listing.id })).body, created.body, 'one project per listing');
  assert.equal((await call('POST', '/api/v1/repair/projects', { listingId: 999999 })).status, 404);
  const url = `/api/v1/repair/projects/${created.body.id}`;
  const p = (await call('GET', url)).body.item;
  assert.deepEqual([p.purchasePriceEur, p.purchaseShippingEur, p.model, p.faults, p.resaleEstimateEur], [60, 7, 'RTX 3080', ['NO_DISPLAY'], 330]);
  assert.deepEqual(p.plan.scenarios.map((s: { key: string }) => s.key), ['worst', 'base', 'best']);
  assert.equal(p.actual, null);

  const settings = (await call('GET', '/api/v1/repair/settings')).body.item;
  assert.equal(settings.costs.length, 8);
  const rule = { fault: 'NO_DISPLAY', model: 'RTX 3080', partsMin: 40, partsMax: 40, hoursMin: 2, hoursMax: 2 };
  assert.equal((await call('PUT', '/api/v1/repair/settings', { ...settings, costs: [...settings.costs, rule, rule] })).status, 400);
  assert.equal((await call('PUT', '/api/v1/repair/settings', { ...settings, costs: [{ ...rule, partsMax: 1 }] })).status, 400);
  assert.equal((await call('PUT', '/api/v1/repair/settings', { ...settings, hourlyRateEur: 10, costs: [...settings.costs, rule] })).status, 200);
  const best = (await call('GET', url)).body.item.plan.scenarios[2];
  assert.deepEqual([best.partsEur, best.laborEur, best.investmentEur], [40, 20, 127]);

  assert.equal((await call('PATCH', url, { outcome: 'great' })).status, 400);
  assert.equal((await call('PATCH', '/api/v1/repair/projects/999999', { notes: 'x' })).status, 404);
  const sold = (await call('PATCH', url, { status: 'sold', outcome: 'success', purchasedAt: '2026-11-01', parts: [{ name: 'MOSFET', costEur: 12 }],
    hoursSpent: 3, soldPriceEur: 300, soldFeesEur: 30, soldShippingEur: 8, soldAt: '2026-11-03' })).body.item;
  assert.deepEqual(sold.actual, { costsEur: 79, revenueEur: 262, marginEur: 183, laborEur: 30, marginInclLaborEur: 153 });
  const stats = (await call('GET', '/api/v1/repair/stats')).body;
  assert.deepEqual(stats.items.find((i: { fault: string }) => i.fault === 'NO_DISPLAY'),
    { fault: 'NO_DISPLAY', n: 1, success: 1, partial: 0, failed: 0, successRatePct: null, marginSamples: 1, avgMarginEur: 183 });
  assert.equal((await call('GET', '/api/v1/repair/projects')).body.items.length, 1);
  assert.equal((await call('DELETE', url)).status, 204);
  assert.equal((await call('DELETE', url)).status, 404);
});

test('P5: market values per model/VRAM/condition, price changes, feedback and ranking weights', async () => {
  const row = (id: string, title: string, priceEur: number, extra = {}) => ({ source: 'ebay', externalId: `mk-${id}`, title, priceEur, shippingEur: 5,
    url: `https://www.ebay.de/itm/mk-${id}`, ...extra });
  await ingestListings(db, [...Array.from({ length: 20 }, (_, i) => row(`12-${i}`, 'ASUS RTX 3060 12GB Dual', 200 + i * 5)), row('fake', 'RTX 3060 12GB', 1),
    row('8gb', 'MSI RTX 3060 8GB Ventus', 150), row('fam', 'Gigabyte RTX 3060 Gaming OC', 180), row('auc', 'RTX 3060 12GB', 50, { offerType: 'AUCTION' })]);
  const overview = (await call('GET', '/api/v1/market')).body;
  assert.equal(overview.basis.minSample, 20); assert.match(overview.basis.note, /keine tatsächlich erzielten Verkaufspreise/);
  const group = (key: string) => overview.items.find((i: { modelKey: string; health: string }) => i.modelKey === key && i.health === 'working');
  assert.deepEqual([group('RTX 3060 (12GB)').n, group('RTX 3060 (12GB)').p50], [20, 247.5], '1 € listing filtered, auction excluded');
  assert.deepEqual([group('RTX 3060 (8GB)').n, group('RTX 3060 (8GB)').reliable], [1, false], '8 GB and 12 GB are separate');
  assert.equal(group('RTX 3060').n, 0, 'family without VRAM is not comparable');

  const url = `/api/v1/market/${encodeURIComponent('RTX 3060 (12GB)')}`;
  const detail = (await call('GET', `${url}?days=30`)).body;
  assert.equal(detail.stats.outliersRemoved, 1);
  assert.deepEqual(detail.stats.excluded, [{ reason: 'Auktion: aktuelles Gebot ist kein Angebotspreis', n: 1 }]);
  assert.equal(detail.history.length, 1); assert.equal(detail.history[0].n, 20);
  assert.deepEqual(detail.availability, { active: 22, notSeenRecently: 0, staleDays: 3 });
  assert.equal((await call('GET', `${url}?source=facebook`)).body.stats.reliable, false);
  assert.match((await call('GET', `/api/v1/market/${encodeURIComponent('RTX 3060 (8GB)')}`)).body.stats.message, /Keine verlässliche Schätzung: 1 von mindestens 20/);
  assert.equal((await call('GET', '/api/v1/market/Nope')).status, 404);
  assert.equal((await call('GET', `${url}?days=3`)).status, 400);
  await ingestListings(db, [row('12-0', 'ASUS RTX 3060 12GB Dual', 185)]);
  assert.deepEqual((await call('GET', url)).body.priceChanges.map((c: { fromEur: number; toEur: number }) => [c.fromEur, c.toEur]), [[200, 185]]);

  await call('POST', '/api/v1/watchlists', { name: '3060 12GB', query: 'RTX 3060 12GB', maxWorking: 260, maxDefect: 80, sourceList: ['ebay'] });
  const feed = async () => (await call('GET', '/api/v1/listings?source=ebay&limit=200')).body.items.filter((x: { externalId: string }) => x.externalId.startsWith('mk-'));
  const cheap = (await feed()).find((x: { externalId: string }) => x.externalId === 'mk-12-0');
  assert.equal(cheap.assessment.market.n, 20);
  assert.ok(cheap.assessment.reasons.some((r: string) => /unter Angebots-Median .* \(20 Inserate, 30 Tage\)/.test(r)));
  assert.ok(cheap.assessment.priorityParts.some((p: { key: string }) => p.key === 'market'));

  const fake = (await feed()).find((x: { externalId: string }) => x.externalId === 'mk-fake');
  assert.equal((await call('POST', `/api/v1/listings/${fake.id}/feedback`, { label: 'bogus' })).status, 400);
  assert.equal((await call('POST', '/api/v1/listings/999999/feedback', { label: 'other' })).status, 404);
  assert.equal((await call('POST', `/api/v1/listings/${fake.id}/feedback`, { label: 'wrong_model', reason: 'Fake-Preis' })).status, 201);
  assert.ok(!(await feed()).some((x: { id: number }) => x.id === fake.id), 'reported listing leaves the feed');
  const fb = (await call('GET', '/api/v1/feedback/stats')).body;
  assert.equal(fb.falseHits, 1); assert.deepEqual(fb.byLabel, [{ label: 'wrong_model', n: 1 }]);
  assert.equal(fb.byWatchlist.find((w: { name: string }) => w.name === '3060 12GB').falseHits, 1);

  const settings = (await call('GET', '/api/v1/ranking/settings')).body.item;
  assert.deepEqual(settings, { weights: { freshness: 1, price: 1, repair: 1, market: 1, personal: 1 }, marketMinSample: 20 });
  assert.equal((await call('PUT', '/api/v1/ranking/settings', { ...settings, weights: { ...settings.weights, market: 5 } })).status, 400);
  assert.equal((await call('PUT', '/api/v1/ranking/settings', { ...settings, marketMinSample: 2 })).status, 400);
  assert.equal((await call('PUT', '/api/v1/ranking/settings', { ...settings, weights: { ...settings.weights, market: 0 } })).status, 200);
  const unweighted = (await feed()).find((x: { externalId: string }) => x.externalId === 'mk-12-0');
  assert.ok(!unweighted.assessment.priorityParts.some((p: { key: string }) => p.key === 'market'));
  assert.ok(unweighted.assessment.priority < cheap.assessment.priority);
  await call('PUT', '/api/v1/ranking/settings', settings);
});

test('DF-601: server-side sessions, logout, password change, HTTPS cookie and lockout per client behind a proxy', async () => {
  const other = (overrides: Record<string, string>) => buildApp({ config: loadConfig({ ...env, ...overrides }), db, queues }).app;
  assert.throws(() => other({ SECRETS_KEY: '' }), /SECRETS_KEY/);
  assert.throws(() => other({ APP_PASSWORD: 'short' }), /APP_PASSWORD/);
  const loginOn = async (app: ReturnType<typeof other>, password: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password }, headers: { 'x-dealforge-action': '1', ...headers } });
  const get = (app: ReturnType<typeof other>, c: string) => app.inject({ method: 'GET', url: '/api/v1/watchlists', headers: { cookie: c } }).then(r => r.statusCode);

  await login();
  const session = cookie;
  assert.match(session, /^df_session=[\w-]{43}$/);
  assert.equal(await get(built.app, session), 200);
  assert.equal(await get(built.app, `${session.slice(0, -2)}xx`), 401, 'tampered token');
  assert.equal(await get(built.app, 'df_session=1893456000000.' + 'a'.repeat(64)), 401, 'old signed cookie format');

  // A new APP_PASSWORD ends every session created with the old one.
  const changed = other({ APP_PASSWORD: 'a-completely-new-password' });
  assert.equal(await get(changed, session), 401);
  await changed.close();

  // Logout ends this session only; all = every session.
  await login(); const second = cookie;
  const logout = await built.app.inject({ method: 'POST', url: '/api/v1/auth/logout', payload: {}, headers: { cookie: second, 'x-dealforge-action': '1' } });
  assert.equal(logout.statusCode, 200); assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);
  assert.equal(await get(built.app, second), 401);
  assert.equal(await get(built.app, session), 200);
  assert.equal((await call('POST', '/api/v1/auth/logout', { all: true }, { auth: false })).status, 401);
  cookie = session;
  assert.equal((await call('POST', '/api/v1/auth/logout', { all: true })).status, 200);
  assert.equal(await get(built.app, session), 401);
  await login();

  // HTTPS: __Host- cookie with Secure, HSTS and upgrade-insecure-requests; the plain cookie name is not accepted there.
  const secure = other({ APP_ORIGIN: 'https://dealforge.example', TRUST_PROXY: 'true' });
  const res = await loginOn(secure, env.APP_PASSWORD, { origin: 'https://dealforge.example' });
  assert.equal(res.statusCode, 200);
  const set = String(res.headers['set-cookie']);
  assert.match(set, /^__Host-df_session=[\w-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800; Secure$/);
  assert.equal(await get(secure, set.split(';')[0]), 200);
  assert.equal(await get(secure, set.split(';')[0].replace('__Host-', '')), 401);
  assert.equal(res.headers['strict-transport-security'], 'max-age=31536000');
  assert.match(String(res.headers['content-security-policy']), /upgrade-insecure-requests/);
  // Behind a trusted proxy the lockout is per client (X-Forwarded-For), not one shared bucket for everyone.
  for (let i = 0; i < 8; i++) assert.equal((await loginOn(secure, 'wrong-password-123', { 'x-forwarded-for': '203.0.113.9' })).statusCode, 401);
  assert.equal((await loginOn(secure, env.APP_PASSWORD, { 'x-forwarded-for': '203.0.113.9' })).statusCode, 429);
  assert.equal((await loginOn(secure, env.APP_PASSWORD, { 'x-forwarded-for': '198.51.100.7' })).statusCode, 200);
  await secure.close();
});

test('DF-602: security headers on every response, no CORS for foreign origins', async () => {
  for (const url of ['/', '/app.js', '/api/v1/health/live']) {
    const r = await built.app.inject({ method: 'GET', url });
    assert.equal(r.headers['x-frame-options'], 'DENY', url);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', url);
    assert.equal(r.headers['referrer-policy'], 'no-referrer', url);
    assert.match(String(r.headers['content-security-policy']), /default-src 'self'; script-src 'self';.*frame-ancestors 'none'/, url);
    assert.equal(r.headers['strict-transport-security'], undefined, 'HSTS only over HTTPS');
  }
  assert.doesNotMatch((await built.app.inject({ method: 'GET', url: '/' })).body, /\son[a-z]+=/i, 'no inline event handlers (CSP script-src self)');
  const preflight = await built.app.inject({ method: 'OPTIONS', url: '/api/v1/watchlists',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-dealforge-action' } });
  assert.ok(preflight.statusCode >= 400);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  const cross = await built.app.inject({ method: 'GET', url: '/api/v1/watchlists', headers: { cookie, origin: 'https://evil.example' } });
  assert.equal(cross.headers['access-control-allow-origin'], undefined, 'a foreign page cannot read API responses');
});

test('DF-603: audit log records changes and rejected requests', async () => {
  await call('POST', '/api/v1/auth/login', { password: 'wrong-password-456' }, { auth: false });
  await call('GET', '/api/v1/watchlists', undefined, { auth: false });
  const { status } = await call('POST', '/api/v1/watchlists', { name: 'Audit', query: 'RTX 3070', maxWorking: 300, maxDefect: 80 });
  assert.equal(status, 201);
  const items = (await call('GET', '/api/v1/audit?limit=200')).body.items as { method: string; path: string; status: number; ip: string }[];
  const has = (method: string, path: string, code: number) => items.some(e => e.method === method && e.path === path && e.status === code);
  assert.ok(has('POST', '/api/v1/watchlists', 201));
  assert.ok(has('POST', '/api/v1/auth/login', 401));
  assert.ok(has('GET', '/api/v1/watchlists', 401));
  assert.ok(!items.some(e => e.method === 'GET' && e.status === 200), 'plain reads are not audited');
  assert.equal(items[0].ip, '127.0.0.1');
});

test('DF-606: an outage opens one incident with one push; recovery resolves it and pushes again', async () => {
  const monitored = { ...config, scheduler: true };
  await savePushSubscription(db, { endpoint: 'https://fcm.googleapis.com/fcm/send/incident', keys: { p256dh: 'BPk', auth: 'xyz' } }, null);
  const pushed: string[] = [];
  const send = async (_t: unknown, payload: string) => { pushed.push(JSON.parse(payload).title); return 201; };
  const titles = () => [...new Set(pushed)];

  // No worker heartbeat: one incident for the worker, the providers are not reported on top.
  assert.deepEqual(await checkIncidents(db, monitored, queues, send), { opened: ['worker'], resolved: [] });
  assert.deepEqual(await checkIncidents(db, monitored, queues, send), { opened: [], resolved: [] }, 'no repeat alarm');
  assert.deepEqual(titles(), ['DealForge: Worker gestört']);
  await writeHeartbeat(queues);
  assert.deepEqual((await checkIncidents(db, monitored, queues, send)).resolved, ['worker']);

  // Simulated runs: eBay failing for 24 hours shows up as down in the status and raises an alarm.
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  for (const h of [24, 16, 8, 1]) await logSourceRun(db, { source: 'ebay', queryKey: 'sim', startedAt: hoursAgo(h), status: 'error', errorCode: 'HTTP', httpStatus: 503, message: 'Provider HTTP 503' });
  const ebay = (await call('GET', '/api/v1/providers/status')).body.providers.find((p: { source: string }) => p.source === 'ebay');
  assert.equal(ebay.errorRatePct, 100); assert.equal(ebay.lastError.code, 'HTTP');
  assert.deepEqual((await checkIncidents(db, monitored, queues, send)).opened, ['ebay']);
  let incidents = (await call('GET', '/api/v1/providers/status')).body.incidents;
  assert.equal(incidents[0].subject, 'ebay'); assert.equal(incidents[0].resolvedAt, null); assert.match(incidents[0].message, /HTTP: Provider HTTP 503/);

  await logSourceRun(db, { source: 'ebay', queryKey: 'sim', startedAt: new Date().toISOString(), status: 'ok' });
  assert.deepEqual((await checkIncidents(db, monitored, queues, send)).resolved, ['ebay']);
  incidents = (await call('GET', '/api/v1/providers/status')).body.incidents;
  assert.ok(incidents.every((i: { resolvedAt: string | null }) => i.resolvedAt));
  assert.deepEqual(titles(), ['DealForge: Worker gestört', 'DealForge: Worker wieder in Ordnung', 'DealForge: eBay gestört', 'DealForge: eBay wieder in Ordnung']);
  assert.deepEqual(await checkIncidents(db, config, queues, send), { opened: [], resolved: [] }, 'no alarms without continuous operation');
  await (await queues.plan.client).del(`${config.queuePrefix}:worker:heartbeat`);
});
