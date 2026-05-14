import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  PARSE_CACHE_VERSION,
  computeChunkHash,
  fileContentHash,
  loadParseCache,
  saveParseCache,
  pruneCache,
  type ParseCache,
} from '../../src/storage/parse-cache.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';

const minimalResult = (overrides: Partial<ParseWorkerResult> = {}): ParseWorkerResult => ({
  nodes: [],
  relationships: [],
  symbols: [],
  imports: [],
  calls: [],
  assignments: [],
  heritage: [],
  routes: [],
  fetchCalls: [],
  decoratorRoutes: [],
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
    const h1 = computeChunkHash(entries);
    const h2 = computeChunkHash(entries);
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
    expect(computeChunkHash(order1)).toBe(computeChunkHash(order2));
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
    expect(computeChunkHash(before)).not.toBe(computeChunkHash(after));
  });

  it('changes when chunk membership changes (file added or removed)', () => {
    const small = [
      { filePath: 'a.ts', contentHash: 'h-a' },
      { filePath: 'b.ts', contentHash: 'h-b' },
    ];
    const bigger = [...small, { filePath: 'c.ts', contentHash: 'h-c' }];
    expect(computeChunkHash(small)).not.toBe(computeChunkHash(bigger));
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

describe('PARSE_CACHE_VERSION', () => {
  it('embeds the gitnexus package version (so upgrades invalidate the cache)', () => {
    // Looks like "1+1.6.4" — schema bump prefix + actual gitnexus version
    expect(PARSE_CACHE_VERSION).toMatch(/^\d+\+\d+\.\d+\.\d+/);
  });
});

describe('pruneCache', () => {
  it('drops entries whose hashes are not in the used-set', () => {
    const cache: ParseCache = {
      version: PARSE_CACHE_VERSION,
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
      version: PARSE_CACHE_VERSION,
      entries: new Map<string, ParseWorkerResult[]>([
        ['hash-A', [minimalResult()]],
        ['hash-B', [minimalResult()]],
      ]),
      usedKeys: new Set<string>(['hash-A', 'hash-B']),
    };
    expect(pruneCache(cache, cache.usedKeys)).toBe(0);
    expect(cache.entries.size).toBe(2);
  });
});

describe('loadParseCache / saveParseCache (round-trip)', () => {
  it('round-trips an empty cache', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const fs = await import('fs/promises');
      const cache: ParseCache = {
        version: PARSE_CACHE_VERSION,
        entries: new Map(),
        usedKeys: new Set(),
      };
      await saveParseCache(dir, cache);
      await expect(fs.access(path.join(dir, 'parse-cache', 'index.json'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(dir, 'parse-cache.json'))).rejects.toThrow();
      const loaded = await loadParseCache(dir);
      expect(loaded.version).toBe(PARSE_CACHE_VERSION);
      expect(loaded.entries.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty cache when the file is missing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const loaded = await loadParseCache(dir);
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
      const loaded = await loadParseCache(dir);
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
      const loaded = await loadParseCache(dir);
      expect(loaded.entries.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads a legacy single-file cache for backwards compatibility', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const fs = await import('fs/promises');
      await fs.writeFile(
        path.join(dir, 'parse-cache.json'),
        JSON.stringify({
          version: PARSE_CACHE_VERSION,
          entries: {
            legacyChunk: [minimalResult({ fileCount: 7 })],
          },
        }),
        'utf-8',
      );
      const loaded = await loadParseCache(dir);
      expect(loaded.entries.size).toBe(1);
      expect(loaded.entries.get('legacyChunk')?.[0]?.fileCount).toBe(7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips corrupt or missing shards while loading the sharded cache', async () => {
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
          version: PARSE_CACHE_VERSION,
          keys: [goodKey, missingKey, badKey],
        }),
        'utf-8',
      );
      await fs.writeFile(
        path.join(cacheDir, `${goodKey}.json`),
        JSON.stringify([minimalResult({ fileCount: 3 })]),
        'utf-8',
      );
      await fs.writeFile(path.join(cacheDir, `${badKey}.json`), '{not-json', 'utf-8');

      const loaded = await loadParseCache(dir);
      expect(loaded.entries.size).toBe(1);
      expect(loaded.entries.get(goodKey)?.[0]?.fileCount).toBe(3);
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
        version: PARSE_CACHE_VERSION,
        entries: new Map<string, ParseWorkerResult[]>([[chunkKey, [fake]]]),
        usedKeys: new Set([chunkKey]),
      };
      await saveParseCache(dir, cache);
      const persisted = await fs.readdir(path.join(dir, 'parse-cache'));
      expect(persisted).toContain('index.json');
      expect(persisted).toContain(`${chunkKey}.json`);
      const loaded = await loadParseCache(dir);
      const reloaded = loaded.entries.get(chunkKey)?.[0];
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
          version: PARSE_CACHE_VERSION,
          keys: ['../evil', '/absolute', 'G'.repeat(64), safeKey],
        }),
        'utf-8',
      );
      await fs.writeFile(
        path.join(cacheDir, `${safeKey}.json`),
        JSON.stringify([minimalResult({ fileCount: 9 })]),
        'utf-8',
      );
      const loaded = await loadParseCache(dir);
      expect(loaded.entries.size).toBe(1);
      expect(loaded.entries.get(safeKey)?.[0]?.fileCount).toBe(9);
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
        version: PARSE_CACHE_VERSION,
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
      expect(names.filter((n) => n.endsWith('.json') && n !== 'index.json').length).toBe(3);
      const loaded = await loadParseCache(dir);
      expect(loaded.entries.size).toBe(3);
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
          version: PARSE_CACHE_VERSION,
          entries: { legacyChunk: [minimalResult({ fileCount: 42 })] },
        }),
        'utf-8',
      );
      const loaded = await loadParseCache(dir);
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
        version: PARSE_CACHE_VERSION,
        entries: new Map([[k1, [minimalResult()]]]),
        usedKeys: new Set([k1]),
      });
      await saveParseCache(dir, {
        version: PARSE_CACHE_VERSION,
        entries: new Map([[k2, [minimalResult({ fileCount: 99 })]]]),
        usedKeys: new Set([k2]),
      });
      const names = await fs.readdir(path.join(dir, 'parse-cache'));
      expect(names).not.toContain(`${k1}.json`);
      expect(names).toContain(`${k2}.json`);
      const loaded = await loadParseCache(dir);
      expect(loaded.entries.size).toBe(1);
      expect(loaded.entries.get(k2)?.[0]?.fileCount).toBe(99);
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
          version: PARSE_CACHE_VERSION,
          entries: { oldLegacy: [minimalResult({ fileCount: 5 })] },
        }),
        'utf-8',
      );
      const k = '6'.repeat(64);
      await saveParseCache(dir, {
        version: PARSE_CACHE_VERSION,
        entries: new Map([[k, [minimalResult({ fileCount: 6 })]]]),
        usedKeys: new Set([k]),
      });
      await expect(fs.access(path.join(dir, 'parse-cache.json'))).rejects.toThrow();
      const loaded = await loadParseCache(dir);
      expect(loaded.entries.get(k)?.[0]?.fileCount).toBe(6);
      expect(loaded.entries.has('oldLegacy')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
