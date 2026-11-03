import { loadConfig, createRedactor, redactConsole } from '@dealforge/config';
import { createPool, migrate, seed, resealSecrets, purgeExpired } from '@dealforge/db';
import { createQueues, redisConnection, createPushSender, checkIncidents } from '@dealforge/jobs';
import { buildApp } from './app.ts';

const config = loadConfig();
redactConsole(createRedactor(config));
const db = createPool(config.databaseUrl);
await migrate(db);
await seed(db, { demoMode: config.demoMode });
const resealed = await resealSecrets(db, config);
if (resealed) console.log(`Re-encrypted ${resealed} app secret(s) with the current SECRETS_KEY`);
const queues = createQueues(redisConnection(config.redisUrl), config.queuePrefix);
const push = await createPushSender(db, config);
const { app } = buildApp({ config, db, queues, push });
await app.listen({ host: config.host, port: config.port });
console.log(`DealForge API at http://${config.host}:${config.port} | demo=${config.demoMode}`);

// Ops loop: outage alarms every minute (DF-606), retention purge every hour (DF-607).
let ticks = 0;
const ops = setInterval(async () => {
  try {
    const c = await checkIncidents(db, config, queues, push);
    if (c.opened.length || c.resolved.length) console.log('[incidents]', JSON.stringify(c));
    if (ticks++ % 60 === 0) {
      const purged = await purgeExpired(db);
      if (Object.values(purged).some(Boolean)) console.log('[retention]', JSON.stringify(purged));
    }
  } catch (e) { console.error('[ops]', (e as Error).message); }
}, 60_000);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => { clearInterval(ops); await app.close(); await queues.close(); await db.end(); process.exit(0); });
}
