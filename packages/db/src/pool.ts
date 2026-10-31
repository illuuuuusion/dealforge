import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

// numeric -> number, bigint counts -> number, timestamptz -> ISO string, date -> 'YYYY-MM-DD': domain code stays unchanged.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);
pg.types.setTypeParser(pg.types.builtins.INT8, Number);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, v => new Date(v).toISOString());
pg.types.setTypeParser(pg.types.builtins.DATE, v => v);

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;
export const DEFAULT_DATABASE_URL = 'postgres://dealforge:dealforge@127.0.0.1:55432/dealforge';

export const createPool = (url: string, { schema }: { schema?: string } = {}) =>
  new pg.Pool({ connectionString: url, max: 10, ...(schema ? { options: `-c search_path=${schema}` } : {}) });

export async function tx<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

const MIGRATION_LOCK = 7346001;
/** Applies migrations/NNN_*.sql in order, each in its own transaction; safe to run from API and worker at once. */
export async function migrate(db: Db) {
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
    const dir = new URL('../migrations/', import.meta.url);
    const applied: string[] = [];
    for (const file of fs.readdirSync(dir).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(new URL(file, dir), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (e) { await client.query('ROLLBACK'); throw e; }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

/** Fresh migrated schema per test file, dropped again by close(). */
export async function createTestDb(url = process.env.DATABASE_URL || DEFAULT_DATABASE_URL) {
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = createPool(url, { schema });
  await migrate(db);
  return { db, schema, async close() { await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } };
}
