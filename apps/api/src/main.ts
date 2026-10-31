import { loadConfig } from '@dealforge/config';
import { createPool, migrate, seed } from '@dealforge/db';
import { createQueues, redisConnection } from '@dealforge/jobs';
import { buildApp } from './app.ts';

const config = loadConfig();
const db = createPool(config.databaseUrl);
await migrate(db);
await seed(db, { demoMode: config.demoMode });
const queues = createQueues(redisConnection(config.redisUrl), config.queuePrefix);
const { app } = buildApp({ config, db, queues });
await app.listen({ host: config.host, port: config.port });
console.log(`DealForge API at http://${config.host}:${config.port} | demo=${config.demoMode}`);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => { await app.close(); await queues.close(); await db.end(); process.exit(0); });
}
