import { createHash } from 'node:crypto';
import { scoreListing, matchesWatchlist, classify, detectModel, repairAssessment, repairScenarios, repairActual, repairStats as statsOf, EVALUATION_VERSION, SOURCES,
  marketStats, weeklyHistory, MARKET_METHOD, MARKET_NOTE, MIN_WEEK_SAMPLE,
  type Source, type WatchRules, type RepairSettings, type Fault, type RepairOutcome, type RankingContext, type RankingWeights } from '@dealforge/domain';
import { WatchlistCreate, WatchlistPatch, ListingStatus, RepairSettings as RepairSettingsSchema, RepairProjectPatch, RankingSettings, FeedbackCreate, type WatchlistCreateInput, type WatchlistRow } from '@dealforge/contracts';
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
  fast: x.fast, active: x.active, createdAt: x.created_at });
const rulesFromRow = (r: Row): WatchRules => ({ query: r.query, maxWorking: r.max_working, maxDefect: r.max_defect, expectedResale: r.expected_resale,
  repairBudget: r.repair_budget, allowUnknownShipping: r.allow_unknown_shipping });

export async function watchlists(db: Queryable) {
  return (await db.query('SELECT * FROM watchlists ORDER BY active DESC, id')).rows.map(watchFromRow);
}
export async function createWatchlist(db: Db, input: WatchlistCreateInput | unknown) {
  const w = WatchlistCreate.parse(input);
  const { rows } = await db.query(`INSERT INTO watchlists (name, query, max_working, max_defect, expected_resale, repair_budget, sources, allow_unknown_shipping, fast)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`, [w.name, w.query, w.maxWorking, w.maxDefect, w.expectedResale, w.repairBudget, w.sourceList, w.allowUnknownShipping, w.fast]);
  await rematchWatchlist(db, rows[0].id);
  return rows[0].id as number;
}
const patchColumns: Record<string, string> = { name: 'name', query: 'query', maxWorking: 'max_working', maxDefect: 'max_defect', expectedResale: 'expected_resale',
  repairBudget: 'repair_budget', sourceList: 'sources', allowUnknownShipping: 'allow_unknown_shipping', fast: 'fast', active: 'active' };
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
  const alertIds: number[] = [];
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
        const events: [string, string, string[]][] = assessment.alerts.map(kind => [kind, `${row.id}:${w.id}:${kind}`, assessment.reasons]);
        // A drop of at least 5 % that ends within the purchase limit; each new price level alerts once.
        const prior = row.prior_price as number | null;
        if (prior !== null && item.priceEur <= prior * 0.95 && (assessment.discountPct ?? -1) >= 0) {
          events.push(['PRICE_DROP', `${row.id}:${w.id}:PRICE_DROP:${item.priceEur}`, [`−${cents(prior - item.priceEur)} € (von ${prior} € auf ${item.priceEur} €)`, ...assessment.reasons]]);
        }
        for (const [kind, key, reasons] of events) {
          const a = await c.query(`INSERT INTO alerts (listing_id, watchlist_id, kind, dedupe_key, priority, reasons, fetched_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, [row.id, w.id, kind, key, assessment.priority, JSON.stringify(reasons.slice(0, 3)), fetchedAt]);
          alertIds.push(...a.rows.map(r => r.id as number));
        }
      }
      await c.query('DELETE FROM watchlist_matches WHERE listing_id = $1 AND watchlist_id = ANY($2::int[]) AND NOT (watchlist_id = ANY($3::int[]))', [row.id, activeIds, keep]);
    }
  });
  return { fetched: items.length, inserted, matched, priceChanges, alerts: alertIds.length, alertIds };
}

const feedSql = `SELECT l.*, w.name AS watchlist_name, w.id AS watchlist_id, w.query, w.max_working, w.max_defect, w.expected_resale, w.repair_budget, w.allow_unknown_shipping
  FROM watchlist_matches m JOIN listings l ON l.id = m.listing_id JOIN watchlists w ON w.id = m.watchlist_id`;
export async function listDeals(db: Queryable, { mode = 'all', source = 'all', watchlistId = null as number | null, limit = 100 } = {}) {
  const { rows } = await db.query(`${feedSql} WHERE w.active AND ($1 = 'all' OR l.source = $1) AND ($2::int IS NULL OR w.id = $2)
      AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.listing_id = l.id)
    ORDER BY l.first_seen_at DESC LIMIT 500`, [source, watchlistId]);
  const context = await rankingContext(db);
  const now = new Date();
  // Scores are recomputed on read: freshness and auction end times depend on the current time.
  return rows.map(r => ({ ...publicListing(r), assessment: scoreListing(publicListing(r), rulesFromRow(r), now, context(r)), watchlistName: r.watchlist_name as string, watchlistId: r.watchlist_id as number }))
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
  const context = await rankingContext(db);
  const matches = (await db.query(`${feedSql} WHERE l.id = $1 ORDER BY w.id`, [id])).rows
    .map(r => ({ watchlistId: r.watchlist_id as number, watchlistName: r.watchlist_name as string, assessment: scoreListing(publicListing(r), rulesFromRow(r), new Date(), context(r)) }))
    .filter(m => m.assessment !== null);
  return { ...publicListing(listing), snapshots, matches };
}
export async function setListingStatus(db: Queryable, id: number, status: unknown) {
  return ((await db.query('UPDATE listings SET status = $2 WHERE id = $1', [id, ListingStatus.parse(status)])).rowCount ?? 0) > 0;
}
export async function listStats(db: Queryable) {
  const r = (await db.query("SELECT count(*) AS total, count(*) FILTER (WHERE status = 'saved') AS saved FROM listings")).rows[0];
  const repair = (await db.query("SELECT count(DISTINCT listing_id) AS n FROM watchlist_matches WHERE assessment->>'health' IN ('defect', 'unknown')")).rows[0];
  const alerts = (await db.query("SELECT count(*) AS n FROM alerts WHERE created_at >= date_trunc('day', now())")).rows[0];
  return { total: r.total as number, saved: r.saved as number, repairCandidates: repair.n as number, alertsToday: alerts.n as number };
}

// createdAt minus publishedAt/firstSeenAt is the pipeline latency of an alert (DF-308).
const alertSql = `SELECT a.id, a.kind, a.priority, a.reasons, a.created_at, a.listing_id, a.watchlist_id, coalesce(a.fetched_at, l.fetched_at) AS batch_fetched_at,
    w.name AS watchlist_name, l.source, l.title, l.url, l.price_eur, l.shipping_eur, l.published_at, l.first_seen_at, d.*
  FROM alerts a JOIN listings l ON l.id = a.listing_id LEFT JOIN watchlists w ON w.id = a.watchlist_id
  LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE status = 'sent') AS push_sent, count(*) FILTER (WHERE shown_at IS NOT NULL) AS push_shown,
    count(*) FILTER (WHERE status IN ('failed', 'gone')) AS push_failed FROM alert_deliveries WHERE alert_id = a.id) d ON true`;
const alertFromRow = (r: Row) => ({ id: r.id as number, kind: r.kind as string, priority: r.priority as number, reasons: r.reasons as string[],
  createdAt: r.created_at as string, listingId: r.listing_id as number, watchlistId: r.watchlist_id as number | null, watchlistName: r.watchlist_name as string | null,
  source: r.source as Source, title: r.title as string, url: r.url as string, priceEur: r.price_eur as number, shippingEur: r.shipping_eur as number | null,
  publishedAt: r.published_at as string | null, firstSeenAt: r.first_seen_at as string, fetchedAt: r.batch_fetched_at as string,
  push: { sent: r.push_sent as number, shown: r.push_shown as number, failed: r.push_failed as number } });
export async function getAlert(db: Queryable, id: number) {
  const r = (await db.query(`${alertSql} WHERE a.id = $1`, [id])).rows[0];
  return r ? alertFromRow(r) : null;
}
export async function recentAlerts(db: Queryable, limit = 50) {
  return (await db.query(`${alertSql} ORDER BY a.id DESC LIMIT $1`, [limit])).rows.map(alertFromRow);
}
/** Oldest first: what a live client has not seen yet. */
export async function alertsAfter(db: Queryable, afterId: number, limit = 50) {
  return (await db.query(`${alertSql} WHERE a.id > $1 ORDER BY a.id LIMIT $2`, [afterId, limit])).rows.map(alertFromRow);
}
export async function latestAlertId(db: Queryable) {
  return (await db.query('SELECT coalesce(max(id), 0) AS id FROM alerts')).rows[0].id as number;
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

export interface PushSubscriptionInput { endpoint: string; keys: { p256dh: string; auth: string } }
export async function savePushSubscription(db: Queryable, s: PushSubscriptionInput, userAgent: string | null) {
  const { rows } = await db.query(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4)
    ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent RETURNING id`,
  [s.endpoint, s.keys.p256dh, s.keys.auth, userAgent?.slice(0, 200) ?? null]);
  return rows[0].id as number;
}
/** With keys, for sending; the API only ever returns the push service host. */
export async function pushSubscriptions(db: Queryable) {
  return (await db.query('SELECT * FROM push_subscriptions ORDER BY id')).rows.map(r => ({ id: r.id as number, endpoint: r.endpoint as string,
    keys: { p256dh: r.p256dh as string, auth: r.auth as string }, userAgent: r.user_agent as string | null, createdAt: r.created_at as string,
    lastSuccessAt: r.last_success_at as string | null }));
}
export async function deletePushSubscription(db: Queryable, id: number) {
  return ((await db.query('DELETE FROM push_subscriptions WHERE id = $1', [id])).rowCount ?? 0) > 0;
}

/** Idempotent per alert and subscription: a retried job gets the existing delivery back and skips what was already sent. */
export async function startDelivery(db: Queryable, alertId: number | null, subscriptionId: number) {
  const { rows: [d] } = await db.query(`INSERT INTO alert_deliveries (alert_id, subscription_id, status) VALUES ($1, $2, 'pending')
    ON CONFLICT (alert_id, subscription_id) DO UPDATE SET status = alert_deliveries.status RETURNING id, status`, [alertId, subscriptionId]);
  return { id: d.id as number, status: d.status as string };
}
export async function finishDelivery(db: Queryable, id: number, r: { status: 'sent' | 'failed' | 'gone'; httpStatus?: number | null; error?: string | null }) {
  const { rows: [d] } = await db.query(`UPDATE alert_deliveries SET status = $2, http_status = $3, error = $4, sent_at = CASE WHEN $2 = 'sent' THEN now() END
    WHERE id = $1 RETURNING subscription_id`, [id, r.status, r.httpStatus ?? null, r.error?.slice(0, 200) ?? null]);
  if (r.status === 'sent') await db.query('UPDATE push_subscriptions SET last_success_at = now() WHERE id = $1', [d.subscription_id]);
  // 404/410: the browser dropped the subscription; never send to it again.
  if (r.status === 'gone') await db.query('DELETE FROM push_subscriptions WHERE id = $1', [d.subscription_id]);
}
/** Receipt from the service worker: the notification was actually displayed. */
export async function markDeliveryShown(db: Queryable, id: number) {
  return ((await db.query('UPDATE alert_deliveries SET shown_at = coalesce(shown_at, now()) WHERE id = $1', [id])).rowCount ?? 0) > 0;
}
export async function recentDeliveries(db: Queryable, limit = 10) {
  return (await db.query('SELECT * FROM alert_deliveries ORDER BY id DESC LIMIT $1', [limit])).rows.map(r => ({ id: r.id as number,
    alertId: r.alert_id as number | null, subscriptionId: r.subscription_id as number | null, status: r.status as string, httpStatus: r.http_status as number | null,
    error: r.error as string | null, createdAt: r.created_at as string, sentAt: r.sent_at as string | null, shownAt: r.shown_at as string | null }));
}

/**
 * DF-308: p50/p95 in seconds per source and stage over the last days. Discovery only counts listings published after
 * the source's first successful run, so the initial backfill of old listings does not distort it.
 */
export async function alertLatency(db: Queryable, days = 7) {
  const { rows } = await db.query(`WITH x AS (
      SELECT a.id AS alert_id, l.source, a.kind,
        extract(epoch FROM l.first_seen_at - l.published_at) AS discovery,
        extract(epoch FROM a.created_at - a.fetched_at) AS ingest,
        extract(epoch FROM d.sent_at - a.created_at) AS push,
        extract(epoch FROM d.shown_at - a.created_at) AS shown,
        l.published_at > (SELECT min(started_at) FROM source_runs r WHERE r.source = l.source AND r.status = 'ok') AS live_published
      FROM alerts a JOIN listings l ON l.id = a.listing_id LEFT JOIN alert_deliveries d ON d.alert_id = a.id
      WHERE a.created_at > now() - make_interval(days => $1))
    SELECT source, count(DISTINCT alert_id) AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY discovery) FILTER (WHERE live_published AND kind <> 'PRICE_DROP') AS discovery_p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY discovery) FILTER (WHERE live_published AND kind <> 'PRICE_DROP') AS discovery_p95,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY ingest) AS ingest_p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY ingest) AS ingest_p95,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY push) AS push_p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY push) AS push_p95,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY shown) AS shown_p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY shown) AS shown_p95
    FROM x GROUP BY source ORDER BY source`, [days]);
  const sec = (v: unknown) => v === null ? null : Math.round(Number(v) * 10) / 10;
  const pair = (r: Row, k: string) => ({ p50: sec(r[`${k}_p50`]), p95: sec(r[`${k}_p95`]) });
  return rows.map(r => ({ source: r.source as Source, samples: r.n as number,
    discovery: pair(r, 'discovery'), ingest: pair(r, 'ingest'), push: pair(r, 'push'), shown: pair(r, 'shown') }));
}

export async function repairSettings(db: Queryable): Promise<RepairSettings> {
  const s = (await db.query('SELECT * FROM repair_settings')).rows[0];
  const costs = (await db.query('SELECT * FROM repair_costs ORDER BY fault, model')).rows.map(r => ({ fault: r.fault as Fault, model: r.model as string,
    partsMin: r.parts_min as number, partsMax: r.parts_max as number, hoursMin: r.hours_min as number, hoursMax: r.hours_max as number }));
  return { hourlyRateEur: s.hourly_rate, saleFeePct: s.sale_fee_pct, resaleShippingEur: s.resale_shipping, costs };
}
/** Replaces all assumptions at once: what the form shows is exactly what is stored. */
export async function saveRepairSettings(db: Db, input: unknown) {
  const s = RepairSettingsSchema.parse(input);
  await tx(db, async c => {
    await c.query('UPDATE repair_settings SET hourly_rate = $1, sale_fee_pct = $2, resale_shipping = $3', [s.hourlyRateEur, s.saleFeePct, s.resaleShippingEur]);
    await c.query('DELETE FROM repair_costs');
    for (const r of s.costs) await c.query('INSERT INTO repair_costs (fault, model, parts_min, parts_max, hours_min, hours_max) VALUES ($1, $2, $3, $4, $5, $6)',
      [r.fault, r.model, r.partsMin, r.partsMax, r.hoursMin, r.hoursMax]);
  });
  return repairSettings(db);
}

const projectFromRow = (r: Row, s: RepairSettings) => {
  const p = { id: r.id as number, listingId: r.listing_id as number | null, url: r.url as string | null, title: r.title as string, model: r.model as string | null,
    faults: r.faults as Fault[], status: r.status as string, outcome: r.outcome as RepairOutcome, purchasePriceEur: r.purchase_price as number,
    purchaseShippingEur: r.purchase_shipping as number | null, purchasedAt: r.purchased_at as string | null, parts: r.parts as { name: string; costEur: number }[],
    hoursSpent: r.hours_spent as number, resaleEstimateEur: r.resale_estimate as number | null, salvageEstimateEur: r.salvage_estimate as number,
    soldPriceEur: r.sold_price as number | null, soldFeesEur: r.sold_fees as number | null, soldShippingEur: r.sold_shipping as number | null,
    soldAt: r.sold_at as string | null, notes: r.notes as string, createdAt: r.created_at as string, updatedAt: r.updated_at as string };
  return { ...p,
    plan: repairScenarios({ purchaseEur: p.purchasePriceEur, shippingEur: p.purchaseShippingEur, faults: p.faults, model: p.model,
      resaleEur: p.resaleEstimateEur, salvageEur: p.salvageEstimateEur }, s),
    actual: repairActual({ purchaseEur: p.purchasePriceEur, shippingEur: p.purchaseShippingEur, partsEur: p.parts.map(x => x.costEur), hours: p.hoursSpent,
      soldEur: p.soldPriceEur, soldFeesEur: p.soldFeesEur, soldShippingEur: p.soldShippingEur, closed: ['sold', 'abandoned'].includes(p.status) }, s.hourlyRateEur) };
};
export async function repairProjects(db: Queryable) {
  const s = await repairSettings(db);
  return (await db.query('SELECT * FROM repair_projects ORDER BY created_at DESC, id DESC')).rows.map(r => projectFromRow(r, s));
}
export async function getRepairProject(db: Queryable, id: number) {
  const r = (await db.query('SELECT * FROM repair_projects WHERE id = $1', [id])).rows[0];
  return r ? projectFromRow(r, await repairSettings(db)) : null;
}
/**
 * Turns a listing into a repair case, prefilled with its price, shipping, detected faults and the resale estimate
 * of a matching watchlist. Idempotent: a second call returns the existing project.
 */
export async function createRepairProject(db: Queryable, listingId: number) {
  const l = (await db.query('SELECT * FROM listings WHERE id = $1', [listingId])).rows[0];
  if (!l) return null;
  const resale = (await db.query(`SELECT w.expected_resale FROM watchlist_matches m JOIN watchlists w ON w.id = m.watchlist_id
    WHERE m.listing_id = $1 AND w.expected_resale IS NOT NULL ORDER BY w.id LIMIT 1`, [listingId])).rows[0]?.expected_resale ?? null;
  const ins = await db.query(`INSERT INTO repair_projects (listing_id, title, url, model, faults, purchase_price, purchase_shipping, resale_estimate)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (listing_id) DO NOTHING RETURNING id`,
  [l.id, l.title, l.url, l.model_key, repairAssessment(l).faults, l.price_eur, l.shipping_eur, resale]);
  if (ins.rowCount) return { id: ins.rows[0].id as number, created: true };
  return { id: (await db.query('SELECT id FROM repair_projects WHERE listing_id = $1', [listingId])).rows[0].id as number, created: false };
}
const projectColumns: Record<string, string> = { title: 'title', model: 'model', faults: 'faults', status: 'status', outcome: 'outcome',
  purchasePriceEur: 'purchase_price', purchaseShippingEur: 'purchase_shipping', purchasedAt: 'purchased_at', parts: 'parts', hoursSpent: 'hours_spent',
  resaleEstimateEur: 'resale_estimate', salvageEstimateEur: 'salvage_estimate', soldPriceEur: 'sold_price', soldFeesEur: 'sold_fees',
  soldShippingEur: 'sold_shipping', soldAt: 'sold_at', notes: 'notes' };
export async function updateRepairProject(db: Queryable, id: number, patch: unknown) {
  const entries = Object.entries(RepairProjectPatch.parse(patch));
  const { rowCount } = await db.query(`UPDATE repair_projects SET ${entries.map(([k], i) => `${projectColumns[k]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
    [id, ...entries.map(([k, v]) => k === 'parts' ? JSON.stringify(v) : v)]);
  return rowCount ? getRepairProject(db, id) : null;
}
export async function deleteRepairProject(db: Queryable, id: number) {
  return ((await db.query('DELETE FROM repair_projects WHERE id = $1', [id])).rowCount ?? 0) > 0;
}
/** DF-407: only finished projects count; rates appear from MIN_REPAIR_SAMPLE projects on. */
export async function repairStats(db: Queryable) {
  return statsOf((await repairProjects(db)).map(p => ({ faults: p.faults, outcome: p.outcome, marginEur: p.actual?.marginEur ?? null })));
}

export async function rankingSettings(db: Queryable) {
  const r = (await db.query('SELECT * FROM ranking_settings')).rows[0];
  const weights: RankingWeights = { freshness: r.freshness, price: r.price, repair: r.repair, market: r.market, personal: r.personal };
  return { weights, marketMinSample: r.market_min_sample as number };
}
export async function saveRankingSettings(db: Queryable, input: unknown) {
  const { weights: w, marketMinSample } = RankingSettings.parse(input);
  await db.query('UPDATE ranking_settings SET freshness = $1, price = $2, repair = $3, market = $4, personal = $5, market_min_sample = $6',
    [w.freshness, w.price, w.repair, w.market, w.personal, marketMinSample]);
  return rankingSettings(db);
}

/** Window of the market value used in the feed ranking. */
export const MARKET_WINDOW_DAYS = 30;
/** Not seen for this long: possibly sold, removed or just no longer polled – never counted as a sale. */
const STALE_DAYS = 3;
const notReported = 'NOT EXISTS (SELECT 1 FROM feedback f WHERE f.listing_id = l.id)';
const basis = (days: number, minSample: number) => ({ windowDays: days, from: new Date(Date.now() - days * 86400000).toISOString(), to: new Date().toISOString(),
  minSample, method: MARKET_METHOD, note: MARKET_NOTE });
const observation = (r: Row) => ({ priceEur: r.price_eur as number, offerType: r.offer_type as string, modelKey: r.model_key as string });

/** DF-501..504: one market value per detected model (VRAM variants are separate keys) and condition, over all sources. */
async function marketGroups(db: Queryable, days: number, minSample: number) {
  const { rows } = await db.query(`SELECT l.model_key, l.health, l.offer_type, l.price_eur FROM listings l
    WHERE l.model_key IS NOT NULL AND l.health IN ('working', 'defect', 'unknown') AND l.last_seen_at >= now() - make_interval(days => $1) AND ${notReported}`, [days]);
  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(`${r.model_key}|${r.health}`, [...groups.get(`${r.model_key}|${r.health}`) ?? [], r]);
  return new Map([...groups].map(([key, list]) => [key, marketStats(list.map(observation), minSample)]));
}
export async function marketOverview(db: Queryable, days = 30) {
  const { marketMinSample } = await rankingSettings(db);
  const items = [...await marketGroups(db, days, marketMinSample)].map(([key, st]) => {
    const [modelKey, health] = key.split('|');
    return { modelKey, health, observations: st.observations, n: st.n, reliable: st.reliable, p50: st.quantiles?.p50 ?? null };
  }).sort((a, b) => b.observations - a.observations || a.modelKey.localeCompare(b.modelKey));
  return { basis: basis(days, marketMinSample), items };
}
/** DF-505: distribution, weekly asking prices and price changes of one model; null if the model was never seen. */
export async function marketDetail(db: Queryable, modelKey: string, { health = 'working', source = 'all', days = 30 } = {}) {
  if (!(await db.query('SELECT 1 FROM listings WHERE model_key = $1 LIMIT 1', [modelKey])).rowCount) return null;
  const { marketMinSample } = await rankingSettings(db);
  const filter = `l.model_key = $1 AND l.health = $2 AND ($3 = 'all' OR l.source = $3) AND ${notReported}`;
  const { rows } = await db.query(`SELECT l.offer_type, l.price_eur, l.model_key, l.first_seen_at, l.last_seen_at,
      (SELECT s.price_eur FROM listing_snapshots s WHERE s.listing_id = l.id ORDER BY s.observed_at, s.id LIMIT 1) AS first_price
    FROM listings l WHERE ${filter} AND (l.last_seen_at >= now() - make_interval(days => $4) OR l.first_seen_at >= now() - make_interval(days => $4))`,
  [modelKey, health, source, days]);
  const from = Date.now() - days * 86400000, stale = Date.now() - STALE_DAYS * 86400000;
  const current = rows.filter(r => Date.parse(r.last_seen_at) >= from);
  const changes = await db.query(`SELECT * FROM (SELECT s.listing_id, l.title, l.source, s.observed_at, s.price_eur,
        lag(s.price_eur) OVER (PARTITION BY s.listing_id ORDER BY s.observed_at, s.id) AS prev
      FROM listing_snapshots s JOIN listings l ON l.id = s.listing_id WHERE ${filter}) x
    WHERE prev IS NOT NULL AND prev <> price_eur AND observed_at >= now() - make_interval(days => $4) ORDER BY observed_at DESC LIMIT 20`, [modelKey, health, source, days]);
  return { modelKey, health, source, basis: basis(days, marketMinSample),
    stats: marketStats(current.map(observation), marketMinSample),
    availability: { active: current.filter(r => Date.parse(r.last_seen_at) >= stale).length, notSeenRecently: current.filter(r => Date.parse(r.last_seen_at) < stale).length, staleDays: STALE_DAYS },
    history: weeklyHistory(rows.filter(r => Date.parse(r.first_seen_at) >= from).map(r => ({ ...observation(r), priceEur: r.first_price ?? r.price_eur, firstSeenAt: r.first_seen_at }))),
    historyBasis: `Erster Angebotspreis neu entdeckter Inserate je Kalenderwoche (Mo–So, UTC); Median und Quartile ab ${MIN_WEEK_SAMPLE} Angeboten je Woche`,
    priceChanges: changes.rows.map(c => ({ listingId: c.listing_id as number, title: c.title as string, source: c.source as Source, observedAt: c.observed_at as string,
      fromEur: c.prev as number, toEur: c.price_eur as number })) };
}

/** One label per listing; reporting again replaces the label. False if the listing does not exist. */
export async function saveFeedback(db: Queryable, listingId: number, input: unknown) {
  const f = FeedbackCreate.parse(input);
  return ((await db.query(`INSERT INTO feedback (listing_id, label, reason) SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM listings WHERE id = $1)
    ON CONFLICT (listing_id) DO UPDATE SET label = EXCLUDED.label, reason = EXCLUDED.reason, created_at = now()`, [listingId, f.label, f.reason ?? null])).rowCount ?? 0) > 0;
}
const ratioOf = (r: Row) => ({ matched: r.matched as number, falseHits: r.hits as number, ratioPct: r.matched ? Math.round(r.hits / r.matched * 100) : null });
const matchedSql = (by: string) => `SELECT ${by} count(DISTINCT m.listing_id) AS matched, count(DISTINCT f.listing_id) AS hits
  FROM watchlist_matches m JOIN listings l ON l.id = m.listing_id JOIN watchlists w ON w.id = m.watchlist_id LEFT JOIN feedback f ON f.listing_id = m.listing_id`;
/** false_positive_feedback_ratio: reported listings / matched listings – only what was actually reported, no quality claim. */
export async function feedbackStats(db: Queryable) {
  const total = (await db.query(matchedSql(''))).rows[0];
  const byLabel = (await db.query('SELECT label, count(*) AS n FROM feedback GROUP BY label ORDER BY n DESC, label')).rows.map(r => ({ label: r.label as string, n: r.n as number }));
  const bySource = (await db.query(`${matchedSql('l.source,')} GROUP BY l.source ORDER BY l.source`)).rows.map(r => ({ source: r.source as Source, ...ratioOf(r) }));
  const byWatchlist = (await db.query(`${matchedSql('w.id, w.name,')} GROUP BY w.id, w.name ORDER BY w.id`)).rows.map(r => ({ watchlistId: r.id as number, name: r.name as string, ...ratioOf(r) }));
  const st = (await db.query(`SELECT count(*) FILTER (WHERE status = 'saved') AS saved, count(*) FILTER (WHERE status = 'contacted') AS contacted,
    count(*) FILTER (WHERE status = 'purchased') AS purchased FROM listings`)).rows[0];
  const closed = (await repairProjects(db)).filter(p => p.actual);
  return { ...ratioOf(total), byLabel, bySource, byWatchlist, personal: { saved: st.saved, contacted: st.contacted, purchased: st.purchased, repairClosed: closed.length,
    repairMarginEur: closed.length ? cents(closed.reduce((sum, p) => sum + p.actual!.marginEur, 0)) : null } };
}

/**
 * DF-506: read-time ranking inputs, each visible as its own priority part. Personal signals: models you saved, contacted,
 * bought or repaired (+10), own closed repair projects of the model from 3 on (±10), watchlists with ≥3 reports and ≥20 % false hits (−10).
 */
async function rankingContext(db: Queryable) {
  const { weights, marketMinSample } = await rankingSettings(db);
  const market = await marketGroups(db, MARKET_WINDOW_DAYS, marketMinSample);
  const interest = new Set((await db.query(`SELECT model_key AS m FROM listings WHERE status IN ('saved', 'contacted', 'purchased') AND model_key IS NOT NULL
    UNION SELECT model FROM repair_projects WHERE model IS NOT NULL`)).rows.map(r => r.m as string));
  const repair = new Map<string, number[]>();
  for (const p of await repairProjects(db)) if (p.actual && p.model) repair.set(p.model, [...repair.get(p.model) ?? [], p.actual.marginEur]);
  const noisy = new Map((await db.query(`${matchedSql('w.id,')} GROUP BY w.id`)).rows.map(r => [r.id as number, ratioOf(r)]));
  return (r: Row): RankingContext => {
    const personal: { label: string; points: number }[] = [];
    if (r.model_key && interest.has(r.model_key)) personal.push({ label: 'Modell gemerkt/kontaktiert/gekauft', points: 10 });
    const margins = r.health !== 'working' ? repair.get(r.model_key) : undefined;
    if (margins && margins.length >= 3) {
      const avg = cents(margins.reduce((a, b) => a + b, 0) / margins.length);
      personal.push({ label: `Eigene Repair-Projekte ${avg >= 0 ? 'mit Gewinn' : 'mit Verlust'} (Ø ${avg} €, n=${margins.length})`, points: avg >= 0 ? 10 : -10 });
    }
    const fh = noisy.get(r.watchlist_id);
    if (fh && fh.falseHits >= 3 && (fh.ratioPct ?? 0) >= 20) personal.push({ label: `Viele Fehltreffer in diesem Profil (${fh.ratioPct} %, n=${fh.falseHits})`, points: -10 });
    const m = market.get(`${r.model_key}|${r.health}`);
    return { weights, personal, market: m?.quantiles ? { medianEur: m.quantiles.p50, n: m.n, windowDays: MARKET_WINDOW_DAYS } : null };
  };
}
