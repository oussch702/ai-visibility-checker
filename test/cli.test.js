import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HELP, run } from '../src/cli.js';

const sink = () => {
  const out = { text: '', isTTY: false, write: (s) => { out.text += s; return true; } };
  return out;
};

const ENV = { DATAFORSEO_LOGIN: 'login-value', DATAFORSEO_PASSWORD: 'password-value' };
const at = (iso) => () => new Date(iso);

/** An LLM Responses reply in DataForSEO's shape. */
const llmReply = (text, urls = [], cost = 0.01) => ({
  status_code: 20000,
  status_message: 'Ok.',
  cost,
  tasks: [
    {
      status_code: 20000,
      status_message: 'Ok.',
      cost,
      result: [{ model_name: 'test-model', items: [{ type: 'message', sections: [{ type: 'text', text, annotations: urls.map((url) => ({ title: 'source', url })) }] }] }],
    },
  ],
});

/** A SERP reply, with an AI Overview when `refs` is given. */
const serpReply = (refs, cost = 0.004) => ({
  status_code: 20000,
  status_message: 'Ok.',
  cost,
  tasks: [
    {
      status_code: 20000,
      status_message: 'Ok.',
      cost,
      result: [{ items: refs ? [{ type: 'ai_overview', markdown: 'An overview.', references: refs.map((url) => ({ url })) }] : [{ type: 'organic' }] }],
    },
  ],
});

/**
 * A fake DataForSEO. `answers` maps "engine|question" to [text, urls]; `overviews` maps a keyword to its cited URLs,
 * or null for no AI Overview. Everything else gets a plain answer that names nobody.
 */
function fakeDataForSeo({ answers = {}, overviews = {}, cost } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const [task] = JSON.parse(init.body);
    calls.push({ url, task, headers: init.headers });
    if (url.includes('/serp/google/organic/')) return Response.json(serpReply(overviews[task.keyword] ?? null, cost));
    const engine = url.includes('/chat_gpt/') ? 'chatgpt' : url.includes('/gemini/') ? 'gemini' : 'perplexity';
    const [text, urls] = answers[`${engine}|${task.user_prompt}`] ?? ['There are many good options.', []];
    return Response.json(llmReply(text, urls, cost));
  };
  return { fetchImpl, calls };
}

const workspace = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-visibility-cli-'));
  const prompts = path.join(dir, 'prompts.txt');
  const keywords = path.join(dir, 'keywords.txt');
  fs.writeFileSync(prompts, '# buyer questions\nWhat is the best CRM for an agency?\n\nWhich CRM tracks client projects?\nWhat is the best CRM for an agency?\n');
  fs.writeFileSync(keywords, 'crm for agencies\nagency crm\n');
  const out = path.join(dir, 'ai-visibility');
  const args = ['--brand', 'Example', '--domain', 'example.com', '--prompts', prompts, '--keywords', keywords, '--competitor', 'Acme', '--out', out];
  return { dir, out, prompts, keywords, args };
};

const Q1 = 'What is the best CRM for an agency?';
const Q2 = 'Which CRM tracks client projects?';

test('prints help', async () => {
  const stdout = sink();
  assert.equal(await run(['--help'], { stdout }), 0);
  assert.equal(stdout.text, HELP);
});

test('rejects a run without a brand or domain, and bad values, before spending anything', async () => {
  const { prompts } = workspace();
  const { fetchImpl, calls } = fakeDataForSeo();
  const cases = [
    [['--domain', 'example.com', '--prompts', prompts], /--brand and --domain are required/],
    [['--brand', 'Example', '--domain', 'not a domain', '--prompts', prompts], /is not a domain/],
    [['--brand', 'Example', '--domain', 'example.com'], /--prompts is required/],
    [['--brand', 'Example', '--domain', 'example.com', '--prompts', prompts, '--engines', 'chatgpt,bing'], /not bing/],
    [['--brand', 'Example', '--domain', 'example.com', '--prompts', prompts, '--engines', 'google'], /needs --keywords/],
    [['--brand', 'Example', '--domain', 'example.com', '--prompts', prompts, '--max-cost', 'lots'], /--max-cost must be/],
    [['--brand', 'Example', '--domain', 'example.com', '--prompts', prompts, '--model', 'gpt-5'], /--model takes engine=model/],
  ];
  for (const [args, message] of cases) {
    const stderr = sink();
    assert.equal(await run(args, { stderr, fetchImpl, env: ENV }), 2, args.join(' '));
    assert.match(stderr.text, message);
  }
  assert.equal(calls.length, 0);
});

test('rejects a question longer than DataForSEO accepts', async () => {
  const { dir } = workspace();
  const prompts = path.join(dir, 'long.txt');
  fs.writeFileSync(prompts, `Short question?\n${'x'.repeat(501)}\n`);
  const stderr = sink();
  assert.equal(await run(['--brand', 'Example', '--domain', 'example.com', '--prompts', prompts], { stderr, env: ENV }), 2);
  assert.match(stderr.text, /Line 2 .* 501 characters\. DataForSEO accepts up to 500/);
});

test('--estimate prints the cost without credentials and without calling DataForSEO', async () => {
  const { args } = workspace();
  const { fetchImpl, calls } = fakeDataForSeo();
  const stdout = sink();
  assert.equal(await run([...args, '--estimate'], { stdout, stderr: sink(), fetchImpl, env: {} }), 0);
  // 2 questions (the repeat is dropped) on 3 assistants, and 2 keywords.
  assert.match(stdout.text, /Estimated cost: \$0\.15/);
  assert.match(stdout.text, /ChatGPT\s+2 x \$0\.016/);
  assert.match(stdout.text, /Google AI Overviews\s+2 x \$0\.004/);
  assert.equal(calls.length, 0);
});

test('refuses to start when the estimate is above --max-cost', async () => {
  const { args } = workspace();
  const { fetchImpl, calls } = fakeDataForSeo();
  const stderr = sink();
  assert.equal(await run([...args, '--max-cost', '0.10'], { stderr, fetchImpl, env: ENV }), 2);
  assert.match(stderr.text, /Estimated cost: \$0\.15, limit \$0\.10/);
  assert.match(stderr.text, /above --max-cost/);
  assert.equal(calls.length, 0);
});

test('stops before the real spend could pass --max-cost, and keeps what it has', async () => {
  const { args, out } = workspace();
  // Each answer costs $0.06, far above the $0.016 estimate. After the first one, the next is expected to cost as much.
  const { fetchImpl, calls } = fakeDataForSeo({ cost: 0.06 });
  const stdout = sink();
  const code = await run([...args, '--engines', 'chatgpt', '--max-cost', '0.1', '--concurrency', '1'], {
    stdout,
    stderr: sink(),
    fetchImpl,
    env: ENV,
    now: at('2026-09-25T10:00:00Z'),
  });
  assert.equal(code, 1);
  assert.equal(calls.length, 1);
  assert.match(stdout.text, /Stopped early: the next request could have taken the spend past --max-cost \$0\.10, with \$0\.06 spent/);
  const [file] = fs.readdirSync(path.join(out, 'example.com'));
  const snapshot = JSON.parse(fs.readFileSync(path.join(out, 'example.com', file), 'utf8'));
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.answers.length, 1);
  assert.equal(snapshot.cost.spent, 0.06);
});

test('runs, saves a snapshot, then reports what changed on the next run', async () => {
  const { args, out } = workspace();
  const first = fakeDataForSeo({
    answers: {
      [`chatgpt|${Q1}`]: ['Agencies like **Acme** and **Initech**.', ['https://www.g2.com/crm']],
      [`gemini|${Q1}`]: ['**Example** is built for agencies.', ['https://example.com/features']],
      [`perplexity|${Q2}`]: ['Try Example or Acme.', ['https://reddit.com/r/crm']],
    },
    overviews: { 'crm for agencies': ['https://www.example.com/blog', 'https://g2.com/x'], 'agency crm': null },
  });
  const stdout = sink();
  assert.equal(await run([...args, '--csv'], { stdout, stderr: sink(), fetchImpl: first.fetchImpl, env: ENV, now: at('2026-09-18T09:12:00Z') }), 0);
  assert.equal(first.calls.length, 8);
  const report = stdout.text;
  assert.match(report, /2 questions on 3 engines, 2 keywords on Google · United States, en/);
  assert.match(report, /ChatGPT\s+0 of 2\s+0%\s+0 of 2\s+0%/);
  assert.match(report, /Gemini\s+1 of 2\s+50%\s+1 of 2\s+50%/);
  assert.match(report, /All engines\s+2 of 6\s+33%\s+1 of 6\s+17%/);
  assert.match(report, /Google AI Overviews: shown for 1 of 2 keywords/);
  assert.match(report, /cited: "crm for agencies"/);
  assert.match(report, /example\.com \(you\)\s+1\s+1/);
  assert.match(report, /Named a competitor and not you: 1\n {2}ChatGPT "What is the best CRM for an agency\?": Acme/);
  assert.match(report, /Other names in lists and bold text: Initech \(1\)/);
  assert.match(report, /First snapshot for example\.com/);
  // Six answers at $0.01 and two searches at $0.004.
  assert.match(report, /Spent \$0\.07 on 8 calls to DataForSEO \(estimated \$0\.15\)/);
  // The assistants search from the country of --location; Gemini's endpoint takes none.
  const chatgpt = first.calls.find((c) => c.url.includes('/chat_gpt/'));
  assert.equal(chatgpt.task.web_search_country_iso_code, 'US');
  const google = first.calls.find((c) => c.url.includes('/serp/'));
  assert.deepEqual([google.task.location_name, google.task.language_code, google.task.load_async_ai_overview], ['United States', 'en', true]);

  const second = fakeDataForSeo({
    answers: {
      [`chatgpt|${Q1}`]: ['Agencies like **Example** and **Acme**.', ['https://example.com/pricing']],
      [`gemini|${Q1}`]: ['Acme is built for agencies.', []],
      [`perplexity|${Q2}`]: ['Try Example or Acme.', ['https://reddit.com/r/crm']],
    },
    overviews: { 'crm for agencies': ['https://g2.com/x'], 'agency crm': ['https://example.com/'] },
  });
  const next = sink();
  // A new UTC day, so nothing comes from the cache.
  await run([...args, '--csv'], { stdout: next, stderr: sink(), fetchImpl: second.fetchImpl, env: ENV, now: at('2026-09-25T09:12:00Z') });
  assert.equal(second.calls.length, 8);
  assert.match(next.text, /Since 2026-09-18 09:12 UTC/);
  assert.match(next.text, /Newly named: 1 {3}No longer named: 1/);
  assert.match(next.text, /Newly cited: 2 {3}Lost citations: 2/);
  assert.match(next.text, /newly named: ChatGPT "What is the best CRM for an agency\?"/);
  assert.match(next.text, /no longer named: Gemini "What is the best CRM for an agency\?"/);
  assert.match(next.text, /newly cited: Google "agency crm"/);
  assert.match(next.text, /lost citation: Google "crm for agencies"/);

  const files = fs.readdirSync(path.join(out, 'example.com'));
  assert.deepEqual(files.sort(), ['2026-09-18T09-12-00Z.csv', '2026-09-18T09-12-00Z.json', '2026-09-25T09-12-00Z.csv', '2026-09-25T09-12-00Z.json']);
});

test('a second run the same day is answered from the cache, for free', async () => {
  const { args } = workspace();
  const first = fakeDataForSeo();
  await run(args, { stdout: sink(), stderr: sink(), fetchImpl: first.fetchImpl, env: ENV, now: at('2026-09-25T08:00:00Z') });
  assert.equal(first.calls.length, 8);

  const again = fakeDataForSeo();
  const stdout = sink();
  const stderr = sink();
  assert.equal(await run(args, { stdout, stderr, fetchImpl: again.fetchImpl, env: ENV, now: at('2026-09-25T20:00:00Z') }), 0);
  assert.equal(again.calls.length, 0);
  assert.match(stderr.text, /Estimated cost: \$0\.00, limit \$5\.00\. 8 already cached today/);
  assert.match(stdout.text, /Spent \$0\.00 on 0 calls to DataForSEO \(estimated \$0\.00\)\. 8 responses came from today's cache at no cost\./);
  assert.match(stdout.text, /Newly named: 0 {3}No longer named: 0/);
});

test('--json prints the snapshot and the changes', async () => {
  const { args } = workspace();
  const { fetchImpl } = fakeDataForSeo({ answers: { [`chatgpt|${Q1}`]: ['Example is a fine choice.', []] } });
  const stdout = sink();
  const stderr = sink();
  await run([...args, '--json', '--engines', 'chatgpt'], { stdout, stderr, fetchImpl, env: ENV, now: at('2026-09-25T10:00:00Z') });
  const { snapshot, changes } = JSON.parse(stdout.text);
  assert.equal(changes, null);
  assert.deepEqual(snapshot.engines, ['chatgpt']);
  assert.equal(snapshot.answers.length, 2);
  assert.equal(snapshot.answers.find((a) => a.prompt === Q1).named, true);
  assert.equal(snapshot.summary.answers.named, 1);
  assert.match(stderr.text, /Saved .*2026-09-25T10-00-00Z\.json/);
});

test('records a failed request without stopping the run', async () => {
  const { args } = workspace();
  const fake = fakeDataForSeo();
  const fetchImpl = async (url, init) => {
    const [task] = JSON.parse(init.body);
    if (task.keyword === 'agency crm') {
      return Response.json({ status_code: 20000, cost: 0.002, tasks: [{ status_code: 40101, status_message: 'Internal SE Server Error.', cost: 0.002, result: null }] });
    }
    return fake.fetchImpl(url, init);
  };
  const stdout = sink();
  const code = await run(args, { stdout, stderr: sink(), fetchImpl, env: ENV, now: at('2026-09-25T10:00:00Z'), sleep: async () => {} });
  assert.equal(code, 0);
  assert.match(stdout.text, /Errors: 1\n {2}Google "agency crm": 40101 Internal SE Server Error\./);
  assert.match(stdout.text, /Google AI Overviews: shown for 0 of 1 keyword/);
});

test('stops at once when DataForSEO refuses the credentials, and never prints them', async () => {
  const { args, out } = workspace();
  const fetchImpl = async () => Response.json({ status_code: 40100, status_message: 'You are not authorized.' }, { status: 401 });
  const stdout = sink();
  const stderr = sink();
  await assert.rejects(run(args, { stdout, stderr, fetchImpl, env: ENV }), /did not accept the login and password/);
  assert.doesNotMatch(stdout.text + stderr.text, /login-value|password-value/);
  assert.equal(fs.existsSync(path.join(out, 'example.com')), false);
});

test('no credential ever reaches the output, the snapshot or the cache', async () => {
  const { args, out } = workspace();
  const { fetchImpl, calls } = fakeDataForSeo();
  const stdout = sink();
  const stderr = sink();
  await run([...args, '--csv'], { stdout, stderr, fetchImpl, env: ENV, now: at('2026-09-25T10:00:00Z') });
  const expected = `Basic ${Buffer.from('login-value:password-value').toString('base64')}`;
  assert.ok(calls.every((c) => c.headers.Authorization === expected));
  const written = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else written.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(out);
  assert.ok(written.length > 8);
  for (const text of [stdout.text, stderr.text, ...written]) {
    assert.doesNotMatch(text, /login-value|password-value|Basic /);
  }
});

test('compares two saved snapshots offline', async () => {
  const { dir } = workspace();
  const snap = (named, finishedAt) => ({
    tool: 'ai-visibility-checker', domain: 'example.com', domains: ['example.com'], brands: ['Example'], competitors: [],
    location: 'United States', language: 'en', engines: ['chatgpt'], questions: 1, keywords: 0, finishedAt, complete: true,
    summary: { answers: { asked: 1, answered: 1, named: named ? 1 : 0, cited: 0, byEngine: { chatgpt: { answers: 1, named: named ? 1 : 0, cited: 0 } } }, overviews: { keywords: 0, checked: 0, shown: 0, named: 0, cited: 0 } },
    answers: [{ engine: 'chatgpt', prompt: Q1, named, cited: false, competitors: [], otherNames: [], citedDomains: [] }],
    overviews: [],
  });
  const older = path.join(dir, 'a.json');
  const newer = path.join(dir, 'b.json');
  fs.writeFileSync(older, JSON.stringify(snap(false, '2026-09-18T09:12:00Z')));
  fs.writeFileSync(newer, JSON.stringify(snap(true, '2026-09-25T09:12:00Z')));
  const stdout = sink();
  assert.equal(await run(['--compare', older, newer], { stdout }), 0);
  assert.match(stdout.text, /Newly named: 1/);
  assert.match(stdout.text, /newly named: ChatGPT "What is the best CRM for an agency\?"/);
});
