import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadCredentials } from '../src/credentials.js';

const basic = (login, password) => `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;

const tempFile = (name, content) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-visibility-creds-')), name);
  fs.writeFileSync(file, content);
  return file;
};

test('reads the login and password from the environment', () => {
  const env = { DATAFORSEO_LOGIN: ' login-value ', DATAFORSEO_PASSWORD: 'password-value' };
  assert.equal(loadCredentials({ env }), basic('login-value', 'password-value'));
});

test('reads a .env style file, quotes and export included', () => {
  const file = tempFile('dataforseo.env', '# DataForSEO\nexport DATAFORSEO_LOGIN="login-value"\nDATAFORSEO_PASSWORD=\'password-value\'\nOTHER=1\n');
  assert.equal(loadCredentials({ file, env: {} }), basic('login-value', 'password-value'));
});

test('reads a JSON file, and a file wins over the environment', () => {
  const file = tempFile('dataforseo.json', JSON.stringify({ login: 'login-value', password: 'password-value' }));
  const env = { DATAFORSEO_LOGIN: 'other', DATAFORSEO_PASSWORD: 'other' };
  assert.equal(loadCredentials({ file, env }), basic('login-value', 'password-value'));
});

test('explains missing or unusable credentials without quoting them', () => {
  assert.throws(() => loadCredentials({ env: { DATAFORSEO_LOGIN: 'login-value' } }), /Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD/);
  assert.throws(() => loadCredentials({ file: '/nonexistent/dataforseo.env', env: {} }), /file not found/);
  const broken = tempFile('broken.json', '{"login": "login-value", "password": password-value}');
  assert.throws(
    () => loadCredentials({ file: broken, env: {} }),
    (err) => /not valid JSON/.test(err.message) && !/login-value|password-value/.test(err.message),
  );
  const half = tempFile('half.env', 'DATAFORSEO_LOGIN=login-value\n');
  assert.throws(
    () => loadCredentials({ file: half, env: {} }),
    (err) => /needs DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD/.test(err.message) && !/login-value/.test(err.message),
  );
});
