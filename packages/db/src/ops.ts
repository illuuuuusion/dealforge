/** Operations data: encrypted app secrets, sessions, audit log, incidents and retention (P6). */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Queryable } from './pool.ts';

// --- Secrets at rest (DF-603): app_secrets rows are AES-256-GCM encrypted with SECRETS_KEY ---
export interface SecretKeys { secretsKey: string; secretsKeyPrevious: string }
const derive = (key: string) => createHash('sha256').update(key).digest();
const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 8);

/** Stored form enc:v1:<key id>:<iv>:<tag>:<ciphertext>; without SECRETS_KEY (demo/dev) the value stays plain. */
export function sealSecret(keys: SecretKeys, plain: string) {
  if (!keys.secretsKey) return plain;
  const key = derive(keys.secretsKey), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['enc', 'v1', keyId(key), iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join(':');
}
export function openSecret(keys: SecretKeys, stored: string) {
  if (!stored.startsWith('enc:')) return stored; // written before SECRETS_KEY was set; resealSecrets encrypts it
  const [, , id, iv, tag, data] = stored.split(':');
  const key = [keys.secretsKey, keys.secretsKeyPrevious].filter(Boolean).map(derive).find(k => keyId(k) === id);
  if (!key) throw Error('Gespeicherte Secrets passen nicht zu SECRETS_KEY (bei Rotation den alten Schlüssel als SECRETS_KEY_PREVIOUS setzen)');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
/** Generated once on first use and shared by all processes; concurrent first calls agree on one value. */
export async function getOrCreateSecret(db: Queryable, name: string, create: () => string, keys: SecretKeys) {
  await db.query('INSERT INTO app_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [name, sealSecret(keys, create())]);
  return openSecret(keys, (await db.query('SELECT value FROM app_secrets WHERE name = $1', [name])).rows[0].value);
}
/** Re-encrypts every row not under the current key (plain or SECRETS_KEY_PREVIOUS). Runs at API start, so rotation = new key + previous key + restart. */
export async function resealSecrets(db: Queryable, keys: SecretKeys) {
  if (!keys.secretsKey) return 0;
  const current = `enc:v1:${keyId(derive(keys.secretsKey))}:`;
  let n = 0;
  for (const r of (await db.query('SELECT name, value FROM app_secrets')).rows) {
    if (r.value.startsWith(current)) continue;
    n += (await db.query('UPDATE app_secrets SET value = $3 WHERE name = $1 AND value = $2', [r.name, r.value, sealSecret(keys, openSecret(keys, r.value))])).rowCount ?? 0;
  }
  return n;
}

// --- Sessions (DF-601) ---
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
export const SESSION_DAYS = 7;
/** Returns the cookie token; only its hash is stored. */
export async function createSession(db: Queryable, passwordTag: string, userAgent: string | null) {
  const token = randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO sessions (token_hash, password_tag, expires_at, user_agent) VALUES ($1, $2, now() + make_interval(days => $3), $4)`,
    [sha256(token), passwordTag, SESSION_DAYS, userAgent?.slice(0, 200) ?? null]);
  return token;
}
export async function sessionValid(db: Queryable, token: string, passwordTag: string) {
  if (!/^[\w-]{43}$/.test(token)) return false;
  return (await db.query('SELECT 1 FROM sessions WHERE token_hash = $1 AND password_tag = $2 AND expires_at > now()', [sha256(token), passwordTag])).rowCount === 1;
}
export async function deleteSessions(db: Queryable, token: string | null) {
  return (await (token === null ? db.query('DELETE FROM sessions') : db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]))).rowCount ?? 0;
}

// --- Audit log (DF-603) ---
export interface AuditEntry { method: string; path: string; status: number; ip: string | null; userAgent: string | null; requestId: string | null }
export async function audit(db: Queryable, e: AuditEntry) {
  await db.query('INSERT INTO audit_log (method, path, status, ip, user_agent, request_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [e.method, e.path.slice(0, 200), e.status, e.ip, e.userAgent?.slice(0, 200) ?? null, e.requestId]);
}
export async function auditLog(db: Queryable, limit = 50) {
  return (await db.query('SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT $1', [limit])).rows.map(r => ({ id: r.id as number, at: r.at as string,
    method: r.method as string, path: r.path as string, status: r.status as number, ip: r.ip as string | null, userAgent: r.user_agent as string | null, requestId: r.request_id as string | null }));
}

// --- Incidents (DF-606) ---
/** Returns the new incident's id, or null if one is already open for this subject. */
export async function openIncident(db: Queryable, subject: string, message: string) {
  const r = await db.query('INSERT INTO incidents (subject, message) VALUES ($1, $2) ON CONFLICT (subject) WHERE resolved_at IS NULL DO NOTHING RETURNING id', [subject, message.slice(0, 300)]);
  return (r.rows[0]?.id as number | undefined) ?? null;
}
export async function resolveIncident(db: Queryable, subject: string) {
  return (await db.query('UPDATE incidents SET resolved_at = now() WHERE subject = $1 AND resolved_at IS NULL', [subject])).rowCount === 1;
}
export async function recentIncidents(db: Queryable, limit = 10) {
  return (await db.query('SELECT * FROM incidents ORDER BY resolved_at IS NULL DESC, opened_at DESC LIMIT $1', [limit])).rows.map(r => ({ id: r.id as number,
    subject: r.subject as string, message: r.message as string, openedAt: r.opened_at as string, resolvedAt: r.resolved_at as string | null }));
}

// --- Retention (DF-607, docs/decisions/002-privacy-retention.md) ---
export const RETENTION_DAYS = { logs: 90, listings: 400 };
/** Deletes expired data. Listings: unseen for 400 days (beyond the 365-day market window), unless saved/contacted/bought or in a repair project. */
export async function purgeExpired(db: Queryable) {
  const del = async (sql: string, days: number) => (await db.query(sql, [days])).rowCount ?? 0;
  const age = (col: string) => `${col} < now() - make_interval(days => $1)`;
  return {
    sessions: (await db.query('DELETE FROM sessions WHERE expires_at < now()')).rowCount ?? 0,
    auditLog: await del(`DELETE FROM audit_log WHERE ${age('at')}`, RETENTION_DAYS.logs),
    sourceRuns: await del(`DELETE FROM source_runs WHERE ${age('started_at')}`, RETENTION_DAYS.logs),
    deliveries: await del(`DELETE FROM alert_deliveries WHERE ${age('created_at')}`, RETENTION_DAYS.logs),
    incidents: await del(`DELETE FROM incidents WHERE ${age('resolved_at')}`, RETENTION_DAYS.logs),
    providerUsage: await del(`DELETE FROM provider_usage WHERE day < (now() - make_interval(days => $1))::date`, RETENTION_DAYS.logs),
    listings: await del(`DELETE FROM listings l WHERE ${age('l.last_seen_at')} AND l.status IN ('new', 'dismissed')
      AND NOT EXISTS (SELECT 1 FROM repair_projects p WHERE p.listing_id = l.id)`, RETENTION_DAYS.listings),
  };
}
