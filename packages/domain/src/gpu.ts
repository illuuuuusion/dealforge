/** GPU domain: model/VRAM detection, accessory/system exclusion and eBay search buckets (ported from gpu-search). */
import rawProfiles from './gpu-profiles.json' with { type: 'json' };
import type { ListingText } from './types.ts';

export interface GpuProfile { name: string; aliases: string[]; negativeAliases: string[]; vramGb: number; category: string; vramVariants: boolean; family: string | null }
export interface DetectedModel { profile: string | null; family: string | null; model: string; vramGb: number | null }
type Text = { normalized: string; compact: string };

export const profiles: GpuProfile[] = rawProfiles
  // "RTX 3080 (10GB)" belongs to family "RTX 3080": used when a listing names the model but not its VRAM.
  .map(p => ({ ...p, family: p.name.match(/^(.*?)\s*\(\d+GB\)$/)?.[1] ?? null }));

export const normalize = (value: unknown) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const compact = (value: unknown) => normalize(value).replace(/ /g, '');

function aliasCandidates(alias: string) {
  const n = normalize(alias);
  return [...new Set([n, ...['geforce', 'radeon', 'nvidia', 'amd'].map(w => n.replace(new RegExp(`\\b${w}\\b`, 'g'), '').replace(/\s+/g, ' ').trim())])].filter(Boolean);
}
const textHasAlias = (text: Text, alias: string) => aliasCandidates(alias).some(c => text.normalized.includes(c) || text.compact.includes(c.replace(/ /g, '')));
const textOf = (value: unknown): Text => ({ normalized: normalize(value), compact: compact(value) });

const vramSizes = new Set([2, 3, 4, 6, 8, 10, 11, 12, 16, 20, 24, 32, 48, 96]);
export function detectVramGb(listing: ListingText): number | null {
  for (const text of [listing.title, listing.description]) {
    for (const m of String(text ?? '').matchAll(/\b(\d{1,2})\s?(?:gb|g)\b/gi)) if (vramSizes.has(Number(m[1]))) return Number(m[1]);
  }
  return null;
}

const familyNegatives = (family: string) => {
  const members = profiles.filter(p => p.family === family);
  return members[0].negativeAliases.filter(n => members.every(p => p.negativeAliases.includes(n)));
};
const families = [...new Set(profiles.map(p => p.family).filter((f): f is string => !!f))];

/** Best matching profile; falls back to the model family when the listing does not state its VRAM. */
export function detectModel(listing: ListingText): DetectedModel | null {
  const title = textOf(listing.title);
  const all = textOf(`${listing.title ?? ''} ${listing.description ?? ''}`);
  const vramGb = detectVramGb(listing);
  let best: (DetectedModel & { score: number; vramGb: number }) | null = null;
  for (const p of profiles) {
    if (p.negativeAliases.some(n => textHasAlias(all, n))) continue;
    if (p.vramVariants && vramGb !== null && vramGb !== p.vramGb) continue;
    const aliases = p.family && vramGb === p.vramGb ? [...p.aliases, p.family] : p.aliases;
    for (const alias of aliases) {
      const inTitle = textHasAlias(title, alias);
      if (!inTitle && !textHasAlias(all, alias)) continue;
      const score = normalize(alias).length + (inTitle ? 1000 : 0) + (p.family && vramGb === p.vramGb ? 500 : 0);
      if (!best || score > best.score || (score === best.score && p.vramGb > best.vramGb)) best = { score, profile: p.name, family: p.family, model: p.name.replace(/ Repair$/, ''), vramGb: p.vramGb };
    }
  }
  if (best) return { profile: best.profile, family: best.family, model: best.model, vramGb: best.vramGb };
  if (vramGb !== null) return null;
  const family = families.find(f => textHasAlias(title, f) && !familyNegatives(f).some(n => textHasAlias(all, n)));
  return family ? { profile: null, family, model: family, vramGb: null } : null;
}

/** Which profiles a watchlist query stands for: an exact profile, a whole family, or null (free-text query). */
export function resolveWatchTargets(query: unknown): { profiles: Set<string>; families: Set<string> } | null {
  const q = normalize(query);
  if (!q) return null;
  const exact = profiles.filter(p => normalize(p.name) === q || p.aliases.some(a => normalize(a) === q));
  if (exact.length) return { profiles: new Set(exact.map(p => p.name)), families: new Set() };
  const family = families.find(f => normalize(f) === q);
  if (family) return { profiles: new Set(profiles.filter(p => p.family === family).map(p => p.name)), families: new Set([family]) };
  return null;
}

// Phrases like "mit Backplate", "+ Stütze", "inkl. eGPU" describe extras of a real card, not the item itself.
const stripExtras = (title: unknown) => String(title ?? '').replace(/(?:\b(?:mit|inkl\.?|inklusive|incl\.?|with|plus)\s|\+\s*)[^,;|]*/gi, ' ');
const exclusionRules: [string, RegExp][] = [
  ['Ohne GPU-Chip/VRAM – nur Teile', /\b(?:ohne|kein(?:e|en)?|without|no)\s+(?:gpu|core|chip|vram|speicher)\b|\b(?:gpu|chip|core)\s+(?:fehlt|missing|removed)\b|\bnur\s+(?:platine|board|pcb)\b|\b(?:bare|only)\s+(?:pcb|board)\b|\bpcb\s+only\b/i],
  ['Zubehör: Lüfter', /\b(?:replacement|cooling|gpu|vga|graphics\s+card|grafikkarten?)[\s-]*(?:fans?|lüfter)\b|\bfans?\s+(?:replacement|for|für)\b|ersatz[\s-]*lüfter|lüfter\s+(?:für|fuer|for|ersatz)\b|\bnur\s+(?:lüfter|kühler)\b/i],
  ['Zubehör: Kühlung', /\b(?:alphacool|eisblock|bykski|barrow|ekwb|ek[\s-]?quantum|backplate|liquid\s+extasy|water\s?block|wasserblock|wasserkühler|gpu[\s-]block|heatsink|kühlkörper\s+für)\b|(?<!ohne\s)\b(?:kühler|cooler)\b/i],
  ['Zubehör: Halterung', /\b(?:bracket|holder|halterung|grafikkartenhalter|stütze|anti[\s-]?sag)\b/i],
  ['Zubehör: Kabel/Strom', /\b(?:12vhpwr|\d{1,2}[\s-]?pin|connector|stecker|adapter(?:kabel)?|riser|verlängerungskabel|extension\s+cable|netzkabel|stromkabel|netzteil|charger|ladegerät|power\s+supply)\b/i],
  ['Zubehör: Verpackung', /\b(?:leerkarton|versand\s*karton|empty\s+box|box\s+only|ovp\s+only|nur\s+(?:ovp|karton|verpackung))\b/i],
  ['Zubehör: Display', /\b(?:bildschirm|panel|lcd)\b/i],
  ['Dienstleistung', /\b(?:reparatur[\s-]*service|repair\s+service|reparaturservice)\b/i],
  ['Konvolut/Sammelposten', /\b(?:konvolut|sammelposten|lot\s+of)\b/i],
];
const systemRule = /\b(?:gam(?:ing|er)|office|desktop|tower|high[\s-]?end|workstation|komplett|retro)[\s-]*pcs?\b|\bpcs\b|\bpc[\s-]*(?:set|system|bundle)\b|\b(?:laptop|notebook|ultrabook|mainboard|motherboard|barebone|zbox|alienware|zephyrus|legion\s+pro|razer\s+blade|omen\s+max)\b|\b(?:mifcom|dubaro|captiva|actina|arlt|thinkstation)\b|\b(?:dell\s+precision|precision\s+\d{4}|cad\s+workstation)\b/i;
const cpu = /\b(?:ryzen\s*[3579]|r[3579]\s+\d{4}|\d{4}x3d|i[3579][\s-]\d{4,5}|core\s+(?:i[3579]|ultra)|ultra\s+[579]\s+\d{3}|xeon|threadripper|athlon)/i;
const bundle = /\b(?:\d{1,3}\s?gb\s*(?:ram|ddr\d)|ddr[345]|ssd|nvme|hdd|\d\s?tb|w(?:in(?:dows)?)?\s?1[01]|freedos)\b/i;

/** Reason why a listing is not a single graphics card, or null. Title only: descriptions mention extras too often. */
export function exclusionReason(listing: ListingText): string | null {
  const raw = String(listing.title ?? ''), title = stripExtras(raw);
  for (const [reason, rx] of exclusionRules) if (rx.test(title)) return reason;
  // Systems on the full title: "… mit Gaming PC" must not be stripped away as an extra.
  return systemRule.test(raw) || (cpu.test(raw) && bundle.test(raw)) ? 'Komplettsystem' : null;
}

// Broad eBay queries; local matching assigns the results to profiles (one call per bucket instead of per profile).
export const searchBuckets = [
  { id: 'repair-legacy', query: '(gtx 970, gtx 980, gtx 980 ti, gtx 1070 ti, gtx 1080 ti, rx 580, rx 590) (defekt, bastler, kein bild, artefakte)', matchers: ['repair /'] },
  { id: 'nvidia-turing', query: 'RTX (2080, 2080 super, 2080 ti, titan)', matchers: ['nvidia turing'] },
  { id: 'nvidia-ampere', query: 'RTX (3060, 3060 ti, 3070 ti, 3080, 3080 ti, 3090, 3090 ti)', matchers: ['nvidia ampere'] },
  { id: 'nvidia-ada', query: 'RTX (4060, 4060 ti, 4070, 4070 super, 4070 ti, 4080, 4080 super, 4090)', matchers: ['ada lovelace'] },
  { id: 'nvidia-blackwell', query: 'RTX (5060, 5060 ti, 5070, 5070 ti, 5080, 5090, pro 6000)', matchers: ['nvidia blackwell'] },
  { id: 'amd-intel', query: '(rx 6800, rx 6900, rx 6950, rx 7700, rx 7800, rx 7900, rx 9070, intel arc, arc a770)', matchers: ['amd rdna', 'intel arc'] },
];
export function bucketForProfile(name: string) {
  const p = profiles.find(x => x.name === name);
  const haystack = `${p?.name} ${p?.category}`.toLowerCase();
  return searchBuckets.find(b => b.matchers.some(m => haystack.includes(m))) ?? null;
}
