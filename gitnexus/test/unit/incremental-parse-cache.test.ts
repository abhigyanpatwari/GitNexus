import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  PARSE_CACHE_VERSION,
  computeChunkHash,
  fileContentHash,
  loadParseCache,
  loadParseCacheChunk,
  persistParseCacheChunk,
  saveParseCache,
  pruneCache,
  slimParseWorkerResultsForCache,
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
  // 35 -> 36 for the bound-callable start-line join (#2735), 36 -> 37 for
  // Java/Kotlin Spring AOP capture side-channels (#2416), 37 -> 38 for the Swift
  // conditional-directive parse-semantics change (#2771), 38 -> 39 for
  // receiver-chain wire format v2: every persisted chain string changed prefix
  // and a v2 decoder refuses v1 by design, so a stale cache replays chains this
  // build silently discards. 39 -> 40 for inference-typed field captures in six
  // languages (#2807) — all parse-time emission, so a warm cache replays the
  // pre-fix capture set for byte-unchanged files and the new receiver edges
  // never appear.
  //
  // This pin has now earned its keep EIGHT times, and twice it caught an EXACT
  // clash rather than a near-miss: main took 37 for #2416 while this branch
  // already used 37, and then took 38 for #2771 after this branch had moved to
  // 38. Both times two incompatible schemas claimed one number. Note when the
  // second clash was caught — after review, while the branch sat waiting to
  // merge — which is precisely the window in which `main` allocates. Re-check
  // against origin/main immediately before merge, not at review time.
  // Moved 42 -> 43 for #2813's `@reference.embedded-pointer` capture, which is
  // parse-time emission and so cannot be served from a v42 warm cache.
  // Moved 43 -> 44 for #2842's TypeScript heritage capture (interface and
  // abstract-class `@reference.inherits`), which is parse-time emission and so
  // cannot be served from a v43 warm cache.
  // Moved 44 -> 45 for #2837 (Go struct/interface captures re-anchored from
  // `type_declaration` to `type_spec`). This branch first took 44 and COLLIDED
  // with #2842 above, which merged first — the ninth entry in the ledger and the
  // third EXACT clash. Note what this pin could and could not do: it cannot
  // detect the tie (both branches asserted `toBe(44)`, which passes when main is
  // already 44); only the merge-time diff against origin/main surfaced it. What
  // the pin DOES do is fail loudly the moment the constant and this expectation
  // drift apart, which is what forces the re-check to happen at all.
  // Moved 45 -> 46 for the JavaScript bare-identifier read captures, the
  // object-literal `@definition.property` rule and the TypeScript shape-member
  // captures (A1/A2/A4/A5) — all parse-time, so a v45 warm cache serves entries
  // carrying neither the new reference sites nor the new Property nodes.
  //
  // This branch first took 45 and COLLIDED with #2837 above, which merged
  // first: the TENTH ledger entry and the FOURTH exact clash, and the second in
  // a row. Same lesson as the note above — the pin cannot detect the tie, since
  // both sides asserted `toBe(45)` and that passes while main is already 45.
  // Only the merge-time diff against origin/main surfaces it.
  //
  // Moved 46 -> 47 for method-level Spring `@RequestMapping` routes (#2857):
  // cached ParseWorkerResults otherwise replay the pre-fix empty route set.
  // That PR read this branch's claim on 46 and took 47 rather than colliding —
  // the FIFTH clash, and the first the ledger's convention actually prevented.
  // It only moved the collision up one step, though: this branch's own 47 and
  // everything above it had to be renumbered +1 at merge time. Capture sets
  // unchanged; only the numbers moved.
  //
  // Moved 51 -> 52 for dispatch-guard routes (R3-7): the JS/TS providers now
  // implement `extractDecoratorRoutes`, and decorator routes are worker output
  // carried in the cache. A v50 warm cache replays a worker result whose
  // `decoratorRoutes` predates the extractor, so `route_map` keeps answering
  // empty — the exact symptom the change fixes, disguised as "it does not work".
  // Moved 52 -> 53 for the same-file constant folding that followed, because a
  // build stamped 50 (now 52) had already been used to analyze without it.
  //
  //
  // Moved 47 -> 48 for #2833's three parse-time changes: C++
  // `field_declaration` captures for `template_type` and qualified generic
  // member types (those members had NO type binding before), a Python interpret
  // change that reduces `Repo[User]` to `Repo` in `TypeRef.rawName`, and the new
  // `SymbolDefinition.typeParameters` field read from a
  // `@declaration.type-parameters` capture in six languages. All three are
  // serialized into the cached ParsedFile, so an older warm cache replays
  // pre-fix bindings and the fix is a silent no-op on incremental analyze while
  // every cold-run test still passes.
  //
  // 48, not 46, because this branch collided TWICE: it staged 46 and then 47,
  // both free when written, and by merge time #2856 claimed 46 and #2857 took 47
  // and merged first. This assertion is exactly what CANNOT detect that — the
  // branch asserted `toBe(47)` and so did #2857, and both passed. What this pin
  // does do is fail loudly the moment the constant and this expectation drift
  // apart, which is what forces the merge-time diff against origin/main to
  // happen at all.
  // Moved 53 -> 54 for W2-8: type parameters are captured on generic functions
  // and aliases, not just class-likes, so the shadowing guard has data to read.
  // Moved 54 -> 55 for W2-9: the dispatch-guard verb walk tracks boolean polarity,
  // so a ternary can no longer report the verb it excludes. Routes are emitted at
  // parse time, so a warm cache would replay the inverted verb indefinitely.
  it('pins SCHEMA_BUMP to 55 so concurrent bumps cannot silently collide (#2766)', () => {
    expect(Number(PARSE_CACHE_VERSION.split('+', 1)[0])).toBe(55);
  });

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

  it('drops onDiskKeys entries not in the used-set and counts them', () => {
    const cache: ParseCache = {
      version: PARSE_CACHE_VERSION,
      entries: new Map<string, ParseWorkerResult[]>(),
      usedKeys: new Set<string>(['disk-A']),
      onDiskKeys: new Set<string>(['disk-A', 'disk-B', 'disk-C']),
    };
    const removed = pruneCache(cache, new Set(['disk-A']));
    expect(removed).toBe(2);
    expect([...(cache.onDiskKeys ?? [])].sort()).toEqual(['disk-A']);
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
        version: PARSE_CACHE_VERSION,
        entries: new Map<string, ParseWorkerResult[]>([[chunkKey, [fake]]]),
        usedKeys: new Set([chunkKey]),
      };
      await saveParseCache(dir, cache);
      const persisted = await fs.readdir(path.join(dir, 'parse-cache'));
      expect(persisted).toContain('index.json');
      expect(persisted).toContain(`${chunkKey}.json`);
      const loaded = await loadParseCache(dir);
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
    });
    const slim = slimParseWorkerResultsForCache([raw])[0];
    expect(slim.calls).toEqual([]);
    expect(slim.assignments).toEqual([]);
    expect(slim.constructorBindings).toEqual([]);
    expect(slim.parsedFiles).toEqual([]);
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

  it('persistParseCacheChunk writes to disk without retaining in-memory entries', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const key = '7'.repeat(64);
      const cache: ParseCache = {
        version: PARSE_CACHE_VERSION,
        entries: new Map(),
        usedKeys: new Set(),
        storagePath: dir,
        onDiskKeys: new Set(),
      };
      await persistParseCacheChunk(cache, key, [minimalResult({ fileCount: 11 })]);
      expect(cache.entries.has(key)).toBe(false);
      expect(cache.onDiskKeys?.has(key)).toBe(true);
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
        version: PARSE_CACHE_VERSION,
        entries: new Map([[realKey, [minimalResult({ fileCount: 3 })]]]),
        usedKeys: new Set([realKey, phantomKey]),
      };
      await saveParseCache(dir, cache);
      const loaded = await loadParseCache(dir);
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
        version: PARSE_CACHE_VERSION,
        entries: new Map(),
        usedKeys: new Set([key]),
        storagePath: dir,
        onDiskKeys: new Set(),
      };
      // persist writes the shard to the live dir and evicts it from `entries`,
      // so saveParseCache must hit the copyFile branch to carry it forward.
      await persistParseCacheChunk(cache, key, [minimalResult({ fileCount: 42 })]);
      expect(cache.entries.has(key)).toBe(false);
      await saveParseCache(dir, cache);
      const loaded = await loadParseCache(dir);
      expect(loaded.onDiskKeys?.has(key)).toBe(true);
      expect((await loadParseCacheChunk(loaded, key))?.[0]?.fileCount).toBe(42);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
