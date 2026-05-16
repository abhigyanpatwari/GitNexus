/**
 * Coverage tests for cross-file-impl.ts — `runCrossFileBindingPropagation`.
 *
 * Scenarios aimed at branches the integration tests exercise only on the
 * happy path:
 *   1. gapRatio < CROSS_FILE_SKIP_THRESHOLD → returns 0 without reprocess.
 *   2. MAX_CROSS_FILE_REPROCESS cap → outer level loop breaks.
 *   3. parse-supplied exportedTypeMap is NEVER mutated by crossFile (cross
 *      file builds its own local working copy for re-resolution writes).
 *   4. namedImportMap.size === 0 → returns 0 immediately.
 *
 * Note: `processCalls`, `readFileContents`, and `isLanguageAvailable` are
 * mocked so the test doesn't require tree-sitter or filesystem access.
 * `buildImportedReturnTypes` and `buildImportedRawReturnTypes` are preserved
 * via `importOriginal`. The graph-fallback enrichment that used to live here
 * was moved into parse-impl's `runChunkedParseAndResolve` so the parse phase
 * hands crossFile a fully-populated, truly read-only map.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/ingestion/call-processor.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/ingestion/call-processor.js')>();
  return {
    ...actual,
    processCalls: vi.fn(async () => {}),
  };
});

vi.mock('../../src/core/ingestion/filesystem-walker.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/ingestion/filesystem-walker.js')>();
  return {
    ...actual,
    readFileContents: vi.fn(async (_repo: string, paths: string[]) => {
      const m = new Map<string, string>();
      for (const p of paths) m.set(p, '// stub');
      return m;
    }),
  };
});

vi.mock('../../src/core/tree-sitter/parser-loader.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/tree-sitter/parser-loader.js')>();
  return {
    ...actual,
    isLanguageAvailable: vi.fn(() => true),
  };
});

// Default to non-registry-primary so existing tests (which use .ts files) are
// not affected by the isRegistryPrimary guard added in cross-file-impl. Tests
// that verify the skip behavior can override this with mockReturnValue(true).
vi.mock('../../src/core/ingestion/registry-primary-flag.js', () => ({
  isRegistryPrimary: vi.fn(() => false),
}));

import { runCrossFileBindingPropagation } from '../../src/core/ingestion/pipeline-phases/cross-file-impl.js';
import { processCalls } from '../../src/core/ingestion/call-processor.js';
import { isRegistryPrimary } from '../../src/core/ingestion/registry-primary-flag.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { ExportedTypeMap } from '../../src/core/ingestion/call-processor.js';

const processCallsMock = vi.mocked(processCalls);
const isRegistryPrimaryMock = vi.mocked(isRegistryPrimary);

/**
 * Index of the `compiledQueryCache` parameter in the `processCalls` signature.
 * graph(0), files(1), astCache(2), ctx(3), onProgress?(4), exportedTypeMap?(5),
 * importedBindingsMap?(6), importedReturnTypesMap?(7),
 * importedRawReturnTypesMap?(8), heritageMap?(9), bindingAccumulator?(10),
 * compiledQueryCache?(11).
 */
const COMPILED_QUERY_CACHE_ARG_INDEX = 11;

describe('runCrossFileBindingPropagation', () => {
  beforeEach(() => {
    processCallsMock.mockClear();
    isRegistryPrimaryMock.mockReturnValue(false); // reset to non-primary before each test
  });

  it('returns 0 immediately when namedImportMap is empty', async () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();
    const exportedTypeMap: ExportedTypeMap = new Map([
      ['upstream.ts', new Map([['User', 'User']])],
    ]);

    const result = await runCrossFileBindingPropagation(
      graph,
      ctx,
      exportedTypeMap,
      new Set(['upstream.ts']),
      1,
      '/repo',
      Date.now(),
      () => {},
    );

    expect(result).toBe(0);
    expect(processCallsMock).not.toHaveBeenCalled();
  });

  it('returns 0 when gapRatio < CROSS_FILE_SKIP_THRESHOLD', async () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    // 100 files total; exportedTypeMap has an export but no downstream
    // namedImportMap entry references a matching name → zero gaps.
    const exportedTypeMap: ExportedTypeMap = new Map([
      ['upstream.ts', new Map([['User', 'User']])],
    ]);

    // One downstream importer whose binding points at a symbol NOT in
    // exportedTypeMap and NOT in ctx.model.symbols → no gap-filling seed
    // available, so filesWithGaps stays at 0.
    const downstreamBindings = new Map();
    downstreamBindings.set('Missing', {
      sourcePath: 'upstream.ts',
      exportedName: 'Missing',
    });
    ctx.namedImportMap.set('downstream.ts', downstreamBindings);

    const totalFiles = 100; // threshold = ceil(100 * 0.03) = 3

    const result = await runCrossFileBindingPropagation(
      graph,
      ctx,
      exportedTypeMap,
      new Set(['downstream.ts', 'upstream.ts']),
      totalFiles,
      '/repo',
      Date.now(),
      () => {},
    );

    expect(result).toBe(0);
    expect(processCallsMock).not.toHaveBeenCalled();
  });

  it('does not mutate the parse-supplied exportedTypeMap (works on a local copy)', async () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    // Seed a single upstream export and a downstream importer so the gap
    // ratio crosses the skip threshold and processCalls (mocked) is invoked.
    const parseExports: ExportedTypeMap = new Map([['upstream.ts', new Map([['User', 'User']])]]);
    const parseExportsSnapshot = new Map(
      Array.from(parseExports, ([k, v]) => [k, new Map(v)] as const),
    );

    const bindings = new Map();
    bindings.set('User', { sourcePath: 'upstream.ts', exportedName: 'User' });
    ctx.namedImportMap.set('downstream.ts', bindings);
    ctx.importMap.set('upstream.ts', new Set());
    ctx.importMap.set('downstream.ts', new Set(['upstream.ts']));

    await runCrossFileBindingPropagation(
      graph,
      ctx,
      parseExports,
      new Set(['downstream.ts', 'upstream.ts']),
      10,
      '/repo',
      Date.now(),
      () => {},
    );

    // Outer map identity preserved, sizes unchanged, inner Maps unchanged —
    // crossFile must operate on its own working copy.
    expect(parseExports.size).toBe(parseExportsSnapshot.size);
    for (const [k, v] of parseExportsSnapshot) {
      const after = parseExports.get(k);
      expect(after).toBeDefined();
      expect(after!.size).toBe(v.size);
      for (const [innerK, innerV] of v) {
        expect(after!.get(innerK)).toBe(innerV);
      }
    }
  });

  it('passes the same compiledQueryCache Map instance to every processCalls call', async () => {
    // Verifies that the O(N)→O(1) query-cache fix is correctly wired: the
    // `compiledQueryCache` created in runCrossFileBindingPropagation is shared
    // across all processCalls invocations so each language's Parser.Query is
    // compiled exactly once, not once per file.
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    const exportedTypeMap: ExportedTypeMap = new Map([
      ['upstream.ts', new Map([['User', 'User']])],
    ]);
    ctx.importMap.set('upstream.ts', new Set());

    const allPaths = ['upstream.ts'];
    for (let i = 0; i < 3; i++) {
      const file = `downstream${i}.ts`;
      allPaths.push(file);
      const bindings = new Map();
      bindings.set('User', { sourcePath: 'upstream.ts', exportedName: 'User' });
      ctx.namedImportMap.set(file, bindings);
      ctx.importMap.set(file, new Set(['upstream.ts']));
    }

    await runCrossFileBindingPropagation(
      graph,
      ctx,
      exportedTypeMap,
      new Set(allPaths),
      allPaths.length,
      '/repo',
      Date.now(),
      () => {},
    );

    expect(processCallsMock).toHaveBeenCalledTimes(3);

    // Argument index 11 is compiledQueryCache — see COMPILED_QUERY_CACHE_ARG_INDEX.
    const caches = processCallsMock.mock.calls.map((call) => call[COMPILED_QUERY_CACHE_ARG_INDEX]);
    // Every call must receive a non-null Map (not undefined).
    for (const cache of caches) {
      expect(cache).toBeDefined();
      expect(cache).toBeInstanceOf(Map);
    }
    // All calls share the SAME instance — the whole point of the cache.
    expect(caches[1]).toBe(caches[0]);
    expect(caches[2]).toBe(caches[0]);
  });

  it('emits live onProgress events every 25 files with N/M format', async () => {
    // Verifies that the frozen-progress-display fix is correctly wired:
    // onProgress must be called multiple times from the processing loop,
    // not just once at phase start, so large repos show real movement in
    // the UI instead of a frozen percentage bar.
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    const exportedTypeMap: ExportedTypeMap = new Map([
      ['upstream.ts', new Map([['User', 'User']])],
    ]);
    ctx.importMap.set('upstream.ts', new Set());

    const allPaths = ['upstream.ts'];
    for (let i = 0; i < 50; i++) {
      const file = `downstream${i}.ts`;
      allPaths.push(file);
      const bindings = new Map();
      bindings.set('User', { sourcePath: 'upstream.ts', exportedName: 'User' });
      ctx.namedImportMap.set(file, bindings);
      ctx.importMap.set(file, new Set(['upstream.ts']));
    }

    const progressMessages: string[] = [];
    const onProgress = vi.fn((p: { phase: string; percent: number; message: string }) => {
      progressMessages.push(p.message);
    });

    await runCrossFileBindingPropagation(
      graph,
      ctx,
      exportedTypeMap,
      new Set(allPaths),
      allPaths.length,
      '/repo',
      Date.now(),
      onProgress,
    );

    // 1 initial call at phase start + 2 loop calls (at 25 and 50 files).
    expect(onProgress).toHaveBeenCalledTimes(3);

    // Loop messages must carry the "N/M files" format so the UI is informative.
    const loopMessages = progressMessages.filter((m) => m.match(/\(\d+\/\d+ files\)/));
    expect(loopMessages).toHaveLength(2);
    expect(loopMessages[0]).toContain('(25/50 files)');
    expect(loopMessages[1]).toContain('(50/50 files)');
  });

  it('caps processing at MAX_CROSS_FILE_REPROCESS (2000)', async () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    // Seed one upstream export reused by every downstream file.
    const exportedTypeMap: ExportedTypeMap = new Map([
      ['upstream.ts', new Map([['User', 'User']])],
    ]);

    const allPaths: string[] = ['upstream.ts'];
    // Create 2100 downstream importers — each will qualify as a candidate
    // (seeded.size === 1 because upstream.ts has the export we bind to).
    // Populate ctx.importMap so topologicalLevelSort returns real levels.
    ctx.importMap.set('upstream.ts', new Set());
    for (let i = 0; i < 2100; i++) {
      const file = `downstream${i}.ts`;
      allPaths.push(file);
      const bindings = new Map();
      bindings.set('User', { sourcePath: 'upstream.ts', exportedName: 'User' });
      ctx.namedImportMap.set(file, bindings);
      ctx.importMap.set(file, new Set(['upstream.ts']));
    }

    const totalFiles = allPaths.length;

    const result = await runCrossFileBindingPropagation(
      graph,
      ctx,
      exportedTypeMap,
      new Set(allPaths),
      totalFiles,
      '/repo',
      Date.now(),
      () => {},
    );

    // Hard cap is 2000. The function returns `crossFileResolved`, which
    // equals MAX_CROSS_FILE_REPROCESS once the cap is hit.
    expect(result).toBe(2000);
    expect(processCallsMock).toHaveBeenCalledTimes(2000);
  });

  it('skips registry-primary language files without calling processCalls', async () => {
    // Finding 3: on large TypeScript/C++ repos (registry-primary since v1.6.4+)
    // cross-file-impl was calling processCalls 595× per candidate only for
    // processCalls to immediately return (isRegistryPrimary guard inside).
    // Now cross-file-impl filters them out BEFORE readFileContents so we avoid
    // the I/O cost and map-building overhead entirely.
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    const exportedTypeMap: ExportedTypeMap = new Map([
      ['upstream.ts', new Map([['User', 'User']])],
    ]);
    ctx.importMap.set('upstream.ts', new Set());

    const allPaths = ['upstream.ts'];
    for (let i = 0; i < 5; i++) {
      const file = `downstream${i}.ts`;
      allPaths.push(file);
      const bindings = new Map();
      bindings.set('User', { sourcePath: 'upstream.ts', exportedName: 'User' });
      ctx.namedImportMap.set(file, bindings);
      ctx.importMap.set(file, new Set(['upstream.ts']));
    }

    // Simulate all files being registry-primary (e.g. TypeScript on main branch).
    isRegistryPrimaryMock.mockReturnValue(true);

    const result = await runCrossFileBindingPropagation(
      graph,
      ctx,
      exportedTypeMap,
      new Set(allPaths),
      allPaths.length,
      '/repo',
      Date.now(),
      () => {},
    );

    // No files are candidates; no processCalls invocations.
    expect(result).toBe(0);
    expect(processCallsMock).not.toHaveBeenCalled();
  });
});
