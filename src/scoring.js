/** Deterministic, explainable MVP rules. Prices represent USER limits, not market averages. */
const defectSignals = [
  /\bdefekt\b/i, /\bkaputt\b/i, /\bbastler(?:ware|gerät|karte)?\b/i,
  /\bkein(?:e[nrms]?)?\s+(?:bild|signal)\b/i, /\bno\s+(?:display|signal)\b/i,
  /\bartefakte?\b/i, /\b(?:artifacts?|reparaturbedürftig|fehlerhaft)\b/i,
  /\b(?:doesn.t work|not working|for parts)\b/i,
];
const uncertainSignals = [/\bungetestet\b/i, /\buntested\b/i, /\bungeprüft\b/i, /\bzustand unbekannt\b/i];
const accessorySignals = [
  /\b(?:leerkarton|nur ovp|box only|empty box)\b/i,
  /\b(?:kühler|wasserkühl(?:er|ung)|waterblock|heatsink|riser|netzteil)\b/i,
  /\b(?:gaming pc|komplettrechner|laptop|notebook|mainboard)\b/i,
];
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
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo,v));
const num = value => Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null;
export function classify(listing) {
  const text = `${listing.title || ''} ${listing.description || ''} ${listing.condition || ''}`;
  if (accessorySignals.some(rx=>rx.test(listing.title || ''))) return 'excluded';
  if (defectSignals.some(rx=>rx.test(text))) return 'defect';
  if (uncertainSignals.some(rx=>rx.test(text))) return 'unknown';
  return 'working';
}
export function repairAssessment(listing) {
  const text = `${listing.title || ''} ${listing.description || ''}`;
  const reasons = [];
  let score = 45;
  for (const {pattern,weight,reason} of [...repairPositive,...repairNegative]) {
    if (pattern.test(text)) { score += weight; reasons.push(reason); }
  }
  return { score: clamp(score,0,100), confidence: reasons.length >= 3 ? 'mittel' : 'niedrig', reasons: reasons.length ? reasons : ['Nur grobe Textbewertung; kein Funktionstest'] };
}
export function matchesWatchlist(listing, watchlist) {
  const title = String(listing.title || '').toLocaleLowerCase('de-DE');
  const query = String(watchlist.query || '').toLocaleLowerCase('de-DE').trim();
  if (!query) return false;
  // Prevent substring false positives: RTX 3080 should not match RTX 3080 Ti.
  const tokens = query.match(/[a-z0-9]+/g) || [];
  const titleTokens = title.match(/[a-z0-9]+/g) || [];
  if (!tokens.every(token=>titleTokens.includes(token))) return false;
  // Keep distinct model variants separate (3080 != 3080 Ti, 4070 != 4070 Super).
  if (/\b(?:rtx|rx)\s+\d{4}\b/.test(query) && !/\b(?:ti|super|xt|xtx|gre)\b/.test(query)) {
    if (/\b(?:ti|super|xt|xtx|gre)\b/.test(title)) return false;
  }
  return true;
}
export function scoreListing(listing, watchlist, now=new Date()) {
  const health=classify(listing);
  if (health === 'excluded') return null;
  const price = num(listing.priceEur);
  if (price === null || price < 0 || (price === 0 && !/zu verschenken|gratis|kostenlos/i.test(listing.title || ''))) return null;
  const shipping = num(listing.shippingEur);
  const allIn = price + (shipping ?? 0);
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
  const isDeal = withinLimit && (discountPct ?? 0) >= 12;
  const isRepair = health === 'defect' && (withinLimit || (profitEstimate !== null && profitEstimate >= 25));
  const isSchnapper = isFresh && withinLimit;
  // Alerts are separate: new, price bargain, repair opportunity, not just cheap offers.
  const alerts = [ ...(isSchnapper?['SCHNAPPER']:[]), ...(isDeal?['DEAL']:[]), ...(isRepair?['REPAIR']:[]) ];
  const reasons=[];
  if (isFresh) reasons.push(`Neu seit ca. ${ageMinutes} Min. (${publishedAt ? 'Inseratszeit' : 'erstmals entdeckt'})`);
  if (discountPct !== null) reasons.push(`${discountPct >= 0 ? discountPct + '% unter' : Math.abs(discountPct) + '% über'} deiner Kaufgrenze`);
  if (shipping === null) reasons.push('Versandkosten unbekannt');
  if (health==='unknown') reasons.push('Zustand nicht bestätigt');
  if (repair && repair.score < 30) reasons.push('Hohes Reparaturrisiko');
  if (profitEstimate !== null) reasons.push(`Rechnerische Marge ${profitEstimate.toFixed(2)} € (Schätzung)`);
  const recency = isFresh ? Math.max(0,35 - ageMinutes*2) : 0;
  const pricePart = clamp(discountPct ?? 0, -30, 60)*0.75;
  const repairPart = isRepair ? (repair.score/100)*18 : 0;
  const priority = Math.round(clamp(25+recency+pricePart+repairPart,0,100));
  return {health, allIn, shippingKnown: shipping !== null, discountPct, ageMinutes,
    timestampBasis:publishedAt?'published':firstSeenAt?'first-seen':'unknown',
    repairScore:repair?.score ?? null, repairConfidence:repair?.confidence ?? null,
    repairReasons:repair?.reasons ?? [], profitEstimate, alerts, reasons, priority,
    requiresAttention:alerts.length>0};
}
