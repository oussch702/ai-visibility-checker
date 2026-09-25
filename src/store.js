// Where snapshots and the day's cache live:
//   <out>/<domain>/<finished-at>.json, oldest to newest by file name
//   <out>/.cache/<yyyy-mm-dd>/<request hash>.json, the raw DataForSEO responses of that UTC day
import fs from 'node:fs';
import path from 'node:path';
import { toCsv } from './snapshot.js';

/** Folder name for a domain. */
export const domainSlug = (domain) => domain.replace(/[^a-z0-9.-]+/gi, '_');

/** A file-name-safe timestamp: 2026-09-19T20:49:43.171Z becomes 2026-09-19T20-49-43Z. */
export const stamp = (iso) => iso.replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');

/** The cache folder for the UTC day of `iso`. */
export const cacheDirFor = (out, iso) => path.join(out, '.cache', iso.slice(0, 10));

const SNAPSHOT_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/;

/** The most recent snapshot in a folder, or null. */
export function latestSnapshot(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => SNAPSHOT_FILE.test(f)).sort();
  if (!files.length) return null;
  const file = path.join(dir, files[files.length - 1]);
  return { file, snapshot: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

/** Writes the snapshot as JSON, and as CSV when asked. Returns the paths written. */
export function saveSnapshot(dir, snapshot, { csv = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, stamp(snapshot.finishedAt));
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(snapshot, null, 2)}\n`);
  if (csv) fs.writeFileSync(`${base}.csv`, toCsv(snapshot));
  return { json: `${base}.json`, csv: csv ? `${base}.csv` : null };
}
