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

  it('unions springTypes across sub-batch results, initializing the target when absent (#2288)', () => {
    const mkType = (name: string, filePath: string) => ({
      filePath,
      kind: 'interface' as const,
      name,
      classPrefixes: [],
      implementedInterfaces: [],
      isController: false,
      methods: [],
    });
    const target = emptyResult(); // no springTypes on the target (the `??=` path)
    mergeResult(target, { ...emptyResult(), springTypes: [mkType('A', 'A.java')], fileCount: 1 });
    mergeResult(target, { ...emptyResult(), springTypes: [mkType('B', 'B.java')], fileCount: 1 });
    expect(target.springTypes?.map((t) => t.name)).toEqual(['A', 'B']);
  });

  it('leaves springTypes undefined when no source carries any (#2288)', () => {
    const target = emptyResult();
    mergeResult(target, { ...emptyResult(), fileCount: 1 });
    expect(target.springTypes).toBeUndefined();
  });

  it('unions moduleConstants across sub-batch results, initializing the target when absent (#2391)', () => {
    const mkConst = (filePath: string, name: string) => ({
      filePath,
      constants: {
        literals: new Map([[name, '/a']]),
        exprs: new Map(),
        imports: new Map(),
      },
    });
    // Regression: the worker-side accumulator dropped this field, so composed
    // FastAPI route constants never reached parse-impl and resolved to `POST /`.
    const target = emptyResult(); // no moduleConstants on the target (the `??=` path)
    mergeResult(target, {
      ...emptyResult(),
      moduleConstants: [mkConst('a.py', 'A')],
      fileCount: 1,
    });
    mergeResult(target, {
      ...emptyResult(),
      moduleConstants: [mkConst('b.py', 'B')],
      fileCount: 1,
    });
    expect(target.moduleConstants?.map((m) => m.filePath)).toEqual(['a.py', 'b.py']);
  });

  it('leaves moduleConstants undefined when no source carries any (#2391)', () => {
    const target = emptyResult();
    mergeResult(target, { ...emptyResult(), fileCount: 1 });
    expect(target.moduleConstants).toBeUndefined();
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
