import fs from 'node:fs';
import { randomBytes, createHmac, timingSafeEqual, scryptSync } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import * as C from '@dealforge/contracts';
import type { Config } from '@dealforge/config';
import * as repo from '@dealforge/db';
import { profiles } from '@dealforge/domain';
import { normalizeFacebook } from '@dealforge/providers';
import { planFor, enqueuePlan, enqueueAlerts, systemStatus, workerOnline, vapidKeys, createPushSender, deliver, PRIORITY, type Queues, type PushSend } from '@dealforge/jobs';

const webRoot = new URL('../../web/public/', import.meta.url);
const staticFiles: [string, string, string][] = [['/', 'index.html', 'text/html; charset=utf-8'], ['/app.js', 'app.js', 'application/javascript; charset=utf-8'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8'], ['/sw.js', 'sw.js', 'application/javascript; charset=utf-8'],
  ['/manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json']];
// Known GPU models for the watchlist form; a query matching one uses profile matching instead of plain text.
const models = [...new Set(profiles.flatMap(p => [p.family, p.name.replace(/ Repair$/, '')]).filter((m): m is string => !!m))].sort();
const publicPaths = new Set(['/api/v1/health/live', '/api/v1/health/ready', '/api/v1/auth/login']);

class HttpError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const notFound = () => new HttpError(404, 'NOT_FOUND', 'Nicht gefunden');

export function buildApp({ config, db, queues, push }: { config: Config; db: repo.Db; queues: Queues; push?: PushSend }) {
  if ((!config.demoMode || !['127.0.0.1', 'localhost'].includes(config.host)) && config.appPassword.length < 16) {
    throw Error('Public deployment requires APP_PASSWORD with at least 16 characters');
  }
  const secret = config.sessionSecret || randomBytes(32).toString('hex');
  const passwordHash = config.appPassword ? scryptSync(config.appPassword, 'dealforge-v1', 32) : null;
  const loginAttempts = new Map<string, { count: number; until: number }>();
  const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('hex');
  function validSession(req: FastifyRequest) {
    if (!config.appPassword) return true;
    const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('df_session='))?.slice(11);
    if (!cookie) return false;
    const [expiration, tag] = cookie.split('.');
    if (!/^\d{10,14}$/.test(expiration || '') || !/^[a-f0-9]{64}$/.test(tag || '')) return false;
    const expected = Buffer.from(sign(expiration), 'hex'), got = Buffer.from(tag, 'hex');
    return expected.length === got.length && timingSafeEqual(expected, got) && Date.now() < Number(expiration);
  }
  // localhost and 127.0.0.1 are different browser origins for the same local app: accept both.
  const loopbackTwin = (origin: string) => {
    try {
      const u = new URL(origin), twin = { localhost: '127.0.0.1', '127.0.0.1': 'localhost' }[u.hostname];
      return twin ? `${u.protocol}//${twin}${u.port ? `:${u.port}` : ''}` : null;
    } catch { return null; }
  };
  function mutationAllowed(req: FastifyRequest) {
    if (req.headers['x-dealforge-action'] !== '1') return false;
    const origin = req.headers.origin;
    if (!origin) return true; // scripts/curl require session and custom header
    const expected = config.appOrigin || `http://${req.headers.host}`;
    return origin === expected || origin === loopbackTwin(expected);
  }

  const app = Fastify({ bodyLimit: 1024 * 1024, genReqId: () => randomBytes(8).toString('hex') });
  const apiRoutes: string[] = [];
  app.addHook('onRoute', r => { if (r.url.startsWith('/api/')) for (const m of [r.method].flat()) if (m !== 'HEAD') apiRoutes.push(`${m} ${r.url}`); });
  app.addHook('onRequest', async req => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    if (req.method !== 'GET' && !mutationAllowed(req)) throw new HttpError(403, 'FORBIDDEN', 'Origin/Header ungültig');
    if (!publicPaths.has(path) && !validSession(req)) throw new HttpError(401, 'UNAUTHORIZED', 'Bitte anmelden');
  });
  app.addHook('onSend', async (_req, reply) => { reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff'); });
  app.setErrorHandler((err: FastifyError | ZodError | HttpError, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ code: 'VALIDATION', message: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), requestId: req.id });
    }
    if (err instanceof HttpError) return reply.code(err.status).send({ code: err.code, message: err.message, requestId: req.id });
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) console.error('[dealforge]', req.id, err.message);
    return reply.code(status).send({ code: status === 500 ? 'INTERNAL' : err.code || 'BAD_REQUEST', message: status === 500 ? 'Interner Fehler' : err.message, requestId: req.id });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: 'Endpunkt nicht vorhanden', requestId: req.id }));

  for (const [route, file, type] of staticFiles) {
    app.get(route, async (_req, reply) => reply.type(type).header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY')
      .send(fs.readFileSync(new URL(file, webRoot))));
  }

  const ok = { ok: true as const };
  const idOf = (req: FastifyRequest) => C.IdParams.parse(req.params).id;
  app.get('/api/v1/health/live', async () => ok);
  app.get('/api/v1/health/ready', async (_req, reply) => {
    const dbOk = await db.query('SELECT 1').then(() => true, () => false);
    const worker = await workerOnline(queues).then(online => ({ redis: true, online }), () => ({ redis: false, online: false }));
    const body = { ok: dbOk && worker.redis && worker.online, db: dbOk, redis: worker.redis, worker: worker.online };
    return reply.code(body.ok ? 200 : 503).send(body);
  });
  app.post('/api/v1/auth/login', async (req, reply) => {
    const ip = req.ip, item = loginAttempts.get(ip) || { count: 0, until: 0 };
    if (Date.now() < item.until) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Zu viele Login-Versuche');
    const { password } = C.Login.parse(req.body ?? {});
    const ok = !passwordHash || timingSafeEqual(scryptSync(password, 'dealforge-v1', 32), passwordHash);
    if (!ok) {
      item.count++; item.until = item.count >= 8 ? Date.now() + 60000 : 0; loginAttempts.set(ip, item);
      throw new HttpError(401, 'WRONG_PASSWORD', 'Falsches Passwort');
    }
    loginAttempts.delete(ip);
    const expiry = String(Date.now() + 7 * 24 * 3600000);
    reply.header('Set-Cookie', `df_session=${expiry}.${sign(expiry)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${config.appOrigin.startsWith('https://') ? '; Secure' : ''}`);
    return { ok: true };
  });
  app.get('/api/v1/openapi.json', async () => C.openApiDocument());
  app.get('/api/v1/state', async () => ({ stats: await repo.listStats(db), models, demoMode: config.demoMode }));

  app.get('/api/v1/watchlists', async () => ({ items: await repo.watchlists(db) }));
  app.post('/api/v1/watchlists', async (req, reply) => reply.code(201).send({ id: await repo.createWatchlist(db, req.body) }));
  app.patch('/api/v1/watchlists/:id', async req => {
    const item = await repo.updateWatchlist(db, idOf(req), req.body);
    if (!item) throw notFound();
    return { item };
  });
  app.delete('/api/v1/watchlists/:id', async (req, reply) => {
    if (!await repo.deleteWatchlist(db, idOf(req))) throw notFound();
    return reply.code(204).send();
  });

  app.get('/api/v1/listings', async req => {
    const q = C.FeedQuery.parse(req.query);
    // ponytail: offset cursor over the ≤500 newest matches; keyset pagination once the feed outgrows that.
    const all = await repo.listDeals(db, { mode: q.mode, source: q.source, watchlistId: q.watchlistId ?? null, limit: 500 });
    const offset = Number(q.cursor ?? 0);
    return { items: all.slice(offset, offset + q.limit), nextCursor: offset + q.limit < all.length ? String(offset + q.limit) : null };
  });
  app.get('/api/v1/listings/:id', async req => {
    const item = await repo.getListing(db, idOf(req));
    if (!item) throw notFound();
    return { item };
  });
  app.patch('/api/v1/listings/:id/user-state', async req => {
    const id = idOf(req), { status } = C.UserStatePatch.parse(req.body);
    if (!await repo.setListingStatus(db, id, status)) throw notFound();
    return ok;
  });

  app.get('/api/v1/alerts', async req => ({ items: await repo.recentAlerts(db, C.AlertsQuery.parse(req.query).limit) }));
  // ponytail: each SSE client polls the alerts table every 2 s; LISTEN/NOTIFY once there are many clients.
  const streams = new Set<() => void>();
  app.addHook('preClose', async () => { for (const end of streams) end(); });
  app.get('/api/v1/events', async (req, reply) => {
    const resume = String(req.headers['last-event-id'] ?? '');
    let last = /^\d{1,15}$/.test(resume) ? Number(resume) : await repo.latestAlertId(db), busy = false, idle = 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'keep-alive' });
    res.write('retry: 5000\n\n');
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const items = await repo.alertsAfter(db, last);
        for (const a of items) { res.write(`id: ${a.id}\nevent: alert\ndata: ${JSON.stringify(a)}\n\n`); last = a.id; }
        if (items.length) idle = 0; else if (++idle % 10 === 0) res.write(': ping\n\n');
      } catch (e) { console.error('[events]', (e as Error).message); } finally { busy = false; }
    };
    const timer = setInterval(tick, 2000);
    const end = () => { clearInterval(timer); streams.delete(end); res.end(); };
    streams.add(end);
    req.raw.on('close', end);
    await tick();
  });

  app.get('/api/v1/alerts/latency', async req => {
    const { days } = C.LatencyQuery.parse(req.query);
    return { days, items: await repo.alertLatency(db, days) };
  });

  let sender: Promise<PushSend> | null = null;
  const send: PushSend = async (target, payload) => (await (sender ??= push ? Promise.resolve(push) : createPushSender(db, config.vapidSubject)))(target, payload);
  app.get('/api/v1/push/public-key', async () => ({ publicKey: (await vapidKeys(db)).publicKey }));
  app.get('/api/v1/push-subscriptions', async () => ({ items: (await repo.pushSubscriptions(db)).map(s => ({ id: s.id, host: new URL(s.endpoint).hostname,
    userAgent: s.userAgent, createdAt: s.createdAt, lastSuccessAt: s.lastSuccessAt })) }));
  app.post('/api/v1/push-subscriptions', async (req, reply) =>
    reply.code(201).send({ id: await repo.savePushSubscription(db, C.PushSubscriptionCreate.parse(req.body), req.headers['user-agent'] ?? null) }));
  app.delete('/api/v1/push-subscriptions/:id', async (req, reply) => {
    if (!await repo.deletePushSubscription(db, idOf(req))) throw notFound();
    return reply.code(204).send();
  });
  app.post('/api/v1/push/test', async () => deliver(db, send, null, { title: 'DealForge: Test-Push', body: `Push funktioniert · ${new Date().toLocaleTimeString('de-DE')}`, tag: 'dealforge-test' }));
  app.post('/api/v1/push/receipts', async (req, reply) => {
    if (!await repo.markDeliveryShown(db, C.PushReceipt.parse(req.body).deliveryId)) throw notFound();
    return reply.code(204).send();
  });
  app.get('/api/v1/push/deliveries', async req => ({ items: await repo.recentDeliveries(db, C.AlertsQuery.parse(req.query).limit) }));

  app.get('/api/v1/repair/settings', async () => ({ item: await repo.repairSettings(db) }));
  app.put('/api/v1/repair/settings', async req => ({ item: await repo.saveRepairSettings(db, req.body) }));
  app.get('/api/v1/repair/stats', async () => repo.repairStats(db));
  app.get('/api/v1/repair/projects', async () => ({ items: await repo.repairProjects(db) }));
  app.post('/api/v1/repair/projects', async (req, reply) => {
    const r = await repo.createRepairProject(db, C.RepairProjectCreate.parse(req.body).listingId);
    if (!r) throw notFound();
    return reply.code(r.created ? 201 : 200).send({ id: r.id });
  });
  app.get('/api/v1/repair/projects/:id', async req => {
    const item = await repo.getRepairProject(db, idOf(req));
    if (!item) throw notFound();
    return { item };
  });
  app.patch('/api/v1/repair/projects/:id', async req => {
    const item = await repo.updateRepairProject(db, idOf(req), req.body);
    if (!item) throw notFound();
    return { item };
  });
  app.delete('/api/v1/repair/projects/:id', async (req, reply) => {
    if (!await repo.deleteRepairProject(db, idOf(req))) throw notFound();
    return reply.code(204).send();
  });

  app.get('/api/v1/providers/status', async () => systemStatus(db, config, queues));
  app.patch('/api/v1/providers/:source', async req => {
    const { source } = C.SourceParams.parse(req.params), { enabled } = C.ProviderPatch.parse(req.body);
    await repo.setProviderEnabled(db, source, enabled);
    return ok;
  });
  app.post('/api/v1/admin/scans', async (req, reply) => {
    const { source } = C.ScanRequest.parse(req.body ?? {});
    const plan = await planFor(db, config, source);
    const blocked = await Promise.all([...new Set(plan.map(p => p.platform))].map(p => repo.budgetExhausted(db, p, config.limits)));
    if (plan.length && blocked.every(Boolean)) throw new HttpError(429, 'BUDGET_EXHAUSTED', `${blocked[0]} – keine weiteren Provider-Abfragen`);
    const result = await enqueuePlan(queues, plan, PRIORITY.manual);
    if (plan.length && !result.queued.length) throw new HttpError(409, 'SCAN_RUNNING', 'Alle Abfragen dieses Scans laufen bereits oder warten');
    return reply.code(202).send(result);
  });
  app.post('/api/v1/import/facebook', async req => {
    const { items } = C.FacebookImport.parse(req.body);
    const normalized = items.map(x => normalizeFacebook((x ?? {}) as Record<string, unknown>)).filter(x => x !== null);
    const { alertIds, ...summary } = await repo.ingestListings(db, normalized);
    await enqueueAlerts(queues, alertIds);
    return { normalized: normalized.length, ...summary };
  });
  return { app, apiRoutes };
}
