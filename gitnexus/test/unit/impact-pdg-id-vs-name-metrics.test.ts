// U8 — id-vs-name metric scorer for the realized PDG name-collision proof harness.
//
// Asserts the PURE scorer (`scoreIdVsName` / `summarizeIdVsName` /
// `reachedItemKey`) on SYNTHETIC reached-item sets ONLY — no `LocalBackend`, no
// analyze, no DB. The scorer lives in `bench/impact-pdg/name-collision.mjs`,
// imported here directly, so this test is deterministic and stays OUT of the
// flaky full-pipeline lane (mirroring impact-pdg-metric-math.test.ts and
// impact-pdg-blast-radius-metrics.test.ts). The live substrate runs only via
// `node --import tsx bench/impact-pdg/name-collision.mjs`, never in `npm test`.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs pure-JS module, no types; intentional (build-free harness).
import * as M from '../../bench/impact-pdg/name-collision.mjs';

interface ReachedItem {
  readonly id?: string;
  readonly name?: string;
  readonly filePath?: string;
}

interface IdVsNameScore {
  readonly nameProven: number;
  readonly idProven: number;
  readonly fpEliminated: number;
  readonly fnRecovered: number;
  readonly fpEliminatedKeys: readonly string[];
  readonly fnRecoveredKeys: readonly string[];
}

interface IdVsNameSummary {
  readonly n: number;
  readonly totalNameProven: number;
  readonly totalIdProven: number;
  readonly totalFpEliminated: number;
  readonly totalFnRecovered: number;
  readonly functionsWithFpEliminated: number;
  readonly functionsWithFnRecovered: number;
  readonly fpEliminatedRate: number | null;
  readonly fnRecoveredRate: number | null;
}

interface ProvenSets {
  readonly nameProven: readonly ReachedItem[];
  readonly idProven: readonly ReachedItem[];
  readonly discriminating: boolean;
  readonly wholeSymbol: boolean;
  readonly truncated: boolean;
}

const reachedItemKey = M.reachedItemKey as (item: ReachedItem) => string;
const scoreIdVsName = M.scoreIdVsName as (
  nameProvenItems: readonly ReachedItem[],
  idProvenItems: readonly ReachedItem[],
) => IdVsNameScore;
const summarizeIdVsName = M.summarizeIdVsName as (
  cases: ReadonlyArray<Partial<IdVsNameScore> & { discriminatingSlice?: boolean }>,
) => IdVsNameSummary;
const bridgeProvenSets = M.bridgeProvenSets as (
  reachedItems: readonly ReachedItem[],
  sliceCalleeNames: ReadonlySet<string>,
  sliceCalleeIds: ReadonlySet<string>,
) => ProvenSets;

const names = (...ns: string[]): ReadonlySet<string> => new Set(ns);
const ids = (...xs: string[]): ReadonlySet<string> => new Set(xs);

interface KeyedItem {
  readonly id: string;
  readonly name: string;
  readonly filePath: string;
}

// Two distinct overloads sharing the leaf name `serialize` — the collision shape:
// same name, different resolved ids. `id` is required so no narrowing cast is
// needed when these fixtures seed the slice id sets.
const SER1: KeyedItem = {
  id: 'Method:Ser.java:S.serialize#1',
  name: 'serialize',
  filePath: 'Ser.java',
};
const SER2: KeyedItem = {
  id: 'Method:Ser.java:S.serialize#2',
  name: 'serialize',
  filePath: 'Ser.java',
};
// An import-alias callee: proven by id even though its leaf name is absent from
// the slice's `callees` (the false-negative the name match would miss).
const ALIAS: KeyedItem = { id: 'Function:a.ts:realFn', name: 'aliased', filePath: 'a.ts' };
const FOO: KeyedItem = { id: 'Function:a.ts:foo', name: 'foo', filePath: 'a.ts' };

describe('impact-pdg id-vs-name scorer — reachedItemKey()', () => {
  it('keys by resolved id when present', () => {
    expect(reachedItemKey(SER1)).toBe('Method:Ser.java:S.serialize#1');
    expect(reachedItemKey(SER2)).toBe('Method:Ser.java:S.serialize#2');
  });

  it('falls back to name@filePath only when id is absent', () => {
    expect(reachedItemKey({ name: 'dyn', filePath: 'd.ts' })).toBe('dyn@d.ts');
    expect(reachedItemKey({ name: 'dyn' })).toBe('dyn@(unknown)');
    expect(reachedItemKey({})).toBe('(unknown)@(unknown)');
  });
});

describe('impact-pdg id-vs-name scorer — bridgeProvenSets() predicate replica', () => {
  it('discriminating collision: name proves both overloads, id proves only the on-slice one', () => {
    // slice `callees` = {serialize}; slice `calleeIds` = {serialize#2}. The name
    // bridge proves BOTH SER1 and SER2 (leaf `serialize` on slice); the id bridge
    // proves only SER2 (its resolved id is on the slice). SER1 = collision FP.
    const sets = bridgeProvenSets([SER1, SER2], names('serialize'), ids(SER2.id));
    expect(sets).toMatchObject({ discriminating: true, wholeSymbol: false, truncated: false });
    expect(sets.nameProven.map(reachedItemKey).sort()).toEqual([SER1.id, SER2.id].sort());
    expect(sets.idProven.map(reachedItemKey)).toEqual([SER2.id]);
  });

  it('discriminating alias: id proves the alias whose leaf name is absent from the slice callees', () => {
    // slice `callees` = {foo} (NOT `aliased`); slice `calleeIds` = {foo, realFn}.
    // The name bridge proves only FOO; the id bridge also proves ALIAS via its id.
    const sets = bridgeProvenSets([FOO, ALIAS], names('foo'), ids(FOO.id, ALIAS.id));
    expect(sets.nameProven.map(reachedItemKey)).toEqual([FOO.id]);
    expect(sets.idProven.map(reachedItemKey).sort()).toEqual([FOO.id, ALIAS.id].sort());
  });

  it('whole-symbol fallback (empty slice callees): BOTH bridges prove ALL reached items', () => {
    // The bug the earlier draft hit: an empty-callees seed block must NOT read as
    // "name proves nothing" — the bridge whole-symbol-falls-back and proves all.
    const sets = bridgeProvenSets([SER1, SER2], names(), ids(SER2.id));
    expect(sets).toMatchObject({ wholeSymbol: true, discriminating: false });
    expect(sets.nameProven.map(reachedItemKey).sort()).toEqual([SER1.id, SER2.id].sort());
    expect(sets.idProven.map(reachedItemKey).sort()).toEqual([SER1.id, SER2.id].sort());
  });

  it('sentinel fallback (capped block): BOTH bridges prove ALL (callee-unknown)', () => {
    // `*` in the slice names marks an incomplete (capped) callee list → callgraph-equal.
    const sets = bridgeProvenSets([SER1, SER2], names('serialize', '*'), ids(SER2.id));
    expect(sets).toMatchObject({ truncated: true, discriminating: false });
    expect(sets.nameProven.map(reachedItemKey).sort()).toEqual([SER1.id, SER2.id].sort());
    expect(sets.idProven.map(reachedItemKey).sort()).toEqual([SER1.id, SER2.id].sort());
  });

  it('pre-v3 (no calleeIds): id set degrades to the name path ⇒ identical to name set', () => {
    const sets = bridgeProvenSets([SER1, SER2], names('serialize'), ids());
    expect(sets).toMatchObject({ discriminating: false, wholeSymbol: false, truncated: false });
    expect(sets.idProven.map(reachedItemKey).sort()).toEqual(
      sets.nameProven.map(reachedItemKey).sort(),
    );
  });

  it('is deterministic: same inputs ⇒ identical proven sets', () => {
    const a = bridgeProvenSets([SER1, SER2, FOO], names('serialize', 'foo'), ids(SER2.id, FOO.id));
    const b = bridgeProvenSets([SER1, SER2, FOO], names('serialize', 'foo'), ids(SER2.id, FOO.id));
    expect(a.nameProven).toEqual(b.nameProven);
    expect(a.idProven).toEqual(b.idProven);
  });
});

describe('impact-pdg id-vs-name scorer — scoreIdVsName()', () => {
  it('name-set ⊋ id-set (a collision): fpEliminated counts exactly the extra name-only labels', () => {
    // Two same-named overloads are BOTH name-proven (the leaf `serialize` is on the
    // slice), but only SER2 is id-proven (the slice resolves to #2). The id bridge
    // drops SER1 — one realized collision false-positive eliminated.
    const score = scoreIdVsName([SER1, SER2], [SER2]);
    expect(score).toMatchObject({
      nameProven: 2,
      idProven: 1,
      fpEliminated: 1,
      fnRecovered: 0,
      fpEliminatedKeys: ['Method:Ser.java:S.serialize#1'],
      fnRecoveredKeys: [],
    });
  });

  it('id-set has an alias-only member: fnRecovered counts it (import-alias FN recovered)', () => {
    // ALIAS is id-proven but NOT name-proven (its leaf name is absent from the
    // slice `callees`) — the name bridge would miss it; the id bridge recovers it.
    const score = scoreIdVsName([FOO], [FOO, ALIAS]);
    expect(score).toMatchObject({
      nameProven: 1,
      idProven: 2,
      fpEliminated: 0,
      fnRecovered: 1,
      fpEliminatedKeys: [],
      fnRecoveredKeys: ['Function:a.ts:realFn'],
    });
  });

  it('identical sets ⇒ fpEliminated == 0 and fnRecovered == 0', () => {
    const score = scoreIdVsName([SER2, FOO], [FOO, SER2]);
    expect(score).toMatchObject({
      nameProven: 2,
      idProven: 2,
      fpEliminated: 0,
      fnRecovered: 0,
      fpEliminatedKeys: [],
      fnRecoveredKeys: [],
    });
  });

  it('is deterministic: same input ⇒ identical output regardless of item ordering', () => {
    const a = scoreIdVsName([SER1, SER2, FOO], [SER2, ALIAS]);
    const b = scoreIdVsName([FOO, SER2, SER1], [ALIAS, SER2]);
    // Order-independent and stable (keys sorted, no Date/random).
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      fpEliminated: 2, // SER1 + FOO are name-proven but not id-proven
      fnRecovered: 1, // ALIAS is id-proven but not name-proven
      fpEliminatedKeys: ['Function:a.ts:foo', 'Method:Ser.java:S.serialize#1'],
      fnRecoveredKeys: ['Function:a.ts:realFn'],
    });
  });

  it('id-less reached items diff by name@filePath fallback key', () => {
    const dynA: ReachedItem = { name: 'handler', filePath: 'x.ts' };
    const dynB: ReachedItem = { name: 'handler', filePath: 'y.ts' };
    // Same leaf name, different files ⇒ distinct keys ⇒ a real diff.
    const score = scoreIdVsName([dynA, dynB], [dynA]);
    expect(score).toMatchObject({
      nameProven: 2,
      idProven: 1,
      fpEliminated: 1,
      fnRecovered: 0,
      fpEliminatedKeys: ['handler@y.ts'],
      fnRecoveredKeys: [],
    });
  });
});

describe('impact-pdg id-vs-name scorer — summarizeIdVsName()', () => {
  it('aggregates per-function counts and rates over the case set', () => {
    const summary = summarizeIdVsName([
      // function 1: a collision eliminated, no alias recovered
      { nameProven: 2, idProven: 1, fpEliminated: 1, fnRecovered: 0 },
      // function 2: an alias recovered, no collision
      { nameProven: 1, idProven: 2, fpEliminated: 0, fnRecovered: 1 },
      // function 3: name == id (no change)
      { nameProven: 3, idProven: 3, fpEliminated: 0, fnRecovered: 0 },
    ]);
    expect(summary).toMatchObject({
      n: 3,
      totalNameProven: 6,
      totalIdProven: 6,
      totalFpEliminated: 1,
      totalFnRecovered: 1,
      functionsWithFpEliminated: 1,
      functionsWithFnRecovered: 1,
      // round(1/6, 3) — the harness rounds rates to 3 digits (see blast-radius.mjs).
      fpEliminatedRate: 0.167,
      fnRecoveredRate: 0.167,
    });
  });

  it('returns null rates when there are no proven labels (no division by zero)', () => {
    const summary = summarizeIdVsName([]);
    expect(summary).toMatchObject({
      n: 0,
      totalNameProven: 0,
      totalIdProven: 0,
      totalFpEliminated: 0,
      totalFnRecovered: 0,
      functionsWithFpEliminated: 0,
      functionsWithFnRecovered: 0,
      fpEliminatedRate: null,
      fnRecoveredRate: null,
    });
  });
});
