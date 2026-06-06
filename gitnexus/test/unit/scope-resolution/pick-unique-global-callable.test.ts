/**
 * Unit tests for `pickUniqueGlobalCallable` + its per-pass `scopeDefsCache`
 * memo (free-call candidate cache — kernel scope-resolution throughput, 2026-06-06).
 *
 * It memoizes the post-filter candidate list keyed (simpleName, callerFilePath)
 * so repeated free calls of the same name from one file reuse the same-name
 * bucket scan instead of re-walking a (potentially huge) bucket per site. The
 * memo is behavior-PRESERVING: the candidate list is a pure function of
 * (name, callerFilePath) whenever no per-caller visibility filter applies, and
 * the cached array is only ever read (never mutated) by the arity / overload
 * narrowers. The only observable change is performance.
 *
 * These tests exercise the helper via synthetic `SymbolDefinition` stubs — no
 * fixtures, no pipeline — mirroring `pick-unique-global-class.test.ts`. The
 * load-bearing test is the EQUIVALENCE battery: the memoized path must agree
 * with an un-memoized reference scan (cache `undefined`) on the resolved nodeId
 * for every (name, callerFile, arity), including warm-cache repeats and
 * interleaved callers — which is what guards the byte-identical edge invariant
 * (the C fixture 177n/255e + the c/cpp/cross-file resolver suites).
 */

import { describe, it, expect } from 'vitest';
import type { SymbolDefinition } from 'gitnexus-shared';
import {
  buildGlobalCallableIndex,
  pickUniqueGlobalCallable,
} from '../../../src/core/ingestion/scope-resolution/passes/free-call-fallback.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';

const mkDef = (overrides: Partial<SymbolDefinition> & { nodeId: string }): SymbolDefinition => ({
  filePath: 'x.c',
  type: 'Function',
  qualifiedName: overrides.nodeId,
  ...overrides,
});

/** Wrap a flat def list as the `scopes.defs.byId` map `buildGlobalCallableIndex`
 *  iterates. Insertion order is preserved by `Map`, so this reproduces the
 *  `defs.byId.values()` iteration order the per-site scan walked. */
const mkScopes = (defs: readonly SymbolDefinition[]): ScopeResolutionIndexes =>
  ({
    defs: {
      byId: new Map(defs.map((d) => [d.nodeId, d])),
    },
  }) as unknown as ScopeResolutionIndexes;

/** Empty semantic model — the free-call fallback's model-side pool returns
 *  nothing, so resolution is driven entirely by the scope-index path under
 *  test (the path the memo covers). */
const EMPTY_MODEL = {
  symbols: { lookupCallableByName: () => [] as readonly SymbolDefinition[] },
  methods: { lookupMethodByName: () => [] as readonly SymbolDefinition[] },
} as unknown as SemanticModel;

// Corpus: a mix of unique names, a same-name-across-files bucket with one
// file-local (C `static`) member, a distinct-qualifiedName ambiguous pair,
// and a same-file arity-overload pair.
const CORPUS: readonly SymbolDefinition[] = [
  mkDef({ nodeId: 'def:probe', qualifiedName: 'drv.probe', filePath: 'drv.c', parameterCount: 1 }),
  // `open` lives in two files; util.c's is file-local (static).
  mkDef({
    nodeId: 'def:open#core',
    qualifiedName: 'core.open',
    filePath: 'core.c',
    parameterCount: 2,
    requiredParameterCount: 2,
  }),
  mkDef({
    nodeId: 'def:open#util',
    qualifiedName: 'util.open',
    filePath: 'util.c',
    parameterCount: 3,
    requiredParameterCount: 3,
  }),
  // distinct-qualifiedName collision (genuinely ambiguous).
  mkDef({ nodeId: 'def:init#a', qualifiedName: 'a.init', filePath: 'a.c', parameterCount: 0 }),
  mkDef({ nodeId: 'def:init#b', qualifiedName: 'b.init', filePath: 'b.c', parameterCount: 0 }),
  // same-file arity overloads.
  mkDef({
    nodeId: 'def:read#1',
    qualifiedName: 'io.read',
    filePath: 'io.c',
    parameterCount: 1,
    requiredParameterCount: 1,
  }),
  mkDef({
    nodeId: 'def:read#2',
    qualifiedName: 'io.read',
    filePath: 'io.c',
    parameterCount: 2,
    requiredParameterCount: 2,
  }),
];

const INDEX = buildGlobalCallableIndex(mkScopes(CORPUS));

/** Only util.c's `open` is file-local (mirrors a C `static` helper). */
const isFileLocalDef = (d: SymbolDefinition): boolean => d.nodeId === 'def:open#util';

const callUnmemoized = (
  name: string,
  callerFile: string,
  arity?: number,
): SymbolDefinition | undefined =>
  pickUniqueGlobalCallable(name, EMPTY_MODEL, INDEX, callerFile, isFileLocalDef, arity);

const callMemoized = (
  cache: Map<string, readonly SymbolDefinition[]>,
  name: string,
  callerFile: string,
  arity?: number,
): SymbolDefinition | undefined =>
  pickUniqueGlobalCallable(
    name,
    EMPTY_MODEL,
    INDEX,
    callerFile,
    isFileLocalDef,
    arity,
    undefined,
    undefined,
    undefined,
    undefined,
    cache,
  );

// Every (name, callerFile, arity) the equivalence test exercises. Ordering
// matters: `open` is hit from three different files (cross-file keying) and
// some calls repeat (warm-cache path).
const CALLS: ReadonlyArray<readonly [name: string, file: string, arity: number | undefined]> = [
  ['probe', 'x.c', 1],
  ['open', 'core.c', 2], // util.c's static excluded → core.open
  ['open', 'util.c', 3], // both visible; arity narrows to util.open
  ['open', 'other.c', 2], // util.c's static excluded → core.open
  ['open', 'core.c', 2], // repeat → warm cache
  ['init', 'a.c', 0], // distinct-qn ambiguous → undefined
  ['read', 'io.c', 1], // arity overload → read#1
  ['read', 'io.c', 2], // arity overload → read#2
  ['open', 'util.c', 3], // repeat from a different file → warm cache
  ['missing', 'x.c', 0], // miss → undefined
];

describe('pickUniqueGlobalCallable — scopeDefsCache memo', () => {
  it('resolves a unique simple-name match', () => {
    expect(callUnmemoized('probe', 'x.c', 1)?.nodeId).toBe('def:probe');
  });

  it('excludes a cross-file file-local (static) candidate', () => {
    // From other.c, util.c's static `open` is invisible → only core.open remains.
    expect(callUnmemoized('open', 'other.c', 2)?.nodeId).toBe('def:open#core');
  });

  it('keeps a unique name even when its arity does not match the call', () => {
    // Single surviving candidate wins regardless of arity — the memo caches the
    // full bucket (not an arity-filtered slice), so this contract is preserved.
    expect(callUnmemoized('open', 'core.c', 99)?.nodeId).toBe('def:open#core');
  });

  it('narrows by arity when multiple candidates survive', () => {
    expect(callUnmemoized('read', 'io.c', 1)?.nodeId).toBe('def:read#1');
    expect(callUnmemoized('read', 'io.c', 2)?.nodeId).toBe('def:read#2');
  });

  it('returns undefined for a distinct-qualifiedName collision', () => {
    expect(callUnmemoized('init', 'a.c', 0)).toBeUndefined();
  });

  it('equivalence: memoized result == un-memoized reference for every call', () => {
    const cache = new Map<string, readonly SymbolDefinition[]>();
    for (const [name, file, arity] of CALLS) {
      const ref = callUnmemoized(name, file, arity);
      const memo = callMemoized(cache, name, file, arity);
      expect(memo?.nodeId).toBe(ref?.nodeId);
    }
  });

  it('a warm cache from one file does not poison another file’s result', () => {
    const cache = new Map<string, readonly SymbolDefinition[]>();
    // Prime (open, util.c) — its bucket includes the static util.open.
    expect(callMemoized(cache, 'open', 'util.c', 3)?.nodeId).toBe('def:open#util');
    // A different caller file must NOT reuse util.c's bucket: core.c can't see
    // util.c's static, so it resolves to core.open.
    expect(callMemoized(cache, 'open', 'core.c', 2)?.nodeId).toBe('def:open#core');
    expect(callMemoized(cache, 'open', 'other.c', 2)?.nodeId).toBe('def:open#core');
    // Distinct cache entries, one per (name, file).
    expect(cache.size).toBe(3);
  });

  it('a warm-cache repeat returns the identical def for the same (name, file)', () => {
    const cache = new Map<string, readonly SymbolDefinition[]>();
    const first = callMemoized(cache, 'open', 'core.c', 2);
    const second = callMemoized(cache, 'open', 'core.c', 2);
    expect(second).toBe(first); // same object reference
    expect(cache.size).toBe(1); // one scan, reused
  });

  it('does not cache when a per-caller visibility filter is present', () => {
    // When isCallerVisible is provided, the candidate list depends on the
    // caller's scope, not just its file — the memo must be bypassed even if a
    // cache map is passed, so it stays empty.
    const cache = new Map<string, readonly SymbolDefinition[]>();
    const visibleAll = (): boolean => true;
    const result = pickUniqueGlobalCallable(
      'open',
      EMPTY_MODEL,
      INDEX,
      'other.c',
      isFileLocalDef,
      2,
      visibleAll,
      undefined,
      undefined,
      undefined,
      cache,
    );
    expect(result?.nodeId).toBe('def:open#core');
    expect(cache.size).toBe(0); // gate: visibility filter ⇒ no caching
  });
});
