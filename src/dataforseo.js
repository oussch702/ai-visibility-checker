// Talks to the DataForSEO API: one task per call, retries, a cache of the day's raw responses,
// and a tally of what DataForSEO actually charged.
// Status codes: https://docs.dataforseo.com/v3/appendix/errors/
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const API = 'https://api.dataforseo.com/v3/';

/** Codes no retry can fix. The run stops and says why. */
const FATAL = {
  40100: 'DataForSEO did not accept the login and password.',
  40104: 'DataForSEO asks you to verify your account before you use the API.',
  40200: 'DataForSEO could not bill the account. Check the balance in the DataForSEO dashboard.',
  40201: 'DataForSEO has paused access to the account.',
  40203: 'The cost limit set in your DataForSEO account has been reached.',
  40210: 'The DataForSEO balance is too low for this run. Add funds in the dashboard.',
};
/** The request itself is wrong (an unknown model, a bad location), so every similar request would fail too. */
const REJECTED = new Set([40400, 40501, 40502, 40503, 40504, 40505, 40506]);
/** Rate limits and server trouble: wait and try again. */
const BUSY = new Set([40202, 40209, 50000]);
/** The search engine failed on this one task. DataForSEO bills these, so they get a single retry. */
const ENGINE_FAILED = new Set([40101, 40103]);
/** Finished tasks: 40102 is "no search results" and 40106 is "partial results". */
const DONE = new Set([20000, 40102, 40106]);

export class DataForSeoError extends Error {
  constructor(message, { fatal = false, cost = 0 } = {}) {
    super(message);
    this.fatal = fatal;
    this.cost = cost;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoff = (attempt) => Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);

/** Path of the cached response for one request, whether or not it exists yet. */
export function cacheFile(cacheDir, endpoint, body) {
  const key = crypto.createHash('sha256').update(JSON.stringify([endpoint, body])).digest('hex').slice(0, 32);
  return path.join(cacheDir, `${key}.json`);
}

export const isCached = (cacheDir, endpoint, body) => Boolean(cacheDir) && fs.existsSync(cacheFile(cacheDir, endpoint, body));

/**
 * A client for DataForSEO's Live endpoints. `post` resolves to { task, cost, cached } or throws a DataForSeoError;
 * `tally` holds the real spend, the calls made and the answers served from the cache.
 */
export function createClient({ authorization, fetchImpl = globalThis.fetch, cacheDir = null, sleep = wait, retries = 3 }) {
  const tally = { spent: 0, calls: 0, fromCache: 0 };

  async function post(endpoint, body) {
    const file = cacheDir ? cacheFile(cacheDir, endpoint, body) : null;
    if (file && fs.existsSync(file)) {
      tally.fromCache += 1;
      return { task: JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0], cost: 0, cached: true };
    }

    let cost = 0;
    for (let attempt = 0; ; attempt += 1) {
      const again = async (limit) => {
        if (attempt >= limit) return false;
        await sleep(backoff(attempt));
        return true;
      };
      let res;
      try {
        res = await fetchImpl(API + endpoint, {
          method: 'POST',
          headers: { Authorization: authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify([body]),
        });
      } catch (err) {
        if (await again(retries)) continue;
        throw new DataForSeoError(`network: ${err.message}`, { cost });
      }
      tally.calls += 1;
      if (res.status === 401) throw new DataForSeoError(FATAL[40100], { fatal: true, cost });
      if (res.status === 402) throw new DataForSeoError(FATAL[40200], { fatal: true, cost });
      if (res.status === 404) throw new DataForSeoError(`DataForSEO has no endpoint ${endpoint}.`, { fatal: true, cost });

      const json = await res.json().catch(() => null);
      if (!json) {
        if ((res.status === 429 || res.status >= 500) && (await again(retries))) continue;
        throw new DataForSeoError(`HTTP ${res.status}`, { cost });
      }
      // What DataForSEO charged for this call, errors included.
      const charged = Number(json.cost) || 0;
      cost += charged;
      tally.spent += charged;

      const task = json.tasks?.[0];
      if (json.status_code === 20000 && !task) throw new DataForSeoError('DataForSEO returned no task.', { cost });
      // A request can succeed while its one task fails, so the task's own code decides.
      const code = json.status_code === 20000 ? task.status_code : json.status_code;
      const message = (json.status_code === 20000 ? task.status_message : json.status_message) || `status ${code}`;
      if (FATAL[code]) throw new DataForSeoError(FATAL[code], { fatal: true, cost });
      if (REJECTED.has(code)) throw new DataForSeoError(`DataForSEO rejected the request: ${message}`, { fatal: true, cost });
      if (DONE.has(code)) {
        if (file) {
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(file, JSON.stringify(json));
        }
        return { task, cost, cached: false };
      }
      if (BUSY.has(code) && (await again(retries))) continue;
      if (ENGINE_FAILED.has(code) && (await again(1))) continue;
      throw new DataForSeoError(`${code} ${message}`, { cost });
    }
  }

  return { post, tally };
}
