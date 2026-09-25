// The four places the tool asks: ChatGPT, Gemini and Perplexity through DataForSEO's LLM Responses API,
// and Google's AI Overviews through its SERP API. Builds each request and reads each reply.
// https://docs.dataforseo.com/v3/ai_optimization/chat_gpt/llm_responses/live/
// https://docs.dataforseo.com/v3/ai_optimization/gemini/llm_responses/live/
// https://docs.dataforseo.com/v3/ai_optimization/perplexity/llm_responses/live/
// https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/
import { hostOf, normalizeDomain } from './mentions.js';

export const ENGINES = {
  chatgpt: { label: 'ChatGPT', endpoint: 'ai_optimization/chat_gpt/llm_responses/live', model: 'gpt-5-mini', webSearch: true, country: true },
  // DataForSEO's Gemini endpoint takes no country for its web search.
  gemini: { label: 'Gemini', endpoint: 'ai_optimization/gemini/llm_responses/live', model: 'gemini-3.5-flash', webSearch: true, country: false },
  // Sonar models always search the web, so the request has no web_search field.
  perplexity: { label: 'Perplexity', endpoint: 'ai_optimization/perplexity/llm_responses/live', model: 'sonar', webSearch: false, country: true },
  google: { label: 'Google', endpoint: 'serp/google/organic/live/advanced' },
};

export const AI_ENGINES = ['chatgpt', 'gemini', 'perplexity'];
export const ALL_ENGINES = [...AI_ENGINES, 'google'];

/** DataForSEO accepts a user_prompt of up to 500 characters and a keyword of up to 700. */
export const PROMPT_LIMIT = 500;
export const KEYWORD_LIMIT = 700;
/** Long enough for a full answer with a list of recommendations, and a known ceiling for the cost estimate. */
export const MAX_OUTPUT_TOKENS = 2048;

/** The task for one question on one assistant. */
export function answerRequest(engine, prompt, { model, country } = {}) {
  const e = ENGINES[engine];
  const body = { user_prompt: prompt, model_name: model || e.model, max_output_tokens: MAX_OUTPUT_TOKENS };
  if (e.webSearch) body.web_search = true;
  if (e.country && country) body.web_search_country_iso_code = country;
  return body;
}

/**
 * The task for one Google search. One page of results is enough, since an AI Overview sits at the top,
 * and load_async_ai_overview also returns the overviews Google loads after the page.
 */
export function overviewRequest(keyword, { location = { location_name: 'United States' }, language = { language_code: 'en' } } = {}) {
  return { keyword, ...location, ...language, device: 'desktop', depth: 10, load_async_ai_overview: true };
}

const citation = (url, domain, title) => ({ url: url || null, domain: hostOf(url) || normalizeDomain(domain), title: title || null });

/** Reads an LLM Responses task: the answer's text, the sources it cites and the searches the model ran. Null when there is no result. */
export function parseAnswer(task) {
  const result = task?.result?.[0];
  if (!result) return null;
  // "reasoning" items hold the model's working notes; only "message" items are shown to the user.
  const sections = (result.items ?? []).filter((item) => item?.type === 'message').flatMap((item) => item.sections ?? []);
  const text = sections.map((s) => s.text ?? '').join('\n').trim();
  const citations = [];
  const seen = new Set();
  for (const a of sections.flatMap((s) => s.annotations ?? [])) {
    // Gemini's url is a Vertex AI redirect; direct_url is the page it leads to.
    const url = a?.direct_url || a?.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    citations.push(citation(url, null, a.title));
  }
  return { model: result.model_name ?? null, text, citations, searches: result.fan_out_queries ?? [] };
}

/** Collects every `references` array inside an AI Overview: the overview's own list and each section's. */
function references(node, found = []) {
  if (Array.isArray(node)) node.forEach((child) => references(child, found));
  else if (node && typeof node === 'object') {
    if (Array.isArray(node.references)) found.push(...node.references);
    for (const [key, value] of Object.entries(node)) if (key !== 'references' && typeof value === 'object') references(value, found);
  }
  return found;
}

/** Reads a SERP task: whether Google showed an AI Overview, its text, and the sources it cites. */
export function parseOverview(task) {
  const overviews = (task?.result?.[0]?.items ?? []).filter((item) => item?.type === 'ai_overview');
  if (!overviews.length) return { shown: false, text: '', citations: [] };
  const text = overviews
    .map((o) => o.markdown || (o.items ?? []).map((el) => el?.text ?? '').join('\n'))
    .join('\n')
    .trim();
  const citations = [];
  const seen = new Set();
  for (const ref of references(overviews)) {
    const key = ref?.url || ref?.domain;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    citations.push(citation(ref.url, ref.domain, ref.title));
  }
  return { shown: true, text, citations };
}
