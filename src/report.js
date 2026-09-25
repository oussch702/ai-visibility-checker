// The plain-text report printed after a run or a --compare.
import { money } from './cost.js';
import { AI_ENGINES, ENGINES } from './engines.js';
import { fold, onDomain } from './mentions.js';
import { diff } from './snapshot.js';

const LIST_LIMIT = 15;
const TOP = 10;

const minute = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : 'never');
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quote = (s, max = 72) => `"${s.length > max ? `${s.slice(0, max - 3).trimEnd()}...` : s}"`;
const label = (engine) => ENGINES[engine]?.label ?? engine;
const where = (item) => (item.keyword !== undefined ? `Google ${quote(item.keyword)}` : `${label(item.engine)} ${quote(item.prompt)}`);
const share = (n, d) => `${`${n} of ${d}`.padStart(9)}${pct(n, d).padStart(6)}`;

/** Counts how many answers or overviews carry each value of a list field, most frequent first. */
function tally(items, field) {
  const counts = new Map();
  for (const item of items) {
    for (const value of new Set(item[field] ?? [])) {
      const key = fold(value);
      const entry = counts.get(key) ?? { value, n: 0 };
      entry.n += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
}

/** Report for one snapshot, with the changes since `older` when there is one. */
export function formatReport(snapshot, older = null) {
  const s = snapshot;
  const answers = s.answers.filter((a) => !a.error);
  const overviews = s.overviews.filter((o) => !o.error);
  const aiEngines = s.engines.filter((e) => AI_ENGINES.includes(e));

  const scope = [];
  if (aiEngines.length) scope.push(`${plural(s.questions, 'question')} on ${plural(aiEngines.length, 'engine')}`);
  if (s.engines.includes('google')) scope.push(`${plural(s.keywords, 'keyword')} on Google`);
  const lines = [`ai-visibility-checker · ${s.domain} · ${scope.join(', ')} · ${s.location}, ${s.language}`];
  if (!s.complete && s.stopReason) lines.push(`Stopped early: ${s.stopReason}`);

  if (aiEngines.length) {
    lines.push('', `${'AI answers'.padEnd(16)}${'named you'.padStart(15)}${'cited you'.padStart(18)}`);
    const { byEngine } = s.summary.answers;
    for (const engine of aiEngines) {
      const e = byEngine[engine] ?? { answers: 0, named: 0, cited: 0 };
      lines.push(`  ${label(engine).padEnd(14)}${share(e.named, e.answers)}   ${share(e.cited, e.answers)}`);
    }
    if (aiEngines.length > 1) {
      const all = s.summary.answers;
      lines.push(`  ${'All engines'.padEnd(14)}${share(all.named, all.answered)}   ${share(all.cited, all.answered)}`);
    }
  }

  if (s.engines.includes('google')) {
    const o = s.summary.overviews;
    lines.push('', `Google AI Overviews: shown for ${o.shown} of ${plural(o.checked, 'keyword')}`);
    if (o.shown) lines.push(`  named you in ${o.named}, cited ${s.domain} in ${o.cited}`);
    for (const item of overviews.filter((x) => x.cited).slice(0, LIST_LIMIT)) lines.push(`    cited: ${quote(item.keyword)}`);
  }

  const sources = new Map();
  for (const [kind, items] of [['answers', answers], ['overviews', overviews]]) {
    for (const { value, n } of tally(items, 'citedDomains')) {
      const entry = sources.get(value) ?? { domain: value, answers: 0, overviews: 0 };
      entry[kind] = n;
      sources.set(value, entry);
    }
  }
  const top = [...sources.values()].sort((a, b) => b.answers + b.overviews - (a.answers + a.overviews) || a.domain.localeCompare(b.domain)).slice(0, TOP);
  if (top.length) {
    const yours = (d) => s.domains.some((mine) => onDomain(d, mine));
    const width = Math.max(20, ...top.map((t) => t.domain.length + (yours(t.domain) ? 6 : 0))) + 2;
    lines.push('', `${'Most cited domains'.padEnd(width + 2)}answers  overviews`);
    for (const t of top) {
      const name = `${t.domain}${yours(t.domain) ? ' (you)' : ''}`;
      lines.push(`  ${name.padEnd(width)}${String(t.answers).padStart(7)}${String(t.overviews).padStart(11)}`);
    }
  }

  const everything = [...answers, ...overviews.filter((o) => o.shown)];
  if (s.competitors.length) {
    const lost = everything.filter((x) => !x.named && x.competitors.length);
    lines.push('', `Named a competitor and not you: ${lost.length}`);
    for (const x of lost.slice(0, LIST_LIMIT)) lines.push(`  ${where(x)}: ${x.competitors.join(', ')}`);
    if (lost.length > LIST_LIMIT) lines.push(`  and ${lost.length - LIST_LIMIT} more in the snapshot file`);
  } else {
    lines.push('', 'Pass --competitor to list the answers that name a competitor and not you.');
  }
  const others = tally(everything, 'otherNames').slice(0, TOP);
  if (others.length) lines.push(`Other names in lists and bold text: ${others.map((x) => `${x.value} (${x.n})`).join(', ')}`);

  if (older) {
    const d = diff(older, s);
    lines.push('', `Since ${minute(d.since)} UTC`);
    lines.push(`  Newly named: ${d.newlyNamed.length}   No longer named: ${d.noLongerNamed.length}`);
    lines.push(`  Newly cited: ${d.newlyCited.length}   Lost citations: ${d.lostCitations.length}`);
    for (const [title, list] of [['newly named', d.newlyNamed], ['no longer named', d.noLongerNamed], ['newly cited', d.newlyCited], ['lost citation', d.lostCitations]]) {
      for (const item of list.slice(0, LIST_LIMIT)) lines.push(`    ${title}: ${where(item)}`);
    }
    if (d.notInOlder) lines.push(`  Not in the earlier run: ${d.notInOlder}`);
    for (const note of d.notes) lines.push(`  Note: ${note}`);
  } else {
    lines.push('', `First snapshot for ${s.domain}. Run it again later to see what changed.`);
  }

  const errors = [...s.answers, ...s.overviews].filter((x) => x.error);
  if (errors.length) {
    lines.push('', `Errors: ${errors.length}`);
    for (const x of errors.slice(0, 5)) lines.push(`  ${where(x)}: ${x.error}`);
  }

  if (s.cost) {
    const cache = s.cost.fromCache ? ` ${plural(s.cost.fromCache, 'response')} came from today's cache at no cost.` : '';
    lines.push('', `Spent ${money(s.cost.spent)} on ${plural(s.cost.calls, 'call')} to DataForSEO (estimated ${money(s.cost.estimated)}).${cache}`);
  }
  return lines.join('\n');
}
