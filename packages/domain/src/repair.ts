/** Repair Lab: fault classes, risk signals, cost scenarios and own statistics. Text heuristics only, never a diagnosis. */
import type { ListingText } from './types.ts';

export const FAULTS = ['NO_DISPLAY', 'ARTIFACTS', 'DRIVER_CRASH', 'NO_POWER', 'WATER_DAMAGE', 'BURN_DAMAGE', 'PARTS_MISSING', 'UNKNOWN'] as const;
export type Fault = typeof FAULTS[number];
export const faultLabels: Record<Fault, string> = {
  NO_DISPLAY: 'Kein Bild', ARTIFACTS: 'Artefakte', DRIVER_CRASH: 'Treiberabsturz', NO_POWER: 'Startet nicht',
  WATER_DAMAGE: 'Wasserschaden', BURN_DAMAGE: 'Brandschaden', PARTS_MISSING: 'Teile fehlen', UNKNOWN: 'Fehler unbekannt',
};
// "kein Wasserschaden" / "nicht verbrannt" deny the damage instead of naming it.
const notDenied = String.raw`(?<!\b(?:kein|keine|keinen|ohne|no|nicht)\s)`;
const faultPatterns: [Fault, RegExp][] = [
  ['NO_DISPLAY', /\b(?:kein(?:e[nrms]?)?\s+(?:bild|signal)|no\s+(?:display|signal|post)|black screen|schwarzer bildschirm|bleibt schwarz)\b/i],
  ['ARTIFACTS', /\b(?:artefakte?|artifacts?|bildfehler|grafikfehler|streifen im bild)\b/i],
  ['DRIVER_CRASH', /\b(?:treiber\s*(?:absturz|abstürze|crash(?:t|es)?|fehler)|treiber\s+stürzt\s+ab|driver\s+(?:crash(?:es)?|error)|code\s*43|blue ?screen|bsod)\b/i],
  ['NO_POWER', /\b(?:(?:startet|bootet)\s+nicht|geht\s+nicht\s+an|keine (?:funktion|reaktion)|komplett tot|no power|kurzschluss|short circuit|lüfter drehen nicht)\b/i],
  ['WATER_DAMAGE', new RegExp(`${notDenied}\\b(?:wasserschaden|water damage|flüssigkeitsschaden|korrosion|corrosion|oxidiert)\\b`, 'i')],
  ['BURN_DAMAGE', new RegExp(`${notDenied}\\b(?:brandschaden|verschmort|verbrannt|durchgebrannt|abgeraucht|burnt|burned|geschmolzen|melted)\\b`, 'i')],
  ['PARTS_MISSING', /\b(?:ohne\s+(?:chip|gpu|vram|kühler|lüfter)|kühlerlos|(?:gpu|speicher|kühler|lüfter)\s+fehlt|(?:bau)?teile\s+fehlen|fehlende\s+teile|missing\s+(?:parts|chip|cooler))\b/i],
];
export function detectFaults(listing: ListingText): Fault[] {
  const text = `${listing.title || ''} ${listing.description || ''}`;
  return faultPatterns.filter(([, rx]) => rx.test(text)).map(([f]) => f);
}

const repairPositive = [
  { pattern: /\b(?:kein bild|no display|no signal|kein signal)\b/i, weight: 14, reason: 'Kein Bild – Symptom benannt' },
  { pattern: /\b(?:artefakte|artifacts?)\b/i, weight: 10, reason: 'Artefakte – Fehlerbild beschrieben' },
  { pattern: /\b(?:lüfter drehen(?! nicht)|fans spin|geht an|startet noch|leuchtet noch)\b/i, weight: 14, reason: 'Startet teilweise' },
  { pattern: /\b(?:ungeöffnet|unverbastelt|nicht geöffnet|originalzustand)\b/i, weight: 9, reason: 'Kein Eingriff angegeben' },
  { pattern: /\b(?:mit kühler|vollständig|komplett)\b/i, weight: 7, reason: 'Komponenten vollständig' },
];
const repairNegative = [
  { pattern: /\b(?:ohne chip|gpu fehlt|ohne gpu|ohne vram|speicher fehlt)\b/i, weight: -60, reason: 'Kernkomponenten fehlen' },
  { pattern: /\b(?:pcb gebrochen|gerissen|abgebrochen|broken pcb)\b/i, weight: -35, reason: 'Mechanischer Schaden' },
  { pattern: new RegExp(`${notDenied}\\b(?:wasserschaden|verschmort|verbrannt|brandschaden|korrosion)\\b`, 'i'), weight: -45, reason: 'Wasser-/Brandschaden' },
  { pattern: /\b(?:reflow|reballing|reparaturversuch|schon repariert|bereits repariert)\b/i, weight: -28, reason: 'Vorheriger Reparaturversuch' },
  { pattern: /\b(?:ungetestet|untested|unbekannter fehler)\b/i, weight: -12, reason: 'Fehler nicht eingegrenzt' },
];
// Two statements that cannot both be true: the fault picture is unclear, so confidence drops.
const conflicts: [RegExp, RegExp, string][] = [
  [/\b(?:(?:startet|bootet)\s+nicht|geht\s+nicht\s+an|komplett tot|no power)\b/i, /\b(?:lüfter drehen(?! nicht)|fans spin|startet noch|leuchtet noch)\b/i,
    'Widerspruch: „startet nicht“, aber Lüfter/LEDs laufen'],
  [/\b(?:ungeöffnet|unverbastelt|nicht geöffnet|originalzustand)\b/i, /\b(?:reflow|reballing|reparaturversuch|schon repariert|bereits repariert)\b/i,
    'Widerspruch: „ungeöffnet“, aber Reparaturversuch erwähnt'],
  [/(?<!nicht\s)\b(?:funktioniert einwandfrei|läuft einwandfrei|voll funktionsfähig)\b/i, /\b(?:defekt|kaputt|kein bild|artefakte|startet nicht)\b/i,
    'Widerspruch: „funktioniert“ und Defektangabe zugleich'],
];
const warningsFor: Partial<Record<Fault, string>> = {
  NO_DISPLAY: '„Kein Bild“ ist eine Verkäuferangabe, keine Diagnose',
  WATER_DAMAGE: 'Wasserschaden: Korrosion und Folgeschäden oft erst nach dem Zerlegen sichtbar',
  BURN_DAMAGE: 'Brandschaden: Platine/Bauteile können dauerhaft beschädigt sein',
  PARTS_MISSING: 'Fehlende Teile müssen erst beschafft werden',
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Heuristic repair score from listing text plus detected fault classes, warnings and contradictions. */
export function repairAssessment(listing: ListingText) {
  const text = `${listing.title || ''} ${listing.description || ''}`;
  const reasons: string[] = [];
  let score = 45;
  for (const { pattern, weight, reason } of [...repairPositive, ...repairNegative]) {
    if (pattern.test(text)) { score += weight; reasons.push(reason); }
  }
  const found = conflicts.filter(([a, b]) => a.test(text) && b.test(text)).map(([, , msg]) => msg);
  score -= found.length * 8;
  const detected = detectFaults(listing);
  const faults: Fault[] = detected.length ? detected : ['UNKNOWN'];
  const warnings = faults.map(f => warningsFor[f]).filter((w): w is string => !!w);
  if (reasons.includes('Vorheriger Reparaturversuch')) warnings.push('Vorheriger Reparaturversuch: Zustand der Platine unbekannt');
  // Text alone never earns "hoch": that would need an own measurement.
  const confidence = found.length ? 'niedrig' : reasons.length >= 3 ? 'mittel' : 'niedrig';
  return { score: clamp(score, 0, 100), confidence, faults, warnings, conflicts: found,
    reasons: reasons.length ? reasons : ['Nur grobe Textbewertung; kein Funktionstest'] };
}

export interface CostRange { partsMin: number; partsMax: number; hoursMin: number; hoursMax: number }
/** model '' = default of the fault class; a rule with the exact model wins. */
export interface RepairCostRule extends CostRange { fault: Fault; model: string }
export interface RepairSettings { hourlyRateEur: number; saleFeePct: number; resaleShippingEur: number; costs: RepairCostRule[] }

const r2 = (v: number) => Math.round(v * 100) / 100;
const de = (v: number) => v.toLocaleString('de-DE', { maximumFractionDigits: 2 });
const range = (a: number, b: number, unit: string) => a === b ? `${de(a)} ${unit}` : `${de(a)}–${de(b)} ${unit}`;

/**
 * Cost range for several faults: best = dearest single minimum (faults can share a cause),
 * worst = all maxima added up (every fault needs its own fix).
 */
export function estimateRepairCost(faults: Fault[], model: string | null, costs: RepairCostRule[]) {
  const notes: string[] = [];
  const rules = faults.map(f => {
    const rule = costs.find(c => c.fault === f && model && c.model === model) ?? costs.find(c => c.fault === f && c.model === '');
    notes.push(rule ? `${faultLabels[f]}${rule.model ? ` (${rule.model})` : ''}: Teile ${range(rule.partsMin, rule.partsMax, '€')}, ${range(rule.hoursMin, rule.hoursMax, 'h')}`
      : `${faultLabels[f]}: keine Kostenannahme hinterlegt – 0 € gerechnet`);
    return rule ?? { partsMin: 0, partsMax: 0, hoursMin: 0, hoursMax: 0 };
  });
  const max = (k: keyof CostRange) => Math.max(0, ...rules.map(r => r[k]));
  const sum = (k: keyof CostRange) => rules.reduce((s, r) => s + r[k], 0);
  return { partsMin: max('partsMin'), partsMax: sum('partsMax'), hoursMin: max('hoursMin'), hoursMax: sum('hoursMax'), notes };
}

export interface ScenarioInput { purchaseEur: number; shippingEur: number | null; faults: Fault[]; model: string | null; resaleEur: number | null; salvageEur: number }

/**
 * Worst/Base/Best without any success probability: worst = repair fails at maximum effort and the card goes
 * for its salvage value, best = cheapest fix, base = midpoint (own assumption). Margins need a resale estimate.
 */
export function repairScenarios(input: ScenarioInput, settings: RepairSettings) {
  const cost = estimateRepairCost(input.faults, input.model, settings.costs);
  const buy = input.purchaseEur + (input.shippingEur ?? 0);
  const net = (gross: number) => gross > 0 ? r2(gross * (1 - settings.saleFeePct / 100) - settings.resaleShippingEur) : 0;
  const scenario = (key: 'worst' | 'base' | 'best', label: string, success: boolean, partsEur: number, hours: number) => {
    const laborEur = r2(hours * settings.hourlyRateEur);
    const investmentEur = r2(buy + partsEur + laborEur);
    const revenueEur = success ? (input.resaleEur === null ? null : net(input.resaleEur)) : net(input.salvageEur);
    return { key, label, success, partsEur: r2(partsEur), hours: r2(hours), laborEur, investmentEur, revenueEur,
      marginEur: revenueEur === null ? null : r2(revenueEur - investmentEur) };
  };
  const assumptions = [
    `Kauf ${de(buy)} €${input.shippingEur === null ? ' ohne Versand (unbekannt – Investition ist eine Untergrenze)' : ' inkl. Versand'}`,
    ...cost.notes,
    `Arbeit ${de(settings.hourlyRateEur)} €/h · Verkaufsgebühren ${de(settings.saleFeePct)} % · Versand beim Weiterverkauf ${de(settings.resaleShippingEur)} €`,
    input.resaleEur === null ? 'Kein Wiederverkaufswert angegeben – Marge im Erfolgsfall nicht berechenbar' : `Wiederverkauf nach Reparatur ${de(input.resaleEur)} € (eigene Annahme)`,
    `Misserfolg: Verkauf als defekt für ${de(input.salvageEur)} € (eigene Annahme)`,
    'Keine Erfolgswahrscheinlichkeit: Szenarien sind Rechenbeispiele, keine Prognose',
  ];
  return {
    shippingKnown: input.shippingEur !== null, assumptions,
    scenarios: [
      scenario('worst', 'Worst Case: Reparatur scheitert', false, cost.partsMax, cost.hoursMax),
      scenario('base', 'Basis (eigene Annahme)', true, (cost.partsMin + cost.partsMax) / 2, (cost.hoursMin + cost.hoursMax) / 2),
      scenario('best', 'Best Case', true, cost.partsMin, cost.hoursMin),
    ],
  };
}

export interface ActualInput { purchaseEur: number | null; shippingEur: number | null; partsEur: number[]; hours: number;
  soldEur: number | null; soldFeesEur: number | null; soldShippingEur: number | null; closed: boolean }
/** Real margin once a project is closed (sold or given up); null while it is still running. */
export function repairActual(p: ActualInput, hourlyRateEur: number) {
  if (!p.closed) return null;
  const costsEur = r2((p.purchaseEur ?? 0) + (p.shippingEur ?? 0) + p.partsEur.reduce((s, v) => s + v, 0));
  const revenueEur = r2((p.soldEur ?? 0) - (p.soldFeesEur ?? 0) - (p.soldShippingEur ?? 0));
  const marginEur = r2(revenueEur - costsEur);
  return { costsEur, revenueEur, marginEur, laborEur: r2(p.hours * hourlyRateEur), marginInclLaborEur: r2(marginEur - p.hours * hourlyRateEur) };
}

/** Below this many finished projects a rate is not shown: too little own history (DF-407). */
export const MIN_REPAIR_SAMPLE = 5;
export type RepairOutcome = 'open' | 'success' | 'partial' | 'failed';
/** Success/failure counts per fault class from own finished projects, always with sample size. */
export function repairStats(projects: { faults: Fault[]; outcome: RepairOutcome; marginEur: number | null }[]) {
  const done = projects.filter(p => p.outcome !== 'open');
  const row = (fault: Fault | 'ALL', list: typeof done) => {
    const margins = list.map(p => p.marginEur).filter((m): m is number => m !== null);
    const success = list.filter(p => p.outcome === 'success').length;
    return { fault, n: list.length, success, partial: list.filter(p => p.outcome === 'partial').length, failed: list.filter(p => p.outcome === 'failed').length,
      successRatePct: list.length >= MIN_REPAIR_SAMPLE ? Math.round(success / list.length * 100) : null,
      marginSamples: margins.length, avgMarginEur: margins.length ? r2(margins.reduce((s, m) => s + m, 0) / margins.length) : null };
  };
  return { minSample: MIN_REPAIR_SAMPLE, items: [row('ALL', done),
    ...FAULTS.map(f => row(f, done.filter(p => p.faults.includes(f)))).filter(r => r.n > 0)] };
}
