import type { RawCoverageRecord } from '../path-coverage/records.js';
import { sha1 } from '../util.js';

/** Content-addressed UTF-8 fixture files. Root directories and test IDs do not enter the key. */
export type FixtureSources = Record<string, [string, string][]>;

export function capturedFixtureSources(records: readonly RawCoverageRecord[]): FixtureSources {
  const sources: FixtureSources = Object.create(null);
  for (const record of records)
    for (const snapshot of Object.values(record.fixtureSnapshots ?? {})) {
      if (snapshot.files.length) sources[sha1(JSON.stringify(snapshot.files))] = snapshot.files;
    }
  return sources;
}

export function mergeFixtureSources(
  tables: readonly (FixtureSources | undefined)[],
): FixtureSources {
  const merged: FixtureSources = Object.create(null);
  for (const table of tables)
    for (const [key, files] of Object.entries(table ?? {})) {
      if (sha1(JSON.stringify(files)) !== key)
        throw new Error(`fixture source hash mismatch: ${key}`);
      merged[key] = files;
    }
  return merged;
}
