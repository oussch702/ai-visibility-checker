import assert from 'node:assert/strict';
import test from 'node:test';
import { PRICES, estimate, money } from '../src/cost.js';

test('estimates each engine at its own price and cached answers at nothing', () => {
  const est = estimate([
    { engine: 'chatgpt', cached: false },
    { engine: 'chatgpt', cached: true },
    { engine: 'gemini', cached: false },
    { engine: 'perplexity', cached: false },
    { engine: 'google', cached: false },
  ]);
  assert.equal(est.total, Math.round((PRICES.chatgpt + PRICES.gemini + PRICES.perplexity + PRICES.google) * 10_000) / 10_000);
  assert.deepEqual(est.byEngine.chatgpt, { requests: 1, cached: 1, each: PRICES.chatgpt, cost: PRICES.chatgpt });
});

test('ten questions on the three assistants come to about 71 cents', () => {
  const jobs = ['chatgpt', 'gemini', 'perplexity'].flatMap((engine) => Array.from({ length: 10 }, () => ({ engine, cached: false })));
  assert.equal(money(estimate(jobs).total), '$0.71');
});

test('formats amounts, keeping precision under a cent', () => {
  assert.equal(money(0.4321), '$0.43');
  assert.equal(money(0.0077), '$0.0077');
  assert.equal(money(0), '$0.00');
});
