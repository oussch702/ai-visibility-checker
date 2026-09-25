import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSnapshot, diff, toCsv } from '../src/snapshot.js';

const answer = (engine, prompt, named, cited, extra = {}) => ({ engine, prompt, named, cited, competitors: [], otherNames: [], citedDomains: [], ...extra });
const overview = (keyword, shown, cited, extra = {}) => ({ keyword, shown, named: false, cited, competitors: [], otherNames: [], citedDomains: [], ...extra });

const snapshotOf = (answers, overviews = [], extra = {}) =>
  buildSnapshot({
    version: 'test',
    domain: 'example.com',
    domains: ['example.com'],
    brands: ['Example'],
    competitors: [],
    location: 'United States',
    language: 'en',
    engines: ['chatgpt', 'gemini', 'google'],
    finishedAt: '2026-09-18T09:12:00.000Z',
    answers,
    overviews,
    ...extra,
  });

test('counts named and cited answers per engine, leaving failed ones out', () => {
  const snap = snapshotOf(
    [
      answer('chatgpt', 'q1', true, true),
      answer('chatgpt', 'q2', false, false),
      answer('gemini', 'q1', true, false),
      { engine: 'gemini', prompt: 'q2', error: '40101 Internal SE Server Error.' },
    ],
    [overview('k1', true, true), overview('k2', false, false), { keyword: 'k3', error: 'network: timeout' }],
  );
  assert.deepEqual(snap.summary.answers, {
    asked: 4,
    answered: 3,
    named: 2,
    cited: 1,
    byEngine: { chatgpt: { answers: 2, named: 1, cited: 1 }, gemini: { answers: 1, named: 1, cited: 0 } },
  });
  assert.deepEqual(snap.summary.overviews, { keywords: 3, checked: 2, shown: 1, named: 0, cited: 1 });
  assert.equal(snap.tool, 'ai-visibility-checker');
});

test('diff reports newly named, no longer named, newly cited and lost citations', () => {
  const older = snapshotOf(
    [answer('chatgpt', 'q1', false, false), answer('chatgpt', 'q2', true, true), answer('gemini', 'q1', false, false)],
    [overview('k1', true, true), overview('k2', true, false)],
  );
  const newer = snapshotOf(
    [answer('chatgpt', 'q1', true, true), answer('chatgpt', 'q2', false, false), answer('gemini', 'q1', false, false), answer('gemini', 'q9', true, false)],
    [overview('k1', false, false), overview('k2', true, true)],
    { finishedAt: '2026-09-25T09:12:00.000Z' },
  );
  const d = diff(older, newer);
  assert.equal(d.since, '2026-09-18T09:12:00.000Z');
  assert.deepEqual(d.newlyNamed, [{ engine: 'chatgpt', prompt: 'q1' }]);
  assert.deepEqual(d.noLongerNamed, [{ engine: 'chatgpt', prompt: 'q2' }]);
  assert.deepEqual(d.newlyCited, [{ engine: 'chatgpt', prompt: 'q1' }, { engine: 'google', keyword: 'k2' }]);
  assert.deepEqual(d.lostCitations, [{ engine: 'chatgpt', prompt: 'q2' }, { engine: 'google', keyword: 'k1' }]);
  assert.equal(d.notInOlder, 1);
  assert.deepEqual(d.notes, []);
});

test('a failed request is never reported as a loss', () => {
  const older = snapshotOf([answer('chatgpt', 'q1', true, true)]);
  const newer = snapshotOf([{ engine: 'chatgpt', prompt: 'q1', error: 'network: timeout' }]);
  const d = diff(older, newer);
  assert.deepEqual([d.noLongerNamed, d.lostCitations], [[], []]);
  const recovered = diff(newer, snapshotOf([answer('chatgpt', 'q1', true, true)]));
  assert.deepEqual([recovered.newlyNamed, recovered.notInOlder], [[], 1]);
});

test('diff notes a change of brands or location between runs', () => {
  const older = snapshotOf([], [], { brands: ['Example'], location: 'United States' });
  const newer = snapshotOf([], [], { brands: ['Example', 'Example CRM'], location: 'France' });
  assert.equal(diff(older, newer).notes.length, 2);
});

test('CSV has one row per answer and keyword, quoted where needed', () => {
  const snap = snapshotOf(
    [answer('chatgpt', 'Best CRM, for "agencies"?', true, false, { competitors: ['Acme', 'Globex'], model: 'gpt-5-mini', cost: 0.01 })],
    [overview('crm', true, true, { citedDomains: ['example.com', 'g2.com'] })],
  );
  const [header, first, second] = toCsv(snap).trim().split('\n');
  assert.equal(header, 'type,engine,query,model,overview_shown,named,cited,competitors,cited_domains,other_names,cost,error');
  assert.equal(first, 'answer,chatgpt,"Best CRM, for ""agencies""?",gpt-5-mini,,true,false,Acme; Globex,,,0.01,');
  assert.equal(second, 'overview,google,crm,,true,false,true,,example.com; g2.com,,,');
});
