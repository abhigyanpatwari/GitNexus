#!/usr/bin/env node
/**
 * Optional V8 sidecar warm-load bench (#3089).
 *
 * Not part of `npm test`. Compares interned JSON load vs V8 sidecar load of
 * the same ParsedFile shards already on disk. Replay of identical shards is
 * throughput-only — it is not unique-object scale.
 *
 * Usage (from gitnexus/):
 *   node --expose-gc --import tsx bench/v8-sidecar/measure.mjs <parsedfile-store-dir>
 */
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadParsedFilesForPaths } from '../../src/storage/parsedfile-store.ts';

const storeParent = process.argv[2];
if (!storeParent) {
  console.error('usage: node --expose-gc --import tsx bench/v8-sidecar/measure.mjs <storagePath>');
  process.exit(2);
}

const storeDir = path.join(storeParent, 'parsedfile-store');
const names = (await readdir(storeDir)).filter((f) => f.endsWith('.json') && !f.includes('.json.'));
const want = new Set();
for (const name of names.slice(0, 8)) {
  const raw = await readFile(path.join(storeDir, name), 'utf8');
  const arr = JSON.parse(raw);
  if (Array.isArray(arr)) {
    for (const pf of arr) {
      if (pf && typeof pf.filePath === 'string') want.add(pf.filePath);
    }
  }
}

const rss = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const heap = () => Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

const run = async (label) => {
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const t0 = performance.now();
  const loaded = await loadParsedFilesForPaths(storeParent, want);
  const ms = Math.round(performance.now() - t0);
  if (typeof globalThis.gc === 'function') globalThis.gc();
  console.log(
    JSON.stringify({
      label,
      files: loaded.size,
      ms,
      rssMiB: rss(),
      heapUsedMiB: heap(),
    }),
  );
};

await run('v8-or-json');
for (const name of names) {
  await rm(path.join(storeDir, `${name}.v8`), { force: true });
}
await run('json-only');
