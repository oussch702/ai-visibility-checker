import assert from 'node:assert/strict';
import test from 'node:test';
import { answerRequest, overviewRequest, parseAnswer, parseOverview } from '../src/engines.js';

test('builds each assistant request the way its endpoint documents it', () => {
  assert.deepEqual(answerRequest('chatgpt', 'Best CRM?', { country: 'US' }), {
    user_prompt: 'Best CRM?',
    model_name: 'gpt-5-mini',
    max_output_tokens: 2048,
    web_search: true,
    web_search_country_iso_code: 'US',
  });
  // Gemini takes no country; Perplexity's Sonar models always search and take no web_search field.
  assert.deepEqual(answerRequest('gemini', 'Best CRM?', { country: 'US' }), {
    user_prompt: 'Best CRM?',
    model_name: 'gemini-3.5-flash',
    max_output_tokens: 2048,
    web_search: true,
  });
  assert.deepEqual(answerRequest('perplexity', 'Best CRM?', { country: 'US', model: 'sonar-pro' }), {
    user_prompt: 'Best CRM?',
    model_name: 'sonar-pro',
    max_output_tokens: 2048,
    web_search_country_iso_code: 'US',
  });
});

test('asks Google for one page with the asynchronous AI Overview loaded', () => {
  assert.deepEqual(overviewRequest('crm for agencies', { location: { location_code: 2840 }, language: { language_name: 'English' } }), {
    keyword: 'crm for agencies',
    location_code: 2840,
    language_name: 'English',
    device: 'desktop',
    depth: 10,
    load_async_ai_overview: true,
  });
});

const task = (result) => ({ status_code: 20000, result: result ? [result] : null });

test('reads the answer shown to the user, never the reasoning notes', () => {
  const parsed = parseAnswer(
    task({
      model_name: 'gpt-5-mini-2025-08-07',
      fan_out_queries: ['best crm for agencies'],
      items: [
        { type: 'reasoning', sections: [{ type: 'summary_text', text: 'Maybe mention Example?' }] },
        {
          type: 'message',
          sections: [
            {
              type: 'text',
              text: 'Acme is a good fit.',
              annotations: [
                { title: 'g2.com', url: 'https://www.g2.com/a?utm_source=openai' },
                { title: 'g2.com', url: 'https://www.g2.com/a?utm_source=openai' },
                { title: 'Capterra', url: 'https://capterra.com/b' },
              ],
            },
          ],
        },
      ],
    }),
  );
  assert.equal(parsed.text, 'Acme is a good fit.');
  assert.equal(parsed.model, 'gpt-5-mini-2025-08-07');
  assert.deepEqual(parsed.searches, ['best crm for agencies']);
  assert.deepEqual(
    parsed.citations.map((c) => c.domain),
    ['g2.com', 'capterra.com'],
  );
});

test("uses Gemini's direct_url, not its Vertex AI redirect", () => {
  const parsed = parseAnswer(
    task({
      items: [
        {
          type: 'message',
          sections: [
            {
              type: 'text',
              text: 'Example is popular.',
              annotations: [
                {
                  title: 'example.com',
                  url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc',
                  direct_url: 'https://www.example.com/pricing',
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(parsed.citations, [{ url: 'https://www.example.com/pricing', domain: 'example.com', title: 'example.com' }]);
});

test('a task without a result is no answer', () => {
  assert.equal(parseAnswer(task(null)), null);
  assert.equal(parseAnswer(undefined), null);
});

test('reads an AI Overview with its own sources and its sections sources', () => {
  const parsed = parseOverview(
    task({
      items: [
        { type: 'organic', url: 'https://example.com/' },
        {
          type: 'ai_overview',
          markdown: 'Agencies often pick **Acme**.',
          references: [{ source: 'G2', domain: 'www.g2.com', url: 'https://www.g2.com/crm', title: 'Best CRM' }],
          items: [
            {
              type: 'ai_overview_element',
              text: 'Agencies often pick Acme.',
              references: [
                { domain: 'www.g2.com', url: 'https://www.g2.com/crm' },
                { domain: 'example.com', url: 'https://example.com/blog/crm' },
              ],
            },
          ],
        },
      ],
    }),
  );
  assert.equal(parsed.shown, true);
  assert.equal(parsed.text, 'Agencies often pick **Acme**.');
  assert.deepEqual(
    parsed.citations.map((c) => c.url),
    ['https://www.g2.com/crm', 'https://example.com/blog/crm'],
  );
});

test('a results page without an AI Overview, or without results, shows none', () => {
  assert.deepEqual(parseOverview(task({ items: [{ type: 'organic' }] })), { shown: false, text: '', citations: [] });
  assert.deepEqual(parseOverview(task(null)), { shown: false, text: '', citations: [] });
});
