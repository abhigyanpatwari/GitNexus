import assert from 'node:assert/strict';
/**
 * TypeScript: CALLS edges from inside higher-order-function callbacks.
 *
 * Repro for the bug filed in `gitnexus-bug-report.md`: in a real
 * TS+React monorepo, ~75% of `Function` nodes had no outgoing CALLS
 * edges. The dominant pattern was call expressions nested inside
 * callbacks passed as arguments to other functions:
 *
 *   - `Promise.all(items.map(item => transform(item)))`
 *   - `useQuery({ queryFn: () => fetchData() })`
 *   - `new Promise((resolve) => { reader.readAsDataURL(file); ... })`
 *   - `create<State>()(devtools(persist((set) => ({ ... }))))` (Zustand)
 *
 * Two underlying issues fixed by this PR (see `query.ts` and
 * `finalize-algorithm.ts`):
 *
 *   1. **Caller attribution.** `pass2AttachDeclarations` placed the
 *      `Function` def for arrow-typed declarations on the wrapping
 *      module scope (the `@declaration.function` anchor was the outer
 *      `lexical_declaration`, whose start lies before the inner
 *      arrow's scope). `resolveCallerGraphId` walked up past the empty
 *      arrow scope into the module and grabbed the first Function-like
 *      def in `ownedDefs` — frequently the wrong function entirely.
 *
 *   2. **Cross-file callee discovery.** TypeScript emits BOTH
 *      `@declaration.function` (Function def) AND `@declaration.variable`
 *      (Variable def) for `const fn = () => {}`. With (1) fixed, the
 *      Function-def's anchor moved to the inner arrow, so the Variable
 *      capture began appearing FIRST in `localDefs` (its match starts
 *      earlier in the source). `findExportByName` returned the
 *      Variable, the consumer's import bound to a non-callable, and
 *      `findCallableBindingInScope` rejected it.
 *
 * Each test fixture below isolates one HOF-callback shape from the bug
 * report with both caller and callee defined in-fixture.
 */
import { describe, it, before as beforeAll } from 'node:test';
import { expect } from 'expect';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from '../support/fixture.js';

describe('TypeScript HOF-callback CALLS edges', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-hof-callbacks'), () => {});
    },
    { timeout: 60000 },
  );

  it('control: direct (x) => transform(x) emits direct → transform', () => {
    const calls = getRelationships(result, 'CALLS').filter((c) => c.target === 'transform');
    expect(edgeSet(calls)).toContain('direct → transform');
  });

  it('Promise.all(map(...)) emits fanOut → transform (call inside .map callback)', () => {
    const calls = getRelationships(result, 'CALLS').filter((c) => c.target === 'transform');
    // `fanOut` is the named arrow declaration; the call to `transform`
    // is syntactically nested inside `.map(...)` inside `Promise.all(...)`.
    expect(edgeSet(calls)).toContain('fanOut → transform');
  });

  it('new Promise((resolve) => { ... }) emits wrap → transform (call inside executor)', () => {
    const calls = getRelationships(result, 'CALLS').filter((c) => c.target === 'transform');
    expect(edgeSet(calls)).toContain('wrap → transform');
  });

  it('useQuery({ queryFn: () => fetchData() }) emits queryFn → fetchData (call inside named pair-arrow)', () => {
    // The structurally correct attribution: `fetchData()` is called
    // from inside the named pair-arrow `queryFn: () => fetchData()`.
    // After moving `@declaration.function` to the inner arrow (mirroring
    // the `lexical_declaration` fix), the pair-arrow becomes its own
    // caller anchor — `resolveCallerGraphId`'s walk-up stops at
    // `queryFn`'s scope rather than continuing into `useFeature`'s.
    //
    // Pre-fix this test asserted `useFeature → fetchData` because the
    // pair pattern's `@declaration.function` anchor was on the outer
    // `pair`, sending `queryFn`'s def into `useFeature`'s `ownedDefs`
    // and bypassing `queryFn` as a caller anchor. That attribution
    // was wrong twice over: it crossed a syntactic function boundary
    // (the arrow body), and it depended on the pair-pattern bug to
    // reroute the walk. Edges that capture intent should follow the
    // syntax tree.
    const calls = getRelationships(result, 'CALLS').filter((c) => c.target === 'fetchData');
    expect(edgeSet(calls)).toContain('queryFn → fetchData');
  });

  it('useQuery({ queryFn: () => fetchData() }) emits useFeature → useQuery (direct call in body)', () => {
    const calls = getRelationships(result, 'CALLS').filter((c) => c.target === 'useQuery');
    expect(edgeSet(calls)).toContain('useFeature → useQuery');
  });

  it('Zustand create()(devtools(persist((set) => ({ ... })))) does NOT emit phantom self-loops', () => {
    // The Zustand idiom `export const useStore = create()(devtools(persist((set) => ({ ... }))))`
    // has its module-level call expressions (`create()`, `devtools(...)`,
    // `persist(...)`) in `useStore`'s declaration RHS, syntactically
    // outside any function body. The bug-report case
    // (`grouped-file-uploads-store.tsx`, "0% capture") was driven by
    // these calls being mis-attributed to a sibling Function (the
    // first declared callable in the module's `ownedDefs`), producing
    // bogus self-loops like `Function:create → Function:create`. The
    // fix in `resolveCallerGraphId` excludes Variable defs from the
    // walk-up's class-fallback branch — module-level calls now fall
    // through to the File node like any other module-level reference.
    //
    // What this test asserts: NO phantom self-loops, and NO phantom
    // edges where one local function "calls" a sibling local
    // function via misattribution.
    const calls = getRelationships(result, 'CALLS').filter(
      (c) => c.sourceFilePath === 'src/store.ts' && c.targetFilePath === 'src/store.ts',
    );
    const phantomSelfLoops = calls.filter((c) => c.source === c.target);
    assert.doesNotThrow(
      () => expect(phantomSelfLoops).toEqual([]),
      'phantom self-loop CALLS edges',
    );

    // Specifically the regression: `create → create / devtools / persist`.
    const fromCreate = calls.filter((c) => c.source === 'create');
    assert.doesNotThrow(
      () => expect(fromCreate).toEqual([]),
      'create() must not be a phantom caller',
    );
  });

  it('Zustand module-level calls source from the File node (not a sibling Function)', () => {
    // The positive complement to the anti-self-loop assertion above:
    // module-level calls in `store.ts` (`create()`, `devtools(...)`,
    // `persist(...)`) MUST attribute to the `File` node — that's the
    // entire point of `isCallerAnchorLabel` excluding `Variable` from
    // the caller-walk fallback. If the fix regresses (Variable defs
    // re-enter the fallback, or the walk-up grabs a sibling Function),
    // the source would change away from `File:store.ts`.
    //
    // Earlier formulation iterated `for (c of calls)` and asserted each
    // edge sourced from File. That passed VACUOUSLY when `calls` was
    // empty — any change that silenced ALL CALLS edges from `store.ts`
    // would have slipped through. The structural assertion below is
    // explicit: at least one File-rooted edge must exist (proving the
    // fallback fired), and no edge may source from anything else
    // (proving the fallback fired EXCLUSIVELY, not as one option
    // alongside a buggy sibling-Function attribution).
    const calls = getRelationships(result, 'CALLS').filter(
      (c) => c.sourceFilePath === 'src/store.ts',
    );
    const fromFile = calls.filter((c) => c.sourceLabel === 'File' && c.source === 'store.ts');
    const fromOther = calls.filter((c) => !(c.sourceLabel === 'File' && c.source === 'store.ts'));
    assert.doesNotThrow(
      () => expect(fromOther).toEqual([]),
      'no module-level call may attribute to a non-File source',
    );
    assert.doesNotThrow(
      () => expect(fromFile.length).toBeGreaterThan(0),
      'at least one File-rooted call edge must exist',
    );
  });

  it('transform is reachable from at least 3 of {direct, fanOut, wrap}', () => {
    // Catch-all: pre-fix, only `direct → transform` was captured (or
    // even THAT was missing depending on file order). After fix, all
    // three callers attribute their `transform` call correctly.
    const callers = new Set(
      getRelationships(result, 'CALLS')
        .filter((c) => c.target === 'transform')
        .map((c) => c.source),
    );
    expect(callers).toContain('direct');
    expect(callers).toContain('fanOut');
    expect(callers).toContain('wrap');
  });

  // ─────────────────────────────────────────────────────────────────
  // Multi-pair object literal — regression case the single-pair `bump`
  // fixture in `store.ts` masked. See `multi-action-store.ts` and the
  // anchor-discipline comment in `query.ts` above the four pair-with-
  // arrow patterns. PR #1175 review (medium finding) flagged this.
  // ─────────────────────────────────────────────────────────────────

  it('multi-action store: addItem → doA (calls inside addItem attribute to addItem, not first sibling)', () => {
    // The diagnostic test for the pair-anchor fix. With the broken
    // anchor (on outer `pair`), all three pair-function defs (addItem,
    // removeItem, fetchData) landed in the same `(set) => ({...})`
    // callback's `ownedDefs`, and `resolveCallerGraphId.ownedDefs.find()`
    // returned the FIRST one — `addItem` — for every walk-up. So
    // calls inside `removeItem` and `fetchData` got mis-attributed.
    //
    // After the fix, each pair-arrow gets its def in its OWN arrow
    // scope's `ownedDefs`; the walk-up stops one level earlier and
    // resolves to the correct sibling.
    const calls = getRelationships(result, 'CALLS').filter(
      (c) => c.sourceFilePath === 'src/multi-action-store.ts',
    );
    const fromAddItem = calls.filter((c) => c.source === 'addItem' && c.target === 'doA');
    assert.doesNotThrow(
      () => expect(fromAddItem.length).toBeGreaterThan(0),
      'addItem must call doA',
    );
  });

  it('multi-action store: removeItem → doB (NOT addItem → doB)', () => {
    // The exact regression fingerprint. Pre-fix, `removeItem`'s body
    // would attribute its `doB(item)` call to `addItem` (the first
    // pair-function def in the parent `(set) => ({...})` scope),
    // producing the bogus edge `addItem → doB` and zero outgoing
    // edges from `removeItem`. The negative + positive assertion
    // pinpoints both halves: no mis-attribution AND a real edge.
    const calls = getRelationships(result, 'CALLS').filter(
      (c) => c.sourceFilePath === 'src/multi-action-store.ts' && c.target === 'doB',
    );
    const fromRemoveItem = calls.filter((c) => c.source === 'removeItem');
    const fromAddItem = calls.filter((c) => c.source === 'addItem');
    assert.doesNotThrow(
      () => expect(fromAddItem).toEqual([]),
      'doB must NOT be attributed to addItem (mis-attribution regression)',
    );
    assert.doesNotThrow(
      () => expect(fromRemoveItem.length).toBeGreaterThan(0),
      'removeItem must call doB',
    );
  });

  it('multi-action store: fetchData → doC (third action also attributes correctly)', () => {
    // Three actions in the same object guarantees the `find()`-returns-
    // first defect would mis-attribute fetchData's call. With the fix,
    // each action's body is its own caller anchor.
    const calls = getRelationships(result, 'CALLS').filter(
      (c) => c.sourceFilePath === 'src/multi-action-store.ts' && c.target === 'doC',
    );
    const fromFetch = calls.filter((c) => c.source === 'fetchData');
    const fromAddItem = calls.filter((c) => c.source === 'addItem');
    assert.doesNotThrow(
      () => expect(fromAddItem).toEqual([]),
      'doC must NOT be attributed to addItem',
    );
    assert.doesNotThrow(
      () => expect(fromFetch.length).toBeGreaterThan(0),
      'fetchData must call doC',
    );
  });

  it('multi-action store: each action attributes calls to itself (no cross-sibling leakage)', () => {
    // Whole-of-fixture invariant: the set of (source, target) pairs
    // for the three action calls must be exactly {addItem→doA,
    // removeItem→doB, fetchData→doC}. No sibling leakage allowed.
    const calls = getRelationships(result, 'CALLS').filter(
      (c) =>
        c.sourceFilePath === 'src/multi-action-store.ts' &&
        ['doA', 'doB', 'doC'].includes(c.target as string),
    );
    const pairs = new Set(calls.map((c) => `${c.source} → ${c.target}`));
    expect(pairs).toContain('addItem → doA');
    expect(pairs).toContain('removeItem → doB');
    expect(pairs).toContain('fetchData → doC');
    // No cross-attribution like `addItem → doB`, `addItem → doC`, etc.
    const crossLeaks = [...pairs].filter(
      (p) =>
        p === 'addItem → doB' ||
        p === 'addItem → doC' ||
        p === 'removeItem → doA' ||
        p === 'removeItem → doC' ||
        p === 'fetchData → doA' ||
        p === 'fetchData → doB',
    );
    assert.doesNotThrow(
      () => expect(crossLeaks).toEqual([]),
      'no pair-arrow may attribute calls to a sibling action',
    );
  });
});
