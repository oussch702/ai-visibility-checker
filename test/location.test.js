import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLanguage, resolveLocation } from '../src/location.js';

test('a country name gives Google the name and the assistants the country code', () => {
  assert.deepEqual(resolveLocation('United States'), { serp: { location_name: 'United States' }, country: 'US' });
  assert.deepEqual(resolveLocation('London,England,United Kingdom'), { serp: { location_name: 'London,England,United Kingdom' }, country: 'GB' });
});

test('a two-letter code works both ways, UK included', () => {
  assert.deepEqual(resolveLocation('de'), { serp: { location_name: 'Germany' }, country: 'DE' });
  assert.deepEqual(resolveLocation('UK'), { serp: { location_name: 'United Kingdom' }, country: 'GB' });
  assert.throws(() => resolveLocation('QQ'), /not a country code/);
});

test('a DataForSEO location code goes to Google as is, with no country for the assistants', () => {
  assert.deepEqual(resolveLocation('2840'), { serp: { location_code: 2840 }, country: null });
});

test('a language is a code or a name', () => {
  assert.deepEqual(resolveLanguage('fr'), { language_code: 'fr' });
  assert.deepEqual(resolveLanguage('pt-BR'), { language_code: 'pt-BR' });
  assert.deepEqual(resolveLanguage('French'), { language_name: 'French' });
});
