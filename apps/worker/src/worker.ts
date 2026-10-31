/** Scheduler + per-provider fetch workers. Provider failures are logged per run and never block another provider. */
import { Worker, type ConnectionOptions, type Job, type WorkerOptions } from 'bullmq';
import type { Config } from '@dealforge/config';
import { ingestListings, logSourceRun, reserveProviderCall, disabledProviders, type Db } from '@dealforge/db';
import { providerReady, ProviderError, DEFAULT_RATE_LIMIT_WAIT_MS, LIVE_SOURCES, type ProviderAdapter, type LiveSource, type PlannedQuery } from '@dealforge/providers';
import { planFor, enqueuePlan, writeHeartbeat, PRIORITY, POLL_SCHEDULER_ID, type Queues } from '@dealforge/jobs';

export interface WorkerDeps {
  db: Db; config: Config; queues: Queues; connection: ConnectionOptions;
  adapters: Record<LiveSource, ProviderAdapter>;
  workerOptions?: Partial<WorkerOptions>;
}

export async function runFetch({ db, config, adapters }: WorkerDeps, worker: Worker, job: Job<PlannedQuery>) {
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
    const summary = await ingestListings(db, result.listings, { fetchedAt: result.fetchedAt });
    await logSourceRun(db, { source: platform, queryKey: key, startedAt, status: 'ok', fetched: summary.fetched, inserted: summary.inserted });
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

export async function startWorker(deps: WorkerDeps) {
  const { db, config, queues, connection } = deps;
  const opts = { connection, prefix: queues.prefix, ...deps.workerOptions };
  const plan = new Worker<{ source: string }>('plan', async job => {
    const r = await enqueuePlan(queues, await planFor(db, config, job.data.source ?? 'all'), PRIORITY.scheduled);
    return { queued: r.queued.length, deduplicated: r.deduplicated.length };
  }, opts);
  const fetchers = LIVE_SOURCES.map(source => {
    const worker: Worker<PlannedQuery> = new Worker(`fetch-${source}`, job => runFetch(deps, worker, job), { ...opts, concurrency: 1 });
    return worker;
  });
  const workers: Worker[] = [plan, ...fetchers];
  for (const w of workers) w.on('error', e => console.error(`[worker ${w.name}]`, e.message));
  // Scheduler state lives in Redis: a restart neither loses nor duplicates it.
  if (config.scheduler) await queues.plan.upsertJobScheduler(POLL_SCHEDULER_ID, { every: config.pollSeconds * 1000 }, { name: 'plan', data: { source: 'all' } });
  else await queues.plan.removeJobScheduler(POLL_SCHEDULER_ID);
  const beat = () => writeHeartbeat(queues).catch(e => console.error('[heartbeat]', e.message));
  await beat();
  const timer = setInterval(beat, 15_000);
  return {
    workers,
    async close(force = false) { clearInterval(timer); await Promise.all(workers.map(w => w.close(force))); },
  };
}
