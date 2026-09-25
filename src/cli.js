import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PRICES, estimate, money } from './cost.js';
import { loadCredentials } from './credentials.js';
import { createClient, isCached } from './dataforseo.js';
import {
  AI_ENGINES,
  ALL_ENGINES,
  ENGINES,
  KEYWORD_LIMIT,
  PROMPT_LIMIT,
  answerRequest,
  overviewRequest,
  parseAnswer,
  parseOverview,
} from './engines.js';
import { resolveLanguage, resolveLocation } from './location.js';
import { analyze, normalizeDomain } from './mentions.js';
import { formatReport } from './report.js';
import { buildSnapshot, diff } from './snapshot.js';
import { cacheDirFor, domainSlug, latestSnapshot, saveSnapshot } from './store.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const HELP = `ai-visibility-checker ${VERSION}
Check whether ChatGPT, Gemini, Perplexity and Google's AI Overviews name and cite your brand,
and see what changed since the last run.

Usage
  ai-visibility-checker --brand <name> --domain <domain> --prompts <file> [options]
  ai-visibility-checker --compare <older.json> <newer.json>

Required
  --brand         Your brand name. Repeat it for other spellings and product names.
  --domain        Your site, such as example.com. Repeat it for several.
  --prompts       Text file with one buyer question per line (not needed with --engines google)

Options
  --keywords      Text file with one Google search per line, to check AI Overviews
  --engines       Any of chatgpt,gemini,perplexity,google
                  (default: the three assistants, plus google when --keywords is given)
  --competitor    A competitor's name to look for. Repeat it for several.
  --location      Country or DataForSEO location name (default: United States)
  --language      Language of the Google results (default: en)
  --model         Model for one assistant, as engine=model (defaults: chatgpt=gpt-5-mini,
                  gemini=gemini-3.5-flash, perplexity=sonar). Estimates assume the defaults.
  --max-cost      Most the run may spend, in US dollars (default: 5)
  --estimate      Print the cost estimate and stop, without calling DataForSEO
  --credentials   File with DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD lines.
                  Defaults to those environment variables.
  --out           Folder for snapshots and the day's cache (default: ./ai-visibility)
  --concurrency   Requests in parallel (default: 5)
  --json          Print the snapshot and the changes as JSON instead of the report
  --csv           Also write a CSV next to the JSON snapshot
  --compare       Compare two saved snapshots without calling DataForSEO
  -h, --help      Show this help
  -v, --version   Show the version

Raw answers are cached for the day (UTC), so running again the same day costs nothing.
`;

const OPTIONS = {
  brand: { type: 'string', multiple: true },
  domain: { type: 'string', multiple: true },
  prompts: { type: 'string' },
  keywords: { type: 'string' },
  engines: { type: 'string' },
  competitor: { type: 'string', multiple: true },
  location: { type: 'string', default: 'United States' },
  language: { type: 'string', default: 'en' },
  model: { type: 'string', multiple: true },
  'max-cost': { type: 'string', default: '5' },
  estimate: { type: 'boolean', default: false },
  credentials: { type: 'string' },
  out: { type: 'string', default: 'ai-visibility' },
  concurrency: { type: 'string', default: '5' },
  json: { type: 'boolean', default: false },
  csv: { type: 'boolean', default: false },
  compare: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

/** A mistake in the command line: reported with exit code 2, before anything is spent. */
class UsageError extends Error {}

const joinAnd = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list.join(''));
const round = (n) => Math.round(n * 1_000_000) / 1_000_000;

/** One entry per line. Blank lines and lines starting with # are skipped, and repeats dropped. */
export function readLines(file, { limit, what }) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new UsageError(`Cannot read ${file}.`);
  }
  const lines = new Set();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (line.length > limit) {
      throw new UsageError(`Line ${i + 1} of ${file} has ${line.length} characters. DataForSEO accepts up to ${limit} for a ${what}.`);
    }
    lines.add(line);
  });
  if (!lines.size) throw new UsageError(`${file} has no ${what}s.`);
  return [...lines];
}

function parseEngines(value, hasKeywords) {
  if (!value) return hasKeywords ? ALL_ENGINES : AI_ENGINES;
  const asked = value.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const unknown = asked.filter((e) => !ALL_ENGINES.includes(e));
  if (!asked.length || unknown.length) {
    throw new UsageError(`--engines takes chatgpt, gemini, perplexity and google${unknown.length ? `, not ${unknown.join(', ')}` : ''}.`);
  }
  return ALL_ENGINES.filter((e) => asked.includes(e));
}

function parseModels(entries = []) {
  const models = Object.fromEntries(AI_ENGINES.map((e) => [e, ENGINES[e].model]));
  for (const entry of entries) {
    const at = entry.indexOf('=');
    const engine = entry.slice(0, at).trim().toLowerCase();
    const model = entry.slice(at + 1).trim();
    if (at < 1 || !AI_ENGINES.includes(engine) || !model) {
      throw new UsageError(`--model takes engine=model, such as chatgpt=gpt-5, not ${entry}.`);
    }
    models[engine] = model;
  }
  return models;
}

/** Checks the command line and lists every request the run would make. Throws a UsageError on bad input. */
function plan(o, startedAt) {
  const brands = [...new Set((o.brand ?? []).map((b) => b.trim()).filter(Boolean))];
  const domains = [];
  for (const value of o.domain ?? []) {
    const domain = normalizeDomain(value);
    if (!domain) throw new UsageError(`--domain ${value} is not a domain. Pass it as example.com.`);
    if (!domains.includes(domain)) domains.push(domain);
  }
  if (!brands.length || !domains.length) throw new UsageError('--brand and --domain are required.');

  const engines = parseEngines(o.engines, Boolean(o.keywords));
  const aiEngines = engines.filter((e) => AI_ENGINES.includes(e));
  if (aiEngines.length && !o.prompts) throw new UsageError('--prompts is required: a text file with one buyer question per line.');
  if (engines.includes('google') && !o.keywords) throw new UsageError('--engines google needs --keywords: a text file with one search per line.');
  const prompts = aiEngines.length ? readLines(o.prompts, { limit: PROMPT_LIMIT, what: 'question' }) : [];
  const keywords = engines.includes('google') ? readLines(o.keywords, { limit: KEYWORD_LIMIT, what: 'keyword' }) : [];

  const models = parseModels(o.model);
  let location;
  let language;
  try {
    location = resolveLocation(o.location);
    language = resolveLanguage(o.language);
  } catch (err) {
    throw new UsageError(err.message);
  }
  const maxCost = Number(o['max-cost']);
  if (!(Number.isFinite(maxCost) && maxCost > 0)) throw new UsageError('--max-cost must be an amount in US dollars, such as 5 or 0.5.');
  const concurrency = /^\d+$/.test(o.concurrency) ? Number(o.concurrency) : NaN;
  if (!(concurrency >= 1 && concurrency <= 30)) throw new UsageError('--concurrency must be a whole number from 1 to 30.');

  const cacheDir = cacheDirFor(o.out, startedAt);
  const jobs = [];
  for (const prompt of prompts) {
    for (const engine of aiEngines) {
      const body = answerRequest(engine, prompt, { model: models[engine], country: location.country });
      jobs.push({ kind: 'answer', engine, prompt, endpoint: ENGINES[engine].endpoint, body, price: PRICES[engine] });
    }
  }
  for (const keyword of keywords) {
    const body = overviewRequest(keyword, { location: location.serp, language });
    jobs.push({ kind: 'overview', engine: 'google', keyword, endpoint: ENGINES.google.endpoint, body, price: PRICES.google });
  }
  for (const job of jobs) job.cached = isCached(cacheDir, job.endpoint, job.body);

  const competitors = [...new Set((o.competitor ?? []).map((c) => c.trim()).filter(Boolean))];
  const usedModels = Object.fromEntries(aiEngines.map((e) => [e, models[e]]));
  return { brands, domains, competitors, engines, aiEngines, prompts, keywords, models: usedModels, location, maxCost, concurrency, cacheDir, jobs };
}

/**
 * Runs the jobs with a small pool of workers. Before each call it checks that the real spend so far, plus what the
 * calls in flight and this one are expected to cost, stays within --max-cost. A call is expected to cost its
 * estimate, or the most a call to the same engine has really cost in this run, whichever is higher.
 * A fatal error stops the run too.
 */
async function runJobs(jobs, { client, cacheDir, maxCost, concurrency, onProgress }) {
  let next = 0;
  let done = 0;
  let inFlight = 0;
  let stop = null;
  const dearest = {};
  const worker = async () => {
    while (!stop && next < jobs.length) {
      const job = jobs[next];
      const expected = isCached(cacheDir, job.endpoint, job.body) ? 0 : Math.max(job.price, dearest[job.engine] ?? 0);
      if (client.tally.spent + inFlight + expected > maxCost + 1e-9) {
        stop = { reason: `the next request could have taken the spend past --max-cost ${money(maxCost)}, with ${money(client.tally.spent)} spent.` };
        break;
      }
      next += 1;
      inFlight += expected;
      try {
        job.reply = await client.post(job.endpoint, job.body);
      } catch (err) {
        if (err.fatal) stop = { reason: err.message, fatal: true };
        else {
          job.error = err.message;
          job.cost = err.cost;
        }
      } finally {
        inFlight -= expected;
      }
      dearest[job.engine] = Math.max(dearest[job.engine] ?? 0, job.reply?.cost ?? job.cost ?? 0);
      done += 1;
      onProgress(done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));
  return stop;
}

/** The snapshot records for the jobs that ran, with what each answer or overview says about you. */
function records(jobs, profile) {
  const answers = [];
  const overviews = [];
  for (const job of jobs) {
    if (!job.reply && !job.error) continue;
    const meta = { cached: Boolean(job.reply?.cached), cost: round(job.reply?.cost ?? job.cost ?? 0) };
    if (job.kind === 'answer') {
      const base = { engine: job.engine, prompt: job.prompt };
      const parsed = job.reply ? parseAnswer(job.reply.task) : null;
      if (!parsed?.text) {
        answers.push({ ...base, error: job.error ?? 'DataForSEO returned no answer text.', ...meta });
        continue;
      }
      const { model, citations, searches, text } = parsed;
      answers.push({ ...base, model, ...analyze(parsed, profile), citations, searches, text, ...meta });
    } else {
      const base = { keyword: job.keyword };
      if (job.error) {
        overviews.push({ ...base, error: job.error, ...meta });
        continue;
      }
      const parsed = parseOverview(job.reply.task);
      overviews.push({ ...base, shown: parsed.shown, ...analyze(parsed, profile), citations: parsed.citations, text: parsed.text, ...meta });
    }
  }
  return { answers, overviews };
}

function estimateText(est, { maxCost }) {
  const lines = [`Estimated cost: ${money(est.total)}`];
  const unit = (n) => `$${Number(n.toPrecision(2))}`;
  let cached = 0;
  for (const [engine, line] of Object.entries(est.byEngine)) {
    const name = engine === 'google' ? 'Google AI Overviews' : ENGINES[engine].label;
    lines.push(`  ${name.padEnd(20)}${String(line.requests).padStart(5)} x ${unit(line.each).padEnd(8)}${`$${line.cost.toFixed(3)}`.padStart(8)}`);
    cached += line.cached;
  }
  if (cached) lines.push(`  Cached today, at no cost: ${cached}`);
  lines.push(`Limit (--max-cost): ${money(maxCost)}`);
  return `${lines.join('\n')}\n`;
}

export async function run(
  argv,
  { fetchImpl = globalThis.fetch, stdout = process.stdout, stderr = process.stderr, env = process.env, now = () => new Date(), sleep } = {},
) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    stderr.write(`${err.message}\n\n${HELP}`);
    return 2;
  }
  const o = parsed.values;
  if (o.help) {
    stdout.write(HELP);
    return 0;
  }
  if (o.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (o.compare) {
    const [olderFile, newerFile] = parsed.positionals;
    if (!olderFile || !newerFile) {
      stderr.write('--compare needs two snapshot files, the older one first.\n');
      return 2;
    }
    const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    const older = read(olderFile);
    const newer = read(newerFile);
    stdout.write(o.json ? `${JSON.stringify(diff(older, newer), null, 2)}\n` : `${formatReport(newer, older)}\n`);
    return 0;
  }

  const startedAt = now().toISOString();
  let p;
  try {
    p = plan(o, startedAt);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr.write(`${err.message}\n`);
    return 2;
  }

  const est = estimate(p.jobs);
  if (o.estimate) {
    stdout.write(o.json ? `${JSON.stringify({ estimate: est, maxCost: p.maxCost }, null, 2)}\n` : estimateText(est, p));
    return 0;
  }
  const labels = p.aiEngines.map((e) => ENGINES[e].label);
  const asking = [];
  if (p.prompts.length) asking.push(`Asking ${p.prompts.length} questions on ${joinAnd(labels)}`);
  if (p.keywords.length) asking.push(`${asking.length ? 'checking' : 'Checking'} ${p.keywords.length} keywords on Google`);
  stderr.write(`${asking.join(', and ')} (${o.location}, ${o.language})\n`);
  const needCountry = p.aiEngines.filter((e) => ENGINES[e].country);
  if (needCountry.length && !p.location.country) {
    stderr.write(`${joinAnd(needCountry.map((e) => ENGINES[e].label))} will search without a country: cannot tell the country of --location ${o.location}.\n`);
  }
  const cachedJobs = p.jobs.filter((j) => j.cached).length;
  stderr.write(`Estimated cost: ${money(est.total)}, limit ${money(p.maxCost)}.${cachedJobs ? ` ${cachedJobs} already cached today, at no cost.` : ''}\n`);
  if (est.total > p.maxCost) {
    stderr.write(`The estimate is above --max-cost ${money(p.maxCost)}. Raise --max-cost to run it, or ask fewer questions.\n`);
    return 2;
  }

  const authorization = loadCredentials({ file: o.credentials, env });
  const client = createClient({ authorization, fetchImpl, cacheDir: p.cacheDir, ...(sleep ? { sleep } : {}) });
  const dir = path.join(o.out, domainSlug(p.domains[0]));
  const previous = latestSnapshot(dir);
  const onProgress = (done, total) => {
    if (stderr.isTTY) stderr.write(`\r  ${done}/${total}`);
    else if (done % 25 === 0 || done === total) stderr.write(`  ${done}/${total}\n`);
  };
  const stop = await runJobs(p.jobs, { client, cacheDir: p.cacheDir, maxCost: p.maxCost, concurrency: p.concurrency, onProgress });
  if (stderr.isTTY) stderr.write('\n');

  const { answers, overviews } = records(p.jobs, p);
  if (stop?.fatal && !answers.length && !overviews.length) throw new Error(stop.reason);

  const snapshot = buildSnapshot({
    version: VERSION,
    domain: p.domains[0],
    domains: p.domains,
    brands: p.brands,
    competitors: p.competitors,
    location: o.location,
    language: o.language,
    country: p.location.country,
    engines: p.engines,
    models: p.models,
    questions: p.prompts.length,
    keywords: p.keywords.length,
    startedAt,
    finishedAt: now().toISOString(),
    complete: !stop,
    ...(stop ? { stopReason: stop.reason } : {}),
    cost: { estimated: est.total, spent: round(client.tally.spent), calls: client.tally.calls, fromCache: client.tally.fromCache, maxCost: p.maxCost },
    answers,
    overviews,
  });
  const saved = saveSnapshot(dir, snapshot, { csv: o.csv });
  const where = `${saved.json}${saved.csv ? ` and ${saved.csv}` : ''}`;
  if (o.json) {
    const changes = previous ? diff(previous.snapshot, snapshot) : null;
    stdout.write(`${JSON.stringify({ snapshot, changes }, null, 2)}\n`);
    stderr.write(`Saved ${where}\n`);
  } else {
    stdout.write(`${formatReport(snapshot, previous?.snapshot)}\n\nSaved ${where}\n`);
  }
  return stop ? 1 : 0;
}
