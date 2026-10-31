/** One-time import of the SQLite prototype database, verified by counts, sums and content hashes on both sides. */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { classify, detectModel } from '@dealforge/domain';
import { tx, type Db, type Queryable } from './pool.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- legacy rows
type Row = Record<string, any>;
const tables = ['watchlists', 'listings', 'listing_snapshots', 'watchlist_matches', 'source_runs', 'provider_usage', 'provider_flags'];
const digest = (rows: unknown[][]) => createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
const sum = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;

function summarize(w: Row[], l: Row[], matches: number, prices: number[], runs: number) {
  return {
    watchlists: { count: w.length, idSum: sum(w.map(x => x.id)), hash: digest(w.map(x => [x.id, x.name, x.query, x.max_working, x.max_defect, x.expected_resale, x.repair_budget, x.sources, x.active])) },
    listings: { count: l.length, idSum: sum(l.map(x => x.id)), hash: digest(l.map(x => [x.id, x.source, x.external_id, x.price_eur, x.status])) },
    matches: { count: matches },
    priceHistory: { count: prices.length, priceSum: sum(prices) },
    sourceRuns: { count: runs },
  };
}
async function summarizePg(db: Queryable) {
  const q = async (sql: string) => (await db.query(sql)).rows;
  return summarize(
    await q('SELECT id, name, query, max_working, max_defect, expected_resale, repair_budget, sources, active FROM watchlists ORDER BY id'),
    await q('SELECT id, source, external_id, price_eur, status FROM listings ORDER BY id'),
    (await q('SELECT count(*) AS n FROM watchlist_matches'))[0].n,
    (await q('SELECT price_eur FROM listing_snapshots ORDER BY id')).map(r => r.price_eur),
    (await q('SELECT count(*) AS n FROM source_runs'))[0].n);
}

export async function importSqlite(db: Db, path: string, { replace = false } = {}) {
  const lite = new DatabaseSync(path, { readOnly: true });
  try {
    const all = (sql: string) => lite.prepare(sql).all() as Row[];
    const W: Row[] = all('SELECT * FROM watchlists ORDER BY id').map(w => ({ ...w, sources: JSON.parse(w.sources), active: !!w.active, allow_unknown_shipping: !!w.allow_unknown_shipping }));
    const L = all('SELECT * FROM listings ORDER BY id');
    const M = all('SELECT * FROM matches');
    const H = all('SELECT * FROM price_history ORDER BY id');
    const R = all('SELECT * FROM source_runs ORDER BY id');
    const before = summarize(W, L, M.length, H.map(h => h.price_eur), R.length);

    await tx(db, async c => {
      const existing = (await c.query('SELECT (SELECT count(*) FROM watchlists) + (SELECT count(*) FROM listings) AS n')).rows[0].n;
      if (existing && !replace) throw Error('Zieldatenbank ist nicht leer (z. B. Startprofile). Mit --replace wird sie vor dem Import geleert.');
      if (replace) await c.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
      for (const w of W) {
        await c.query(`INSERT INTO watchlists (id, name, query, max_working, max_defect, expected_resale, repair_budget, sources, allow_unknown_shipping, active, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [w.id, w.name, w.query, w.max_working, w.max_defect, w.expected_resale, w.repair_budget, w.sources, w.allow_unknown_shipping, w.active, w.created_at]);
      }
      for (const l of L) {
        // Legacy rows have no fetch time; last_seen_at is the closest known value.
        await c.query(`INSERT INTO listings (id, source, external_id, title, description, url, image_url, price_eur, shipping_eur, condition, offer_type,
            auction_ends_at, bid_count, published_at, first_seen_at, last_seen_at, fetched_at, health, model_key, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16, $17, $18, $19)`,
        [l.id, l.source, l.external_id, l.title, l.description, l.url, l.image_url, l.price_eur, l.shipping_eur, l.condition, l.offer_type ?? 'FIXED_PRICE',
          l.auction_ends_at ?? null, l.bid_count ?? null, l.published_at, l.first_seen_at, l.last_seen_at,
          classify({ title: l.title, description: l.description, condition: l.condition }), detectModel({ title: l.title, description: l.description })?.model ?? null, l.status]);
      }
      // evaluation_version 0 marks assessments computed by the prototype.
      for (const m of M) await c.query('INSERT INTO watchlist_matches (listing_id, watchlist_id, evaluation_version, assessment, matched_at) VALUES ($1, $2, 0, $3, $4)',
        [m.listing_id, m.watchlist_id, m.assessment, m.updated_at]);
      for (const h of H) await c.query('INSERT INTO listing_snapshots (listing_id, observed_at, price_eur) VALUES ($1, $2, $3)', [h.listing_id, h.observed_at, h.price_eur]);
      for (const r of R) await c.query(`INSERT INTO source_runs (id, source, started_at, finished_at, status, fetched, inserted, message) VALUES ($1, $2, $3, $3, $4, $5, $6, $7)`,
        [r.id, r.source, r.happened_at, r.ok ? 'ok' : 'error', r.fetched, r.inserted, r.message]);
      // Legacy calls keep counting against today's and this month's budget.
      for (const [key, rows] of Map.groupBy(R, r => `${r.source}|${String(r.happened_at).slice(0, 10)}`)) {
        const [source, day] = key.split('|');
        await c.query("INSERT INTO provider_usage (provider, query_key, day, calls) VALUES ($1, 'legacy', $2, $3)", [source, day, rows.length]);
      }
      for (const t of ['watchlists', 'listings', 'source_runs']) await c.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), coalesce(max(id), 0) + 1, false) FROM ${t}`);
    });
    const after = await summarizePg(db);
    return { ok: JSON.stringify(before) === JSON.stringify(after), before, after };
  } finally { lite.close(); }
}
