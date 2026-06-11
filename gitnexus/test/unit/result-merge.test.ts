/**
 * #2135 tri-review (R12): the parse-worker result merge unions the clone-safety
 * `skippedPaths` across sub-batch results. mergeResult was extracted from the
 * parse-worker entry module into result-merge.ts so it can be unit-tested here
 * (a main-thread import of parse-worker.ts would run its MessagePort setup).
 */
import { describe, it, expect } from 'vitest';

import { mergeResult } from '../../src/core/ingestion/workers/result-merge.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';

function emptyResult(): ParseWorkerResult {
  return {
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
  };
}

describe('mergeResult', () => {
  it('unions skippedPaths across sub-batch results, initializing the target when absent', () => {
    const target = emptyResult(); // no skippedPaths on the target (the `??=` path)
    mergeResult(target, {
      ...emptyResult(),
      skippedPaths: [{ path: 'a.ts', reason: 'r1' }],
      fileCount: 1,
    });
    mergeResult(target, {
      ...emptyResult(),
      skippedPaths: [{ path: 'b.ts', reason: 'r2' }],
      fileCount: 1,
    });
    expect(target.skippedPaths).toEqual([
      { path: 'a.ts', reason: 'r1' },
      { path: 'b.ts', reason: 'r2' },
    ]);
    expect(target.fileCount).toBe(2);
  });

  it('leaves skippedPaths undefined when no source carries any (no spurious empty array)', () => {
    const target = emptyResult();
    mergeResult(target, { ...emptyResult(), fileCount: 1 });
    expect(target.skippedPaths).toBeUndefined();
  });

  it('also sums skippedLanguages and appends node arrays (sanity of the rest of the merge)', () => {
    const target = { ...emptyResult(), skippedLanguages: { rust: 1 } };
    mergeResult(target, {
      ...emptyResult(),
      nodes: [
        { id: 'n', label: 'Function', properties: { name: 'n' } },
      ] as ParseWorkerResult['nodes'],
      skippedLanguages: { rust: 2, go: 1 },
    });
    expect(target.skippedLanguages).toEqual({ rust: 3, go: 1 });
    expect(target.nodes).toHaveLength(1);
  });
});
