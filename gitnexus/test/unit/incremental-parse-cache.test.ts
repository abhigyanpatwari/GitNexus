import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readdir, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  emptyParseCache,
  PARSE_CACHE_BUCKET_COUNT,
  computeChunkHash,
  fileContentHash,
  packParseCacheChunks,
  parseCacheBucketId,
  loadParseCache,
  loadParseCacheChunk,
  persistParseCacheChunk,
  saveParseCache,
  pruneCache,
  slimParseWorkerResultsForCache,
  getColdParseRebuildDir,
  createColdParseRebuildDir,
  type ParseCache,
} from '../../src/storage/parse-cache.js';
import { TEST_PARSE_IDENTITY } from '../helpers/cache-identity.js';
import { writeV8CacheFile } from '../../src/storage/v8-sidecar.js';
import {
  getDurableParsedFileDir,
  durableChunkHasShards,
  loadParsedFilesForPaths,
  loadDurableParsedFileIndex,
  persistDurableParsedFileShardSync,
  pruneAndSaveDurableParsedFileStore,
} from '../../src/storage/parsedfile-store.js';
import type { ParsedFile } from 'gitnexus-shared';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';

const minimalResult = (overrides: Partial<ParseWorkerResult> = {}): ParseWorkerResult => ({
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
  fileCount: 0,
  ...overrides,
});

describe('computeChunkHash', () => {
  it('produces a stable hex hash for a fixed set of (filePath, contentHash) entries', () => {
    const entries = [
      { filePath: 'a.ts', contentHash: 'h-a' },
      { filePath: 'b.ts', contentHash: 'h-b' },
      { filePath: 'c.ts', contentHash: 'h-c' },
    ];
    const h1 = computeChunkHash(entries, TEST_PARSE_IDENTITY);
    const h2 = computeChunkHash(entries, TEST_PARSE_IDENTITY);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is order-independent (same files in different order → same hash)', () => {
    const order1 = [
      { filePath: 'a.ts', contentHash: 'h-a' },
      { filePath: 'b.ts', contentHash: 'h-b' },
    ];
    const order2 = [
      { filePath: 'b.ts', contentHash: 'h-b' },
      { filePath: 'a.ts', contentHash: 'h-a' },
    ];
    expect(computeChunkHash(order1, TEST_PARSE_IDENTITY)).toBe(
      computeChunkHash(order2, TEST_PARSE_IDENTITY),
    );
  });

  it('changes when any file content changes', () => {
    const before = [
      { filePath: 'a.ts', contentHash: 'h-a' },
      { filePath: 'b.ts', contentHash: 'h-b' },
    ];
    const after = [
      { filePath: 'a.ts', contentHash: 'h-a' },
      { filePath: 'b.ts', contentHash: 'h-b-NEW' }, // b.ts content changed
    ];
    expect(computeChunkHash(before, TEST_PARSE_IDENTITY)).not.toBe(
      computeChunkHash(after, TEST_PARSE_IDENTITY),
    );
  });

  it('changes when chunk membership changes (file added or removed)', () => {
    const small = [
      { filePath: 'a.ts', contentHash: 'h-a' },
      { filePath: 'b.ts', contentHash: 'h-b' },
    ];
    const bigger = [...small, { filePath: 'c.ts', contentHash: 'h-c' }];
    expect(computeChunkHash(small, TEST_PARSE_IDENTITY)).not.toBe(
      computeChunkHash(bigger, TEST_PARSE_IDENTITY),
    );
  });
});

describe('fileContentHash', () => {
  it('hashes a string deterministically', () => {
    expect(fileContentHash('hello')).toBe(fileContentHash('hello'));
    expect(fileContentHash('hello')).not.toBe(fileContentHash('hello!'));
    expect(fileContentHash('hello')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles Buffer input identical to its string form', () => {
    const s = 'sentinel';
    expect(fileContentHash(Buffer.from(s))).toBe(fileContentHash(s));
  });
});

describe('packParseCacheChunks (#3088)', () => {
  const files = [
    { path: 'src/a.ts', size: 100, language: 'typescript' },
    { path: 'src/b.ts', size: 100, language: 'typescript' },
    { path: 'pkg/c.py', size: 100, language: 'python' },
  ];
  const budget = 2 * 1024 * 1024;
  const packKey = (chunk: string[]): string =>
    `${files.find((f) => f.path === chunk[0])?.language ?? 'typescript'}\0${parseCacheBucketId(chunk[0])}`;

  it('is independent of scan order', () => {
    expect(packParseCacheChunks(files, budget)).toEqual(
      packParseCacheChunks([...files].reverse(), budget),
    );
  });

  it('add/delete only rewrites packs in the affected (language, bucket)', () => {
    const a = packParseCacheChunks(files, budget);
    const added = { path: 'AAA.ts', size: 150_000, language: 'typescript' };
    const withNew = packParseCacheChunks([...files, added], budget);
    const addedKey = packKey([added.path]);
    const untouched = (packs: string[][]) =>
      packs.filter((c) => packKey(c) !== addedKey).map((c) => c.join('|'));
    expect(untouched(withNew).sort()).toEqual(untouched(a).sort());
    expect(withNew.some((c) => c.includes(added.path))).toBe(true);

    const withoutB = packParseCacheChunks(
      files.filter((f) => f.path !== 'src/b.ts'),
      budget,
    );
    const removedKey = packKey(['src/b.ts']);
    const leftover = (packs: string[][]) =>
      packs.filter((c) => packKey(c) !== removedKey).map((c) => c.join('|'));
    expect(leftover(withoutB).sort()).toEqual(leftover(a).sort());
    expect(withoutB.every((c) => !c.includes('src/b.ts'))).toBe(true);
  });

  it('parseCacheBucketId uses the full sha256 digest, not an IEEE-754 prefix', () => {
    const path = 'src/foo.ts';
    const hex = fileContentHash(path);
    const full = Number(BigInt(`0x${hex}`) % BigInt(PARSE_CACHE_BUCKET_COUNT));
    const truncated = Number.parseInt(hex.slice(0, 8), 16) % PARSE_CACHE_BUCKET_COUNT;
    expect(parseCacheBucketId(path)).toBe(full);
    expect(parseCacheBucketId(path)).toBeGreaterThanOrEqual(0);
    expect(parseCacheBucketId(path)).toBeLessThan(PARSE_CACHE_BUCKET_COUNT);
    expect(full).not.toBe(truncated);
  });
});

describe('pruneCache', () => {
  it('drops entries whose hashes are not in the used-set', () => {
    const cache: ParseCache = {
      identity: TEST_PARSE_IDENTITY,
      entries: new Map<string, ParseWorkerResult[]>([
        ['hash-A', [minimalResult()]],
        ['hash-B', [minimalResult()]],
        ['hash-C', [minimalResult()]],
      ]),
      usedKeys: new Set<string>(['hash-A']),
    };
    const removed = pruneCache(cache, cache.usedKeys);
    expect(removed).toBe(2);
    expect([...cache.entries.keys()].sort()).toEqual(['hash-A']);
  });

  it('returns 0 when every entry is in use', () => {
    const cache: ParseCache = {
      identity: TEST_PARSE_IDENTITY,
      entries: new Map<string, ParseWorkerResult[]>([
        ['hash-A', [minimalResult()]],
        ['hash-B', [minimalResult()]],
      ]),
      usedKeys: new Set<string>(['hash-A', 'hash-B']),
    };
    expect(pruneCache(cache, cache.usedKeys)).toBe(0);
    expect(cache.entries.size).toBe(2);
  });

  it('drops onDiskKeys entries not in the used-set and counts them', () => {
    const cache: ParseCache = {
      identity: TEST_PARSE_IDENTITY,
      entries: new Map<string, ParseWorkerResult[]>(),
      usedKeys: new Set<string>(['disk-A']),
      onDiskKeys: new Set<string>(['disk-A', 'disk-B', 'disk-C']),
    };
    const removed = pruneCache(cache, new Set(['disk-A']));
    expect(removed).toBe(2);
    expect([...(cache.onDiskKeys ?? [])].sort()).toEqual(['disk-A']);
  });
});

describe('cache identity boundaries', () => {
  const entries = [{ filePath: 'src/a.ts', contentHash: fileContentHash('export const a = 1;') }];
  const key = computeChunkHash(entries, TEST_PARSE_IDENTITY);
  const parsedFile: ParsedFile = {
    filePath: 'src/a.ts',
    moduleScope: '',
    scopes: [],
    parsedImports: [],
    localDefs: [],
    referenceSites: [],
  };

  it('reuses both stores only under the matching base identity', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-paired-identity-'));
    try {
      const cache = emptyParseCache(TEST_PARSE_IDENTITY);
      cache.entries.set(key, [minimalResult({ fileCount: 1 })]);
      cache.usedKeys.add(key);
      const saved = await saveParseCache(dir, cache);
      const durable = getDurableParsedFileDir(dir);
      persistDurableParsedFileShardSync(durable, key, 1, 0, [parsedFile]);
      await pruneAndSaveDurableParsedFileStore(durable, cache.identity.base, new Set(saved));

      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      expect((await loadParseCacheChunk(loaded, key))?.[0]?.fileCount).toBe(1);
      const coverage = await loadDurableParsedFileIndex(durable, loaded.identity.base);
      expect(coverage.get(key)).toEqual(new Set(['src/a.ts']));
      expect(await durableChunkHasShards(dir, key, coverage.get(key)!)).toBe(true);
      expect((await loadParsedFilesForPaths(dir, new Set(['src/a.ts']))).get('src/a.ts')).toEqual(
        parsedFile,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing', undefined],
    ['numeric legacy', 143],
    ['release-based legacy', '143+1.6.12'],
    ['foreign', 'c'.repeat(64)],
    ['malformed', { base: TEST_PARSE_IDENTITY.base }],
  ])(
    'misses both stores with %s identity metadata even when shards are valid',
    async (_label, version) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'gnx-foreign-identity-'));
      try {
        const cache = emptyParseCache(TEST_PARSE_IDENTITY);
        cache.entries.set(key, [minimalResult({ fileCount: 1 })]);
        cache.usedKeys.add(key);
        await saveParseCache(dir, cache);
        const durable = getDurableParsedFileDir(dir);
        persistDurableParsedFileShardSync(durable, key, 1, 0, [parsedFile]);
        await pruneAndSaveDurableParsedFileStore(durable, TEST_PARSE_IDENTITY.base, new Set([key]));
        // Establish the readable generation before changing only its metadata.
        expect(await loadDurableParsedFileIndex(durable, TEST_PARSE_IDENTITY.base)).toEqual(
          new Map([[key, new Set(['src/a.ts'])]]),
        );
        await writeFile(
          path.join(dir, 'parse-cache', 'index.json'),
          JSON.stringify({ version, keys: [key] }),
        );
        await writeFile(
          path.join(durable, 'index.json'),
          JSON.stringify({ version, entries: { [key]: ['src/a.ts'] } }),
        );

        const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
        expect(loaded.onDiskKeys?.size).toBe(0);
        expect(await loadParseCacheChunk(loaded, key)).toBeUndefined();
        expect(await loadDurableParsedFileIndex(durable, TEST_PARSE_IDENTITY.base)).toEqual(
          new Map(),
        );
        // A sibling branch listing an old hash cannot admit a foreign shard.
        loaded.usedKeys.add(key);
        expect(await saveParseCache(dir, loaded)).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('puts identical source under different physical keys for different base identities', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-identity-address-'));
    try {
      const otherIdentity = { ...TEST_PARSE_IDENTITY, base: 'c'.repeat(64) };
      const otherKey = computeChunkHash(entries, otherIdentity);
      expect(otherKey).not.toBe(key);
      const first = emptyParseCache(TEST_PARSE_IDENTITY, { writeStoragePath: dir });
      const second = emptyParseCache(otherIdentity, { writeStoragePath: dir });
      await persistParseCacheChunk(first, key, [minimalResult({ fileCount: 1 })]);
      await persistParseCacheChunk(second, otherKey, [minimalResult({ fileCount: 2 })]);
      expect((await readdir(path.join(dir, 'parse-cache'))).sort()).toEqual(
        [`${key}.v8`, `${otherKey}.v8`].sort(),
      );
      expect((await loadParseCacheChunk(first, key))?.[0]?.fileCount).toBe(1);
      expect((await loadParseCacheChunk(second, otherKey))?.[0]?.fileCount).toBe(2);
      expect(await loadParseCacheChunk(first, otherKey)).toBeUndefined();
      expect(await loadParseCacheChunk(second, key)).toBeUndefined();

      const durable = getDurableParsedFileDir(dir);
      persistDurableParsedFileShardSync(durable, key, 1, 0, [parsedFile]);
      persistDurableParsedFileShardSync(durable, otherKey, 1, 0, [parsedFile]);
      expect((await readdir(durable)).sort()).toEqual([key, otherKey].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('loadParseCache / saveParseCache (round-trip)', () => {
  it('round-trips an empty cache', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const fs = await import('fs/promises');
      const cache: ParseCache = {
        identity: TEST_PARSE_IDENTITY,
        entries: new Map(),
        usedKeys: new Set(),
      };
      await saveParseCache(dir, cache);
      await expect(fs.access(path.join(dir, 'parse-cache', 'index.json'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(dir, 'parse-cache.json'))).rejects.toThrow();
      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      expect(loaded.identity).toEqual(TEST_PARSE_IDENTITY);
      expect(loaded.entries.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty cache when the file is missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      expect(loaded.entries.size).toBe(0);
      expect(loaded.usedKeys.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty cache on version mismatch (next-run regen)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      // Write a cache file with a different version directly
      const fs = await import('fs/promises');
      await fs.writeFile(
        path.join(dir, 'parse-cache.json'),
        JSON.stringify({ version: 'foreign-99', entries: { h: [] } }),
        'utf-8',
      );
      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      expect(loaded.entries.size).toBe(0); // mismatch → empty
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty cache on corrupt JSON', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const fs = await import('fs/promises');
      await fs.writeFile(path.join(dir, 'parse-cache.json'), '{not-json', 'utf-8');
      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      expect(loaded.entries.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads a single-file representation bearing the current identity', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const fs = await import('fs/promises');
      await fs.writeFile(
        path.join(dir, 'parse-cache.json'),
        JSON.stringify({
          version: TEST_PARSE_IDENTITY.base,
          entries: {
            legacyChunk: [minimalResult({ fileCount: 7 })],
          },
        }),
        'utf-8',
      );
      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      expect(loaded.entries.size).toBe(1);
      expect(loaded.entries.get('legacyChunk')?.[0]?.fileCount).toBe(7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips corrupt or missing shards while loading the sharded cache index', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const fs = await import('fs/promises');
      const cacheDir = path.join(dir, 'parse-cache');
      const goodKey = 'a'.repeat(64);
      const missingKey = 'b'.repeat(64);
      const badKey = 'c'.repeat(64);
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        path.join(cacheDir, 'index.json'),
        JSON.stringify({
          version: TEST_PARSE_IDENTITY.base,
          keys: [goodKey, missingKey, badKey],
        }),
        'utf-8',
      );
      await writeV8CacheFile(path.join(cacheDir, `${goodKey}.v8`), [
        minimalResult({ fileCount: 3 }),
      ]);
      await fs.writeFile(path.join(cacheDir, `${badKey}.v8`), '{not-json', 'utf-8');

      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      expect(loaded.entries.size).toBe(0);
      expect(loaded.onDiskKeys?.size).toBe(3);
      const chunk = await loadParseCacheChunk(loaded, goodKey);
      expect(chunk?.[0]?.fileCount).toBe(3);
      // A shard listed in the index but absent on disk, and a corrupt-JSON
      // shard, both resolve to undefined (graceful cache miss) — not a throw.
      expect(await loadParseCacheChunk(loaded, missingKey)).toBeUndefined();
      expect(await loadParseCacheChunk(loaded, badKey)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('round-trips Map and Set values through the JSON replacer/reviver', async () => {
    // ParsedFile.scopes[*].typeBindings is a ReadonlyMap<string, TypeRef>.
    // Without the replacer/reviver pair, JSON.stringify collapses Maps to
    // {} and downstream code that does .get() / iterates entries crashes
    // with "is not iterable". This test pins the round-trip behaviour.
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const fs = await import('fs/promises');
      const innerMap = new Map<string, string>([
        ['k1', 'v1'],
        ['k2', 'v2'],
      ]);
      const innerSet = new Set<string>(['s1', 's2']);
      // Stash the live Map/Set inside a synthetic ParseWorkerResult — we
      // only need the serializer to traverse them. Casting to bypass the
      // strict shape isn't a problem here: this test is about JSON
      // round-tripping of arbitrary nested Map/Set values, not full
      // ParseWorkerResult contents.
      const fake = minimalResult({
        parsedFiles: [
          {
            filePath: 't.ts',
            // Cast through unknown to satisfy the readonly Scope shape
            // while still smuggling a live Map into the serializer's
            // traversal path — see comment block above.
            scopes: [{ id: 's1', typeBindings: innerMap, extras: innerSet }],
          } as unknown as ParseWorkerResult['parsedFiles'][number],
        ],
      });

      const chunkKey = 'd'.repeat(64);
      const cache: ParseCache = {
        identity: TEST_PARSE_IDENTITY,
        entries: new Map<string, ParseWorkerResult[]>([[chunkKey, [fake]]]),
        usedKeys: new Set([chunkKey]),
      };
      await saveParseCache(dir, cache);
      const persisted = await fs.readdir(path.join(dir, 'parse-cache'));
      expect(persisted).toContain('index.json');
      expect(persisted).toContain(`${chunkKey}.v8`);
      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      const reloaded = (await loadParseCacheChunk(loaded, chunkKey))?.[0];
      expect(reloaded).toBeDefined();
      const scope = (reloaded as ParseWorkerResult).parsedFiles[0]?.scopes[0] as unknown as {
        typeBindings?: unknown;
        extras?: unknown;
      };
      expect(scope.typeBindings).toBeInstanceOf(Map);
      expect((scope.typeBindings as Map<string, string>).get('k1')).toBe('v1');
      expect((scope.typeBindings as Map<string, string>).size).toBe(2);
      expect(scope.extras).toBeInstanceOf(Set);
      expect((scope.extras as Set<string>).has('s2')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores traversal-like and non-hex keys in sharded index.json', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const fs = await import('fs/promises');
      const cacheDir = path.join(dir, 'parse-cache');
      await fs.mkdir(cacheDir, { recursive: true });
      const safeKey = 'e'.repeat(64);
      await fs.writeFile(
        path.join(cacheDir, 'index.json'),
        JSON.stringify({
          version: TEST_PARSE_IDENTITY.base,
          keys: ['../evil', '/absolute', 'G'.repeat(64), safeKey],
        }),
        'utf-8',
      );
      await writeV8CacheFile(path.join(cacheDir, `${safeKey}.v8`), [
        minimalResult({ fileCount: 9 }),
      ]);
      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      expect(loaded.onDiskKeys?.size).toBe(1);
      const chunk = await loadParseCacheChunk(loaded, safeKey);
      expect(chunk?.[0]?.fileCount).toBe(9);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes one shard file per cache entry (three distinct keys)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const fs = await import('fs/promises');
      const k1 = '1'.repeat(64);
      const k2 = '2'.repeat(64);
      const k3 = '3'.repeat(64);
      const cache: ParseCache = {
        identity: TEST_PARSE_IDENTITY,
        entries: new Map<string, ParseWorkerResult[]>([
          [k1, [minimalResult({ fileCount: 1 })]],
          [k2, [minimalResult({ fileCount: 2 })]],
          [k3, [minimalResult({ fileCount: 3 })]],
        ]),
        usedKeys: new Set([k1, k2, k3]),
      };
      await saveParseCache(dir, cache);
      const cacheDir = path.join(dir, 'parse-cache');
      const names = await fs.readdir(cacheDir);
      expect(names).toContain('index.json');
      expect(names.filter((n) => n.endsWith('.v8')).length).toBe(3);
      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      expect(loaded.onDiskKeys?.size).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns empty when sharded index version mismatches even if legacy parse-cache.json is valid', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const fs = await import('fs/promises');
      const cacheDir = path.join(dir, 'parse-cache');
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        path.join(cacheDir, 'index.json'),
        JSON.stringify({ version: 'foreign-sharded-1', keys: [] }),
        'utf-8',
      );
      await fs.writeFile(
        path.join(dir, 'parse-cache.json'),
        JSON.stringify({
          version: TEST_PARSE_IDENTITY.base,
          entries: { legacyChunk: [minimalResult({ fileCount: 42 })] },
        }),
        'utf-8',
      );
      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      expect(loaded.entries.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('second saveParseCache replaces the first sharded cache', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const fs = await import('fs/promises');
      const k1 = '4'.repeat(64);
      const k2 = '5'.repeat(64);
      await saveParseCache(dir, {
        identity: TEST_PARSE_IDENTITY,
        entries: new Map([[k1, [minimalResult()]]]),
        usedKeys: new Set([k1]),
      });
      await saveParseCache(dir, {
        identity: TEST_PARSE_IDENTITY,
        entries: new Map([[k2, [minimalResult({ fileCount: 99 })]]]),
        usedKeys: new Set([k2]),
      });
      const names = await fs.readdir(path.join(dir, 'parse-cache'));
      expect(names).not.toContain(`${k1}.v8`);
      expect(names).toContain(`${k2}.v8`);
      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      expect(loaded.onDiskKeys?.size).toBe(1);
      const chunk = await loadParseCacheChunk(loaded, k2);
      expect(chunk?.[0]?.fileCount).toBe(99);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('removes legacy parse-cache.json after a successful sharded save', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const fs = await import('fs/promises');
      await fs.writeFile(
        path.join(dir, 'parse-cache.json'),
        JSON.stringify({
          version: TEST_PARSE_IDENTITY.base,
          entries: { oldLegacy: [minimalResult({ fileCount: 5 })] },
        }),
        'utf-8',
      );
      const k = '6'.repeat(64);
      await saveParseCache(dir, {
        identity: TEST_PARSE_IDENTITY,
        entries: new Map([[k, [minimalResult({ fileCount: 6 })]]]),
        usedKeys: new Set([k]),
      });
      await expect(fs.access(path.join(dir, 'parse-cache.json'))).rejects.toThrow();
      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      const chunk = await loadParseCacheChunk(loaded, k);
      expect(chunk?.[0]?.fileCount).toBe(6);
      expect(loaded.onDiskKeys?.has(k)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('slimParseWorkerResultsForCache drops legacy DAG fields', () => {
    const raw = minimalResult({
      calls: [{ filePath: 'a.c', calleeName: 'f', line: 1 } as never],
      assignments: [
        { filePath: 'a.c', sourceId: 's', receiverText: 'x', propertyName: 'y', line: 1 },
      ],
      constructorBindings: [{ filePath: 'a.c', bindings: [] }],
      parsedFiles: [
        {
          filePath: 'a.c',
          moduleScope: 'm',
          scopes: [],
          parsedImports: [],
          localDefs: [],
          referenceSites: [],
        },
      ],
      scopeExtractionFailures: ['a.c'],
    });
    const slim = slimParseWorkerResultsForCache([raw])[0];
    expect(slim.calls).toEqual([]);
    expect(slim.assignments).toEqual([]);
    expect(slim.constructorBindings).toEqual([]);
    expect(slim.parsedFiles).toEqual([]);
    expect(slim.scopeExtractionFailures).toEqual(['a.c']);
    expect(slim.fileCount).toBe(raw.fileCount);
  });

  it('slimParseWorkerResultsForCache preserves nodes (incremental exportedTypeMap depends on them)', () => {
    const raw = minimalResult({
      nodes: [
        {
          id: 'Function:a.ts:foo',
          label: 'Function',
          properties: { name: 'foo', filePath: 'a.ts', isExported: true },
        },
      ] as ParseWorkerResult['nodes'],
    });
    const slim = slimParseWorkerResultsForCache([raw])[0];
    // `nodes` (and `symbols`) must survive slimming — on a warm cache hit they
    // are what mergeChunkResults replays to rebuild the ExportedTypeMap.
    expect(slim.nodes).toEqual(raw.nodes);
    expect(slim.nodes).toHaveLength(1);
  });

  it('round-trips scope extraction failures through a persisted cache shard', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const key = 'e'.repeat(64);
      await saveParseCache(dir, {
        identity: TEST_PARSE_IDENTITY,
        entries: new Map([[key, [minimalResult({ scopeExtractionFailures: ['src/broken.ts'] })]]]),
        usedKeys: new Set([key]),
      });

      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      const replayed = await loadParseCacheChunk(loaded, key);
      expect(replayed?.[0]?.scopeExtractionFailures).toEqual(['src/broken.ts']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persistParseCacheChunk writes to disk without retaining in-memory entries', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const key = '7'.repeat(64);
      const cache: ParseCache = {
        identity: TEST_PARSE_IDENTITY,
        entries: new Map(),
        usedKeys: new Set(),
        writeStoragePath: dir,
        onDiskKeys: new Set(),
      };
      await persistParseCacheChunk(cache, key, [minimalResult({ fileCount: 11 })]);
      expect(cache.entries.has(key)).toBe(false);
      expect(cache.stagedKeys?.has(key)).toBe(true);
      const chunk = await loadParseCacheChunk(cache, key);
      expect(chunk?.[0]?.fileCount).toBe(11);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('saveParseCache excludes a usedKeys hash whose shard was never persisted (no phantom index key)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const realKey = 'a'.repeat(64);
      const phantomKey = 'b'.repeat(64); // in usedKeys but has no entry and no on-disk shard
      const cache: ParseCache = {
        identity: TEST_PARSE_IDENTITY,
        entries: new Map([[realKey, [minimalResult({ fileCount: 3 })]]]),
        usedKeys: new Set([realKey, phantomKey]),
      };
      await saveParseCache(dir, cache);
      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      expect(loaded.onDiskKeys?.has(realKey)).toBe(true);
      // The phantom key was never written, so it must not appear in the index.
      expect(loaded.onDiskKeys?.has(phantomKey)).toBe(false);
      expect((await loadParseCacheChunk(loaded, realKey))?.[0]?.fileCount).toBe(3);
      expect(await loadParseCacheChunk(loaded, phantomKey)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('saveParseCache copies a persisted-but-evicted shard (copyFile branch) and round-trips', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const key = 'c'.repeat(64);
      const cache: ParseCache = {
        identity: TEST_PARSE_IDENTITY,
        entries: new Map(),
        usedKeys: new Set([key]),
        writeStoragePath: dir,
        onDiskKeys: new Set(),
      };
      // persist writes the shard to the live dir and evicts it from `entries`,
      // so saveParseCache must hit the copyFile branch to carry it forward.
      await persistParseCacheChunk(cache, key, [minimalResult({ fileCount: 42 })]);
      expect(cache.entries.has(key)).toBe(false);
      await saveParseCache(dir, cache);
      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      expect(loaded.onDiskKeys?.has(key)).toBe(true);
      expect((await loadParseCacheChunk(loaded, key))?.[0]?.fileCount).toBe(42);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recreates a memoized shard directory after a long-lived process replaces it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const firstKey = 'd'.repeat(64);
      const secondKey = 'e'.repeat(64);
      const cache: ParseCache = {
        identity: TEST_PARSE_IDENTITY,
        entries: new Map(),
        usedKeys: new Set([firstKey]),
        writeStoragePath: dir,
        onDiskKeys: new Set(),
      };

      await persistParseCacheChunk(cache, firstKey, [minimalResult({ fileCount: 1 })]);
      await rm(path.join(dir, 'parse-cache'), { recursive: true, force: true });

      cache.usedKeys = new Set([secondKey]);
      await persistParseCacheChunk(cache, secondKey, [minimalResult({ fileCount: 2 })]);
      await saveParseCache(dir, cache);

      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      expect((await loadParseCacheChunk(loaded, secondKey))?.[0]?.fileCount).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes a V8 shard and loads it with Map-preserving semantics', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-v8-'));
    try {
      const innerMap = new Map<string, string>([
        ['k1', 'v1'],
        ['k2', 'v2'],
      ]);
      const innerSet = new Set<string>(['s1', 's2']);
      // Exercise opaque structured-clone data without relying on a removed
      // worker field (ParsedFiles intentionally live in a separate store).
      const fake = {
        ...minimalResult({ fileCount: 9 }),
        serializationProbe: { typeBindings: innerMap, extras: innerSet },
      };
      const key = 'f'.repeat(64);
      const cache: ParseCache = {
        identity: TEST_PARSE_IDENTITY,
        entries: new Map(),
        usedKeys: new Set([key]),
        writeStoragePath: dir,
        onDiskKeys: new Set(),
      };
      await persistParseCacheChunk(cache, key, [fake]);
      const names = await readdir(path.join(dir, 'parse-cache'));
      expect(names).toEqual(expect.arrayContaining([`${key}.v8`]));
      expect(names.some((n) => n.endsWith('.json') && n !== 'index.json')).toBe(false);
      const loaded = await loadParseCacheChunk(cache, key);
      expect(loaded?.[0]?.fileCount).toBe(9);
      const restored = loaded?.[0];
      if (!restored || !('serializationProbe' in restored)) {
        throw new Error('Missing serialized probe');
      }
      const smuggled = restored.serializationProbe;
      if (
        typeof smuggled !== 'object' ||
        smuggled === null ||
        !('typeBindings' in smuggled) ||
        !('extras' in smuggled)
      ) {
        throw new Error('Invalid serialized probe');
      }
      expect(smuggled.typeBindings).toBeInstanceOf(Map);
      expect(smuggled.extras).toBeInstanceOf(Set);
      if (!(smuggled.typeBindings instanceof Map) || !(smuggled.extras instanceof Set)) {
        throw new Error('Structured-clone collections were not preserved');
      }
      expect([...smuggled.typeBindings]).toEqual([
        ['k1', 'v1'],
        ['k2', 'v2'],
      ]);
      expect([...smuggled.extras].sort()).toEqual(['s1', 's2']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a corrupt parse-cache V8 shard as a miss', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-v8-fb-'));
    try {
      const key = 'a'.repeat(64);
      const cache: ParseCache = {
        identity: TEST_PARSE_IDENTITY,
        entries: new Map(),
        usedKeys: new Set([key]),
        writeStoragePath: dir,
        onDiskKeys: new Set(),
      };
      await persistParseCacheChunk(cache, key, [minimalResult({ fileCount: 4 })]);
      await writeFile(path.join(dir, 'parse-cache', `${key}.v8`), Buffer.from([1, 2, 3]));
      const loaded = await loadParseCacheChunk(cache, key);
      expect(loaded).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('saveParseCache copies an existing V8 shard', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-v8-copy-'));
    try {
      const key = 'c'.repeat(64);
      const cache: ParseCache = {
        identity: TEST_PARSE_IDENTITY,
        entries: new Map(),
        usedKeys: new Set([key]),
        writeStoragePath: dir,
        onDiskKeys: new Set(),
      };
      await persistParseCacheChunk(cache, key, [minimalResult({ fileCount: 42 })]);
      const liveV8 = await readFile(path.join(dir, 'parse-cache', `${key}.v8`));
      await saveParseCache(dir, cache);
      expect(await readdir(path.join(dir, 'parse-cache'))).toEqual(
        expect.arrayContaining([`${key}.v8`, 'index.json']),
      );
      expect(await readFile(path.join(dir, 'parse-cache', `${key}.v8`))).toEqual(liveV8);
      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      expect((await loadParseCacheChunk(loaded, key))?.[0]?.fileCount).toBe(42);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('misses when the V8 shard is absent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-v8-legacy-'));
    try {
      const key = 'b'.repeat(64);
      const cache: ParseCache = {
        identity: TEST_PARSE_IDENTITY,
        entries: new Map(),
        usedKeys: new Set([key]),
        writeStoragePath: dir,
        onDiskKeys: new Set(),
      };
      await persistParseCacheChunk(cache, key, [minimalResult({ fileCount: 7 })]);
      await rm(path.join(dir, 'parse-cache', `${key}.v8`), { force: true });
      const loaded = await loadParseCacheChunk(cache, key);
      expect(loaded).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists cold-rebuild shards under staging without touching the live parse-cache dir', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-stage-'));
    try {
      const liveKey = 'a'.repeat(64);
      const stagedKey = 'b'.repeat(64);
      await saveParseCache(dir, {
        identity: TEST_PARSE_IDENTITY,
        entries: new Map([[liveKey, [minimalResult({ fileCount: 1 })]]]),
        usedKeys: new Set([liveKey]),
      });
      const staging = getColdParseRebuildDir(dir);
      const cache = await loadParseCache(dir, TEST_PARSE_IDENTITY, staging);
      cache.usedKeys = new Set([liveKey, stagedKey]);
      await persistParseCacheChunk(cache, stagedKey, [minimalResult({ fileCount: 99 })]);
      const liveNames = await readdir(path.join(dir, 'parse-cache'));
      expect(liveNames).toContain(`${liveKey}.v8`);
      expect(liveNames).not.toContain(`${stagedKey}.v8`);
      const stagedNames = await readdir(path.join(staging, 'parse-cache'));
      expect(stagedNames).toContain(`${stagedKey}.v8`);

      const saved = await saveParseCache(dir, cache);
      expect(saved.sort()).toEqual([liveKey, stagedKey].sort());
      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      expect((await loadParseCacheChunk(loaded, liveKey))?.[0]?.fileCount).toBe(1);
      expect((await loadParseCacheChunk(loaded, stagedKey))?.[0]?.fileCount).toBe(99);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prefers a staged shard over a same-hash live shard when publishing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-pref-'));
    try {
      const key = 'c'.repeat(64);
      await saveParseCache(dir, {
        identity: TEST_PARSE_IDENTITY,
        entries: new Map([[key, [minimalResult({ fileCount: 1 })]]]),
        usedKeys: new Set([key]),
      });
      const staging = getColdParseRebuildDir(dir);
      const cache = await loadParseCache(dir, TEST_PARSE_IDENTITY, staging);
      cache.usedKeys.add(key);
      await persistParseCacheChunk(cache, key, [minimalResult({ fileCount: 7 })]);
      expect((await loadParseCacheChunk(cache, key))?.[0]?.fileCount).toBe(7);
      await saveParseCache(dir, cache);
      const loaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, getColdParseRebuildDir(dir));
      expect((await loadParseCacheChunk(loaded, key))?.[0]?.fileCount).toBe(7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not fall back to a live shard when its staged repair disappears', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-missing-repair-'));
    try {
      const key = 'd'.repeat(64);
      const original = emptyParseCache(TEST_PARSE_IDENTITY);
      original.entries.set(key, [minimalResult({ fileCount: 1 })]);
      original.usedKeys.add(key);
      await saveParseCache(dir, original);
      const staging = getColdParseRebuildDir(dir);
      const cache = await loadParseCache(dir, TEST_PARSE_IDENTITY, staging);
      expect((await loadParseCacheChunk(cache, key))?.[0]?.fileCount).toBe(1);
      await persistParseCacheChunk(cache, key, [minimalResult({ fileCount: 7 })]);
      cache.usedKeys.add(key);
      await rm(path.join(staging, 'parse-cache', `${key}.v8`));

      expect(await loadParseCacheChunk(cache, key)).toBeUndefined();
      expect(await readFile(path.join(dir, 'parse-cache', `${key}.v8`))).not.toHaveLength(0);
      expect(await saveParseCache(dir, cache)).toEqual([]);
      const reloaded = await loadParseCache(dir, TEST_PARSE_IDENTITY, staging);
      expect(await loadParseCacheChunk(reloaded, key)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('createColdParseRebuildDir isolates run children beneath each locked slot staging root', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-uniq-'));
    try {
      const a = await createColdParseRebuildDir(path.join(dir, 'slot-a'));
      const nextA = await createColdParseRebuildDir(path.join(dir, 'slot-a'));
      const b = await createColdParseRebuildDir(path.join(dir, 'slot-b'));
      expect(a).not.toBe(nextA);
      expect(a).not.toBe(b);
      expect(path.dirname(a)).toBe(getColdParseRebuildDir(path.join(dir, 'slot-a')));
      expect(path.dirname(nextA)).toBe(path.dirname(a));
      expect(path.dirname(b)).toBe(getColdParseRebuildDir(path.join(dir, 'slot-b')));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
