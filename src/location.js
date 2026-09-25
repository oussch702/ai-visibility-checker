// Turns --location and --language into what each API expects: a DataForSEO location and language for Google,
// and a two-letter country for the assistants' web search.
import { fold } from './mentions.js';

const regions = new Intl.DisplayNames(['en'], { type: 'region' });
// ISO has GB where people write UK.
const ALIASES = { uk: 'GB', usa: 'US', 'united states of america': 'US', 'great britain': 'GB' };

let byName = null;
/** Country name to ISO code, built once from the runtime's own list of region names. */
function countryCode(name) {
  if (!byName) {
    byName = new Map();
    for (let a = 65; a <= 90; a += 1) {
      for (let b = 65; b <= 90; b += 1) {
        const code = String.fromCharCode(a, b);
        // Skip retired codes such as UK, which the runtime also names "United Kingdom" but canonicalizes to GB.
        if (Intl.getCanonicalLocales(`und-${code}`)[0] !== `und-${code}`) continue;
        const label = regions.of(code);
        if (label && label !== code && !byName.has(fold(label))) byName.set(fold(label), code);
      }
    }
  }
  const key = fold(name).trim();
  return ALIASES[key] ?? byName.get(key) ?? null;
}

/**
 * --location accepts a DataForSEO location name ("United States", "London,England,United Kingdom"),
 * a DataForSEO location code (2840) or a two-letter country code (US).
 * Returns the fields for Google and the country for the assistants, which is null when it cannot be told.
 */
export function resolveLocation(value) {
  const v = String(value ?? '').trim();
  if (/^\d+$/.test(v)) return { serp: { location_code: Number(v) }, country: null };
  if (/^[a-z]{2}$/i.test(v)) {
    const code = ALIASES[v.toLowerCase()] ?? v.toUpperCase();
    const name = regions.of(code);
    if (!name || name === code) throw new Error(`--location ${v} is not a country code.`);
    return { serp: { location_name: name }, country: code };
  }
  if (!v) throw new Error('--location is empty.');
  return { serp: { location_name: v }, country: countryCode(v.split(',').pop()) };
}

/** --language accepts a code such as en or pt-BR, or a name such as English. */
export function resolveLanguage(value) {
  const v = String(value ?? '').trim();
  if (!v) throw new Error('--language is empty.');
  return /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/i.test(v) ? { language_code: v } : { language_name: v };
}
