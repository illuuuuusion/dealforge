/** Provider HTTP: timeout, bounded retries with exponential backoff + full jitter, 429 handed back to the queue. */
export type ProviderErrorCode = 'AUTH' | 'RATE_LIMIT' | 'QUOTA' | 'SCHEMA_CHANGE' | 'NETWORK' | 'TERMS_NOT_APPROVED' | 'HTTP';

export class ProviderError extends Error {
  code: ProviderErrorCode;
  httpStatus: number | null;
  retryAfterMs: number | null;
  constructor(code: ProviderErrorCode, message: string, { httpStatus = null, retryAfterMs = null }: { httpStatus?: number | null; retryAfterMs?: number | null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface RequestOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  /** Runs before every single HTTP attempt; the budget gate throws QUOTA here, so retries are paid for too. */
  beforeRequest?: () => Promise<void>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Full jitter: uniform in [0, min(max, base·2^attempt)] keeps many retrying jobs from hitting a provider in sync. */
export const backoffMs = (attempt: number, baseMs: number, maxMs: number, random = Math.random) =>
  Math.round(random() * Math.min(maxMs, baseMs * 2 ** attempt));

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function requestJson<T>(url: string | URL, init: RequestInit = {}, opts: RequestOptions = {}): Promise<T> {
  const { attempts = 3, baseDelayMs = 1000, maxDelayMs = 30_000, timeoutMs = 14_000, beforeRequest, fetch: fetchImpl = fetch, sleep = wait, random = Math.random } = opts;
  for (let attempt = 0; ; attempt++) {
    const last = attempt + 1 >= attempts;
    await beforeRequest?.();
    let response: Response, text: string;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      text = await response.text();
    } catch (e) {
      if (last) throw new ProviderError('NETWORK', `Provider nicht erreichbar: ${(e as Error).message}`);
      await sleep(backoffMs(attempt, baseDelayMs, maxDelayMs, random));
      continue;
    }
    // 429 is not retried here: the worker pauses this provider's queue for Retry-After instead of hammering it.
    if (response.status === 429) {
      throw new ProviderError('RATE_LIMIT', 'Provider HTTP 429: Rate-Limit erreicht', {
        httpStatus: 429, retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) ?? DEFAULT_RATE_LIMIT_WAIT_MS });
    }
    if (response.status >= 500 && !last) { await sleep(backoffMs(attempt, baseDelayMs, maxDelayMs, random)); continue; }
    if (!response.ok) {
      throw new ProviderError([401, 403].includes(response.status) ? 'AUTH' : 'HTTP', `Provider HTTP ${response.status}: ${text.slice(0, 180)}`, { httpStatus: response.status });
    }
    try { return JSON.parse(text) as T; } catch { throw new ProviderError('SCHEMA_CHANGE', `Provider returned invalid JSON (${response.status})`, { httpStatus: response.status }); }
  }
}
