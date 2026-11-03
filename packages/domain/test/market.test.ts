import test from 'node:test';
import assert from 'node:assert/strict';
import { comparability, detectModel, marketStats, quantile, robustQuantiles, scoreListing, weeklyHistory, DEFAULT_WEIGHTS } from '../src/index.ts';

const obs = (prices: number[], extra = {}) => prices.map(priceEur => ({ priceEur, offerType: 'FIXED_PRICE', modelKey: 'RTX 3060 (12GB)', ...extra }));

test('DF-501: model keys keep VRAM variants apart; family without VRAM is not comparable', () => {
  assert.equal(detectModel({ title: 'RTX 3060 8GB' })?.model, 'RTX 3060 (8GB)');
  assert.equal(detectModel({ title: 'RTX 3060 12GB' })?.model, 'RTX 3060 (12GB)');
  assert.equal(comparability({ priceEur: 200, modelKey: 'RTX 3060' }), 'VRAM-Variante unbekannt');
  assert.equal(comparability({ priceEur: 200, modelKey: 'RTX 3060 (12GB)', offerType: 'AUCTION' }), 'Auktion: aktuelles Gebot ist kein Angebotspreis');
  assert.equal(comparability({ priceEur: 200, modelKey: 'RTX 3090' }), null);
});

test('DF-502: linear quantiles; a 1 € listing does not move the market value', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([10, 20, 30, 40, 50], 0.25), 20);
  const prices = Array.from({ length: 20 }, (_, i) => 200 + i * 5);
  const clean = robustQuantiles(prices)!, dirty = robustQuantiles([...prices, 1, 1, 9999])!;
  assert.equal(dirty.outliers, 3);
  assert.deepEqual([dirty.p25, dirty.p50, dirty.p75], [clean.p25, clean.p50, clean.p75]);
  assert.equal(robustQuantiles([1, 300, 310])!.outliers, 0, 'too few values to filter');
});

test('DF-503/504: excluded offers are listed by reason; below the minimum sample no estimate', () => {
  const few = marketStats([...obs([250, 260, 270]), ...obs([100], { offerType: 'AUCTION' })], 20);
  assert.equal(few.reliable, false); assert.equal(few.quantiles, null); assert.equal(few.n, 3);
  assert.match(few.message ?? '', /Keine verlässliche Schätzung: 3 von mindestens 20/);
  assert.deepEqual(few.excluded, [{ reason: 'Auktion: aktuelles Gebot ist kein Angebotspreis', n: 1 }]);
  const many = marketStats(obs(Array.from({ length: 20 }, (_, i) => 200 + i)), 20);
  assert.equal(many.reliable, true); assert.equal(many.quantiles?.p50, 209.5);
});

test('DF-505: weekly history groups by Monday (UTC) and hides quantiles of thin weeks', () => {
  const at = (d: string) => obs([300]).map(o => ({ ...o, firstSeenAt: d }))[0];
  const h = weeklyHistory([...Array.from({ length: 5 }, () => at('2026-11-02T10:00:00Z')), at('2026-11-08T23:00:00Z'), at('2026-10-30T10:00:00Z')]);
  assert.deepEqual(h.map(w => [w.weekStart, w.n, w.p50]), [['2026-10-26', 1, null], ['2026-11-02', 6, 300]]);
});

test('DF-506: weighted, explained priority; no context keeps the default ranking', () => {
  const listing = { title: 'RTX 3090 24GB', priceEur: 500, shippingEur: 10 }, rules = { query: 'RTX 3090', maxWorking: 700, maxDefect: 200 };
  const plain = scoreListing(listing, rules)!;
  assert.equal(plain.market, null);
  assert.deepEqual(plain.priorityParts.map(p => p.key), ['price']);
  const ctx = { market: { medianEur: 600, n: 25, windowDays: 30 }, personal: [{ label: 'Modell gemerkt/gekauft', points: 10 }] };
  const ranked = scoreListing(listing, rules, new Date(), ctx)!;
  assert.equal(ranked.market?.belowPct, 17);
  assert.ok(ranked.reasons.some(r => r === '17% unter Angebots-Median 600 € (25 Inserate, 30 Tage)'));
  assert.deepEqual(ranked.priorityParts.map(p => [p.key, p.points]), [['price', 20], ['market', 9], ['personal', 10]]);
  assert.deepEqual([plain.priority, ranked.priority], [45, 64], '25 + 20.25 + 8.5 + 10, rounded once');
  const off = scoreListing(listing, rules, new Date(), { ...ctx, weights: { ...DEFAULT_WEIGHTS, market: 0, personal: 0 } })!;
  assert.equal(off.priority, plain.priority);
  const auction = scoreListing({ ...listing, offerType: 'AUCTION' }, rules, new Date(), ctx)!;
  assert.equal(auction.market, null, 'a bid is not compared with offer prices');
});
