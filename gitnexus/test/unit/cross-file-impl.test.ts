/**
 * Coverage tests for cross-file-impl.ts — `runCrossFileBindingPropagation`.
 *
 * Scenarios aimed at branches the integration tests exercise only on the
 * happy path:
 *   1. gapRatio < CROSS_FILE_SKIP_THRESHOLD → returns 0 without reprocess.
 *   2. MAX_CROSS_FILE_REPROCESS cap → outer level loop breaks.
 *   3. exportedTypeMap empty + graph has nodes → fallback populates map.
 *   4. namedImportMap.size === 0 → returns 0 immediately.
 *
 * Note: `processCalls`, `readFileContents`, and `isLanguageAvailable` are
 * mocked so the test doesn't require tree-sitter or filesystem access.
 * `buildExportedTypeMapFromGraph`, `buildImportedReturnTypes`, and
 * `buildImportedRawReturnTypes` are preserved via `importOriginal` so the
 * graph-fallback branch (scenario 3) exercises real code.
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

import { runCrossFileBindingPropagation } from '../../src/core/ingestion/pipeline-phases/cross-file-impl.js';
import { processCalls } from '../../src/core/ingestion/call-processor.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { ExportedTypeMap } from '../../src/core/ingestion/call-processor.js';

const processCallsMock = vi.mocked(processCalls);

describe('runCrossFileBindingPropagation', () => {
  beforeEach(() => {
    processCallsMock.mockClear();
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
      ['upstream.ts'],
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
      ['downstream.ts', 'upstream.ts'],
      totalFiles,
      '/repo',
      Date.now(),
      () => {},
    );

    expect(result).toBe(0);
    expect(processCallsMock).not.toHaveBeenCalled();
  });

  it('runs buildExportedTypeMapFromGraph fallback when exportedTypeMap empty but graph populated', async () => {
    const graph = createKnowledgeGraph();
    const ctx = createResolutionContext();

    // Populate graph with an exported symbol that has a resolvable
    // returnType via the symbol table — this is what
    // buildExportedTypeMapFromGraph needs to emit an entry.
    ctx.model.symbols.add('upstream.ts', 'getUser', 'Function:upstream.ts:getUser', 'Function', {
      returnType: 'User',
    });
    graph.addNode({
      id: 'Function:upstream.ts:getUser',
      label: 'Function',
      properties: {
        name: 'getUser',
        filePath: 'upstream.ts',
        startLine: 1,
        endLine: 5,
        isExported: true,
      },
    });

    // Downstream imports the symbol but under a name that the fallback
    // won't match → gap detection finds no gaps → function returns 0,
    // but NOT before the fallback has populated exportedTypeMap.
    const bindings = new Map();
    bindings.set('getUser', { sourcePath: 'upstream.ts', exportedName: 'getUser' });
    ctx.namedImportMap.set('downstream.ts', bindings);

    const exportedTypeMap: ExportedTypeMap = new Map(); // EMPTY — triggers fallback

    // totalFiles large enough that single gap < threshold (3 needed for 100)
    const totalFiles = 100;

    await runCrossFileBindingPropagation(
      graph,
      ctx,
      exportedTypeMap,
      ['downstream.ts', 'upstream.ts'],
      totalFiles,
      '/repo',
      Date.now(),
      () => {},
    );

    // The fallback populated exportedTypeMap with the graph-derived entry.
    expect(exportedTypeMap.size).toBeGreaterThan(0);
    expect(exportedTypeMap.get('upstream.ts')?.get('getUser')).toBe('User');
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
      allPaths,
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
});
