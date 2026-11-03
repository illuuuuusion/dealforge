/** Market view from offer prices: robust quantiles, outlier filter, minimum sample. Offer prices are never sale prices. */
import { profiles } from './gpu.ts';

export const MARKET_METHOD = 'Angebotspreise ohne Versand, 1 Beobachtung je Inserat (aktueller Preis), Ausreißer außerhalb 1,5×IQR entfernt, Quantile linear interpoliert';
export const MARKET_NOTE = 'Angebotspreise aktiver und zuletzt gesehener Inserate – keine tatsächlich erzielten Verkaufspreise';
/** Weekly points need fewer values than the market value itself; each point still shows its n. */
export const MIN_WEEK_SAMPLE = 5;

const r2 = (v: number) => Math.round(v * 100) / 100;
/** Linear interpolation between closest ranks (same as R type 7 / numpy default). */
export function quantile(sorted: number[], q: number) {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
/** Quantiles after removing values outside 1.5×IQR (Tukey); below 4 values nothing is filtered. */
export function robustQuantiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  let kept = sorted;
  if (sorted.length >= 4) {
    const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75), fence = 1.5 * (q3 - q1);
    kept = sorted.filter(v => v >= q1 - fence && v <= q3 + fence);
  }
  return { n: kept.length, outliers: sorted.length - kept.length, p25: r2(quantile(kept, 0.25)), p50: r2(quantile(kept, 0.5)), p75: r2(quantile(kept, 0.75)),
    min: kept[0], max: kept[kept.length - 1] };
}

const variantFamilies = new Set(profiles.filter(p => p.family).map(p => p.family));
export interface Observation { priceEur: number; offerType?: string | null; modelKey: string | null }
/** Why an offer does not belong into a market value, or null when it is comparable. */
export function comparability(o: Observation): string | null {
  if (o.offerType === 'AUCTION') return 'Auktion: aktuelles Gebot ist kein Angebotspreis';
  if (o.modelKey && variantFamilies.has(o.modelKey)) return 'VRAM-Variante unbekannt';
  if (o.priceEur <= 0) return 'Verschenkt';
  return null;
}

/** Market value of one group (model + VRAM + condition + source filter); reliable only from minSample kept values on. */
export function marketStats(obs: Observation[], minSample: number) {
  const excluded = new Map<string, number>();
  const prices: number[] = [];
  for (const o of obs) {
    const why = comparability(o);
    if (why) excluded.set(why, (excluded.get(why) ?? 0) + 1); else prices.push(o.priceEur);
  }
  const q = robustQuantiles(prices);
  const reliable = !!q && q.n >= minSample;
  return { observations: obs.length, n: q?.n ?? 0, outliersRemoved: q?.outliers ?? 0, minSample, reliable,
    quantiles: reliable && q ? { p25: q.p25, p50: q.p50, p75: q.p75, min: q.min, max: q.max } : null,
    excluded: [...excluded].map(([reason, n]) => ({ reason, n })),
    message: reliable ? null : `Keine verlässliche Schätzung: ${q?.n ?? 0} von mindestens ${minSample} vergleichbaren Angeboten` };
}

const weekStart = (iso: string) => {
  const d = new Date(iso); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
};
/** Asking prices of listings first seen per ISO week (Monday, UTC); quantiles only from MIN_WEEK_SAMPLE values on. */
export function weeklyHistory(obs: (Observation & { firstSeenAt: string })[]) {
  const weeks = new Map<string, number[]>();
  for (const o of obs) if (!comparability(o)) weeks.set(weekStart(o.firstSeenAt), [...weeks.get(weekStart(o.firstSeenAt)) ?? [], o.priceEur]);
  return [...weeks].sort(([a], [b]) => a.localeCompare(b)).map(([week, prices]) => {
    const q = robustQuantiles(prices)!;
    const ok = q.n >= MIN_WEEK_SAMPLE;
    return { weekStart: week, n: q.n, p25: ok ? q.p25 : null, p50: ok ? q.p50 : null, p75: ok ? q.p75 : null };
  });
}
