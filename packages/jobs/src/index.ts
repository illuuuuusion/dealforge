/** BullMQ queues shared by API and worker: one fetch queue per provider, so a throttled provider never blocks another. */
import { randomUUID } from 'node:crypto';
import { Queue, type ConnectionOptions } from 'bullmq';
import type { Config } from '@dealforge/config';
import { watchlists, disabledProviders, budgetExhausted, providerUsage, providerRunStats, type Db } from '@dealforge/db';
import { planScan, providerReady, LIVE_SOURCES, type LiveSource, type PlannedQuery } from '@dealforge/providers';

export const PRIORITY = { manual: 1, scheduled: 10 };
export const POLL_SCHEDULER_ID = 'poll';

export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379), username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined, db: Number(u.pathname.slice(1) || 0), maxRetriesPerRequest: null };
}

export function createQueues(connection: ConnectionOptions, prefix: string) {
  const plan = new Queue<{ source: string }>('plan', { connection, prefix });
  const fetch = Object.fromEntries(LIVE_SOURCES.map(s => [s, new Queue<PlannedQuery>(`fetch-${s}`, { connection, prefix })])) as Record<LiveSource, Queue<PlannedQuery>>;
  return { prefix, plan, fetch, close: () => Promise.all([plan, ...Object.values(fetch)].map(q => q.close())).then(() => {}) };
}
export type Queues = ReturnType<typeof createQueues>;

export async function planFor(db: Db, config: Config, source = 'all') {
  return planScan(await watchlists(db), providerReady(config, await disabledProviders(db)), source);
}
/** One job per provider query. The query key deduplicates: while a job for it waits or runs, no second one is added. */
export async function enqueuePlan(queues: Queues, plan: PlannedQuery[], priority: number) {
  const queued: { platform: LiveSource; label: string; jobId: string }[] = [], deduplicated: { platform: LiveSource; label: string }[] = [];
  for (const q of plan) {
    const jobId = randomUUID();
    const job = await queues.fetch[q.platform].add('fetch', q, { jobId, priority, deduplication: { id: q.key }, removeOnComplete: 100, removeOnFail: 100 });
    if (job.id === jobId) queued.push({ platform: q.platform, label: q.label, jobId });
    else deduplicated.push({ platform: q.platform, label: q.label });
  }
  return { queued, deduplicated };
}

const heartbeatKey = (prefix: string) => `${prefix}:worker:heartbeat`;
export async function writeHeartbeat(queues: Queues) {
  await (await queues.plan.client).set(heartbeatKey(queues.prefix), new Date().toISOString(), { EX: 60 });
}
export async function lastHeartbeat(queues: Queues) {
  return (await queues.plan.client).get(heartbeatKey(queues.prefix));
}
export const WORKER_TIMEOUT_MS = 45_000;
export async function workerOnline(queues: Queues, now = Date.now()) {
  const at = await lastHeartbeat(queues);
  return !!at && now - Date.parse(at) < WORKER_TIMEOUT_MS;
}

async function queueState(q: Queue) {
  const c = await q.getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'failed');
  return { waiting: c.waiting + c.prioritized, active: c.active, delayed: c.delayed, failed: c.failed, rateLimitedMs: Math.max(0, await q.getRateLimitTtl()) };
}

/**
 * Operator view per provider. down = worker offline, last 3 runs failed, or no successful poll for 3 intervals;
 * degraded = >20 % errors in 24 h, budget exhausted or provider currently rate-limited.
 */
export async function systemStatus(db: Db, config: Config, queues: Queues, now = new Date()) {
  const ready = providerReady(config, await disabledProviders(db));
  const heartbeat = await lastHeartbeat(queues);
  const online = !!heartbeat && now.getTime() - Date.parse(heartbeat) < WORKER_TIMEOUT_MS;
  const providers = [];
  for (const source of ['ebay', 'kleinanzeigen', 'facebook'] as const) {
    const p = ready[source];
    const stats = await providerRunStats(db, source);
    const usage = await providerUsage(db, source, now);
    const live = source !== 'facebook';
    const exhausted = live ? await budgetExhausted(db, source, config.limits, now) : null;
    const queue = live ? await queueState(queues.fetch[source]) : null;
    const errorRatePct = stats.runs24h ? Math.round(100 * stats.errors24h / stats.runs24h) : null;
    const stale = config.scheduler && stats.lastSuccessAt !== null && now.getTime() - Date.parse(stats.lastSuccessAt) > 3 * config.pollSeconds * 1000;
    const failing = stats.recentStatuses.length >= 3 && stats.recentStatuses.every(s => s === 'error');
    const state = !p.live ? 'off' : !online || failing || stale ? 'down' : !stats.lastRunAt ? 'idle'
      : (errorRatePct ?? 0) > 20 || exhausted || (queue?.rateLimitedMs ?? 0) > 0 ? 'degraded' : 'ok';
    providers.push({ source, ...p, state, lastRunAt: stats.lastRunAt, lastSuccessAt: stats.lastSuccessAt, lastError: stats.lastError,
      runs24h: stats.runs24h, errors24h: stats.errors24h, errorRatePct, callsToday: usage.today, callsMonth: usage.month, budgetExhausted: exhausted, queue });
  }
  return { providers, worker: { online, lastHeartbeatAt: heartbeat }, scheduler: { enabled: config.scheduler, pollSeconds: config.pollSeconds }, limits: config.limits };
}
