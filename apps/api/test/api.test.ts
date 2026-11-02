import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '@dealforge/config';
import { routes, ErrorBody } from '@dealforge/contracts';
import { createTestDb, seed, reserveProviderCall, ingestListings, type Db } from '@dealforge/db';
import { createQueues, redisConnection, type Queues } from '@dealforge/jobs';
import { buildApp } from '../src/app.ts';

const config = loadConfig({ APP_PASSWORD: 'correct-horse-battery', APP_ORIGIN: 'http://localhost:3000', DEMO_MODE: 'false', APPROVED_PROVIDERS: 'ebay', EBAY_APP_ID: 'a', EBAY_CLIENT_SECRET: 'b',
  QUEUE_PREFIX: `test-${randomBytes(4).toString('hex')}`, REDIS_URL: process.env.REDIS_URL, PROVIDER_DAILY_CALL_LIMIT: '50' });
let t: Awaited<ReturnType<typeof createTestDb>>, db: Db, queues: Queues, built: ReturnType<typeof buildApp>, cookie = '';
before(async () => {
  t = await createTestDb(); db = t.db; await seed(db);
  queues = createQueues(redisConnection(config.redisUrl), config.queuePrefix);
  built = buildApp({ config, db, queues });
});
after(async () => {
  for (const q of [queues.plan, ...Object.values(queues.fetch)]) await q.obliterate({ force: true });
  await built.app.close(); await queues.close(); await t.close();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
