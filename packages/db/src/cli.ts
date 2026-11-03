/** pnpm db migrate [--dry-run] | pnpm db import-sqlite <path> [--replace] */
import { createPool, migrate, DEFAULT_DATABASE_URL } from './pool.ts';
import { importSqlite } from './import-sqlite.ts';

const [command, ...args] = process.argv.slice(2);
const db = createPool(process.env.DATABASE_URL || DEFAULT_DATABASE_URL);
try {
  if (command === 'migrate' && args.includes('--dry-run')) console.log('Dry run, rolled back. Pending:', await migrate(db, { dryRun: true }));
  else if (command === 'migrate') console.log('Applied:', await migrate(db));
  else if (command === 'import-sqlite' && args[0]) {
    await migrate(db);
    const report = await importSqlite(db, args[0], { replace: args.includes('--replace') });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) { console.error('Vergleich vorher/nachher stimmt nicht überein.'); process.exitCode = 1; }
  } else throw Error('Usage: cli.js migrate [--dry-run] | cli.js import-sqlite <path> [--replace]');
} catch (e) { console.error((e as Error).message); process.exitCode = 1; } finally { await db.end(); }
