import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '@dealforge/config';
import { createTestDb, setProviderEnabled, createWatchlist, savePushSubscription, markDeliveryShown, alertLatency, type Db } from '@dealforge/db';
import { createQueues, redisConnection, enqueuePlan, systemStatus, planFor, PRIORITY, type Queues, type PushSend } from '@dealforge/jobs';
import { ProviderError, type ProviderAdapter, type SearchRequest, type LiveSource, type NormalizedListing } from '@dealforge/providers';
import { startWorker, syncSchedulers } from '../src/worker.ts';

const env = { APPROVED_PROVIDERS: 'ebay,kleinanzeigen', EBAY_APP_ID: 'a', EBAY_CLIENT_SECRET: 'b', KLAZ_API_KEY: 'k',
  QUEUE_PREFIX: `test-${randomBytes(4).toString('hex')}`, REDIS_URL: process.env.REDIS_URL, PROVIDER_DAILY_CALL_LIMIT: '1000' };
const config = loadConfig(env);
const connection = redisConnection(config.redisUrl);
let t: Awaited<ReturnType<typeof createTestDb>>, db: Db, queues: Queues;
before(async () => { t = await createTestDb(); db = t.db; queues = createQueues(connection, config.queuePrefix); });
after(async () => {
  for (const q of queues.all) await q.obliterate({ force: true });
  await (await queues.plan.client).del(`${config.queuePrefix}:worker:heartbeat`);
  await queues.close(); await t.close();
});

type Search = (r: SearchRequest) => Promise<{ listings: NormalizedListing[]; fetchedAt: string }>;
const fake = (id: LiveSource, search: Search): ProviderAdapter => ({ id, search, validateConfig: () => ({ ok: true }),
  capabilities: { search: true, auctions: false, webhooks: false, regions: false, publishedAt: false } });
const listing = (source: LiveSource, externalId: string): NormalizedListing => ({ source, externalId, title: 'ASUS RTX 3080 10GB', description: '',
  url: `https://www.ebay.de/itm/${externalId}`, imageUrl: null, priceEur: 200, shippingEur: 5, condition: '', publishedAt: null });
const result = (...listings: NormalizedListing[]) => ({ listings, fetchedAt: new Date().toISOString() });
const adapters: Record<LiveSource, ProviderAdapter> = { ebay: fake('ebay', async () => result()), kleinanzeigen: fake('kleinanzeigen', async () => result()) };
const fast = { lockDuration: 1000, stalledInterval: 500 };
const start = (cfg = config, push?: PushSend) => startWorker({ db, config: cfg, queues, connection, adapters, workerOptions: fast, push });
const job = (platform: LiveSource, key: string) => ({ platform, query: key, label: key, key: `${platform}|${key}` });
async function until(check: () => Promise<boolean> | boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw Error('timeout'); await new Promise(r => setTimeout(r, 50)); }
}
const runs = async (key: string) => (await db.query('SELECT status, error_code FROM source_runs WHERE query_key = $1 ORDER BY id', [key])).rows;
const listings = async (prefix: string) => (await db.query('SELECT count(*) AS n FROM listings WHERE external_id LIKE $1', [`${prefix}%`])).rows[0].n;

test('DF-204: the same source/query is never queued twice while it waits or runs', async () => {
  const first = await enqueuePlan(queues, [job('ebay', 'dedupe'), job('kleinanzeigen', 'dedupe')], PRIORITY.scheduled);
  const second = await enqueuePlan(queues, [job('ebay', 'dedupe')], PRIORITY.manual);
  assert.equal(first.queued.length, 2);
  assert.deepEqual(second, { queued: [], deduplicated: [{ platform: 'ebay', label: 'dedupe' }] });
  const w = await start();
  await until(async () => (await runs('ebay|dedupe')).length === 1 && (await runs('kleinanzeigen|dedupe')).length === 1);
  await w.close();
  // Completed: the key is free again.
  assert.equal((await enqueuePlan(queues, [job('ebay', 'dedupe')], PRIORITY.manual)).queued.length, 1);
  const w2 = await start();
  await until(async () => (await runs('ebay|dedupe')).length === 2);
  await w2.close();
});

test('DF-204: jobs survive a worker restart, including one that was running', async () => {
  let release: () => void = () => {};
  let calls = 0;
  adapters.ebay = fake('ebay', async () => {
    calls++;
    if (calls === 1) await new Promise<void>(r => { release = r; }); // first run hangs: worker dies mid-job
    return result(listing('ebay', `restart-${calls}`));
  });
  await enqueuePlan(queues, [job('ebay', 'restart')], PRIORITY.manual);
  const w = await start();
  await until(() => calls === 1);
  await w.close(true);
  assert.equal((await enqueuePlan(queues, [job('ebay', 'restart')], PRIORITY.manual)).queued.length, 0, 'interrupted job still owns its key');
  const w2 = await start();
  await until(async () => (await runs('ebay|restart')).some(r => r.status === 'ok'));
  await w2.close();
  release();
  assert.equal(calls, 2);
  assert.equal(await listings('restart-'), 1);
});

test('DF-205/T-14: a 429 pauses only that provider; the other keeps delivering', async () => {
  const seen: Record<string, number[]> = { ebay: [], kleinanzeigen: [] };
  adapters.ebay = fake('ebay', async () => {
    seen.ebay.push(Date.now());
    if (seen.ebay.length === 1) throw new ProviderError('RATE_LIMIT', 'Provider HTTP 429', { httpStatus: 429, retryAfterMs: 1000 });
    return result(listing('ebay', 'rl-ebay'));
  });
  adapters.kleinanzeigen = fake('kleinanzeigen', async () => { seen.kleinanzeigen.push(Date.now()); return result(listing('kleinanzeigen', 'rl-klaz')); });
  const w = await start();
  await enqueuePlan(queues, [job('ebay', 'rl'), job('kleinanzeigen', 'rl')], PRIORITY.manual);
  await until(() => seen.kleinanzeigen.length === 1 && seen.ebay.length === 1);
  const status = await systemStatus(db, config, queues);
  assert.ok((status.providers.find(p => p.source === 'ebay')?.queue?.rateLimitedMs ?? 0) > 0);
  await until(() => seen.ebay.length === 2);
  await w.close();
  assert.ok(seen.ebay[1] - seen.ebay[0] >= 900, 'waited for Retry-After');
  assert.ok(seen.kleinanzeigen[0] < seen.ebay[1], 'kleinanzeigen was not blocked');
  assert.deepEqual((await runs('ebay|rl')).map(r => r.error_code), ['RATE_LIMIT', null]);
});

test('DF-206/T-17: simulated quota exhaustion stops external calls', async () => {
  let requests = 0;
  adapters.ebay = fake('ebay', async ({ beforeRequest }) => { await beforeRequest?.(); requests++; return result(); });
  const tight = { ...config, limits: { daily: 2, monthly: 100, perQueryDaily: 100 } };
  const w = await start(tight);
  await enqueuePlan(queues, ['q1', 'q2', 'q3', 'q4'].map(k => job('ebay', `quota-${k}`)), PRIORITY.manual);
  await until(async () => (await db.query("SELECT count(*) AS n FROM source_runs WHERE query_key LIKE 'ebay|quota-%'")).rows[0].n === 4);
  await w.close();
  assert.equal(requests, 2);
  const skipped = (await db.query("SELECT error_code FROM source_runs WHERE query_key LIKE 'ebay|quota-%' AND status = 'skipped'")).rows;
  assert.deepEqual(skipped.map(r => r.error_code), ['QUOTA', 'QUOTA']);
  assert.ok((await systemStatus(db, tight, queues)).providers.find(p => p.source === 'ebay')?.budgetExhausted);
});

test('DF-207/DF-209: provider errors and kill switch stay isolated and show up in the system status', async () => {
  let ebayCalls = 0;
  adapters.ebay = fake('ebay', async () => { ebayCalls++; throw new ProviderError('NETWORK', 'Provider nicht erreichbar: ECONNRESET'); });
  adapters.kleinanzeigen = fake('kleinanzeigen', async () => result(listing('kleinanzeigen', 'iso-1')));
  const w = await start();
  await enqueuePlan(queues, ['a', 'b', 'c'].map(k => job('ebay', `iso-${k}`)).concat(job('kleinanzeigen', 'iso')), PRIORITY.manual);
  await until(async () => ebayCalls === 3 && (await runs('kleinanzeigen|iso')).length === 1);
  await until(async () => (await runs('ebay|iso-c')).length === 1);
  let status = await systemStatus(db, config, queues);
  const ebay = status.providers.find(p => p.source === 'ebay')!;
  assert.equal(status.worker.online, true);
  assert.equal(ebay.state, 'down');
  assert.equal(ebay.lastError?.code, 'NETWORK');
  assert.ok((ebay.errorRatePct ?? 0) > 0);
  assert.equal(status.providers.find(p => p.source === 'kleinanzeigen')?.state, 'ok');
  assert.equal(await listings('iso-'), 1);

  await setProviderEnabled(db, 'ebay', false);
  await enqueuePlan(queues, [job('ebay', 'off')], PRIORITY.manual);
  await until(async () => (await runs('ebay|off')).length === 1);
  assert.equal(ebayCalls, 3);
  assert.deepEqual(await runs('ebay|off'), [{ status: 'skipped', error_code: 'TERMS_NOT_APPROVED' }]);
  status = await systemStatus(db, config, queues);
  assert.equal(status.providers.find(p => p.source === 'ebay')?.state, 'off');
  await w.close();
  await setProviderEnabled(db, 'ebay', true);
});

test('DF-303/305/307: a detected listing becomes alerts and one push per subscription; failures retry, expired subscriptions go', async () => {
  await createWatchlist(db, { name: 'Push 4070S', query: 'RTX 4070 Super', maxWorking: 470, maxDefect: 120, sourceList: ['ebay'] });
  const sub = (name: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: { p256dh: 'p', auth: 'a' } });
  for (const name of ['ok', 'flaky', 'gone']) await savePushSubscription(db, sub(name), null);
  const sent: { name: string; message: Record<string, unknown> }[] = [];
  let flaky = 0;
  const push: PushSend = async (target, payload) => {
    const name = target.endpoint.split('/').pop()!;
    sent.push({ name, message: JSON.parse(payload) });
    return name === 'gone' ? 410 : name === 'flaky' && ++flaky === 1 ? 503 : 201;
  };
  adapters.ebay = fake('ebay', async () => result({ ...listing('ebay', 'push-1'), title: 'MSI RTX 4070 Super Ventus 12GB', priceEur: 300, publishedAt: new Date().toISOString() }));
  const w = await start(config, push);
  const deliveries = async () => (await db.query(`SELECT d.id, d.status, s.endpoint FROM alert_deliveries d
    LEFT JOIN push_subscriptions s ON s.id = d.subscription_id ORDER BY d.id`)).rows;
  // Two alerts (SCHNAPPER, DEAL) x two live subscriptions; the 503 is retried after the job's backoff.
  await enqueuePlan(queues, [job('ebay', 'push')], PRIORITY.manual);
  await until(async () => (await deliveries()).filter(d => d.status === 'sent').length === 4, 15000);
  // A replay of the same listing raises no new alert and no new push.
  await enqueuePlan(queues, [job('ebay', 'push')], PRIORITY.manual);
  await until(async () => (await runs('ebay|push')).length === 2);
  await new Promise(r => setTimeout(r, 300));
  await w.close();
  const count = (name: string) => sent.filter(x => x.name === name).length;
  assert.equal(count('ok'), 2, 'already sent deliveries are not resent on retry');
  assert.equal(count('flaky'), 3);
  assert.ok(count('gone') >= 1);
  assert.equal((await db.query("SELECT count(*) AS n FROM push_subscriptions WHERE endpoint LIKE '%/gone'")).rows[0].n, 0, 'expired subscription removed');
  assert.deepEqual([...new Set((await deliveries()).map(d => d.status))].sort(), ['gone', 'sent']);
  const msg = sent.find(x => x.name === 'ok')!.message;
  assert.match(String(msg.title), /^DealForge: (Schnapper|Preisalarm)$/);
  assert.equal(msg.url, 'https://www.ebay.de/itm/push-1');
  assert.equal(typeof msg.deliveryId, 'number');
  // DF-308: only a service worker receipt makes a delivery "shown"; latency stages become measurable.
  assert.equal(await markDeliveryShown(db, msg.deliveryId as number), true);
  const [ebay] = await alertLatency(db);
  assert.equal(ebay.source, 'ebay'); assert.equal(ebay.samples, 2);
  assert.ok(ebay.ingest.p50 !== null && ebay.push.p95 !== null && ebay.shown.p50 !== null);
});

test('DF-301: fast watchlists get their own schedule, only for sources in FAST_PROVIDERS', async () => {
  const fastConfig = loadConfig({ ...env, FAST_PROVIDERS: 'ebay', ENABLE_SCHEDULER: 'true', FAST_POLL_INTERVAL_SECONDS: '45' });
  await createWatchlist(db, { name: 'Fast', query: 'steam deck oled', maxWorking: 400, maxDefect: 100, sourceList: ['ebay', 'kleinanzeigen'], fast: true });
  assert.deepEqual((await planFor(db, fastConfig, 'all', true)).map(p => p.key), ['ebay|steam deck oled']);
  assert.ok((await planFor(db, fastConfig)).some(p => p.key === 'kleinanzeigen|steam deck oled'), 'standard schedule still covers every source');
  assert.deepEqual(await planFor(db, config, 'all', true), [], 'no FAST_PROVIDERS, no fast polling');
  const every = async () => Object.fromEntries((await queues.plan.getJobSchedulers()).map(s => [s.key, s.every]));
  await syncSchedulers(queues, fastConfig);
  assert.deepEqual(await every(), { poll: 300000, 'poll-fast': 45000 });
  await syncSchedulers(queues, config);
  assert.deepEqual(await every(), {});
});
