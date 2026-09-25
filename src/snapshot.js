// Turns one run into a snapshot, compares two snapshots, and writes CSV.

const count = (list, field) => list.filter((x) => x[field]).length;

/** Counts behind the report. Answers that failed are left out of every share. */
export function summarize(answers, overviews) {
  const ok = answers.filter((a) => !a.error);
  const byEngine = {};
  for (const a of ok) {
    const e = (byEngine[a.engine] ??= { answers: 0, named: 0, cited: 0 });
    e.answers += 1;
    if (a.named) e.named += 1;
    if (a.cited) e.cited += 1;
  }
  const checked = overviews.filter((o) => !o.error);
  return {
    answers: { asked: answers.length, answered: ok.length, named: count(ok, 'named'), cited: count(ok, 'cited'), byEngine },
    overviews: { keywords: overviews.length, checked: checked.length, shown: count(checked, 'shown'), named: count(checked, 'named'), cited: count(checked, 'cited') },
  };
}

/** A snapshot of one run. */
export function buildSnapshot({ version, answers, overviews, ...run }) {
  return {
    tool: 'ai-visibility-checker',
    version,
    ...run,
    summary: summarize(answers, overviews),
    answers,
    overviews,
  };
}

const sameList = (a = [], b = []) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/**
 * What changed between an older and a newer snapshot of the same domain. Only questions and keywords that
 * both runs answered are compared, so a failed request or a new question never shows up as a loss.
 */
export function diff(older, newer) {
  const changes = { since: older.finishedAt, newlyNamed: [], noLongerNamed: [], newlyCited: [], lostCitations: [], notInOlder: 0, notes: [] };
  const compare = (before, now, key, describe) => {
    const earlier = new Map(before.filter((x) => !x.error).map((x) => [key(x), x]));
    for (const item of now) {
      if (item.error) continue;
      const was = earlier.get(key(item));
      if (!was) {
        changes.notInOlder += 1;
        continue;
      }
      const entry = describe(item);
      if (!was.named && item.named) changes.newlyNamed.push(entry);
      if (was.named && !item.named) changes.noLongerNamed.push(entry);
      if (!was.cited && item.cited) changes.newlyCited.push(entry);
      if (was.cited && !item.cited) changes.lostCitations.push(entry);
    }
  };
  compare(older.answers ?? [], newer.answers ?? [], (a) => `${a.engine}\u0000${a.prompt}`, (a) => ({ engine: a.engine, prompt: a.prompt }));
  compare(older.overviews ?? [], newer.overviews ?? [], (o) => o.keyword, (o) => ({ engine: 'google', keyword: o.keyword }));
  if (!sameList(older.brands, newer.brands) || !sameList(older.domains, newer.domains)) {
    changes.notes.push('The brand names or domains differ from the earlier run.');
  }
  if (older.location !== newer.location || older.language !== newer.language) {
    changes.notes.push(`The earlier run used ${older.location}, ${older.language}.`);
  }
  return changes;
}

const COLUMNS = ['type', 'engine', 'query', 'model', 'overview_shown', 'named', 'cited', 'competitors', 'cited_domains', 'other_names', 'cost', 'error'];

const cell = (value) => {
  if (value === null || value === undefined) return '';
  const s = Array.isArray(value) ? value.join('; ') : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per answer and per keyword, ready for a spreadsheet. */
export function toCsv(snapshot) {
  const rows = [
    ...snapshot.answers.map((a) => ['answer', a.engine, a.prompt, a.model, '', a.named, a.cited, a.competitors, a.citedDomains, a.otherNames, a.cost, a.error]),
    ...snapshot.overviews.map((o) => ['overview', 'google', o.keyword, '', o.shown, o.named, o.cited, o.competitors, o.citedDomains, o.otherNames, o.cost, o.error]),
  ];
  return `${[COLUMNS, ...rows].map((row) => row.map(cell).join(',')).join('\n')}\n`;
}
