#!/usr/bin/env node
/**
 * Optional V8 sidecar warm-load bench (#3089).
 *
 * Not part of `npm test`. Measures repeated warm loads of the `.v8` ParsedFile
 * shards already on disk through the production loader. Replay of identical
 * shards is throughput-only — it is not unique-object scale.
 *
 * Copies the store into a temporary workspace first. The source cache is
 * never mutated.
 *
 * Usage (from gitnexus/):
 *   node --expose-gc --import tsx bench/v8-sidecar/measure.mjs <storagePath>
 */
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadParsedFilesForPaths } from '../../src/storage/parsedfile-store.ts';
import { tryLoadV8Cache } from '../../src/storage/v8-sidecar.ts';

const srcStorage = process.argv[2];
if (!srcStorage) {
  console.error('usage: node --expose-gc --import tsx bench/v8-sidecar/measure.mjs <storagePath>');
  process.exit(2);
}

const srcStoreDir = path.join(srcStorage, 'parsedfile-store');
const benchRoot = await mkdtemp(path.join(tmpdir(), 'gnx-v8-bench-'));
const storeDir = path.join(benchRoot, 'parsedfile-store');
const PATH_SOURCE_SHARDS = 8;
const RUNS = 3;

try {
  await cp(srcStoreDir, storeDir, { recursive: true });

  const names = (await readdir(storeDir))
    .filter((f) => f.endsWith('.v8') && !f.includes('.v8.'))
    .sort();
  if (names.length === 0) {
    throw new Error(
      `no .v8 ParsedFile shards in ${srcStoreDir} — run an analyze that populates the store first`,
    );
  }

  const want = new Set();
  let sourceShards = 0;
  for (const name of names) {
    const loaded = await tryLoadV8Cache(path.join(storeDir, name), new Map());
    if (loaded?.kind !== 'hit' || !Array.isArray(loaded.value)) continue;
    sourceShards++;
    for (const pf of loaded.value) {
      if (pf && typeof pf.filePath === 'string') want.add(pf.filePath);
    }
    if (sourceShards >= PATH_SOURCE_SHARDS) break;
  }
  if (want.size === 0) {
    throw new Error(
      `no file paths readable from the first ${Math.min(PATH_SOURCE_SHARDS, names.length)} of ${names.length} shard(s) in ${srcStoreDir} — shards may be from another Node/V8 runtime, so re-analyze with this runtime`,
    );
  }

  const rss = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
  const heap = () => Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

  const run = async (label) => {
    if (typeof globalThis.gc === 'function') globalThis.gc();
    const t0 = performance.now();
    const loaded = await loadParsedFilesForPaths(benchRoot, want);
    const ms = Math.round(performance.now() - t0);
    if (loaded.size !== want.size) {
      throw new Error(`incomplete V8 load: requested ${want.size} paths but loaded ${loaded.size}`);
    }
    if (typeof globalThis.gc === 'function') globalThis.gc();
    console.log(
      JSON.stringify({
        label,
        shards: names.length,
        wantPaths: want.size,
        files: loaded.size,
        ms,
        rssMiB: rss(),
        heapUsedMiB: heap(),
      }),
    );
  };

  for (let i = 1; i <= RUNS; i++) {
    await run(`v8-load-${i}`);
  }
} finally {
  await rm(benchRoot, { recursive: true, force: true });
}
