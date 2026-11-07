import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
  loadParseCacheChunk,
  persistParseCacheChunk,
  saveParseCache,
  type ParseCache,
} from '../../src/storage/parse-cache.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';
import { TEST_PARSE_IDENTITY } from '../helpers/cache-identity.js';

const generation = 'e'.repeat(32);
const a = 'a'.repeat(64),
  b = 'b'.repeat(64),
  c = 'c'.repeat(64),
  d = 'd'.repeat(64);
const result = (fileCount: number): ParseWorkerResult => ({
  nodes: [],
  relationships: [],
  symbols: [],
  calls: [],
  assignments: [],
  routes: [],
  fetchCalls: [],
  fetchWrapperDefs: [],
  decoratorRoutes: [],
  routerIncludes: [],
  routerImports: [],
  toolDefs: [],
  ormQueries: [],
  constructorBindings: [],
  fileScopeBindings: [],
  parsedFiles: [],
  skippedLanguages: {},
  fileCount,
});
let root: string, stage: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gn-cache-handoff-')));
  stage = await createColdParseRebuildDir(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const metadata = (keys: string[]): RepoMeta => ({
  repoPath: root,
  lastCommit: '1'.repeat(40),
  indexedAt: '2026-11-04T00:00:00Z',
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
async function live(keys: [string, number][]) {
  const cache = emptyParseCache(TEST_PARSE_IDENTITY);
  for (const [key, count] of keys) {
    cache.usedKeys.add(key);
    cache.entries.set(key, [result(count)]);
  }
  await saveParseCache(root, cache);
}
async function restored(meta: RepoMeta): Promise<ParseCache> {
  const cache = await loadAnalysisParseCache(root, meta);
  if (!cache) throw new Error('Missing handoff fixture');
  return cache;
}
async function mutateReceipt(change: (payload: Record<string, unknown>) => void) {
  const file = path.join(root, `analysis-cache-${generation}.json`);
  const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
  change(envelope.payload);
  envelope.checksum = createHash('sha256').update(JSON.stringify(envelope.payload)).digest('hex');
  await fs.writeFile(file, JSON.stringify(envelope));
}

it('rejects a checksummed selection that repeats one key instead of including another', async () => {
  const cache = emptyParseCache(TEST_PARSE_IDENTITY, { writeStoragePath: stage });
  cache.usedKeys = new Set([a, b]);
  await stageAnalysisParseCache(root, generation, cache);
  await mutateReceipt((payload) => {
    payload.used = [a, a];
  });
  await expect(loadAnalysisParseCache(root, metadata([a, b]))).rejects.toThrow('selection differs');
});

it('hands off keys without copying live shards, then merges a newer sibling publication', async () => {
  await live([
    [a, 1],
    [b, 2],
  ]);
  const cache = await loadParseCache(root, TEST_PARSE_IDENTITY, stage);
  cache.usedKeys = new Set([a, b, c]);
  cache.staleKeys = new Set([b]);
  await persistParseCacheChunk(cache, a, [result(11)]);
  await persistParseCacheChunk(cache, c, [result(3)]);
  const copy = vi.spyOn(fs, 'copyFile');
  await stageAnalysisParseCache(root, generation, cache);
  expect(copy).not.toHaveBeenCalled();
  expect(
    (await loadParseCacheChunk(await loadParseCache(root, TEST_PARSE_IDENTITY, stage), a))?.[0]
      .fileCount,
  ).toBe(1);
  expect((await fs.readdir(path.join(stage, 'parse-cache'))).sort()).toEqual([
    `${a}.v8`,
    `${c}.v8`,
  ]);
  // A sibling finishes after the graph child exited, before cache publication.
  await live([
    [a, 1],
    [b, 2],
    [d, 4],
  ]);
  await publishAnalysisParseCache(await restored(metadata([a, b, c])), options([d]));
  const published = await loadParseCache(root, TEST_PARSE_IDENTITY, stage);
  expect([...(published.onDiskKeys ?? [])].sort()).toEqual([a, c, d]);
  expect((await loadParseCacheChunk(published, a))?.[0].fileCount).toBe(11);
  expect((await loadParseCacheChunk(published, c))?.[0].fileCount).toBe(3);
  expect((await loadParseCacheChunk(published, d))?.[0].fileCount).toBe(4);
  await expect(fs.stat(path.join(root, `analysis-cache-${generation}.json`))).rejects.toMatchObject(
    { code: 'ENOENT' },
  );
});

it('retains its receipt when cache publication fails', async () => {
  const cache = emptyParseCache(TEST_PARSE_IDENTITY, { writeStoragePath: stage });
  cache.usedKeys.add(a);
  await persistParseCacheChunk(cache, a, [result(2)]);
  await stageAnalysisParseCache(root, generation, cache);
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('cache publication interrupted'));
  await expect(publishAnalysisParseCache(await restored(metadata([a])), options())).rejects.toThrow(
    'cache publication interrupted',
  );
  await expect(
    fs.stat(path.join(root, `analysis-cache-${generation}.json`)),
  ).resolves.toBeDefined();
  expect((await loadParseCacheChunk(await restored(metadata([a])), a))?.[0].fileCount).toBe(2);
});

it('flushes memory fallback shards before the child can hand off its cache', async () => {
  const cache = emptyParseCache(TEST_PARSE_IDENTITY, { writeStoragePath: stage });
  cache.usedKeys.add(a);
  cache.entries.set(a, [result(123)]);
  await stageAnalysisParseCache(root, generation, cache);
  expect(cache.entries.size).toBe(0);
  const recovered = await restored(metadata([a]));
  expect(recovered.entries.size).toBe(0);
  expect((await loadParseCacheChunk(recovered, a))?.[0].fileCount).toBe(123);
  const receipt = await fs.readFile(path.join(root, `analysis-cache-${generation}.json`), 'utf8');
  expect(receipt).not.toContain('fileCount');
});

it.each(['../../escaped', '..\\escaped', 'not-a-digest'])(
  'rejects an invalid fallback entry before writing any shard (%s)',
  async (key) => {
    const cache = emptyParseCache(TEST_PARSE_IDENTITY, { writeStoragePath: stage });
    cache.entries.set(a, [result(1)]);
    cache.entries.set(key, [result(2)]);
    await expect(stageAnalysisParseCache(root, generation, cache)).rejects.toThrow('invalid key');
    await expect(fs.stat(path.join(stage, 'parse-cache', `${a}.v8`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(path.resolve(stage, 'parse-cache', `${key}.v8`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fs.stat(path.join(root, `analysis-cache-${generation}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it('does not revive the old shard when a staged repair disappears', async () => {
  await live([[a, 1]]);
  const cache = await loadParseCache(root, TEST_PARSE_IDENTITY, stage);
  cache.usedKeys.add(a);
  await persistParseCacheChunk(cache, a, [result(2)]);
  await stageAnalysisParseCache(root, generation, cache);
  await fs.unlink(path.join(stage, 'parse-cache', `${a}.v8`));
  await publishAnalysisParseCache(await restored(metadata([a])), options());
  expect(
    await loadParseCacheChunk(await loadParseCache(root, TEST_PARSE_IDENTITY, stage), a),
  ).toBeUndefined();
});

it('retains sibling shards when metadata cannot be fully inspected, while dropping stale keys', async () => {
  await live([
    [a, 1],
    [b, 2],
    [c, 3],
  ]);
  const cache = await loadParseCache(root, TEST_PARSE_IDENTITY, stage);
  cache.usedKeys.add(a);
  cache.staleKeys = new Set([b]);
  await stageAnalysisParseCache(root, generation, cache);
  await publishAnalysisParseCache(await restored(metadata([a])), options([], false));
  const published = await loadParseCache(root, TEST_PARSE_IDENTITY, stage);
  expect([...(published.onDiskKeys ?? [])].sort()).toEqual([a, c]);
});

it.each(['generation', 'parser', 'selection', 'path', 'checksum'])(
  'refuses an incompatible or corrupt %s receipt',
  async (kind) => {
    const cache = emptyParseCache(TEST_PARSE_IDENTITY, { writeStoragePath: stage });
    cache.usedKeys.add(a);
    await stageAnalysisParseCache(root, generation, cache);
    if (kind === 'checksum') {
      const file = path.join(root, `analysis-cache-${generation}.json`);
      const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
      envelope.checksum = '0'.repeat(64);
      await fs.writeFile(file, JSON.stringify(envelope));
    } else
      await mutateReceipt((payload) => {
        if (kind === 'generation') payload.generation = '9'.repeat(32);
        if (kind === 'parser') payload.identity = { base: 'other', pdg: 'other' };
        if (kind === 'selection') payload.used = [b];
        if (kind === 'path') payload.stage = '../foreign';
      });
    await expect(loadAnalysisParseCache(root, metadata([a]))).rejects.toThrow();
    expect((await fs.stat(stage)).isDirectory()).toBe(true);
  },
);

it('treats a missing optional cache receipt as absent', async () => {
  expect(await loadAnalysisParseCache(root, metadata([]))).toBeUndefined();
});
