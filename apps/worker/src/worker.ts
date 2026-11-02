/** Scheduler + per-provider fetch workers. Provider failures are logged per run and never block another provider. */
import { Worker, type ConnectionOptions, type Job, type WorkerOptions } from 'bullmq';
import type { Config } from '@dealforge/config';
import { ingestListings, logSourceRun, reserveProviderCall, disabledProviders, type Db } from '@dealforge/db';
import { providerReady, ProviderError, DEFAULT_RATE_LIMIT_WAIT_MS, LIVE_SOURCES, type ProviderAdapter, type LiveSource, type PlannedQuery } from '@dealforge/providers';
import { planFor, enqueuePlan, enqueueAlerts, dispatchAlert, createPushSender, writeHeartbeat, PRIORITY, POLL_SCHEDULER_ID, FAST_POLL_SCHEDULER_ID,
  type Queues, type PlanJob, type PushSend } from '@dealforge/jobs';

export interface WorkerDeps {
  db: Db; config: Config; queues: Queues; connection: ConnectionOptions;
  adapters: Record<LiveSource, ProviderAdapter>;
  workerOptions?: Partial<WorkerOptions>;
  /** Web Push sender; defaults to VAPID via web-push. */
  push?: PushSend;
}

export async function runFetch({ db, config, adapters, queues }: WorkerDeps, worker: Worker, job: Job<PlannedQuery>) {
  const { platform, query, key } = job.data;
  const startedAt = new Date().toISOString();
  // Re-checked per job: a provider switched off after planning gets no further calls.
  if (!providerReady(config, await disabledProviders(db))[platform].live) {
    await logSourceRun(db, { source: platform, queryKey: key, startedAt, status: 'skipped', errorCode: 'TERMS_NOT_APPROVED', message: 'Quelle nicht freigegeben oder ausgeschaltet' });
    return { skipped: 'TERMS_NOT_APPROVED' };
  }
  try {
    const result = await adapters[platform].search({ query, beforeRequest: async () => {
      const reason = await reserveProviderCall(db, platform, key, config.limits);
      if (reason) throw new ProviderError('QUOTA', reason);
    } });
    const { alertIds, ...summary } = await ingestListings(db, result.listings, { fetchedAt: result.fetchedAt });
    await logSourceRun(db, { source: platform, queryKey: key, startedAt, status: 'ok', fetched: summary.fetched, inserted: summary.inserted });
    await enqueueAlerts(queues, alertIds);
    return summary;
  } catch (e) {
    const err = e instanceof ProviderError ? e : null;
    await logSourceRun(db, { source: platform, queryKey: key, startedAt, status: err?.code === 'QUOTA' ? 'skipped' : 'error',
      errorCode: err?.code ?? 'INTERNAL', httpStatus: err?.httpStatus, message: (e as Error).message });
    // 429: pause only this provider's queue for Retry-After; the job goes back to waiting without a retry storm.
    if (err?.code === 'RATE_LIMIT') {
      await worker.rateLimit(err.retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS);
      throw Worker.RateLimitError();
    }
    // HTTP-level retries already happened; a failed run waits for the next scheduled poll.
    return { error: err?.code ?? 'INTERNAL' };
  }
}

/** Scheduler state lives in Redis: a restart neither loses nor duplicates it. Fast polling only with FAST_PROVIDERS (DF-301). */
export async function syncSchedulers(queues: Queues, config: Config) {
  if (config.scheduler) await queues.plan.upsertJobScheduler(POLL_SCHEDULER_ID, { every: config.pollSeconds * 1000 }, { name: 'plan', data: { source: 'all' } });
  else await queues.plan.removeJobScheduler(POLL_SCHEDULER_ID);
  if (config.scheduler && config.fastProviders.length) {
    await queues.plan.upsertJobScheduler(FAST_POLL_SCHEDULER_ID, { every: config.fastPollSeconds * 1000 }, { name: 'plan', data: { source: 'all', fast: true } });
  } else await queues.plan.removeJobScheduler(FAST_POLL_SCHEDULER_ID);
}

export async function startWorker(deps: WorkerDeps) {
  const { db, config, queues, connection } = deps;
  const opts = { connection, prefix: queues.prefix, ...deps.workerOptions };
  const plan = new Worker<PlanJob>('plan', async job => {
    const fast = !!job.data.fast;
    const r = await enqueuePlan(queues, await planFor(db, config, job.data.source ?? 'all', fast), fast ? PRIORITY.fast : PRIORITY.scheduled);
    return { queued: r.queued.length, deduplicated: r.deduplicated.length };
  }, opts);
  const send = deps.push ?? await createPushSender(db, config.vapidSubject);
  const alerts = new Worker<{ alertId: number }>('alerts', async job => {
    const r = await dispatchAlert(db, send, job.data.alertId);
    // Throwing makes BullMQ retry; already sent deliveries are skipped then.
    if (r?.failed) throw Error(`${r.failed} Push-Zustellung(en) fehlgeschlagen`);
    return r;
  }, { ...opts, concurrency: 4 });
  const fetchers = LIVE_SOURCES.map(source => {
    const worker: Worker<PlannedQuery> = new Worker(`fetch-${source}`, job => runFetch(deps, worker, job), { ...opts, concurrency: 1 });
    return worker;
  });
  const workers: Worker[] = [plan, alerts, ...fetchers];
  for (const w of workers) w.on('error', e => console.error(`[worker ${w.name}]`, e.message));
  await syncSchedulers(queues, config);
  const beat = () => writeHeartbeat(queues).catch(e => console.error('[heartbeat]', e.message));
  await beat();
  const timer = setInterval(beat, 15_000);
  return {
    workers,
    async close(force = false) { clearInterval(timer); await Promise.all(workers.map(w => w.close(force))); },
  };
}
