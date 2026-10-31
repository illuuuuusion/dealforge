import { createHash } from 'node:crypto';
import { scoreListing, matchesWatchlist, classify, detectModel, EVALUATION_VERSION, SOURCES, type Source, type WatchRules } from '@dealforge/domain';
import { WatchlistCreate, WatchlistPatch, ListingStatus, type WatchlistCreateInput, type WatchlistRow } from '@dealforge/contracts';
import { tx, type Db, type Queryable } from './pool.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- database rows and untrusted import payloads
type Row = Record<string, any>;
export interface BudgetLimits { daily: number; monthly: number; perQueryDaily: number }

const seedWatches: WatchlistCreateInput[] = [
  { name: 'RTX 5080', query: 'RTX 5080', maxWorking: 880, maxDefect: 275, expectedResale: 1050, repairBudget: 80, sourceList: ['ebay', 'kleinanzeigen', 'facebook'] },
  { name: 'RTX 4070 Super', query: 'RTX 4070 Super', maxWorking: 470, maxDefect: 125, expectedResale: 550, repairBudget: 60, sourceList: ['ebay', 'kleinanzeigen', 'facebook'] },
  { name: 'RTX 3080', query: 'RTX 3080', maxWorking: 270, maxDefect: 85, expectedResale: 330, repairBudget: 55, sourceList: ['ebay', 'kleinanzeigen', 'facebook'] },
  { name: 'RX 7800 XT', query: 'RX 7800 XT', maxWorking: 350, maxDefect: 220, expectedResale: 420, repairBudget: 50, sourceList: ['ebay', 'kleinanzeigen', 'facebook'] },
];
const minutesAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();
const demoData = () => [
  { source: 'ebay', externalId: 'demo-1', title: 'NVIDIA RTX 5080 16GB – gebraucht, voll funktionsfähig', description: 'Funktioniert einwandfrei.', url: 'https://www.ebay.de/', priceEur: 699, shippingEur: 9.99, condition: 'Gebraucht', publishedAt: minutesAgo(4) },
  { source: 'kleinanzeigen', externalId: 'demo-2', title: 'RTX 4070 Super – Kein Bild, Lüfter drehen', description: 'Unverbastelt, mit Kühler, plötzlich kein Signal.', url: 'https://www.kleinanzeigen.de/', priceEur: 89, shippingEur: 6.99, condition: 'Defekt', publishedAt: minutesAgo(3) },
  { source: 'facebook', externalId: 'demo-3', title: 'RX 7800 XT Sapphire – guter Zustand', description: 'Abholung möglich', url: 'https://www.facebook.com/marketplace/', priceEur: 269, shippingEur: null, condition: 'Gebraucht', publishedAt: minutesAgo(8) },
  { source: 'ebay', externalId: 'demo-4', title: 'RTX 3080 defekt Wasserschaden, Reparaturversuch', description: 'Es wurde bereits versucht sie zu reparieren.', url: 'https://www.ebay.de/', priceEur: 55, shippingEur: 7.49, condition: 'Defekt', publishedAt: minutesAgo(32) },
  { source: 'kleinanzeigen', externalId: 'demo-5', title: 'RTX 4070 Super Gaming PC', description: 'Komplettrechner', url: 'https://www.kleinanzeigen.de/', priceEur: 400, shippingEur: 0, condition: 'Gebraucht', publishedAt: minutesAgo(0) },
];

/** Starter watchlists on an empty database; demo rows only in demo mode, and never left behind outside it. */
export async function seed(db: Db, { demoMode = false } = {}) {
  if (!(await db.query('SELECT 1 FROM watchlists LIMIT 1')).rowCount) for (const w of seedWatches) await createWatchlist(db, w);
  if (demoMode && !(await db.query('SELECT 1 FROM listings LIMIT 1')).rowCount) await ingestListings(db, demoData());
  if (!demoMode) await db.query("DELETE FROM listings WHERE external_id LIKE 'demo-%'");
}

const watchFromRow = (x: Row): WatchlistRow => ({ id: x.id, name: x.name, query: x.query, maxWorking: x.max_working, maxDefect: x.max_defect,
  expectedResale: x.expected_resale, repairBudget: x.repair_budget, sourceList: x.sources, allowUnknownShipping: x.allow_unknown_shipping,
  active: x.active, createdAt: x.created_at });
const rulesFromRow = (r: Row): WatchRules => ({ query: r.query, maxWorking: r.max_working, maxDefect: r.max_defect, expectedResale: r.expected_resale,
  repairBudget: r.repair_budget, allowUnknownShipping: r.allow_unknown_shipping });

export async function watchlists(db: Queryable) {
  return (await db.query('SELECT * FROM watchlists ORDER BY active DESC, id')).rows.map(watchFromRow);
}
export async function createWatchlist(db: Db, input: WatchlistCreateInput | unknown) {
  const w = WatchlistCreate.parse(input);
  const { rows } = await db.query(`INSERT INTO watchlists (name, query, max_working, max_defect, expected_resale, repair_budget, sources, allow_unknown_shipping)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [w.name, w.query, w.maxWorking, w.maxDefect, w.expectedResale, w.repairBudget, w.sourceList, w.allowUnknownShipping]);
  await rematchWatchlist(db, rows[0].id);
  return rows[0].id as number;
}
const patchColumns: Record<string, string> = { name: 'name', query: 'query', maxWorking: 'max_working', maxDefect: 'max_defect', expectedResale: 'expected_resale',
  repairBudget: 'repair_budget', sourceList: 'sources', allowUnknownShipping: 'allow_unknown_shipping', active: 'active' };
export async function updateWatchlist(db: Db, id: number, patch: unknown) {
  const p = WatchlistPatch.parse(patch);
  const entries = Object.entries(p);
  const { rows } = await db.query(`UPDATE watchlists SET ${entries.map(([k], i) => `${patchColumns[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...entries.map(([, v]) => v)]);
  if (!rows.length) return null;
  await rematchWatchlist(db, id);
  return watchFromRow(rows[0]);
}
/** Matches and future alerts go away; listings and their history stay. */
export async function deleteWatchlist(db: Db, id: number) {
  return ((await db.query('DELETE FROM watchlists WHERE id = $1', [id])).rowCount ?? 0) > 0;
}
/** Re-evaluates stored listings after a watchlist was created or its rules changed. */
async function rematchWatchlist(db: Db, id: number) {
  await tx(db, async c => {
    const w = (await c.query('SELECT * FROM watchlists WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!w?.active) return;
    const rules = rulesFromRow(w);
    // ponytail: full scan over the watchlist's sources; restrict to recently seen listings once the table gets large.
    const { rows } = await c.query('SELECT * FROM listings WHERE source = ANY($1)', [w.sources]);
    await c.query('DELETE FROM watchlist_matches WHERE watchlist_id = $1', [id]);
    for (const r of rows) {
      const listing = publicListing(r);
      const assessment = matchesWatchlist(listing, rules) ? scoreListing(listing, rules) : null;
      if (assessment) await c.query('INSERT INTO watchlist_matches (listing_id, watchlist_id, evaluation_version, assessment, matched_at) VALUES ($1, $2, $3, $4, now())',
        [r.id, id, EVALUATION_VERSION, assessment]);
    }
  });
}

const publicListing = (r: Row) => ({ id: r.id as number, source: r.source as Source, externalId: r.external_id as string, title: r.title as string,
  description: r.description, url: r.url as string, imageUrl: r.image_url, priceEur: r.price_eur as number, shippingEur: r.shipping_eur as number | null,
  condition: r.condition, publishedAt: r.published_at, offerType: r.offer_type, auctionEndsAt: r.auction_ends_at, bidCount: r.bid_count,
  firstSeenAt: r.first_seen_at as string, lastSeenAt: r.last_seen_at as string, fetchedAt: r.fetched_at as string, status: r.status as string });

const cents = (v: number) => Math.round(v * 100) / 100;
const isoOrNull = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const hash = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 16);
/** Trust boundary for adapter and import data: anything malformed is dropped, not guessed. */
function validListing(x: Row) {
  if (!x || !(SOURCES as readonly string[]).includes(x.source)) return null;
  if (typeof x.externalId !== 'string' || !x.externalId || x.externalId.length > 200) return null;
  if (typeof x.title !== 'string' || !x.title.trim() || x.title.length > 500) return null;
  const price = Number(x.priceEur);
  if (!Number.isFinite(price) || price < 0 || price > 500000 || (price === 0 && !/zu verschenken|gratis|kostenlos/i.test(x.title))) return null;
  let url: URL; try { url = new URL(x.url); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const shipping = x.shippingEur === null || x.shippingEur === undefined ? null : Number(x.shippingEur);
  return { source: x.source as Source, externalId: x.externalId, title: x.title, description: String(x.description ?? ''), url: url.href,
    imageUrl: typeof x.imageUrl === 'string' ? x.imageUrl : null, priceEur: cents(price),
    shippingEur: shipping !== null && Number.isFinite(shipping) && shipping >= 0 && shipping <= 100000 ? cents(shipping) : null,
    condition: String(x.condition ?? ''), publishedAt: isoOrNull(x.publishedAt),
    offerType: ['AUCTION', 'OTHER'].includes(x.offerType) ? x.offerType as string : 'FIXED_PRICE',
    auctionEndsAt: isoOrNull(x.auctionEndsAt), bidCount: Number.isInteger(x.bidCount) ? x.bidCount as number : null };
}

/**
 * Upserts one provider batch in a single transaction. A replay of an older or identical fetch changes nothing;
 * a snapshot is written only when price, shipping, title or condition differ from the latest snapshot.
 */
export async function ingestListings(db: Db, items: unknown[], { fetchedAt = new Date().toISOString() } = {}) {
  const active = (await watchlists(db)).filter(w => w.active);
  const activeIds = active.map(w => w.id);
  const valid = items.map(x => validListing(x as Row)).filter(x => x !== null)
    // Stable lock order across concurrent batches avoids deadlocks.
    .sort((a, b) => `${a.source}|${a.externalId}`.localeCompare(`${b.source}|${b.externalId}`));
  let inserted = 0, matched = 0, priceChanges = 0;
  await tx(db, async c => {
    for (const item of valid) {
      const up = await c.query(`WITH prior AS (SELECT price_eur FROM listings WHERE source = $1 AND external_id = $2)
        INSERT INTO listings (source, external_id, title, description, url, image_url, price_eur, shipping_eur, condition, offer_type,
          auction_ends_at, bid_count, published_at, first_seen_at, last_seen_at, fetched_at, health, model_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now(), $14, $15, $16)
        ON CONFLICT (source, external_id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, url = EXCLUDED.url,
          image_url = EXCLUDED.image_url, price_eur = EXCLUDED.price_eur, shipping_eur = EXCLUDED.shipping_eur, condition = EXCLUDED.condition,
          offer_type = EXCLUDED.offer_type, auction_ends_at = EXCLUDED.auction_ends_at, bid_count = EXCLUDED.bid_count,
          published_at = COALESCE(EXCLUDED.published_at, listings.published_at), last_seen_at = now(), fetched_at = EXCLUDED.fetched_at,
          health = EXCLUDED.health, model_key = EXCLUDED.model_key
        WHERE listings.fetched_at < EXCLUDED.fetched_at
        RETURNING id, first_seen_at, (xmax = 0) AS inserted, (SELECT price_eur FROM prior) AS prior_price`,
      [item.source, item.externalId, item.title, item.description, item.url, item.imageUrl, item.priceEur, item.shippingEur, item.condition,
        item.offerType, item.auctionEndsAt, item.bidCount, item.publishedAt, fetchedAt, classify(item), detectModel(item)?.model ?? null]);
      if (!up.rowCount) continue;
      const row = up.rows[0];
      if (row.inserted) inserted++;
      const snap = await c.query(`INSERT INTO listing_snapshots (listing_id, observed_at, price_eur, shipping_eur, title_hash, condition_hash)
        SELECT $1, $2::timestamptz, $3::numeric, $4::numeric, $5::text, $6::text
        WHERE NOT EXISTS (SELECT 1 FROM (SELECT * FROM listing_snapshots WHERE listing_id = $1 ORDER BY observed_at DESC, id DESC LIMIT 1) s
          WHERE s.price_eur = $3::numeric AND s.shipping_eur IS NOT DISTINCT FROM $4::numeric
            AND s.title_hash IS NOT DISTINCT FROM $5::text AND s.condition_hash IS NOT DISTINCT FROM $6::text)`,
      [row.id, fetchedAt, item.priceEur, item.shippingEur, hash(item.title), hash(item.condition)]);
      if (snap.rowCount && !row.inserted && row.prior_price !== item.priceEur) priceChanges++;
      // Re-evaluate every active watchlist: an updated listing that no longer fits loses its old match.
      const listing = { ...item, firstSeenAt: row.first_seen_at };
      const keep: number[] = [];
      for (const w of active) {
        const assessment = w.sourceList.includes(item.source) && matchesWatchlist(listing, w) ? scoreListing(listing, w) : null;
        if (!assessment) continue;
        await c.query(`INSERT INTO watchlist_matches (listing_id, watchlist_id, evaluation_version, assessment, matched_at) VALUES ($1, $2, $3, $4, now())
          ON CONFLICT (listing_id, watchlist_id) DO UPDATE SET assessment = EXCLUDED.assessment, evaluation_version = EXCLUDED.evaluation_version`,
        [row.id, w.id, EVALUATION_VERSION, assessment]);
        keep.push(w.id); matched++;
      }
      await c.query('DELETE FROM watchlist_matches WHERE listing_id = $1 AND watchlist_id = ANY($2::int[]) AND NOT (watchlist_id = ANY($3::int[]))', [row.id, activeIds, keep]);
    }
  });
  return { fetched: items.length, inserted, matched, priceChanges };
}

const feedSql = `SELECT l.*, w.name AS watchlist_name, w.id AS watchlist_id, w.query, w.max_working, w.max_defect, w.expected_resale, w.repair_budget, w.allow_unknown_shipping
  FROM watchlist_matches m JOIN listings l ON l.id = m.listing_id JOIN watchlists w ON w.id = m.watchlist_id`;
export async function listDeals(db: Queryable, { mode = 'all', source = 'all', watchlistId = null as number | null, limit = 100 } = {}) {
  const { rows } = await db.query(`${feedSql} WHERE w.active AND ($1 = 'all' OR l.source = $1) AND ($2::int IS NULL OR w.id = $2)
    ORDER BY l.first_seen_at DESC LIMIT 500`, [source, watchlistId]);
  // Scores are recomputed on read: freshness and auction end times depend on the current time.
  return rows.map(r => ({ ...publicListing(r), assessment: scoreListing(publicListing(r), rulesFromRow(r)), watchlistName: r.watchlist_name as string, watchlistId: r.watchlist_id as number }))
    .filter((r): r is typeof r & { assessment: NonNullable<typeof r.assessment> } => r.assessment !== null)
    .filter(r => mode === 'all' || (mode === 'schnapper' && r.assessment.alerts.includes('SCHNAPPER')) || (mode === 'deal' && r.assessment.alerts.includes('DEAL'))
      || (mode === 'repair' && ['defect', 'unknown'].includes(r.assessment.health)))
    .sort((a, b) => b.assessment.priority - a.assessment.priority || b.firstSeenAt.localeCompare(a.firstSeenAt)).slice(0, limit);
}
export async function getListing(db: Queryable, id: number) {
  const listing = (await db.query('SELECT * FROM listings WHERE id = $1', [id])).rows[0];
  if (!listing) return null;
  const snapshots = (await db.query('SELECT observed_at, price_eur, shipping_eur FROM listing_snapshots WHERE listing_id = $1 ORDER BY observed_at, id', [id])).rows
    .map(s => ({ observedAt: s.observed_at as string, priceEur: s.price_eur as number, shippingEur: s.shipping_eur as number | null }));
  const matches = (await db.query(`${feedSql} WHERE l.id = $1 ORDER BY w.id`, [id])).rows
    .map(r => ({ watchlistId: r.watchlist_id as number, watchlistName: r.watchlist_name as string, assessment: scoreListing(publicListing(r), rulesFromRow(r)) }))
    .filter(m => m.assessment !== null);
  return { ...publicListing(listing), snapshots, matches };
}
export async function setListingStatus(db: Queryable, id: number, status: unknown) {
  return ((await db.query('UPDATE listings SET status = $2 WHERE id = $1', [id, ListingStatus.parse(status)])).rowCount ?? 0) > 0;
}
export async function listStats(db: Queryable) {
  const r = (await db.query("SELECT count(*) AS total, count(*) FILTER (WHERE status = 'saved') AS saved FROM listings")).rows[0];
  const repair = (await db.query("SELECT count(DISTINCT listing_id) AS n FROM watchlist_matches WHERE assessment->>'health' IN ('defect', 'unknown')")).rows[0];
  return { total: r.total as number, saved: r.saved as number, repairCandidates: repair.n as number };
}

export interface SourceRun { source: string; queryKey: string | null; startedAt: string; status: 'ok' | 'error' | 'skipped';
  httpStatus?: number | null; fetched?: number; inserted?: number; errorCode?: string | null; message?: string | null }
export async function logSourceRun(db: Queryable, r: SourceRun) {
  await db.query(`INSERT INTO source_runs (source, query_key, started_at, finished_at, status, http_status, fetched, inserted, error_code, message)
    VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9)`,
  [r.source, r.queryKey, r.startedAt, r.status, r.httpStatus ?? null, r.fetched ?? 0, r.inserted ?? 0, r.errorCode ?? null, r.message ? String(r.message).slice(0, 200) : null]);
}

const days = (now: Date) => { const day = now.toISOString().slice(0, 10); return { day, monthStart: `${day.slice(0, 7)}-01` }; };
export async function providerUsage(db: Queryable, provider: string, now = new Date(), queryKey = '') {
  const { day, monthStart } = days(now);
  const { rows: [u] } = await db.query(`SELECT coalesce(sum(calls) FILTER (WHERE day = $2::date), 0) AS today, coalesce(sum(calls), 0) AS month,
      coalesce(sum(calls) FILTER (WHERE day = $2::date AND query_key = $4), 0) AS query
    FROM provider_usage WHERE provider = $1 AND day >= $3::date`, [provider, day, monthStart, queryKey]);
  return { today: u.today as number, month: u.month as number, query: u.query as number };
}
export async function budgetExhausted(db: Queryable, provider: string, limits: BudgetLimits, now = new Date(), queryKey?: string) {
  const u = await providerUsage(db, provider, now, queryKey);
  if (u.today >= limits.daily) return 'Tagesbudget erreicht';
  if (u.month >= limits.monthly) return 'Monatsbudget erreicht';
  if (queryKey && u.query >= limits.perQueryDaily) return 'Tagesbudget für diesen Suchfilter erreicht';
  return null;
}
/**
 * Hard budget gate: atomically books one provider call or returns why not. Runs before every request,
 * serialized per provider, so parallel workers can never overshoot a limit.
 */
export async function reserveProviderCall(db: Db, provider: string, queryKey: string, limits: BudgetLimits, now = new Date()) {
  return tx(db, async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`budget:${provider}`]);
    const reason = await budgetExhausted(c, provider, limits, now, queryKey);
    if (reason) return reason;
    await c.query(`INSERT INTO provider_usage (provider, query_key, day, calls) VALUES ($1, $2, $3::date, 1)
      ON CONFLICT (provider, day, query_key) DO UPDATE SET calls = provider_usage.calls + 1`, [provider, queryKey, days(now).day]);
    return null;
  });
}

export async function disabledProviders(db: Queryable) {
  return new Set((await db.query('SELECT source FROM provider_flags WHERE NOT enabled')).rows.map(r => r.source as string));
}
export async function setProviderEnabled(db: Queryable, source: string, enabled: boolean) {
  await db.query(`INSERT INTO provider_flags (source, enabled) VALUES ($1, $2) ON CONFLICT (source) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`, [source, enabled]);
}

/** Inputs for the system status: last poll, error rate (24 h, skipped runs excluded) and latest error. */
export async function providerRunStats(db: Queryable, source: string) {
  const s = (await db.query(`SELECT max(started_at) AS last_run_at, max(started_at) FILTER (WHERE status = 'ok') AS last_success_at,
      count(*) FILTER (WHERE started_at > now() - interval '24 hours' AND status <> 'skipped') AS runs24h,
      count(*) FILTER (WHERE started_at > now() - interval '24 hours' AND status = 'error') AS errors24h
    FROM source_runs WHERE source = $1`, [source])).rows[0];
  const lastError = (await db.query("SELECT started_at, error_code, message FROM source_runs WHERE source = $1 AND status = 'error' ORDER BY started_at DESC, id DESC LIMIT 1", [source])).rows[0];
  const recent = (await db.query("SELECT status FROM source_runs WHERE source = $1 AND status <> 'skipped' ORDER BY started_at DESC, id DESC LIMIT 3", [source])).rows.map(r => r.status as string);
  return { lastRunAt: s.last_run_at as string | null, lastSuccessAt: s.last_success_at as string | null, runs24h: s.runs24h as number, errors24h: s.errors24h as number,
    lastError: lastError ? { at: lastError.started_at as string, code: lastError.error_code as string | null, message: lastError.message as string | null } : null,
    recentStatuses: recent };
}
