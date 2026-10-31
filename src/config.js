import { resolve } from 'node:path';
const positiveInt = (key, fallback, min=1, max=3600) => {
  const value = Number(process.env[key] ?? fallback);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};
export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: positiveInt('PORT', 3000, 1, 65535),
  dbPath: resolve(process.env.DB_PATH || './data/dealforge.sqlite'),
  appPassword: process.env.APP_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  appOrigin: process.env.APP_ORIGIN || '',
  demoMode: process.env.DEMO_MODE !== 'false',
  scheduler: process.env.ENABLE_SCHEDULER === 'true',
  pollSeconds: positiveInt('POLL_INTERVAL_SECONDS', 300, 60, 3600),
  ebayAppId: process.env.EBAY_APP_ID || '',
  ebayClientSecret: process.env.EBAY_CLIENT_SECRET || '',
  klazKey: process.env.KLAZ_API_KEY || '',
  klazLocationId: process.env.KLAZ_LOCATION_ID || '',
  klazRadiusKm: process.env.KLAZ_RADIUS_KM || '',
};
