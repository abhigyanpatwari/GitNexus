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
  it('retains opaque route facts across worker sub-batches', () => {
    const target = emptyResult();
    const first = { filePath: 'mount.ts', routePosition: 0, facts: { privateMountData: ['/api'] } };
    const second = {
      filePath: 'router.js',
      routePosition: 0,
      facts: { privateRegistrationData: ['/users'] },
    };
    mergeResult(target, { ...emptyResult(), routeFacts: [first] });
    const declaration = {
      filePath: 'middle.ts',
      routePath: '/existing',
      httpMethod: 'GET',
      decoratorName: 'other',
      lineNumber: 1,
    };
    mergeResult(target, { ...emptyResult(), decoratorRoutes: [declaration] });
    mergeResult(target, { ...emptyResult(), routeFacts: [second] });
    expect(target.routeFacts).toEqual([first, { ...second, routePosition: 1 }]);
    expect(target.decoratorRoutes).toEqual([declaration]);
    expect(second.routePosition).toBe(0);
  });

  it('retains wrapper candidates across sub-batches without treating them as HTTP sinks', () => {
    const target = emptyResult();
    const first = {
      filePath: 'a.ts',
      functionName: 'request',
      fetchURL: '/a',
      lineNumber: 1,
      target: { kind: 'unresolved' as const },
    };
    const second = {
      filePath: 'b.ts',
      functionName: 'client.get',
      fetchURL: '/b',
      lineNumber: 2,
      target: { kind: 'member' as const },
    };
    mergeResult(target, { ...emptyResult(), fetchWrapperCalls: [first] });
    mergeResult(target, emptyResult());
    mergeResult(target, { ...emptyResult(), fetchWrapperCalls: [second] });
    expect(target.fetchWrapperCalls).toEqual([first, second]);
    expect(target.fetchCalls).toEqual([]);
  });

  it('retains barrel re-export facts across sub-batches', () => {
    const target = emptyResult();
    const named = {
      filePath: 'index.ts',
      exportedName: 'request',
      from: { specifier: './request', importedName: 'request' },
    };
    const star = {
      filePath: 'index.ts',
      exportedName: '*',
      from: { specifier: './star', importedName: '*' },
    };
    mergeResult(target, { ...emptyResult(), fetchWrapperReexports: [named] });
    mergeResult(target, emptyResult());
    mergeResult(target, { ...emptyResult(), fetchWrapperReexports: [star] });
    expect(target.fetchWrapperReexports).toEqual([named, star]);
  });

  it('sums every CFG skip bucket by language across worker sub-batches', () => {
    const target = emptyResult();
    const first = {
      zig: { tooManyLines: 1, tooDeeplyNested: 2, buildError: 1 },
    };
    mergeResult(target, { ...emptyResult(), cfgSkipped: first });
    mergeResult(target, {
      ...emptyResult(),
      cfgSkipped: {
        zig: { tooManyLines: 2, tooDeeplyNested: 1, buildError: 3 },
        typescript: { tooManyLines: 0, tooDeeplyNested: 1, buildError: 0 },
      },
    });
    expect(target.cfgSkipped).toEqual({
      zig: { tooManyLines: 3, tooDeeplyNested: 3, buildError: 4 },
      typescript: { tooManyLines: 0, tooDeeplyNested: 1, buildError: 0 },
    });
    expect(first.zig).toEqual({ tooManyLines: 1, tooDeeplyNested: 2, buildError: 1 });
  });

  it('leaves CFG skip telemetry absent for older or successful results', () => {
    const target = emptyResult();
    mergeResult(target, emptyResult());
    mergeResult(target, { ...emptyResult(), cfgSkipped: {} });
    expect(target.cfgSkipped).toBeUndefined();
  });

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

  it('unions scope-extraction failures across worker sub-batches', () => {
    const target = emptyResult();
    mergeResult(target, {
      ...emptyResult(),
      scopeExtractionFailures: ['src/a.ts'],
    });
    mergeResult(target, {
      ...emptyResult(),
      scopeExtractionFailures: ['src/b.ts'],
    });
    expect(target.scopeExtractionFailures).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('leaves scope-extraction failures absent for backward-compatible results', () => {
    const target = emptyResult();
    mergeResult(target, emptyResult());
    expect(target.scopeExtractionFailures).toBeUndefined();
  });

  it('merges failure sets larger than the JavaScript argument limit', () => {
    const target = emptyResult();
    const scopeExtractionFailures = Array.from(
      { length: 70_000 },
      (_, index) => `src/failure-${index}.ts`,
    );

    expect(() => mergeResult(target, { ...emptyResult(), scopeExtractionFailures })).not.toThrow();
    expect(target.scopeExtractionFailures).toHaveLength(70_000);
    expect(target.scopeExtractionFailures?.at(-1)).toBe('src/failure-69999.ts');
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
