// The DataForSEO API login and password, from the environment or from a file.
// Nothing in this module prints them, and no error message ever quotes them.
import fs from 'node:fs';

const MISSING = 'No DataForSEO credentials. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD, or pass --credentials <file>.';

/** Reads KEY=value lines, as in a .env file, or a JSON object. Only the two DataForSEO values are kept. */
function parse(text) {
  if (text.trim().startsWith('{')) {
    const data = JSON.parse(text);
    return { login: data.login ?? data.DATAFORSEO_LOGIN, password: data.password ?? data.DATAFORSEO_PASSWORD };
  }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?(DATAFORSEO_LOGIN|DATAFORSEO_PASSWORD)\s*=\s*(.*?)\s*$/);
    if (m) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return { login: values.DATAFORSEO_LOGIN, password: values.DATAFORSEO_PASSWORD };
}

/**
 * Returns the Authorization header value for DataForSEO's Basic authentication.
 * A file given with --credentials wins over the environment variables.
 */
export function loadCredentials({ file, env = process.env } = {}) {
  let login;
  let password;
  if (file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`Cannot read the credentials file ${file}: ${err.code === 'ENOENT' ? 'file not found' : 'not readable'}.`);
    }
    try {
      ({ login, password } = parse(text));
    } catch {
      // JSON.parse quotes the text it choked on, so its message never leaves this function.
      throw new Error(`Cannot read the credentials file ${file}: not valid JSON.`);
    }
    if (!login || !password) {
      throw new Error(`${file} needs DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD lines, or a JSON object with login and password.`);
    }
  } else {
    login = env.DATAFORSEO_LOGIN?.trim();
    password = env.DATAFORSEO_PASSWORD?.trim();
    if (!login || !password) throw new Error(MISSING);
  }
  return `Basic ${Buffer.from(`${String(login).trim()}:${String(password).trim()}`).toString('base64')}`;
}
