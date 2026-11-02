/** Environment validation. Invalid numbers fall back to their default instead of crashing the process. */
import { z } from 'zod';

const int = (fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).catch(fallback);
const str = (fallback = '') => z.string().default(fallback);
const list = z.string().default('').transform(v => v.split(',').map(x => x.trim()).filter(Boolean));

const schema = z.object({
  HOST: str('127.0.0.1'),
  PORT: int(3000, 1, 65535),
  APP_PASSWORD: str(),
  SESSION_SECRET: str(),
  APP_ORIGIN: str(),
  DEMO_MODE: str('true').transform(v => v !== 'false'),
  ENABLE_SCHEDULER: str('false').transform(v => v === 'true'),
  POLL_INTERVAL_SECONDS: int(300, 60, 3600),
  // Fast watchlists (DF-301): own schedule, only for these sources. Empty = fast mode plans nothing.
  FAST_POLL_INTERVAL_SECONDS: int(60, 30, 3600),
  FAST_PROVIDERS: list,
  // Contact for push services (VAPID); the key pair itself is generated once and kept in the database.
  VAPID_SUBJECT: str('mailto:dealforge@localhost'),
  DATABASE_URL: str('postgres://dealforge:dealforge@127.0.0.1:55432/dealforge'),
  REDIS_URL: str('redis://127.0.0.1:56379'),
  QUEUE_PREFIX: str('dealforge'),
  EBAY_APP_ID: str(),
  EBAY_CLIENT_SECRET: str(),
  KLAZ_API_KEY: str(),
  KLAZ_LOCATION_ID: str(),
  KLAZ_RADIUS_KM: str(),
  // Live polling only for sources with a documented GO (docs/decisions/001-provider-policy.md).
  APPROVED_PROVIDERS: list,
  // Hard budget gate per provider: UTC day, calendar month and single search filter (query key) per day.
  PROVIDER_DAILY_CALL_LIMIT: int(200, 1, 100000),
  PROVIDER_MONTHLY_CALL_LIMIT: int(5000, 1, 3000000),
  QUERY_DAILY_CALL_LIMIT: int(100, 1, 100000),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = schema.parse(env);
  return {
    host: e.HOST, port: e.PORT, appPassword: e.APP_PASSWORD, sessionSecret: e.SESSION_SECRET, appOrigin: e.APP_ORIGIN,
    demoMode: e.DEMO_MODE, scheduler: e.ENABLE_SCHEDULER, pollSeconds: e.POLL_INTERVAL_SECONDS,
    fastPollSeconds: e.FAST_POLL_INTERVAL_SECONDS, fastProviders: e.FAST_PROVIDERS, vapidSubject: e.VAPID_SUBJECT,
    databaseUrl: e.DATABASE_URL, redisUrl: e.REDIS_URL, queuePrefix: e.QUEUE_PREFIX,
    ebayAppId: e.EBAY_APP_ID, ebayClientSecret: e.EBAY_CLIENT_SECRET,
    klazKey: e.KLAZ_API_KEY, klazLocationId: e.KLAZ_LOCATION_ID, klazRadiusKm: e.KLAZ_RADIUS_KM,
    approvedProviders: e.APPROVED_PROVIDERS,
    limits: { daily: e.PROVIDER_DAILY_CALL_LIMIT, monthly: e.PROVIDER_MONTHLY_CALL_LIMIT, perQueryDaily: e.QUERY_DAILY_CALL_LIMIT },
  };
}
export type Config = ReturnType<typeof loadConfig>;
export type BudgetLimits = Config['limits'];
