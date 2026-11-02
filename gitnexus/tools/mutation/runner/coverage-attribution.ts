/**
 * Coverage buckets for the vitest5 runner's dry run (KTD4).
 *
 * Stryker's instrumenter counts a hit into `mutantCoverage.perTest[currentTestId]` when
 * `currentTestId` is set, and into `mutantCoverage.static` otherwise. The runner's setup file never
 * sets `currentTestId`; it installs {@link CoverageRecorder.instrumenterView}, whose `static` is a
 * getter that picks the bucket for the moment of the hit:
 *
 * - before the setup file's file-level hook runs (module load and collection): `static`;
 * - while a test runs (`TestRunner.getCurrentTest()`, which covers `beforeEach`/`afterEach`): that
 *   test's per-test bucket;
 * - after collection with no current test: a hook hit of the deepest running suite, later
 *   attributed by {@link attributeHookHits} to every test of that suite.
 *
 * Buckets are keyed by Vitest task id here; the main process translates them to Stryker ids
 * ({@link rekeyCoverage}). This module is imported by the worker setup file, so it imports types
 * only.
 *
 * The hook bucket is also kept apart ({@link hookCoverage}): the dry run records, per mutant, the
 * tests a suite hook attributed it to ({@link hookAttributedTests}), the hook marker that caps a
 * Phase 1 pair at weak (Phase 1 KTD2, KTD9).
 */
import type { CoverageData, MutantCoverage } from '@stryker-mutator/api/core';

export type HitContext =
  | { phase: 'collection' }
  | { phase: 'run'; testId: string | undefined; runningSuiteIds: readonly string[] };

export type HitBucket =
  | { kind: 'static' }
  | { kind: 'test'; testId: string }
  | { kind: 'hook'; suiteId: string };

export interface RawCoverage {
  static: CoverageData;
  /** Keyed by Vitest task id. */
  perTest: Record<string, CoverageData>;
  /** Hook hits, keyed by the task id of the suite (or file) whose hook ran. */
  hooks: Record<string, CoverageData>;
}

export function bucketForHit(context: HitContext): HitBucket {
  if (context.phase === 'collection') return { kind: 'static' };
  if (context.testId !== undefined) return { kind: 'test', testId: context.testId };
  const suiteId = context.runningSuiteIds[context.runningSuiteIds.length - 1];
  if (suiteId === undefined) {
    throw new Error('coverage: a hit after collection had no current test and no running suite');
  }
  return { kind: 'hook', suiteId };
}

const bucketIn = (buckets: Record<string, CoverageData>, key: string): CoverageData =>
  (buckets[key] ??= {});

export class CoverageRecorder {
  readonly #static: CoverageData = {};
  readonly #perTest: Record<string, CoverageData> = {};
  readonly #hooks: Record<string, CoverageData> = {};
  /** Assign to the instrumenter namespace's `mutantCoverage` before any instrumented code loads. */
  readonly instrumenterView: MutantCoverage;

  constructor(context: () => HitContext) {
    const select = (): CoverageData => {
      const bucket = bucketForHit(context());
      if (bucket.kind === 'static') return this.#static;
      if (bucket.kind === 'test') return bucketIn(this.#perTest, bucket.testId);
      return bucketIn(this.#hooks, bucket.suiteId);
    };
    const view = { perTest: {} } as MutantCoverage;
    Object.defineProperty(view, 'static', { enumerable: true, get: select });
    this.instrumenterView = view;
  }

  snapshot(): RawCoverage {
    return {
      static: { ...this.#static },
      perTest: Object.fromEntries(
        Object.entries(this.#perTest).map(([id, data]) => [id, { ...data }]),
      ),
      hooks: Object.fromEntries(Object.entries(this.#hooks).map(([id, data]) => [id, { ...data }])),
    };
  }
}

const addInto = (into: CoverageData, from: CoverageData): void => {
  for (const [mutantId, count] of Object.entries(from)) {
    into[mutantId] = (into[mutantId] ?? 0) + count;
  }
};

/**
 * The hook bucket alone, attributed: every hook bucket added to each test below that suite, keyed
 * by test task id. `testsBySuite` maps a suite (or file) task id to the task ids of all tests
 * below it.
 */
export function hookCoverage(
  raw: RawCoverage,
  testsBySuite: Readonly<Record<string, readonly string[]>>,
): Record<string, CoverageData> {
  const perTest: Record<string, CoverageData> = {};
  for (const [suiteId, data] of Object.entries(raw.hooks)) {
    const tests = testsBySuite[suiteId];
    if (tests === undefined) throw new Error(`coverage: hook hits for unknown suite ${suiteId}`);
    for (const testId of tests) addInto(bucketIn(perTest, testId), data);
  }
  return perTest;
}

/**
 * Adds every hook bucket to the per-test coverage of each test below that suite
 * ({@link hookCoverage}).
 */
export function attributeHookHits(
  raw: RawCoverage,
  testsBySuite: Readonly<Record<string, readonly string[]>>,
): MutantCoverage {
  const perTest: Record<string, CoverageData> = {};
  for (const [testId, data] of Object.entries(raw.perTest))
    addInto(bucketIn(perTest, testId), data);
  for (const [testId, data] of Object.entries(hookCoverage(raw, testsBySuite))) {
    addInto(bucketIn(perTest, testId), data);
  }
  return { static: { ...raw.static }, perTest };
}

/** Per mutant id, the sorted keys of the per-test buckets that hold it (the hook marker). */
export function hookAttributedTests(
  perTest: Readonly<Record<string, CoverageData>>,
): Record<string, string[]> {
  const byMutant: Record<string, string[]> = {};
  for (const testId of Object.keys(perTest).sort()) {
    for (const mutantId of Object.keys(perTest[testId])) (byMutant[mutantId] ??= []).push(testId);
  }
  return byMutant;
}

/** Translates per-test keys through `idByTaskId`; tests outside the map (skipped) are dropped. */
export function rekeyCoverage(
  coverage: MutantCoverage,
  idByTaskId: ReadonlyMap<string, string>,
): MutantCoverage {
  const perTest: Record<string, CoverageData> = {};
  for (const [taskId, data] of Object.entries(coverage.perTest)) {
    const id = idByTaskId.get(taskId);
    if (id !== undefined) addInto(bucketIn(perTest, id), data);
  }
  return { static: { ...coverage.static }, perTest };
}

export function mergeCoverage(into: MutantCoverage, from: MutantCoverage): void {
  addInto(into.static, from.static);
  for (const [id, data] of Object.entries(from.perTest)) addInto(bucketIn(into.perTest, id), data);
}
