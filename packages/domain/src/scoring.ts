/** Deterministic, explainable MVP rules. Prices represent USER limits, not market averages. */
import { detectModel, exclusionReason, resolveWatchTargets } from './gpu.ts';
import type { Health, ListingText, ScoredListing, WatchRules } from './types.ts';

/** Bump when scoring rules change so stored assessments can be told apart. */
export const EVALUATION_VERSION = 1;
const defectSignals = [
  /\bdefekt\b/i, /\bkaputt\b/i, /\bbastler(?:ware|gerät|karte)?\b/i, /\b(?:für|zum)\s+basteln\b/i,
  /\bkein(?:e[nrms]?)?\s+(?:bild|signal)\b/i, /\bno\s+(?:display|signal|post)\b/i,
  /\bartefakte?\b/i, /\b(?:artifacts?|reparaturbedürftig|fehlerhaft)\b/i,
  /\b(?:doesn.t work|not working|for parts|ersatzteile?|nicht funktionsfähig)\b/i,
  /\b(?:wasserschaden|water damage|brandschaden|verschmort|verbrannt|pcb gebrochen|broken pcb|cracked pcb)\b/i,
  /\b(?:startet|bootet)\s+nicht\b/i, /\b(?:black screen|schwarzer bildschirm|kurzschluss|short circuit|bios defekt)\b/i,
];
const uncertainSignals = [/\bungetestet\b/i, /\buntested\b/i, /\bungeprüft\b/i, /\bnicht getestet\b/i, /\bzustand unbekannt\b/i, /\bohne kühler\b/i, /\bkühlerlos\b/i];
const repairPositive = [
  { pattern:/\b(?:kein bild|no display|no signal|kein signal)\b/i, weight:14, reason:'Kein Bild – Fehlerbild eingegrenzt' },
  { pattern:/\b(?:artefakte|artifacts?)\b/i, weight:10, reason:'Artefakte – Fehlerbild beschrieben' },
  { pattern:/\b(?:lüfter drehen|fans spin|geht an|startet noch|leuchtet noch)\b/i, weight:14, reason:'Startet teilweise' },
  { pattern:/\b(?:ungeöffnet|unverbastelt|nicht geöffnet|originalzustand)\b/i, weight:9, reason:'Kein Eingriff angegeben' },
  { pattern:/\b(?:mit kühler|vollständig|komplett)\b/i, weight:7, reason:'Komponenten vollständig' },
];
const repairNegative = [
  { pattern:/\b(?:ohne chip|gpu fehlt|ohne gpu|ohne vram|speicher fehlt)\b/i, weight:-60, reason:'Kernkomponenten fehlen' },
  { pattern:/\b(?:pcb gebrochen|gerissen|abgebrochen|broken pcb)\b/i, weight:-35, reason:'Mechanischer Schaden' },
  { pattern:/\b(?:wasserschaden|verschmort|verbrannt|brandschaden)\b/i, weight:-45, reason:'Wasser-/Brandschaden' },
  { pattern:/\b(?:reflow|reballing|reparaturversuch|schon repariert)\b/i, weight:-28, reason:'Vorheriger Reparaturversuch' },
  { pattern:/\b(?:ungetestet|untested|unbekannter fehler)\b/i, weight:-12, reason:'Fehler nicht eingegrenzt' },
];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo,v));
const num = (value: unknown): number | null => Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null;
export function classify(listing: ListingText): Health {
  const text = `${listing.title || ''} ${listing.description || ''} ${listing.condition || ''}`;
  if (exclusionReason(listing)) return 'excluded';
  if (defectSignals.some(rx=>rx.test(text))) return 'defect';
  if (uncertainSignals.some(rx=>rx.test(text))) return 'unknown';
  return 'working';
}
export function repairAssessment(listing: ListingText) {
  const text = `${listing.title || ''} ${listing.description || ''}`;
  const reasons: string[] = [];
  let score = 45;
  for (const {pattern,weight,reason} of [...repairPositive,...repairNegative]) {
    if (pattern.test(text)) { score += weight; reasons.push(reason); }
  }
  return { score: clamp(score,0,100), confidence: reasons.length >= 3 ? 'mittel' : 'niedrig', reasons: reasons.length ? reasons : ['Nur grobe Textbewertung; kein Funktionstest'] };
}
export function matchesWatchlist(listing: ListingText, watchlist: { query: string }): boolean {
  const targets = resolveWatchTargets(watchlist.query);
  if (targets) {
    // Known GPU model: compare detected profile/VRAM, never plain substrings (4070 Super != 4070 Ti Super).
    const model = detectModel(listing);
    if (!model) return false;
    return model.profile ? targets.profiles.has(model.profile) : targets.families.has(model.family ?? '');
  }
  // Free-text query (no GPU profile): all query tokens must appear in the title.
  const tokens = String(watchlist.query || '').toLocaleLowerCase('de-DE').match(/[a-z0-9]+/g) || [];
  const titleTokens: string[] = String(listing.title || '').toLocaleLowerCase('de-DE').match(/[a-z0-9]+/g) || [];
  return tokens.length > 0 && tokens.every(token=>titleTokens.includes(token));
}
export function scoreListing(listing: ScoredListing, watchlist: WatchRules, now = new Date()) {
  const health=classify(listing);
  if (health === 'excluded') return null;
  const price = num(listing.priceEur);
  if (price === null || price < 0 || (price === 0 && !/zu verschenken|gratis|kostenlos/i.test(listing.title || ''))) return null;
  const shipping = num(listing.shippingEur);
  // Unknown shipping is not 0 €: allIn is then only a lower bound.
  const allIn = price + (shipping ?? 0);
  const knownTotalEur = shipping === null ? null : allIn;
  const costsConfirmed = shipping !== null || !!watchlist.allowUnknownShipping;
  const isAuction = listing.offerType === 'AUCTION';
  const endsAt = listing.auctionEndsAt && Number.isFinite(Date.parse(listing.auctionEndsAt)) ? Date.parse(listing.auctionEndsAt) : null;
  const auctionMinutesLeft = endsAt === null ? null : Math.round((endsAt-now.getTime())/60000);
  // A current bid is not a price: auctions only count shortly before their end (gpu-search: 5 h).
  const priceFinal = !isAuction || (auctionMinutesLeft !== null && auctionMinutesLeft > 0 && auctionMinutesLeft <= 300);
  const ceiling = health === 'defect' ? num(watchlist.maxDefect) : num(watchlist.maxWorking);
  const discountPct = ceiling && ceiling > 0 ? Math.round((ceiling-allIn)/ceiling*100) : null;
  const repair = health === 'defect' ? repairAssessment(listing) : null;
  const resale = num(watchlist.expectedResale);
  const repairBudget = health === 'defect' ? (num(watchlist.repairBudget) ?? 0) : 0;
  const profitEstimate = resale && resale > 0 ? Math.round((resale*0.88 - allIn - repairBudget - 8)*100)/100 : null;
  const publishedRaw = listing.publishedAt && Number.isFinite(Date.parse(listing.publishedAt)) ? Date.parse(listing.publishedAt) : null;
  const publishedAt = publishedRaw !== null && publishedRaw <= now.getTime()+120000 ? publishedRaw : null;
  const firstSeenAt = listing.firstSeenAt && Number.isFinite(Date.parse(listing.firstSeenAt)) ? Date.parse(listing.firstSeenAt) : null;
  const effectiveTime = publishedAt ?? firstSeenAt;
  const ageMinutes = effectiveTime === null ? null : Math.floor(Math.max(0,now.getTime()-effectiveTime)/60000);
  const isFresh = ageMinutes !== null && ageMinutes <= 12;
  const withinLimit = ceiling !== null && ceiling > 0 && allIn <= ceiling;
  const isDeal = withinLimit && costsConfirmed && priceFinal && (discountPct ?? 0) >= 12;
  const isRepair = health === 'defect' && (withinLimit || (profitEstimate !== null && profitEstimate >= 25));
  const isSchnapper = isFresh && withinLimit && costsConfirmed && priceFinal;
  const needsPriceCheck = withinLimit && !costsConfirmed;
  // Alerts are separate: new, price bargain, repair opportunity, not just cheap offers.
  const alerts = [ ...(isSchnapper?['SCHNAPPER']:[]), ...(isDeal?['DEAL']:[]), ...(isRepair?['REPAIR']:[]) ];
  const reasons: string[] = [];
  if (isFresh) reasons.push(`Neu seit ca. ${ageMinutes} Min. (${publishedAt ? 'Inseratszeit' : 'erstmals entdeckt'})`);
  if (discountPct !== null) reasons.push(`${discountPct >= 0 ? discountPct + '% unter' : Math.abs(discountPct) + '% über'} deiner Kaufgrenze${shipping === null ? ' (ohne Versand)' : ''}`);
  if (shipping === null) reasons.push(needsPriceCheck ? 'Versandkosten unbekannt – Gesamtpreis prüfen' : 'Versandkosten unbekannt');
  if (isAuction) reasons.push(`Auktion: aktuelles Gebot${listing.bidCount != null ? `, ${listing.bidCount} Gebote` : ''}${auctionMinutesLeft === null ? ', Ende unbekannt' : auctionMinutesLeft > 0 ? `, endet in ${auctionMinutesLeft < 120 ? auctionMinutesLeft + ' Min.' : Math.round(auctionMinutesLeft/60) + ' Std.'}` : ', beendet'}`);
  if (health==='unknown') reasons.push('Zustand nicht bestätigt');
  if (repair && repair.score < 30) reasons.push('Hohes Reparaturrisiko');
  if (profitEstimate !== null) reasons.push(`Rechnerische Marge ${profitEstimate.toFixed(2)} € (Schätzung)`);
  const recency = isFresh ? Math.max(0,35 - (ageMinutes ?? 0)*2) : 0;
  const pricePart = clamp(discountPct ?? 0, -30, 60)*0.75;
  const repairPart = isRepair ? ((repair?.score ?? 0)/100)*18 : 0;
  const priority = Math.round(clamp(25+recency+pricePart+repairPart,0,100));
  const model = detectModel(listing);
  return {health, model: model?.model ?? null, vramGb: model?.vramGb ?? null, allIn, knownTotalEur, shippingKnown: shipping !== null, needsPriceCheck,
    offerType: listing.offerType ?? 'FIXED_PRICE', auctionMinutesLeft, discountPct, ageMinutes,
    timestampBasis:publishedAt?'published':firstSeenAt?'first-seen':'unknown',
    repairScore:repair?.score ?? null, repairConfidence:repair?.confidence ?? null,
    repairReasons:repair?.reasons ?? [], profitEstimate, alerts, reasons, priority,
    requiresAttention:alerts.length>0};
}

export type Assessment = NonNullable<ReturnType<typeof scoreListing>>;
