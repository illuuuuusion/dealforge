/** Environment validation. Invalid numbers fall back to their default instead of crashing the process. */
import fs from 'node:fs';
import { format } from 'node:util';
import { z } from 'zod';

const int = (fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).catch(fallback);
const str = (fallback = '') => z.string().default(fallback);
const list = z.string().default('').transform(v => v.split(',').map(x => x.trim()).filter(Boolean));

const schema = z.object({
  HOST: str('127.0.0.1'),
  PORT: int(3000, 1, 65535),
  APP_PASSWORD: str(),
  // Encrypts app_secrets at rest (DF-603); required wherever APP_PASSWORD is. Rotation: old key into SECRETS_KEY_PREVIOUS, restart.
  SECRETS_KEY: str(),
  SECRETS_KEY_PREVIOUS: str(),
  APP_ORIGIN: str(),
  // Proxies whose X-Forwarded-For is trusted (Fastify trustProxy): '' = none, 'true' or addresses/CIDRs/'uniquelocal'.
  TRUST_PROXY: str(),
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

/** X_FILE=/run/secrets/x reads X from a file (Docker/Compose secrets); a directly set X wins. */
function withFiles(env: NodeJS.ProcessEnv) {
  const out = { ...env };
  for (const key of Object.keys(schema.shape)) {
    const file = env[`${key}_FILE`];
    if (file && !env[key]) out[key] = fs.readFileSync(file, 'utf8').trim();
  }
  return out;
}
const trustProxy = (v: string): boolean | string => v === '' || v === 'false' ? false : v === 'true' ? true : v;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = schema.parse(withFiles(env));
  return {
    host: e.HOST, port: e.PORT, appPassword: e.APP_PASSWORD, secretsKey: e.SECRETS_KEY, secretsKeyPrevious: e.SECRETS_KEY_PREVIOUS,
    appOrigin: e.APP_ORIGIN, trustProxy: trustProxy(e.TRUST_PROXY),
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

/** Masks configured secret values and common credential patterns in log and status text (DF-603). */
export function createRedactor(config: Pick<Config, 'appPassword' | 'secretsKey' | 'secretsKeyPrevious' | 'ebayAppId' | 'ebayClientSecret' | 'klazKey'>) {
  const values = [config.appPassword, config.secretsKey, config.secretsKeyPrevious, config.ebayAppId, config.ebayClientSecret, config.klazKey].filter(v => v.length >= 6);
  return (text: string) => values.reduce((out, v) => out.split(v).join('[REDACTED]'), text)
    .replace(/(\/\/[^:/@\s]+:)[^@\s]+@/g, '$1[REDACTED]@')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [REDACTED]')
    .replace(/\b(klaz_key|access_token|refresh_token|client_secret|api_?key|password|token)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, '$1$2[REDACTED]');
}
export type Redact = ReturnType<typeof createRedactor>;
/** Every console line of the process goes through the redactor. */
export function redactConsole(redact: Redact) {
  for (const m of ['log', 'info', 'warn', 'error'] as const) {
    const write = console[m].bind(console);
    console[m] = (...args: unknown[]) => write(redact(format(...args)));
  }
}
