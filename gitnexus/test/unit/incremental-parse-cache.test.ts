import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  PARSE_CACHE_VERSION,
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
  // Moved 55 -> 56 for R3-8 part 1: the verb walk returns every method a guard
  // serves, so a multi-method guard emits several routes where it emitted one.
  // Moved 56 -> 57 for R3-8 part 2: `.match()` dispatch, bound-match test sites,
  // named regex consts, and capturing segment wildcards in `regexToRoutePath`.
  // Moved 57 -> 58 for #2897: fetch sites are captured without a literal URL.
  // Moved 58 -> 59 for the #2899 review follow-up: the dispatch-guard walk keys
  // match bindings on (enclosing function, name) instead of the bare identifier,
  // and a ternary conjunction INTERSECTS its operands instead of taking the first
  // non-empty set. Both strictly remove routes, so a warm cache would keep
  // serving a fabricated verbed route that evicts the true one.
  // Moved 59 -> 60 for #2864's `ParsedImport.reexportsName` and the
  // `@import.publishes` capture gating it — a serialized ParsedFile field AND a
  // capture change, the first being the easy-to-miss half. 60 was staged while
  // main was 53, chosen above every in-flight MAXIMUM rather than at main + 1;
  // #2899 then cascaded main to 59, and 60 survived only because of that choice.
  // Moved 60 -> 62 for the cycle-checker fix's two optional `ParsedImport`
  // fields, `typeOnly` and `runsOnlyWhenCalled`. Neither is a capture, but
  // `parsedfile-store.ts` serializes the whole ParsedFile generically, so both
  // are part of the cached shape — the same half of #2864 that was easy to miss.
  // A warm cache would replay untagged imports, the strict `=== true` reads
  // would take the untagged path, and `check --cycles` would keep reporting the
  // erased and deferred imports the branch exists to stop reporting: a silent
  // no-op on incremental analyze while every cold-run test passes.
  // Main subsequently advanced through 63. Values above it must remain distinct
  // from both published branch heads and every active in-flight claim.
  // Moved 63 -> 64 for Java enum and annotated heritage captures (#2918),
  // then 64 -> 66 for the synthetic-declaration sidecar, both now on main.
  // Moved 66 -> 67 for #2917's implicit Java record-component accessor
  // definitions and scope declarations. This branch staged 65 before #2918's 66
  // landed; 67 is the next free value above every in-flight claim (main 66,
  // #2939's 64), re-checked against the claims rather than against main alone.
  // Moved 67 -> 68 for #2912's `ReferenceSite.typeArguments` — heritage generic
  // arguments derived at extraction time, so a warm cache replays `inherits`
  // sites without them and instantiation-aware dispatch degrades silently to
  // the pre-fix fan-out. This branch staged 64 above the claims live at the
  // time (61, 62, 63); all three landed and cascaded main to 67, so 68 is the
  // next free value above every claim at merge — the rule, re-applied.
  // Version 69 added #2969's JS/TS data-route-table decoratorRoutes. Version 70
  // adds Spring non-HTTP handler side-channel facts (#2417 / #2891), so it is
  // the next free value after both cache payload changes.
  // Moved 70 -> 71 for #2980's Java constant-route capture set (moduleConstants
  // + routePathOperands). 72 -> 74 added import-proven Convex endpoint metadata,
  // skipping 73 because open PR #3046 claims it.
  // Version 75 adds #3009's NestJS decorator routes to the same JS/TS
  // decoratorRoutes channel, so a warm pre-feature cache cannot replay the empty
  // route set that change fixes. This branch originally claimed 71; origin/main
  // cascaded past it (71 to #2980, 74 to Convex) while the PR was open, so 71
  // would now be BELOW main and the reuse gate would never fire. 75 is the next
  // free value above origin/main and above every in-flight claim (#3046 at 73,
  // #1616 at a stale 2) — the rule, re-applied at merge, not at authoring time.
  // Moved 75 -> 76 within this same branch for the NestJS array form, then
  // 76 -> 77 because 76 turned out not to be free: origin/main reached 76 via
  // #3046 while this branch was in review, and package.json is 1.6.9 on both
  // sides, so the cache key was the byte-identical `76+1.6.9` on two branches
  // with incompatible worker output. #3046 had skipped 75 precisely because
  // this branch held it. Two PRs each doing the bookkeeping correctly still
  // collided, because each re-checked once and neither re-checked after the
  // other moved — which is why the rule is re-applied AT MERGE, not when the
  // number is picked.
  it('pins SCHEMA_BUMP to 80 so concurrent bumps cannot silently collide (#2766, #3015, #3088)', () => {
    expect(Number(PARSE_CACHE_VERSION.split('+', 1)[0])).toBe(80);
    expect(PARSE_CACHE_BUCKET_COUNT).toBe(128);
    for (const taken of [
      59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79,
    ]) {
      expect(Number(PARSE_CACHE_VERSION.split('+', 1)[0])).not.toBe(taken);
    }
  });

  it('embeds the gitnexus package version (so upgrades invalidate the cache)', () => {
    // Looks like "1+1.6.4" — schema bump prefix + actual gitnexus version
    expect(PARSE_CACHE_VERSION).toMatch(/^\d+\+\d+\.\d+\.\d+/);
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
        version: PARSE_CACHE_VERSION,
        entries: new Map([[key, [minimalResult({ scopeExtractionFailures: ['src/broken.ts'] })]]]),
        usedKeys: new Set([key]),
      });

      const loaded = await loadParseCache(dir);
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

  it('recreates a memoized shard directory after a long-lived process replaces it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-pc-'));
    try {
      const firstKey = 'd'.repeat(64);
      const secondKey = 'e'.repeat(64);
      const cache: ParseCache = {
        version: PARSE_CACHE_VERSION,
        entries: new Map(),
        usedKeys: new Set([firstKey]),
        storagePath: dir,
        onDiskKeys: new Set(),
      };

      await persistParseCacheChunk(cache, firstKey, [minimalResult({ fileCount: 1 })]);
      await rm(path.join(dir, 'parse-cache'), { recursive: true, force: true });

      cache.usedKeys = new Set([secondKey]);
      await persistParseCacheChunk(cache, secondKey, [minimalResult({ fileCount: 2 })]);
      await saveParseCache(dir, cache);

      const loaded = await loadParseCache(dir);
      expect((await loadParseCacheChunk(loaded, secondKey))?.[0]?.fileCount).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
