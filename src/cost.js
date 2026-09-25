// What each request is expected to cost, in US dollars, with the default models and 2,048 output tokens at most.
// An AI answer costs DataForSEO's $0.0006 Live task fee plus what the model's provider charges for tokens and web
// searches, which DataForSEO passes through. Prices as published on 2026-09-25:
//   https://dataforseo.com/pricing/ai-optimization/llm-responses
//   https://dataforseo.com/help-center/how-the-price-for-using-llm-responses-endpoints-is-calculated
//   https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/
//   https://developers.openai.com/api/docs/pricing
//   https://ai.google.dev/gemini-api/docs/pricing
//   https://docs.perplexity.ai/getting-started/pricing
// Real costs move with answer length and with how many searches a model runs, so the run also keeps a tally of
// what DataForSEO reports for every call, and --max-cost applies to that tally.

export const PRICES = {
  // gpt-5-mini: $0.0006 task fee, one web search call at $10 per 1,000, about 5,000 input tokens (search results
  // count as input) at $0.25 per million, and up to 2,048 output tokens at $2 per million.
  chatgpt: 0.016,
  // gemini-3.5-flash: $0.0006 task fee, Google Search at $14 per 1,000 queries with two queries assumed per
  // answer, and up to 2,048 output tokens at $9 per million.
  gemini: 0.047,
  // sonar: $0.0006 task fee, a request fee of $5 per 1,000 at the default low search context, and tokens at
  // $1 per million.
  perplexity: 0.0077,
  // $0.002 for a results page of up to 10 results, and $0.002 more for load_async_ai_overview.
  google: 0.004,
};

/** Estimate for a list of jobs, each { engine, cached }. Cached answers cost nothing. */
export function estimate(jobs) {
  const byEngine = {};
  let total = 0;
  for (const { engine, cached } of jobs) {
    const line = (byEngine[engine] ??= { requests: 0, cached: 0, each: PRICES[engine], cost: 0 });
    if (cached) {
      line.cached += 1;
    } else {
      line.requests += 1;
      line.cost += PRICES[engine];
      total += PRICES[engine];
    }
  }
  return { total: Math.round(total * 10_000) / 10_000, byEngine };
}

/** $0.43, or $0.0077 for amounts under a cent. */
export const money = (n) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
