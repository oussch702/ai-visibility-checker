import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { API, cacheFile, createClient, isCached } from '../src/dataforseo.js';

const AUTH = `Basic ${Buffer.from('login-value:password-value').toString('base64')}`;
const sleep = async () => {};
const ENDPOINT = 'ai_optimization/chat_gpt/llm_responses/live';
const BODY = { user_prompt: 'Best CRM?', model_name: 'gpt-5-mini' };

const ok = (cost = 0.012) => ({
  status_code: 20000,
  status_message: 'Ok.',
  cost,
  tasks: [{ status_code: 20000, status_message: 'Ok.', cost, result: [{ items: [] }] }],
});
const taskError = (code, message, cost = 0) => ({
  status_code: 20000,
  status_message: 'Ok.',
  cost,
  tasks: [{ status_code: code, status_message: message, cost, result: null }],
});

/** A fake fetch that answers with the given replies in order and records every call. */
const replies = (...list) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = list[Math.min(calls.length - 1, list.length - 1)];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : Response.json(next);
  };
  return { fetchImpl, calls };
};

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-visibility-client-'));

test('posts one task with Basic authentication and tallies the cost DataForSEO reports', async () => {
  const { fetchImpl, calls } = replies(ok(0.012));
  const client = createClient({ authorization: AUTH, fetchImpl, sleep });
  const reply = await client.post(ENDPOINT, BODY);
  assert.equal(calls[0].url, `${API}${ENDPOINT}`);
  assert.equal(calls[0].init.headers.Authorization, AUTH);
  assert.deepEqual(JSON.parse(calls[0].init.body), [BODY]);
  assert.equal(reply.cost, 0.012);
  assert.equal(reply.cached, false);
  assert.equal(client.tally.spent, 0.012);
  assert.equal(client.tally.calls, 1);
});

test('serves a second identical request from the day cache, for free', async () => {
  const cacheDir = tempDir();
  const { fetchImpl, calls } = replies(ok(0.012));
  const client = createClient({ authorization: AUTH, fetchImpl, cacheDir, sleep });
  assert.equal(isCached(cacheDir, ENDPOINT, BODY), false);
  await client.post(ENDPOINT, BODY);
  assert.equal(isCached(cacheDir, ENDPOINT, BODY), true);
  const again = await client.post(ENDPOINT, BODY);
  assert.equal(again.cached, true);
  assert.equal(again.cost, 0);
  assert.equal(calls.length, 1);
  assert.equal(client.tally.fromCache, 1);
  assert.equal(client.tally.spent, 0.012);
  // A different question is a different request.
  assert.equal(isCached(cacheDir, ENDPOINT, { ...BODY, user_prompt: 'Cheapest CRM?' }), false);
});

test('the cache holds the response only, never the credentials', async () => {
  const cacheDir = tempDir();
  const { fetchImpl } = replies(ok());
  await createClient({ authorization: AUTH, fetchImpl, cacheDir, sleep }).post(ENDPOINT, BODY);
  const saved = fs.readFileSync(cacheFile(cacheDir, ENDPOINT, BODY), 'utf8');
  assert.doesNotMatch(saved, /login-value|password-value|Basic /);
});

test('retries a search engine failure once, pays for both tries, and caches neither', async () => {
  const cacheDir = tempDir();
  const { fetchImpl, calls } = replies(taskError(40101, 'Internal SE Server Error.', 0.002));
  const client = createClient({ authorization: AUTH, fetchImpl, cacheDir, sleep });
  await assert.rejects(client.post(ENDPOINT, BODY), (err) => {
    assert.equal(err.fatal, false);
    assert.match(err.message, /40101 Internal SE Server Error/);
    assert.equal(err.cost, 0.004);
    return true;
  });
  assert.equal(calls.length, 2);
  assert.equal(client.tally.spent, 0.004);
  assert.equal(isCached(cacheDir, ENDPOINT, BODY), false);
});

test('waits out a rate limit and a server error', async () => {
  const { fetchImpl, calls } = replies(
    () => Response.json({ status_code: 40202, status_message: 'Rate limit.' }, { status: 429 }),
    () => new Response('Bad gateway', { status: 502 }),
    ok(),
  );
  const reply = await createClient({ authorization: AUTH, fetchImpl, sleep }).post(ENDPOINT, BODY);
  assert.equal(reply.task.status_code, 20000);
  assert.equal(calls.length, 3);
});

test('retries a network failure, then reports it for this request only', async () => {
  const { fetchImpl, calls } = replies(new Error('socket hang up'));
  await assert.rejects(createClient({ authorization: AUTH, fetchImpl, sleep, retries: 2 }).post(ENDPOINT, BODY), (err) => {
    assert.equal(err.fatal, false);
    assert.match(err.message, /network: socket hang up/);
    return true;
  });
  assert.equal(calls.length, 3);
});

test('stops the run on refused credentials, without quoting them', async () => {
  const { fetchImpl } = replies(() => Response.json({ status_code: 40100, status_message: 'You are not authorized.' }, { status: 401 }));
  await assert.rejects(createClient({ authorization: AUTH, fetchImpl, sleep }).post(ENDPOINT, BODY), (err) => {
    assert.equal(err.fatal, true);
    assert.match(err.message, /did not accept the login and password/);
    assert.doesNotMatch(err.message, /login-value|password-value/);
    return true;
  });
});

test('stops the run when the balance is too low or the request is invalid', async () => {
  const low = replies({ status_code: 40210, status_message: 'Insufficient funds.', cost: 0 });
  await assert.rejects(createClient({ authorization: AUTH, fetchImpl: low.fetchImpl, sleep }).post(ENDPOINT, BODY), (err) => err.fatal && /balance is too low/.test(err.message));
  const invalid = replies(taskError(40501, "Invalid Field: 'model_name'."));
  await assert.rejects(createClient({ authorization: AUTH, fetchImpl: invalid.fetchImpl, sleep }).post(ENDPOINT, BODY), (err) => {
    assert.equal(err.fatal, true);
    assert.match(err.message, /rejected the request: Invalid Field: 'model_name'/);
    return true;
  });
});

test('a search with no results is an answer, not an error', async () => {
  const { fetchImpl } = replies(taskError(40102, 'No Search Results.', 0.002));
  const reply = await createClient({ authorization: AUTH, fetchImpl, sleep }).post('serp/google/organic/live/advanced', { keyword: 'x' });
  assert.equal(reply.task.status_code, 40102);
  assert.equal(reply.cost, 0.002);
});
