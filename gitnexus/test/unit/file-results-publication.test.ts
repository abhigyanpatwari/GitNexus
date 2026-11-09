import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  loadAnalysisParseCache,
  publishAnalysisParseCache,
  stageAnalysisParseCache,
} from '../../src/core/analysis-parse-cache.js';
import {
  createColdParseRebuildDir,
  emptyParseCache,
  loadParseCache,
  loadParseCacheFiles,
  persistParseCacheFiles,
  saveParseCache,
  type ParseCache,
} from '../../src/storage/parse-cache.js';
import { encodeFileResultSection } from '../../src/storage/file-result-codec.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';
import { TEST_PARSE_IDENTITY } from '../helpers/cache-identity.js';

const generation = 'e'.repeat(32);
const a = 'a'.repeat(64),
  b = 'b'.repeat(64),
  c = 'c'.repeat(64),
  d = 'd'.repeat(64);
let root: string, stage: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gn-file-publication-')));
  stage = await createColdParseRebuildDir(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const metadata = (keys: string[]): RepoMeta => ({
  repoPath: root,
  lastCommit: '1'.repeat(40),
  indexedAt: '2026-11-09T00:00:00Z',
  graphGeneration: { version: 1, id: generation, coveredContent: 'f'.repeat(64) },
  parseCacheIdentity: { base: TEST_PARSE_IDENTITY.base },
  cacheKeys: keys,
});
const options = (keys: string[] = [], complete = true) => ({
  storagePath: root,
  metadataDirectory: root,
  cacheRoot: root,
  publishedGeneration: generation,
  collectBranchKeys: async () => ({ keys: new Set(keys), complete }),
  log: vi.fn(),
});
async function put(cache: ParseCache, key: string, name: string) {
  await persistParseCacheFiles(cache, [
    {
      key,
      path: `${key}.ts`,
      cacheable: true,
      facts: encodeFileResultSection(key, `${key}.ts`, 'facts', {
        name,
        nodes: [],
        parsedFiles: [],
      })!,
      scopes: encodeFileResultSection(key, `${key}.ts`, 'scopes', [])!,
    },
  ]);
  cache.usedKeys.add(key);
}
async function live(keys: [string, string][]) {
  const cache = emptyParseCache(TEST_PARSE_IDENTITY);
  for (const [key, name] of keys) await put(cache, key, name);
  await saveParseCache(root, cache);
}
async function restored(keys: string[]) {
  const cache = await loadAnalysisParseCache(root, metadata(keys));
  if (!cache) throw new Error('Missing cache handoff');
  return cache;
}
const read = (cache: ParseCache, key: string) =>
  loadParseCacheFiles(cache, [{ key, path: `${key}.ts` }]);

it('hands off packed repairs, merges newer sibling files, and excludes retired keys', async () => {
  await live([
    [a, 'old'],
    [b, 'retired'],
  ]);
  const cache = await loadParseCache(root, TEST_PARSE_IDENTITY, stage);
  cache.usedKeys = new Set([a, b, c]);
  cache.staleKeys = new Set([b]);
  await put(cache, a, 'repaired');
  await put(cache, c, 'new');
  await stageAnalysisParseCache(root, generation, cache);
  await live([
    [a, 'old'],
    [b, 'retired'],
    [d, 'sibling'],
  ]);
  await publishAnalysisParseCache(await restored([a, b, c]), options([b, d]));
  const published = await loadParseCache(root, TEST_PARSE_IDENTITY, stage);
  expect([...(published.onDiskKeys ?? [])].sort()).toEqual([a, c, d]);
  expect((await read(published, a)).get(a)).toMatchObject({ name: 'repaired' });
  expect((await read(published, d)).get(d)).toMatchObject({ name: 'sibling' });
  await expect(fs.stat(path.join(root, `analysis-cache-${generation}.json`))).rejects.toMatchObject(
    { code: 'ENOENT' },
  );
});

it('does not fall back to a live file when its staged repair disappears', async () => {
  await live([[a, 'old']]);
  const cache = await loadParseCache(root, TEST_PARSE_IDENTITY, stage);
  await put(cache, a, 'repair');
  await stageAnalysisParseCache(root, generation, cache);
  const store = cache.fileResults!.stage!;
  await fs.rm(path.join(store.directory, store.records.get(a)!.pack));
  await publishAnalysisParseCache(await restored([a]), options([a]));
  expect((await loadParseCache(root, TEST_PARSE_IDENTITY, stage)).onDiskKeys?.has(a)).toBe(false);
});

it('keeps recovery receipt and complete stage when publication fails', async () => {
  const cache = emptyParseCache(TEST_PARSE_IDENTITY, { writeStoragePath: stage });
  await put(cache, a, 'recover');
  await stageAnalysisParseCache(root, generation, cache);
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('publication interrupted'));
  await expect(publishAnalysisParseCache(await restored([a]), options())).rejects.toThrow(
    'publication interrupted',
  );
  expect((await read(await restored([a]), a)).get(a)).toMatchObject({ name: 'recover' });
  await expect(
    fs.stat(path.join(root, `analysis-cache-${generation}.json`)),
  ).resolves.toBeDefined();
});

it('retains sibling files when branch metadata is unreadable', async () => {
  await live([
    [a, 'used'],
    [b, 'sibling'],
    [c, 'retired'],
  ]);
  const cache = await loadParseCache(root, TEST_PARSE_IDENTITY, stage);
  cache.usedKeys.add(a);
  cache.staleKeys = new Set([c]);
  await stageAnalysisParseCache(root, generation, cache);
  await publishAnalysisParseCache(await restored([a]), options([], false));
  expect([...(await loadParseCache(root, TEST_PARSE_IDENTITY, stage)).onDiskKeys!].sort()).toEqual([
    a,
    b,
  ]);
});

it('binds packed recovery to the published graph identity and key selection', async () => {
  const cache = emptyParseCache(TEST_PARSE_IDENTITY, { writeStoragePath: stage });
  await put(cache, a, 'bound');
  await stageAnalysisParseCache(root, generation, cache);
  await expect(loadAnalysisParseCache(root, metadata([b]))).rejects.toThrow('selection differs');
  await expect(
    loadAnalysisParseCache(root, { ...metadata([a]), parseCacheIdentity: { base: 'foreign' } }),
  ).rejects.toThrow('does not match');
});

it('accepts 95,000 file keys within the actual handoff byte limit', async () => {
  const cache = emptyParseCache(TEST_PARSE_IDENTITY, { writeStoragePath: stage });
  cache.usedKeys = new Set(
    Array.from({ length: 95_000 }, (_, n) => n.toString(16).padStart(64, '0')),
  );
  cache.stagedKeys = new Set(cache.usedKeys);
  await stageAnalysisParseCache(root, generation, cache);
  expect((await restored([...cache.usedKeys])).usedKeys.size).toBe(95_000);
  expect((await fs.stat(path.join(root, `analysis-cache-${generation}.json`))).size).toBeLessThan(
    16 * 1024 * 1024,
  );
  cache.staleKeys = new Set(cache.usedKeys);
  await expect(stageAnalysisParseCache(root, generation, cache)).rejects.toThrow(
    'exceeds its bound',
  );
});
