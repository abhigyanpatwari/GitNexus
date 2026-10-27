/**
 * Locks how the vitest5 runner's setup file buckets instrumenter hits (KTD4): load- and
 * collection-time hits stay static, hits inside a test are per-test coverage, and a hit with no
 * current test after collection is a hook hit, attributed to every test of the suite whose hook
 * ran. Per-test coverage keys are then translated from Vitest task ids to Stryker ids (KTD3). The
 * hook bucket is also kept apart, as the per-mutant hook marker (Phase 1 KTD2).
 */
import { describe, expect, it } from 'vitest';
import {
  CoverageRecorder,
  attributeHookHits,
  bucketForHit,
  hookAttributedTests,
  hookCoverage,
  mergeCoverage,
  rekeyCoverage,
  type HitContext,
} from '../../../tools/mutation/runner/coverage-attribution.js';

/** Mirrors the instrumenter's `stryCov_9fa48` with no `currentTestId` set: it always counts into `static`. */
const instrumenterHit = (recorder: CoverageRecorder, ...mutantIds: string[]): void => {
  const coverage = recorder.instrumenterView;
  for (const id of mutantIds) coverage.static[id] = (coverage.static[id] ?? 0) + 1;
};

describe('bucketForHit', () => {
  it.each([
    ['a collection-time hit', { phase: 'collection' }, { kind: 'static' }],
    [
      'a hit inside a test',
      { phase: 'run', testId: 'f_0_1', runningSuiteIds: ['f', 'f_0'] },
      { kind: 'test', testId: 'f_0_1' },
    ],
    [
      'a hit with no current test after collection',
      { phase: 'run', testId: undefined, runningSuiteIds: ['f', 'f_0'] },
      { kind: 'hook', suiteId: 'f_0' },
    ],
  ] satisfies [string, HitContext, ReturnType<typeof bucketForHit>][])(
    'buckets %s',
    (_label, context, bucket) => {
      expect(bucketForHit(context)).toEqual(bucket);
    },
  );

  it('refuses a run-phase hit with no running suite', () => {
    expect(() => bucketForHit({ phase: 'run', testId: undefined, runningSuiteIds: [] })).toThrow(
      /no running suite/,
    );
  });
});

describe('CoverageRecorder with attributeHookHits', () => {
  const testsBySuite = {
    f: ['f_0_0', 'f_0_1', 'f_1_0'],
    f_0: ['f_0_0', 'f_0_1'],
    f_1: ['f_1_0'],
  };

  it('attributes a hook hit after collection to every test of the suite whose hook ran, and keeps collection hits static', () => {
    let context: HitContext = { phase: 'collection' };
    const recorder = new CoverageRecorder(() => context);

    instrumenterHit(recorder, '1', '1');
    context = { phase: 'run', testId: undefined, runningSuiteIds: ['f', 'f_0'] };
    instrumenterHit(recorder, '2');
    context = { phase: 'run', testId: 'f_1_0', runningSuiteIds: ['f', 'f_1'] };
    instrumenterHit(recorder, '3');

    expect(attributeHookHits(recorder.snapshot(), testsBySuite)).toEqual({
      static: { '1': 2 },
      perTest: { f_0_0: { '2': 1 }, f_0_1: { '2': 1 }, f_1_0: { '3': 1 } },
    });
  });

  it('attributes a file-level hook hit to every test of the file', () => {
    const recorder = new CoverageRecorder(() => ({
      phase: 'run',
      testId: undefined,
      runningSuiteIds: ['f'],
    }));

    instrumenterHit(recorder, '7');

    expect(attributeHookHits(recorder.snapshot(), testsBySuite).perTest).toEqual({
      f_0_0: { '7': 1 },
      f_0_1: { '7': 1 },
      f_1_0: { '7': 1 },
    });
  });

  it('adds hook hits to the per-test hits of the same test', () => {
    let context: HitContext = { phase: 'run', testId: 'f_1_0', runningSuiteIds: ['f', 'f_1'] };
    const recorder = new CoverageRecorder(() => context);

    instrumenterHit(recorder, '4');
    context = { phase: 'run', testId: undefined, runningSuiteIds: ['f', 'f_1'] };
    instrumenterHit(recorder, '4');

    expect(attributeHookHits(recorder.snapshot(), testsBySuite).perTest).toEqual({
      f_1_0: { '4': 2 },
    });
  });

  it('refuses a hook hit for a suite it does not know', () => {
    const recorder = new CoverageRecorder(() => ({
      phase: 'run',
      testId: undefined,
      runningSuiteIds: ['unknown'],
    }));
    instrumenterHit(recorder, '1');

    expect(() => attributeHookHits(recorder.snapshot(), testsBySuite)).toThrow(/unknown/);
  });
});

describe('hookCoverage and hookAttributedTests (the hook marker, KTD2)', () => {
  const testsBySuite = {
    f: ['f_0_0', 'f_0_1', 'f_1_0'],
    f_0: ['f_0_0', 'f_0_1'],
    f_1: ['f_1_0'],
  };

  /** Mutant 2 is hit only in suite f_0's beforeAll, mutant 3 only inside test f_1_0. */
  const recorded = (): CoverageRecorder => {
    let context: HitContext = { phase: 'collection' };
    const recorder = new CoverageRecorder(() => context);
    instrumenterHit(recorder, '1');
    context = { phase: 'run', testId: undefined, runningSuiteIds: ['f', 'f_0'] };
    instrumenterHit(recorder, '2');
    context = { phase: 'run', testId: 'f_1_0', runningSuiteIds: ['f', 'f_1'] };
    instrumenterHit(recorder, '3');
    context = { phase: 'run', testId: undefined, runningSuiteIds: ['f', 'f_1'] };
    instrumenterHit(recorder, '3');
    return recorder;
  };

  it('keeps the hook bucket apart: only hook hits, attributed to every test of the suite', () => {
    expect(hookCoverage(recorded().snapshot(), testsBySuite)).toEqual({
      f_0_0: { '2': 1 },
      f_0_1: { '2': 1 },
      f_1_0: { '3': 1 },
    });
  });

  it('lists, per mutant, every test that a suite hook attributed it to', () => {
    expect(hookAttributedTests(hookCoverage(recorded().snapshot(), testsBySuite))).toEqual({
      '2': ['f_0_0', 'f_0_1'],
      '3': ['f_1_0'],
    });
  });

  it('leaves the attributed per-test coverage unchanged', () => {
    expect(attributeHookHits(recorded().snapshot(), testsBySuite)).toEqual({
      static: { '1': 1 },
      perTest: { f_0_0: { '2': 1 }, f_0_1: { '2': 1 }, f_1_0: { '3': 2 } },
    });
  });

  it('refuses a hook-bucket hit for a suite it does not know', () => {
    const recorder = new CoverageRecorder(() => ({
      phase: 'run',
      testId: undefined,
      runningSuiteIds: ['unknown'],
    }));
    instrumenterHit(recorder, '1');

    expect(() => hookCoverage(recorder.snapshot(), testsBySuite)).toThrow(/unknown/);
  });
});

describe('rekeyCoverage and mergeCoverage', () => {
  it('translates per-test keys from task ids to Stryker ids and drops tests outside the map', () => {
    expect(
      rekeyCoverage(
        { static: { '1': 1 }, perTest: { f_0: { '2': 1 }, f_skipped: { '3': 1 } } },
        new Map([['f_0', 'test/a.test.ts#A > b']]),
      ),
    ).toEqual({ static: { '1': 1 }, perTest: { 'test/a.test.ts#A > b': { '2': 1 } } });
  });

  it('sums the coverage of several test files', () => {
    const into = { static: { '1': 1 }, perTest: { a: { '2': 1 } } };

    mergeCoverage(into, { static: { '1': 2, '5': 1 }, perTest: { a: { '2': 3 }, b: { '6': 1 } } });

    expect(into).toEqual({
      static: { '1': 3, '5': 1 },
      perTest: { a: { '2': 4 }, b: { '6': 1 } },
    });
  });
});
