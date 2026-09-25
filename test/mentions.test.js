import assert from 'node:assert/strict';
import test from 'node:test';
import { analyze, hostOf, mentionsDomain, namesIn, normalizeDomain, onDomain, otherNames, visibleText } from '../src/mentions.js';

test('finds a brand as a whole word, ignoring case and accents', () => {
  assert.deepEqual(namesIn('We recommend ACME for small teams.', ['Acme']), ['Acme']);
  assert.deepEqual(namesIn('Try Cafe Nero first.', ['Café Nero']), ['Café Nero']);
  assert.deepEqual(namesIn('The Acmeology course is unrelated.', ['Acme']), []);
  assert.deepEqual(namesIn('Coca-Cola and Pepsi', ['Coca Cola', 'pepsi', 'Fanta']), ['Coca Cola', 'pepsi']);
});

test('a link address is not a mention, but its visible text is', () => {
  assert.equal(visibleText('See [their docs](https://acme.com/docs) or https://acme.com'), 'See their docs or  ');
  assert.deepEqual(namesIn('See [their docs](https://acme.com/docs).', ['Acme']), []);
  assert.deepEqual(namesIn('Sources: ([acme.com](https://acme.com/?utm_source=openai))', ['Acme']), ['Acme']);
});

test('spots a domain written in the text, subdomains included', () => {
  assert.equal(mentionsDomain('Order from Example.com today.', 'example.com'), true);
  assert.equal(mentionsDomain('Their shop.example.com page lists prices.', 'example.com'), true);
  assert.equal(mentionsDomain('Try notexample.com instead.', 'example.com'), false);
  assert.equal(mentionsDomain('Try example.com.au for Australia.', 'example.com'), false);
  assert.equal(mentionsDomain('[Read more](https://example.com/guide)', 'example.com'), false);
});

test('matches cited hosts to your domain', () => {
  assert.equal(hostOf('https://www.Example.com/a?b=c'), 'example.com');
  assert.equal(hostOf('not a url'), null);
  assert.equal(onDomain('blog.example.com', 'example.com'), true);
  assert.equal(onDomain('example.com.evil.net', 'example.com'), false);
  assert.equal(onDomain('myexample.com', 'example.com'), false);
});

test('normalizes the --domain value', () => {
  assert.equal(normalizeDomain('https://www.Example.com/pricing'), 'example.com');
  assert.equal(normalizeDomain('shop.example.co.uk'), 'shop.example.co.uk');
  assert.equal(normalizeDomain('not a domain'), null);
  assert.equal(normalizeDomain('localhost'), null);
});

test('lists the other names an answer puts forward, and skips headings and known names', () => {
  const answer = [
    'Here are good options:',
    '',
    '### 1. Globex',
    '1. **Initech**: simple and cheap',
    '2. Umbrella (best for large teams)',
    '- **Acme CRM**: popular with agencies',
    '- Easy setup for new users',
    '- **Pros and Cons**',
    '**Best Overall:** Hooli',
    'Some **really useful features** too.',
  ].join('\n');
  assert.deepEqual(otherNames(answer, ['Acme']), ['Globex', 'Initech', 'Umbrella']);
});

test('analyze combines names, citations and competitors', () => {
  const result = analyze(
    {
      text: 'For agencies, **Example** and Acme both work.',
      citations: [
        { url: 'https://blog.example.com/a', domain: 'blog.example.com' },
        { url: 'https://g2.com/b', domain: 'g2.com' },
        { url: 'https://g2.com/c', domain: 'g2.com' },
      ],
    },
    { brands: ['Example'], domains: ['example.com'], competitors: ['Acme', 'Globex'] },
  );
  assert.equal(result.named, true);
  assert.equal(result.cited, true);
  assert.deepEqual(result.competitors, ['Acme']);
  assert.deepEqual(result.citedDomains, ['blog.example.com', 'g2.com']);
});

test('the domain in the text counts as naming you', () => {
  const result = analyze({ text: 'A retailer such as example.com ships in two days.', citations: [] }, { brands: ['Example Shop'], domains: ['example.com'] });
  assert.equal(result.named, true);
  assert.equal(result.cited, false);
});
