// Decides whether a text names a brand or a domain, which of the cited sites are yours,
// and which other names an answer puts forward.

/** Lowercase, without accents, with straight apostrophes: "Café" and "cafe" compare equal. */
export const fold = (value) =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase();

/** The text a reader sees: a markdown link keeps its words and loses its address, and bare URLs go. */
export const visibleText = (markdown) =>
  String(markdown ?? '')
    .replace(/!?\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))*\)/g, '$1')
    .replace(/\bhttps?:\/\/[^\s<>()\]]+/gi, ' ');

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LETTER = '[\\p{L}\\p{N}]';

/** A whole-word pattern for a name. Spaces and hyphens inside the name match either, so "Coca Cola" finds "Coca-Cola". */
function wholeWords(name) {
  const parts = fold(name).split(/[\s\p{Pd}]+/u).filter(Boolean).map(escapeRegExp);
  return parts.length ? new RegExp(`(?<!${LETTER})${parts.join('[\\s\\p{Pd}]+')}(?!${LETTER})`, 'u') : null;
}

/** The names from `list` that the text contains as whole words, ignoring case, accents and link addresses. */
export function namesIn(text, list = []) {
  const haystack = fold(visibleText(text));
  return list.filter((name) => wholeWords(name)?.test(haystack));
}

/** True when the text writes out the domain or one of its subdomains, as in "order from shop.example.com". */
export function mentionsDomain(text, domain) {
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}\\p{Pd}_.])(?:[\\p{L}\\p{N}-]+\\.)*${escapeRegExp(domain)}(?![\\p{L}\\p{N}\\p{Pd}_]|\\.[\\p{L}\\p{N}])`,
    'u',
  );
  return re.test(fold(visibleText(text)));
}

/** The host of a URL without "www.", or null. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

/** "https://www.Example.com/about" and "example.com" both become example.com. Null when it is not a domain. */
export function normalizeDomain(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const host = hostOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  return host && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

/** True when a host is the domain itself or one of its subdomains. */
export const onDomain = (host, domain) => Boolean(host) && (host === domain || host.endsWith(`.${domain}`));

// Short words that may sit in lowercase inside a name, as in "Bank of America".
const CONNECTORS = new Set(['&', '+', 'and', 'of', 'the', 'for', 'by', 'at', 'de', 'du', 'des', 'la', 'le', 'et', 'y', 'van', 'von', 'der', 'di', 'da']);
// Headings that answers write in Title Case and that are not names.
const GENERIC = new Set(
  [
    'answer', 'quick answer', 'short answer', 'summary', 'overview', 'conclusion', 'bottom line', 'verdict', 'final thoughts',
    'takeaway', 'key takeaways', 'recommendation', 'recommendations', 'our pick', 'top pick', 'top picks', 'best overall',
    'best value', 'best for', 'budget pick', 'runner up', 'pros', 'cons', 'pros and cons', 'price', 'prices', 'pricing',
    'cost', 'costs', 'features', 'key features', 'benefits', 'advantages', 'disadvantages', 'drawbacks', 'limitations',
    'strengths', 'weaknesses', 'why', 'how it works', 'what to look for', 'how to choose', 'considerations',
    'key considerations', 'comparison', 'alternatives', 'option', 'options', 'step', 'steps', 'next steps', 'tip', 'tips',
    'note', 'notes', 'important', 'warning', 'example', 'examples', 'faq', 'faqs', 'sources', 'references', 'support',
    'customer support', 'integrations', 'ease of use', 'reviews', 'rating', 'ratings', 'free plan', 'free trial', 'use case',
    'use cases', 'ideal for', 'good for', 'location', 'address', 'hours', 'opening hours', 'contact', 'website', 'phone',
    'delivery', 'shipping', 'returns', 'warranty', 'availability', 'quality', 'reputation', 'experience', 'service',
    'services', 'products', 'overall', 'best practices', 'getting started', 'in short', 'tl;dr',
  ].map(fold),
);

/** Trims a bold span, list item or heading down to the name it starts with. */
function lead(raw) {
  return visibleText(raw)
    .replace(/[*_`"“”]/g, '')
    .replace(/^\s*#?\d{1,2}[.):]?\s+/, '')
    .split(/:|\s\p{Pd}\s|\s\(|,\s/u)[0]
    .replace(/[\s.,!?;]+$/u, '')
    .trim();
}

/** Looks like a name: one to four words, each capitalized, a known connector, or mixed case like "eBay". */
function looksLikeName(name) {
  if (name.length < 2 || name.length > 50) return false;
  const words = name.split(/\s+/);
  if (words.length > 4 || !/\p{L}/u.test(words[0])) return false;
  return words.every((word, i) => /^\p{N}/u.test(word) || /\p{Lu}/u.test(word) || (i > 0 && CONNECTORS.has(word.toLowerCase())));
}

/**
 * Names an answer puts forward: the start of its bold text, list items and headings, which is where assistants
 * write the products and companies they recommend. A heuristic, so expect the odd heading among them.
 * Names already matched by `known` (your brands and competitors) are left out.
 */
export function otherNames(markdown, known = []) {
  const text = String(markdown ?? '');
  const spans = [
    ...text.matchAll(/\*\*([^*\n]+?)\*\*/g),
    ...text.matchAll(/(?<![\p{L}\p{N}_])__([^_\n]+?)__(?![\p{L}\p{N}_])/gu),
    ...text.matchAll(/^[ \t]*(?:[-*+•]|\d{1,2}[.)])[ \t]+(.+)$/gm),
    ...text.matchAll(/^#{1,6}[ \t]+(.+)$/gm),
  ].sort((a, b) => a.index - b.index);
  const found = new Map();
  for (const match of spans) {
    const name = lead(match[1]);
    const key = fold(name);
    if (!looksLikeName(name) || GENERIC.has(key) || found.has(key) || namesIn(name, known).length) continue;
    found.set(key, name);
  }
  return [...found.values()];
}

/** What one answer or AI Overview says about you. */
export function analyze({ text, citations }, { brands = [], domains = [], competitors = [] }) {
  const citedDomains = [...new Set(citations.map((c) => c.domain).filter(Boolean))];
  return {
    named: namesIn(text, brands).length > 0 || domains.some((d) => mentionsDomain(text, d)),
    cited: citedDomains.some((host) => domains.some((d) => onDomain(host, d))),
    competitors: namesIn(text, competitors),
    otherNames: otherNames(text, [...brands, ...competitors]),
    citedDomains,
  };
}
