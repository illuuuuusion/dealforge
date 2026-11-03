import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, detectFaults, repairAssessment, repairScenarios, repairActual, repairStats, scoreListing, type RepairSettings } from '../src/index.ts';

test('DF-401: fault classes, several at once, UNKNOWN when nothing is named', () => {
  assert.deepEqual(detectFaults({ title: 'RTX 3080 kein Bild, Artefakte beim Booten' }), ['NO_DISPLAY', 'ARTIFACTS']);
  assert.deepEqual(detectFaults({ title: 'RX 6800 Treiberabsturz, Code 43' }), ['DRIVER_CRASH']);
  assert.deepEqual(detectFaults({ title: 'RTX 2080 startet nicht', description: 'Kurzschluss auf 12V' }), ['NO_POWER']);
  assert.deepEqual(detectFaults({ title: 'RTX 3070 Wasserschaden, verschmort' }), ['WATER_DAMAGE', 'BURN_DAMAGE']);
  assert.deepEqual(detectFaults({ title: 'RTX 3090 defekt ohne Kühler' }), ['PARTS_MISSING']);
  assert.deepEqual(detectFaults({ title: 'RTX 3080 defekt', description: 'Kein Wasserschaden, nicht verbrannt' }), []);
  assert.deepEqual(repairAssessment({ title: 'RTX 3080 defekt' }).faults, ['UNKNOWN']);
  assert.equal(classify({ title: 'RX 6800 XT Code 43' }), 'defect');
});

test('DF-402: no display is no promise, damage warns, contradictions lower confidence', () => {
  const noDisplay = repairAssessment({ title: 'RTX 3080 kein Bild, Lüfter drehen', description: 'unverbastelt, mit Kühler' });
  assert.ok(noDisplay.warnings.some(w => /keine Diagnose/.test(w)));
  assert.equal(noDisplay.confidence, 'mittel');
  const water = repairAssessment({ title: 'RTX 3080 Wasserschaden' });
  assert.ok(water.warnings.some(w => /Wasserschaden/.test(w)));
  assert.ok(water.score < noDisplay.score);
  const conflict = repairAssessment({ title: 'RTX 3080 startet nicht, Lüfter drehen', description: 'unverbastelt, mit Kühler' });
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.confidence, 'niedrig');
  assert.ok(repairAssessment({ title: 'RTX 3080 ungeöffnet', description: 'Reparaturversuch mit Reflow' }).conflicts.length === 1);
  const a = scoreListing({ title: 'RTX 3080 defekt Wasserschaden', priceEur: 50, shippingEur: 5 }, { query: 'RTX 3080', maxWorking: 300, maxDefect: 100 })!;
  assert.deepEqual(a.repairFaults, ['WATER_DAMAGE']);
  assert.ok(a.reasons.includes('Warnung: Wasser-/Brandschaden'));
});

const settings: RepairSettings = { hourlyRateEur: 20, saleFeePct: 10, resaleShippingEur: 10, costs: [
  { fault: 'NO_DISPLAY', model: '', partsMin: 10, partsMax: 50, hoursMin: 1, hoursMax: 3 },
  { fault: 'NO_DISPLAY', model: 'RTX 3080', partsMin: 20, partsMax: 80, hoursMin: 2, hoursMax: 4 },
  { fault: 'ARTIFACTS', model: '', partsMin: 30, partsMax: 100, hoursMin: 2, hoursMax: 5 },
] };

test('DF-403/404: worst/base/best with labor, fees, shipping and parts; model rules win', () => {
  const r = repairScenarios({ purchaseEur: 100, shippingEur: 10, faults: ['NO_DISPLAY', 'ARTIFACTS'], model: 'RTX 2080', resaleEur: 300, salvageEur: 40 }, settings);
  const [worst, base, best] = r.scenarios;
  // best = dearest single minimum (30 €, 2 h), worst = all maxima (150 €, 8 h)
  assert.deepEqual([best.partsEur, best.hours, worst.partsEur, worst.hours], [30, 2, 150, 8]);
  assert.equal(best.investmentEur, 100 + 10 + 30 + 40);
  assert.equal(best.revenueEur, 300 * 0.9 - 10);
  assert.equal(best.marginEur, 260 - 180);
  assert.equal(worst.success, false);
  assert.equal(worst.revenueEur, 40 * 0.9 - 10);
  assert.equal(worst.marginEur, 26 - (110 + 150 + 160));
  assert.equal(base.partsEur, 90); assert.equal(base.hours, 5);
  assert.ok(r.assumptions.some(a => /Keine Erfolgswahrscheinlichkeit/.test(a)));
  const model = repairScenarios({ purchaseEur: 100, shippingEur: 10, faults: ['NO_DISPLAY'], model: 'RTX 3080', resaleEur: null, salvageEur: 0 }, settings);
  assert.equal(model.scenarios[0].partsEur, 80);
  assert.equal(model.scenarios[1].marginEur, null, 'no resale value, no margin');
  assert.equal(model.scenarios[0].revenueEur, 0);
  const unknown = repairScenarios({ purchaseEur: 100, shippingEur: null, faults: ['DRIVER_CRASH'], model: null, resaleEur: 200, salvageEur: 0 }, settings);
  assert.equal(unknown.shippingKnown, false);
  assert.ok(unknown.assumptions.some(a => /Untergrenze/.test(a)));
  assert.ok(unknown.assumptions.some(a => /keine Kostenannahme/.test(a)));
});

test('DF-406/407: actual margin only when closed; rates only from enough own projects', () => {
  const input = { purchaseEur: 100, shippingEur: 10, partsEur: [15, 5], hours: 3, soldEur: 250, soldFeesEur: 25, soldShippingEur: 8, closed: true };
  assert.deepEqual(repairActual(input, 20), { costsEur: 130, revenueEur: 217, marginEur: 87, laborEur: 60, marginInclLaborEur: 27 });
  assert.equal(repairActual({ ...input, closed: false }, 20), null);
  const p = (outcome: 'open' | 'success' | 'failed', marginEur: number | null) => ({ faults: ['NO_DISPLAY' as const], outcome, marginEur });
  const few = repairStats([p('success', 50), p('failed', -100), p('open', null)]);
  assert.equal(few.items[0].n, 2); assert.equal(few.items[0].successRatePct, null);
  const many = repairStats([p('success', 50), p('success', 30), p('success', 10), p('failed', -100), p('success', null)]);
  assert.deepEqual(many.items.find(i => i.fault === 'NO_DISPLAY'), { fault: 'NO_DISPLAY', n: 5, success: 4, partial: 0, failed: 1, successRatePct: 80, marginSamples: 4, avgMarginEur: -2.5 });
});
