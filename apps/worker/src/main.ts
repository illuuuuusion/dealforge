import { loadConfig } from '@dealforge/config';
import { createPool, migrate } from '@dealforge/db';
import { createQueues, redisConnection } from '@dealforge/jobs';
import { createAdapters } from '@dealforge/providers';
import { startWorker } from './worker.ts';

const config = loadConfig();
const db = createPool(config.databaseUrl);
await migrate(db);
const connection = redisConnection(config.redisUrl);
const queues = createQueues(connection, config.queuePrefix);
const worker = await startWorker({ db, config, queues, connection, adapters: createAdapters(config) });
console.log(`DealForge worker | scheduler=${config.scheduler} every ${config.pollSeconds}s | fast=${config.fastProviders.join(',') || 'none'} every ${config.fastPollSeconds}s | approved=${config.approvedProviders.join(',') || 'none'}`);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => { await worker.close(); await queues.close(); await db.end(); process.exit(0); });
}
