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
};
export const WatchlistCreate = z.object({
  ...watchlistFields,
  expectedResale: watchlistFields.expectedResale.default(null),
  repairBudget: money.default(0),
  sourceList: watchlistFields.sourceList.default(['ebay']),
  allowUnknownShipping: z.boolean().default(false),
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
export const ImportResult = z.object({ normalized: z.number().int(), fetched: z.number().int(), inserted: z.number().int(), matched: z.number().int(), priceChanges: z.number().int() });
export const Login = z.object({ password: z.string().max(1024) });
export const ProviderPatch = z.object({ enabled: z.boolean() });

const count = z.number().int().min(0);
export const ProviderHealth = z.object({
  source: Source, ready: z.boolean(), approved: z.boolean(), enabled: z.boolean(), live: z.boolean(), kind: z.string(), status: z.string(),
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
  scheduler: z.object({ enabled: z.boolean(), pollSeconds: z.number().int() }),
  limits: z.object({ daily: count, monthly: count, perQueryDaily: count }),
});
export const DashboardState = z.object({
  stats: z.object({ total: count, saved: count, repairCandidates: count }),
  models: z.array(z.string()),
  demoMode: z.boolean(),
});
export const Ok = z.object({ ok: z.literal(true) });
export const Ready = z.object({ ok: z.boolean(), db: z.boolean(), redis: z.boolean(), worker: z.boolean() });
export const ErrorBody = z.object({ code: z.string(), message: z.string(), requestId: z.string() });
export const IdParams = z.object({ id });
export const SourceParams = z.object({ source: z.enum(['ebay', 'kleinanzeigen']) });

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
