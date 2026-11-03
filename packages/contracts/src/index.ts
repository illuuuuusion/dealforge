/** Zod request/response contracts for /api/v1 and the OpenAPI document generated from them. */
import { z } from 'zod';

export const Source = z.enum(['ebay', 'kleinanzeigen', 'facebook']);
export const ListingStatus = z.enum(['new', 'saved', 'dismissed', 'contacted', 'purchased']);
const money = z.number().min(0).max(100000);
const id = z.coerce.number().int().positive();
const isoTime = z.string();

const watchlistFields = {
  name: z.string().trim().min(1).max(120),
  query: z.string().trim().min(1).max(120),
  maxWorking: money,
  maxDefect: money,
  expectedResale: money.nullable(),
  repairBudget: money,
  sourceList: z.array(Source).min(1).max(3),
  allowUnknownShipping: z.boolean(),
  // Fast mode: own, shorter poll schedule for sources allowed in FAST_PROVIDERS (DF-301).
  fast: z.boolean(),
};
export const WatchlistCreate = z.object({
  ...watchlistFields,
  expectedResale: watchlistFields.expectedResale.default(null),
  repairBudget: money.default(0),
  sourceList: watchlistFields.sourceList.default(['ebay']),
  allowUnknownShipping: z.boolean().default(false),
  fast: z.boolean().default(false),
});
export const WatchlistPatch = z.object({ ...watchlistFields, active: z.boolean() }).partial()
  .refine(o => Object.keys(o).length > 0, 'Mindestens ein Feld angeben');
export const Watchlist = z.object({ id: z.number().int(), ...watchlistFields, active: z.boolean(), createdAt: isoTime });
export type WatchlistCreateInput = z.input<typeof WatchlistCreate>;
export type WatchlistPatchInput = z.infer<typeof WatchlistPatch>;
export type WatchlistRow = z.infer<typeof Watchlist>;

export const Assessment = z.looseObject({
  health: z.enum(['working', 'defect', 'unknown']),
  model: z.string().nullable(),
  allIn: z.number(),
  knownTotalEur: z.number().nullable(),
  shippingKnown: z.boolean(),
  needsPriceCheck: z.boolean(),
  timestampBasis: z.enum(['published', 'first-seen', 'unknown']),
  alerts: z.array(z.enum(['SCHNAPPER', 'DEAL', 'REPAIR'])),
  reasons: z.array(z.string()),
  priority: z.number().int().min(0).max(100),
});
export const Listing = z.object({
  id: z.number().int(), source: Source, externalId: z.string(), title: z.string(), description: z.string().nullable(),
  url: z.string(), imageUrl: z.string().nullable(), priceEur: z.number(), shippingEur: z.number().nullable(),
  condition: z.string().nullable(), publishedAt: isoTime.nullable(), offerType: z.enum(['FIXED_PRICE', 'AUCTION', 'OTHER']),
  auctionEndsAt: isoTime.nullable(), bidCount: z.number().int().nullable(),
  // first seen / last seen = our ingest time; fetched = when the provider response was received.
  firstSeenAt: isoTime, lastSeenAt: isoTime, fetchedAt: isoTime, status: ListingStatus,
});
export const FeedItem = Listing.extend({ assessment: Assessment, watchlistId: z.number().int(), watchlistName: z.string() });
export const FeedQuery = z.object({
  mode: z.enum(['all', 'schnapper', 'deal', 'repair']).default('all'),
  source: z.enum(['all', 'ebay', 'kleinanzeigen', 'facebook']).default('all'),
  watchlistId: id.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().regex(/^\d{1,4}$/).optional(),
});
export const FeedResponse = z.object({ items: z.array(FeedItem), nextCursor: z.string().nullable() });
export const Snapshot = z.object({ observedAt: isoTime, priceEur: z.number(), shippingEur: z.number().nullable() });
export const ListingDetail = Listing.extend({
  snapshots: z.array(Snapshot),
  matches: z.array(z.object({ watchlistId: z.number().int(), watchlistName: z.string(), assessment: Assessment })),
});
export const UserStatePatch = z.object({ status: ListingStatus });

export const ScanRequest = z.object({ source: z.enum(['all', 'ebay', 'kleinanzeigen']).default('all') });
export const ScanAccepted = z.object({
  queued: z.array(z.object({ platform: Source, label: z.string(), jobId: z.string() })),
  deduplicated: z.array(z.object({ platform: Source, label: z.string() })),
});
export const FacebookImport = z.object({ items: z.array(z.unknown()).max(100, 'Maximal 100 Einträge als items:[]') });
export const ImportResult = z.object({ normalized: z.number().int(), fetched: z.number().int(), inserted: z.number().int(), matched: z.number().int(), priceChanges: z.number().int(), alerts: z.number().int() });
export const Alert = z.object({
  id: z.number().int(), kind: z.enum(['SCHNAPPER', 'DEAL', 'REPAIR', 'PRICE_DROP']), priority: z.number().int(), reasons: z.array(z.string()), createdAt: isoTime,
  listingId: z.number().int(), watchlistId: z.number().int().nullable(), watchlistName: z.string().nullable(), source: Source, title: z.string(), url: z.string(),
  priceEur: z.number(), shippingEur: z.number().nullable(), publishedAt: isoTime.nullable(), firstSeenAt: isoTime, fetchedAt: isoTime,
  push: z.object({ sent: z.number().int(), shown: z.number().int(), failed: z.number().int() }),
});
export const AlertsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const percentiles = z.object({ p50: z.number().nullable(), p95: z.number().nullable() });
export const LatencyQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) });
export const AlertLatency = z.object({ days: z.number().int(), items: z.array(z.object({
  source: Source, samples: z.number().int(), discovery: percentiles, ingest: percentiles, push: percentiles, shown: percentiles })) });

// The server POSTs to the endpoint: only known browser push services, never arbitrary hosts (SSRF).
const pushHosts = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
export const PushSubscriptionCreate = z.object({
  endpoint: z.string().max(1000).refine(v => { try { const u = new URL(v); return u.protocol === 'https:' && pushHosts.test(u.hostname); } catch { return false; } },
    'Kein bekannter Push-Dienst (https)'),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});
export const PushSubscriptionItem = z.object({ id: z.number().int(), host: z.string(), userAgent: z.string().nullable(), createdAt: isoTime, lastSuccessAt: isoTime.nullable() });
export const PushResult = z.object({ sent: z.number().int(), failed: z.number().int(), gone: z.number().int(), skipped: z.number().int() });
export const PushReceipt = z.object({ deliveryId: z.number().int().positive() });
export const Delivery = z.object({ id: z.number().int(), alertId: z.number().int().nullable(), subscriptionId: z.number().int().nullable(),
  status: z.enum(['pending', 'sent', 'failed', 'gone']), httpStatus: z.number().int().nullable(), error: z.string().nullable(),
  createdAt: isoTime, sentAt: isoTime.nullable(), shownAt: isoTime.nullable() });
// Repair Lab (P4). Fault classes mirror FAULTS in @dealforge/domain.
export const Fault = z.enum(['NO_DISPLAY', 'ARTIFACTS', 'DRIVER_CRASH', 'NO_POWER', 'WATER_DAMAGE', 'BURN_DAMAGE', 'PARTS_MISSING', 'UNKNOWN']);
const hours = z.number().min(0).max(1000);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum als JJJJ-MM-TT');
export const RepairCostRule = z.object({ fault: Fault, model: z.string().trim().max(120), partsMin: money, partsMax: money, hoursMin: hours, hoursMax: hours })
  .refine(r => r.partsMax >= r.partsMin && r.hoursMax >= r.hoursMin, 'Maximum muss mindestens dem Minimum entsprechen');
export const RepairSettings = z.object({ hourlyRateEur: money, saleFeePct: z.number().min(0).max(100), resaleShippingEur: money, costs: z.array(RepairCostRule).max(500) })
  .refine(s => new Set(s.costs.map(c => `${c.fault}|${c.model}`)).size === s.costs.length, 'Jede Fehlerklasse je Modell nur einmal');
const repairFields = {
  title: z.string().trim().min(1).max(500),
  model: z.string().trim().max(120).nullable(),
  faults: z.array(Fault).min(1).max(8).refine(f => new Set(f).size === f.length, 'Fehlerklasse doppelt'),
  status: z.enum(['candidate', 'purchased', 'repairing', 'repaired', 'sold', 'abandoned']),
  outcome: z.enum(['open', 'success', 'partial', 'failed']),
  purchasePriceEur: money, purchaseShippingEur: money.nullable(), purchasedAt: day.nullable(),
  parts: z.array(z.object({ name: z.string().trim().min(1).max(120), costEur: money })).max(50),
  hoursSpent: hours, resaleEstimateEur: money.nullable(), salvageEstimateEur: money,
  soldPriceEur: money.nullable(), soldFeesEur: money.nullable(), soldShippingEur: money.nullable(), soldAt: day.nullable(),
  notes: z.string().max(4000),
};
export const RepairProjectCreate = z.object({ listingId: z.number().int().positive() });
export const RepairProjectPatch = z.object(repairFields).partial().refine(o => Object.keys(o).length > 0, 'Mindestens ein Feld angeben');
const RepairScenario = z.object({ key: z.enum(['worst', 'base', 'best']), label: z.string(), success: z.boolean(), partsEur: z.number(), hours: z.number(),
  laborEur: z.number(), investmentEur: z.number(), revenueEur: z.number().nullable(), marginEur: z.number().nullable() });
export const RepairProject = z.object({ id: z.number().int(), listingId: z.number().int().nullable(), url: z.string().nullable(), ...repairFields,
  createdAt: isoTime, updatedAt: isoTime,
  plan: z.object({ shippingKnown: z.boolean(), assumptions: z.array(z.string()), scenarios: z.array(RepairScenario) }),
  actual: z.object({ costsEur: z.number(), revenueEur: z.number(), marginEur: z.number(), laborEur: z.number(), marginInclLaborEur: z.number() }).nullable() });
export const RepairStats = z.object({ minSample: z.number().int(), items: z.array(z.object({ fault: z.union([Fault, z.literal('ALL')]), n: z.number().int(),
  success: z.number().int(), partial: z.number().int(), failed: z.number().int(), successRatePct: z.number().nullable(),
  marginSamples: z.number().int(), avgMarginEur: z.number().nullable() })) });

// Market values from offer prices, feedback and ranking weights (P5).
const Health = z.enum(['working', 'defect', 'unknown']);
const days = z.coerce.number().int().min(7).max(365).default(30);
export const MarketListQuery = z.object({ days });
export const MarketQuery = z.object({ health: Health.default('working'), source: z.enum(['all', 'ebay', 'kleinanzeigen', 'facebook']).default('all'), days });
export const MarketParams = z.object({ modelKey: z.string().min(1).max(120) });
const MarketBasis = z.object({ windowDays: z.number().int(), from: isoTime, to: isoTime, minSample: z.number().int(), method: z.string(), note: z.string() });
const quantiles = z.object({ p25: z.number(), p50: z.number(), p75: z.number(), min: z.number(), max: z.number() });
export const MarketSummary = z.object({ basis: MarketBasis, items: z.array(z.object({ modelKey: z.string(), health: Health, observations: z.number().int(),
  n: z.number().int(), reliable: z.boolean(), p50: z.number().nullable() })) });
export const MarketDetail = z.object({ modelKey: z.string(), health: Health, source: z.string(), basis: MarketBasis,
  stats: z.object({ observations: z.number().int(), n: z.number().int(), outliersRemoved: z.number().int(), minSample: z.number().int(), reliable: z.boolean(),
    quantiles: quantiles.nullable(), excluded: z.array(z.object({ reason: z.string(), n: z.number().int() })), message: z.string().nullable() }),
  availability: z.object({ active: z.number().int(), notSeenRecently: z.number().int(), staleDays: z.number().int() }),
  history: z.array(z.object({ weekStart: z.string(), n: z.number().int(), p25: z.number().nullable(), p50: z.number().nullable(), p75: z.number().nullable() })),
  historyBasis: z.string(),
  priceChanges: z.array(z.object({ listingId: z.number().int(), title: z.string(), source: Source, observedAt: isoTime, fromEur: z.number(), toEur: z.number() })) });
export const FeedbackCreate = z.object({ label: z.enum(['wrong_model', 'accessory', 'wrong_condition', 'other']), reason: z.string().trim().max(500).optional() });
const ratio = z.object({ matched: z.number().int(), falseHits: z.number().int(), ratioPct: z.number().int().nullable() });
export const FeedbackStats = ratio.extend({
  byLabel: z.array(z.object({ label: z.string(), n: z.number().int() })),
  bySource: z.array(ratio.extend({ source: Source })),
  byWatchlist: z.array(ratio.extend({ watchlistId: z.number().int(), name: z.string() })),
  personal: z.object({ saved: z.number().int(), contacted: z.number().int(), purchased: z.number().int(), repairClosed: z.number().int(), repairMarginEur: z.number().nullable() }),
});
const weight = z.number().min(0).max(3);
export const RankingSettings = z.object({ weights: z.object({ freshness: weight, price: weight, repair: weight, market: weight, personal: weight }),
  marketMinSample: z.number().int().min(5).max(1000) });

export const Login = z.object({ password: z.string().max(1024) });
export const ProviderPatch = z.object({ enabled: z.boolean() });

const count = z.number().int().min(0);
export const ProviderHealth = z.object({
  source: Source, ready: z.boolean(), approved: z.boolean(), enabled: z.boolean(), live: z.boolean(), fast: z.boolean(), kind: z.string(), status: z.string(),
  state: z.enum(['off', 'idle', 'ok', 'degraded', 'down']),
  lastRunAt: isoTime.nullable(), lastSuccessAt: isoTime.nullable(),
  lastError: z.object({ at: isoTime, code: z.string().nullable(), message: z.string().nullable() }).nullable(),
  runs24h: count, errors24h: count, errorRatePct: count.nullable(), callsToday: count, callsMonth: count,
  budgetExhausted: z.string().nullable(),
  queue: z.object({ waiting: count, active: count, delayed: count, failed: count, rateLimitedMs: count }).nullable(),
});
export const SystemStatus = z.object({
  providers: z.array(ProviderHealth),
  worker: z.object({ online: z.boolean(), lastHeartbeatAt: isoTime.nullable() }),
  scheduler: z.object({ enabled: z.boolean(), pollSeconds: z.number().int(), fastPollSeconds: z.number().int() }),
  limits: z.object({ daily: count, monthly: count, perQueryDaily: count }),
});
export const DashboardState = z.object({
  stats: z.object({ total: count, saved: count, repairCandidates: count, alertsToday: count }),
  models: z.array(z.string()),
  demoMode: z.boolean(),
});
export const Ok = z.object({ ok: z.literal(true) });
export const Ready = z.object({ ok: z.boolean(), db: z.boolean(), redis: z.boolean(), worker: z.boolean() });
export const ErrorBody = z.object({ code: z.string(), message: z.string(), requestId: z.string() });
export const IdParams = z.object({ id });
export const SourceParams = z.object({ source: z.enum(['ebay', 'kleinanzeigen']) });

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface RouteContract {
  method: Method; path: string; summary: string; auth?: false;
  query?: z.ZodObject; params?: z.ZodObject; body?: z.ZodType;
  /** null = empty body */
  responses: Record<number, z.ZodType | null>;
}
const E = ErrorBody;
export const routes: RouteContract[] = [
  { method: 'GET', path: '/api/v1/health/live', summary: 'Prozess erreichbar', auth: false, responses: { 200: Ok } },
  { method: 'GET', path: '/api/v1/health/ready', summary: 'DB, Redis und Worker erreichbar', auth: false, responses: { 200: Ready, 503: Ready } },
  { method: 'POST', path: '/api/v1/auth/login', summary: 'Session-Cookie per App-Passwort', auth: false, body: Login, responses: { 200: Ok, 401: E, 429: E } },
  { method: 'GET', path: '/api/v1/openapi.json', summary: 'Dieses OpenAPI-Dokument', responses: { 200: z.looseObject({ openapi: z.string() }) } },
  { method: 'GET', path: '/api/v1/state', summary: 'Dashboard-Kennzahlen und Modellliste', responses: { 200: DashboardState } },
  { method: 'GET', path: '/api/v1/watchlists', summary: 'Eigene Suchprofile', responses: { 200: z.object({ items: z.array(Watchlist) }) } },
  { method: 'POST', path: '/api/v1/watchlists', summary: 'Suchprofil erstellen', body: WatchlistCreate, responses: { 201: z.object({ id: z.number().int() }), 400: E } },
  { method: 'PATCH', path: '/api/v1/watchlists/:id', summary: 'Regeln, Quellen, Aktivierung ändern', params: IdParams, body: WatchlistPatch, responses: { 200: z.object({ item: Watchlist }), 400: E, 404: E } },
  { method: 'DELETE', path: '/api/v1/watchlists/:id', summary: 'Suchprofil löschen (Inserate und Historie bleiben)', params: IdParams, responses: { 204: null, 404: E } },
  { method: 'GET', path: '/api/v1/listings', summary: 'Deal-Feed mit Filtern und Cursor', query: FeedQuery, responses: { 200: FeedResponse, 400: E } },
  { method: 'GET', path: '/api/v1/listings/:id', summary: 'Inserat mit Bewertung und Preisverlauf', params: IdParams, responses: { 200: z.object({ item: ListingDetail }), 404: E } },
  { method: 'PATCH', path: '/api/v1/listings/:id/user-state', summary: 'saved, dismissed, contacted, purchased', params: IdParams, body: UserStatePatch, responses: { 200: Ok, 400: E, 404: E } },
  { method: 'POST', path: '/api/v1/listings/:id/feedback', summary: 'Als Fehltreffer melden (blendet das Inserat aus dem Feed und dem Marktwert aus)', params: IdParams,
    body: FeedbackCreate, responses: { 201: Ok, 400: E, 404: E } },
  { method: 'GET', path: '/api/v1/feedback/stats', summary: 'Fehltreffer-Quote je Quelle/Profil und persönliche Bilanz', responses: { 200: FeedbackStats } },
  { method: 'GET', path: '/api/v1/ranking/settings', summary: 'Ranking-Gewichte und Mindeststichprobe für Marktwerte', responses: { 200: z.object({ item: RankingSettings }) } },
  { method: 'PUT', path: '/api/v1/ranking/settings', summary: 'Ranking-Gewichte und Mindeststichprobe setzen', body: RankingSettings, responses: { 200: z.object({ item: RankingSettings }), 400: E } },
  { method: 'GET', path: '/api/v1/market', summary: 'Angebots-Marktwerte je Modell und Zustand (Übersicht)', query: MarketListQuery, responses: { 200: MarketSummary, 400: E } },
  { method: 'GET', path: '/api/v1/market/:modelKey', summary: 'Angebotspreis-Verteilung, Wochenverlauf und Preisänderungen eines Modells; nur mit Statistikbasis',
    params: MarketParams, query: MarketQuery, responses: { 200: MarketDetail, 400: E, 404: E } },
  { method: 'GET', path: '/api/v1/alerts', summary: 'Ausgelöste Alerts, neueste zuerst', query: AlertsQuery, responses: { 200: z.object({ items: z.array(Alert) }), 400: E } },
  { method: 'GET', path: '/api/v1/events', summary: 'Live-Alerts als Server-Sent Events (text/event-stream): event alert, id = Alert-ID, Last-Event-ID setzt fort', responses: { 200: null } },
  { method: 'GET', path: '/api/v1/alerts/latency', summary: 'p50/p95 in Sekunden je Quelle: Inserat→Fund, Abruf→Alert, Alert→Push, Alert→angezeigt', query: LatencyQuery, responses: { 200: AlertLatency, 400: E } },
  { method: 'GET', path: '/api/v1/push/public-key', summary: 'VAPID-Public-Key für pushManager.subscribe', responses: { 200: z.object({ publicKey: z.string() }) } },
  { method: 'GET', path: '/api/v1/push-subscriptions', summary: 'Registrierte Push-Abos (nur Host des Push-Dienstes)', responses: { 200: z.object({ items: z.array(PushSubscriptionItem) }) } },
  { method: 'POST', path: '/api/v1/push-subscriptions', summary: 'Browser-Push-Abo speichern (idempotent je Endpoint)', body: PushSubscriptionCreate, responses: { 201: z.object({ id: z.number().int() }), 400: E } },
  { method: 'DELETE', path: '/api/v1/push-subscriptions/:id', summary: 'Push-Abo entfernen', params: IdParams, responses: { 204: null, 404: E } },
  { method: 'POST', path: '/api/v1/push/test', summary: 'Test-Push an alle Abos senden', responses: { 200: PushResult } },
  { method: 'POST', path: '/api/v1/push/receipts', summary: 'Empfangsbestätigung des Service Workers: Benachrichtigung angezeigt', body: PushReceipt, responses: { 204: null, 400: E, 404: E } },
  { method: 'GET', path: '/api/v1/push/deliveries', summary: 'Zustellungslog: erstellt, versandt, angezeigt, fehlgeschlagen', query: AlertsQuery, responses: { 200: z.object({ items: z.array(Delivery) }), 400: E } },
  { method: 'GET', path: '/api/v1/repair/settings', summary: 'Stundensatz, Gebühren und Teile-/Zeitannahmen je Fehlerklasse und Modell', responses: { 200: z.object({ item: RepairSettings }) } },
  { method: 'PUT', path: '/api/v1/repair/settings', summary: 'Reparaturannahmen ersetzen', body: RepairSettings, responses: { 200: z.object({ item: RepairSettings }), 400: E } },
  { method: 'GET', path: '/api/v1/repair/stats', summary: 'Eigene Erfolgs-/Fehlerstatistik je Fehlerklasse mit Stichprobengröße', responses: { 200: RepairStats } },
  { method: 'GET', path: '/api/v1/repair/projects', summary: 'Reparaturprojekte mit Szenarien und tatsächlicher Marge', responses: { 200: z.object({ items: z.array(RepairProject) }) } },
  { method: 'POST', path: '/api/v1/repair/projects', summary: 'Reparaturprojekt aus Inserat anlegen (200 = existiert bereits)', body: RepairProjectCreate,
    responses: { 200: z.object({ id: z.number().int() }), 201: z.object({ id: z.number().int() }), 400: E, 404: E } },
  { method: 'GET', path: '/api/v1/repair/projects/:id', summary: 'Reparaturprojekt', params: IdParams, responses: { 200: z.object({ item: RepairProject }), 404: E } },
  { method: 'PATCH', path: '/api/v1/repair/projects/:id', summary: 'Kauf, Teile, Zeit, Ergebnis, Verkauf und Annahmen erfassen', params: IdParams, body: RepairProjectPatch,
    responses: { 200: z.object({ item: RepairProject }), 400: E, 404: E } },
  { method: 'DELETE', path: '/api/v1/repair/projects/:id', summary: 'Reparaturprojekt löschen (Inserat bleibt)', params: IdParams, responses: { 204: null, 404: E } },
  { method: 'GET', path: '/api/v1/providers/status', summary: 'Systemstatus: Quellen, Queues, Quoten, Worker', responses: { 200: SystemStatus } },
  { method: 'PATCH', path: '/api/v1/providers/:source', summary: 'Quelle zur Laufzeit ein-/ausschalten', params: SourceParams, body: ProviderPatch, responses: { 200: Ok, 400: E } },
  { method: 'POST', path: '/api/v1/admin/scans', summary: 'Manuellen Scan einplanen', body: ScanRequest, responses: { 202: ScanAccepted, 409: E, 429: E } },
  { method: 'POST', path: '/api/v1/import/facebook', summary: 'Zulässige Facebook-Importdaten (max. 100)', body: FacebookImport, responses: { 200: ImportResult, 400: E } },
];

const json = (schema: z.ZodType, io: 'input' | 'output') => z.toJSONSchema(schema, { io, unrepresentable: 'any' });
const fields = (schema: z.ZodObject, where: 'query' | 'path') => Object.entries(schema.shape).map(([name, s]) =>
  ({ name, in: where, required: where === 'path' || !(s as z.ZodType).safeParse(undefined).success, schema: json(s as z.ZodType, 'input') }));

export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const path = r.path.replace(/:(\w+)/g, '{$1}');
    paths[path] ??= {};
    paths[path][r.method.toLowerCase()] = {
      summary: r.summary,
      ...(r.auth === false ? { security: [] } : {}),
      parameters: [...(r.params ? fields(r.params, 'path') : []), ...(r.query ? fields(r.query, 'query') : [])],
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: json(r.body, 'input') } } } } : {}),
      responses: Object.fromEntries(Object.entries(r.responses).map(([status, s]) =>
        [status, { description: status, ...(s ? { content: { 'application/json': { schema: json(s, 'output') } } } : {}) }])),
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'DealForge API', version: '1' },
    components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'df_session' } } },
    security: [{ session: [] }],
    paths,
  };
}
