/** Only eBay uses an official read API. Kleinanzeigen Agent is a third-party pilot. Facebook is import-only. */
import { resolveWatchTargets, bucketForProfile, type NormalizedListing } from '@dealforge/domain';
import { requestJson, ProviderError, type RequestOptions } from './http.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untrusted provider JSON, validated field by field
type Row = Record<string, any>;

export interface ProviderConfig {
  ebayAppId: string; ebayClientSecret: string; klazKey: string;
  klazLocationId?: string; klazRadiusKm?: string; approvedProviders?: string[];
}
export interface SearchRequest { query: string; variant?: 'default' | 'auction'; beforeRequest?: () => Promise<void> }
export interface SearchResult { listings: NormalizedListing[]; fetchedAt: string }
/** One adapter per live source. Failures surface as ProviderError codes; there is never a fallback scraper. */
export interface ProviderAdapter {
  readonly id: LiveSource;
  readonly capabilities: { search: boolean; auctions: boolean; webhooks: boolean; regions: boolean; publishedAt: boolean };
  validateConfig(): { ok: boolean; reason?: string };
  search(request: SearchRequest): Promise<SearchResult>;
}
export const LIVE_SOURCES = ['ebay', 'kleinanzeigen'] as const;
export type LiveSource = typeof LIVE_SOURCES[number];

const first = (...items: unknown[]) => items.find(x => x !== null && x !== undefined && x !== '');
const isListing = (x: NormalizedListing | null): x is NormalizedListing => x !== null;

const ebayTokens = new Map<string, { token: string; expiry: number }>();
async function getEbayToken(cfg: ProviderConfig, http: RequestOptions) {
  const cached = ebayTokens.get(cfg.ebayAppId);
  if (cached && Date.now() + 60000 < cached.expiry) return cached.token;
  if (!cfg.ebayAppId || !cfg.ebayClientSecret) throw new ProviderError('AUTH', 'eBay OAuth Zugang fehlt');
  const body = new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' });
  // Token calls are not Browse calls: they bypass the budget gate (no beforeRequest).
  const response = await requestJson<Row>('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.ebayAppId}:${cfg.ebayClientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }, { ...http, beforeRequest: undefined });
  if (!response.access_token) throw new ProviderError('AUTH', 'eBay OAuth: no access_token');
  ebayTokens.set(cfg.ebayAppId, { token: response.access_token, expiry: Date.now() + (Number(response.expires_in) || 3600) * 1000 });
  return response.access_token as string;
}
function sumShipping(row: Row) {
  const s = first(row.shippingOptions?.[0]?.shippingCost?.value, row.shippingCost?.value);
  return s === undefined ? null : Number(s);
}
export function normalizeEbay(row: Row): NormalizedListing | null {
  const id = first(row.itemId, row.legacyItemId);
  const url = first(row.itemWebUrl, row.itemAffiliateWebUrl);
  const options: string[] = row.buyingOptions || [];
  // Auction + Buy It Now counts as fixed price (price = BIN); pure auctions report the current bid.
  const offerType = options.includes('FIXED_PRICE') ? 'FIXED_PRICE' : options.includes('AUCTION') ? 'AUCTION' : 'OTHER';
  const priceInfo = offerType === 'AUCTION' ? (row.currentBidPrice ?? row.price) : row.price;
  const price = Number(priceInfo?.value);
  if (!id || !url || !Number.isFinite(price) || (priceInfo?.currency && priceInfo.currency !== 'EUR')) return null;
  return { source: 'ebay', externalId: String(id), title: row.title || '', description: row.shortDescription || '',
    url: String(url), imageUrl: row.image?.imageUrl ?? null, priceEur: price, shippingEur: sumShipping(row),
    condition: row.condition || '', publishedAt: row.itemOriginDate || null,
    offerType, auctionEndsAt: row.itemEndDate ?? null, bidCount: row.bidCount ?? null };
}
export function ebayAdapter(cfg: ProviderConfig, http: RequestOptions = {}): ProviderAdapter {
  return {
    id: 'ebay',
    capabilities: { search: true, auctions: true, webhooks: false, regions: false, publishedAt: true },
    validateConfig: () => cfg.ebayAppId && cfg.ebayClientSecret ? { ok: true } : { ok: false, reason: 'EBAY_APP_ID / EBAY_CLIENT_SECRET fehlen' },
    async search({ query, variant = 'default', beforeRequest }) {
      const token = await getEbayToken(cfg, http);
      // Without a buyingOptions filter eBay omits pure auctions (verified live 31.10.2026).
      const params = new URLSearchParams({ q: query, limit: '200', sort: 'newlyListed', filter: variant === 'auction' ? 'buyingOptions:{AUCTION}' : 'buyingOptions:{FIXED_PRICE|AUCTION}' });
      const payload = await requestJson<Row>(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
        headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE', 'Accept-Language': 'de-DE' } }, { ...http, beforeRequest });
      return { listings: (payload.itemSummaries || []).map(normalizeEbay).filter(isListing), fetchedAt: new Date().toISOString() };
    },
  };
}

export function normalizeKlaz(row: Row): NormalizedListing | null {
  const id = first(row.ad_id, row.id, row.adId);
  const url = first(row.ad_url, row.url, row.link);
  const p = first(row.price?.amount, row.price?.value, typeof row.price === 'number' ? row.price : null);
  if (!id || !url || p === undefined || !Number.isFinite(Number(p)) || (row.price?.currency_code && row.price.currency_code !== 'EUR')) return null;
  const shipping = first(row.shipping?.amount, row.shipping_cost?.amount, row.shipping_cost);
  return { source: 'kleinanzeigen', externalId: String(id), title: row.title ?? '', description: row.description ?? '', url: String(url),
    imageUrl: (first(row.images?.[0]?.url, row.images?.[0]?.image_url, row.image_url) ?? null) as string | null,
    priceEur: Number(p), shippingEur: shipping === undefined || !Number.isFinite(Number(shipping)) ? null : Number(shipping),
    condition: String(first(row.condition?.label, typeof row.condition === 'string' ? row.condition : null, '') || ''),
    publishedAt: (first(row.created_at, row.published_at) ?? null) as string | null };
}
export function kleinanzeigenAdapter(cfg: ProviderConfig, http: RequestOptions = {}): ProviderAdapter {
  return {
    id: 'kleinanzeigen',
    capabilities: { search: true, auctions: false, webhooks: true, regions: true, publishedAt: true },
    validateConfig: () => cfg.klazKey ? { ok: true } : { ok: false, reason: 'KLAZ_API_KEY fehlt' },
    async search({ query, beforeRequest }) {
      if (!cfg.klazKey) throw new ProviderError('AUTH', 'Kleinanzeigen Agent API-Key fehlt');
      const u = new URL('https://api.kleinanzeigen-agent.de/api/v2/kleinanzeigen/search');
      u.searchParams.set('q', query); u.searchParams.set('size', '100');
      if (cfg.klazLocationId) u.searchParams.set('location_id', cfg.klazLocationId);
      if (cfg.klazRadiusKm && cfg.klazLocationId) u.searchParams.set('distance', cfg.klazRadiusKm);
      const payload = await requestJson<Row>(u, { headers: { klaz_key: cfg.klazKey } }, { ...http, beforeRequest });
      if (payload.success === false) throw new ProviderError('HTTP', 'Kleinanzeigen Agent meldet success=false');
      const ads = payload?.data?.ads;
      if (!Array.isArray(ads)) throw new ProviderError('SCHEMA_CHANGE', 'Kleinanzeigen Agent: unerwartetes data.ads-Schema');
      return { listings: ads.map(normalizeKlaz).filter(isListing), fetchedAt: new Date().toISOString() };
    },
  };
}

export function normalizeFacebook(row: Row): NormalizedListing | null {
  const url = first(row.url, row.listingUrl, row.itemUrl, row.item_url, row.listing_url);
  let parsed: URL; try { parsed = new URL(String(url)); } catch { return null; }
  if (parsed.protocol !== 'https:' || !['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(parsed.hostname)) return null;
  const id = first(row.id, row.listingId, row.listing_id, row.itemId, parsed.pathname.match(/\/item\/(\d+)/)?.[1]);
  const price = first(row.priceAmount, row.price_amount, row.price?.amount, row.price?.value, typeof row.price === 'number' ? row.price : null);
  if (!id || price === undefined || !Number.isFinite(Number(price))) return null;
  return { source: 'facebook', externalId: String(id), title: String(first(row.title, row.name, '')).slice(0, 500),
    description: String(first(row.description, row.body, '')), url: parsed.href,
    imageUrl: (first(row.imageUrl, row.image_url, row.photoUrl, row.photo_url) ?? null) as string | null,
    priceEur: Number(price), shippingEur: null, condition: String(first(row.condition) ?? ''),
    publishedAt: (first(row.createdAt, row.created_at, row.listedAt, row.publishedAt) ?? null) as string | null };
}

export const createAdapters = (cfg: ProviderConfig, http: RequestOptions = {}): Record<LiveSource, ProviderAdapter> =>
  ({ ebay: ebayAdapter(cfg, http), kleinanzeigen: kleinanzeigenAdapter(cfg, http) });

export interface ProviderState { ready: boolean; approved: boolean; enabled: boolean; live: boolean; kind: string; status: string }
/**
 * ready = credentials present; approved = documented GO (APPROVED_PROVIDERS); enabled = runtime switch (DB).
 * Only all three together allow live calls.
 */
export const providerReady = (cfg: ProviderConfig, disabled: ReadonlySet<string> = new Set()) => {
  const entry = (ready: boolean, name: string, kind: string, status: string): ProviderState => {
    const approved = !!cfg.approvedProviders?.includes(name), enabled = !disabled.has(name);
    return { ready, approved, enabled, live: ready && approved && enabled, kind, status };
  };
  return {
    ebay: entry(!!(cfg.ebayAppId && cfg.ebayClientSecret), 'ebay', 'official', 'Offizielle Browse API · GO LIMITED (Standardquelle)'),
    kleinanzeigen: entry(!!cfg.klazKey, 'kleinanzeigen', 'third-party', 'Drittanbieter · NO GO bis Nutzungsfreigabe'),
    // Facebook is import-only: never live, regardless of APPROVED_PROVIDERS.
    facebook: { ready: false, approved: false, enabled: false, live: false, kind: 'manual-import', status: 'Nur manueller Import · NO GO für Live-Suche' } as ProviderState,
  };
};
export type ProviderStates = ReturnType<typeof providerReady>;

export interface PlannedQuery { platform: LiveSource; query: string; label: string; key: string }
interface PlanWatch { query: string; sourceList: string[]; active: boolean }
/** Provider calls for one scan: eBay GPU watchlists share broad buckets, free-text queries run as-is. key = dedupe/budget key. */
export function planScan(watches: PlanWatch[], ready: ProviderStates, source = 'all'): PlannedQuery[] {
  const pairs = new Map<string, PlannedQuery>();
  for (const watch of watches.filter(x => x.active)) {
    for (const platform of watch.sourceList) {
      if (!(LIVE_SOURCES as readonly string[]).includes(platform) || (source !== 'all' && source !== platform) || !ready[platform as LiveSource].live) continue;
      const live = platform as LiveSource;
      const targets = live === 'ebay' ? resolveWatchTargets(watch.query) : null;
      const buckets = targets ? [...targets.profiles].map(bucketForProfile).filter(b => b !== null) : [];
      if (buckets.length) { for (const b of buckets) pairs.set(`ebay|bucket:${b.id}`, { platform: live, query: b.query, label: b.id, key: `ebay|bucket:${b.id}` }); continue; }
      const key = `${live}|${watch.query.toLowerCase()}`;
      pairs.set(key, { platform: live, query: watch.query, label: watch.query, key });
    }
  }
  return [...pairs.values()];
}
