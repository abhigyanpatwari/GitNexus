/**
 * Locks Layer 3 shard planning (U7, KTD7, KTD14, KTD17, R11): the whole-file mutate scope of a
 * group (production files a test executed or statically imports, with excluded files marked), the
 * cost estimate with its isolation term, deterministic bin-packing that never splits a group,
 * the group-over-budget rule, the start-only-if-fits deadline check, and how the merge stage reads
 * a pair's schedule: never run, not scheduled, a foreign run manifest or a failed group run are
 * Inconclusive.
 */
import { describe, expect, it } from 'vitest';
import {
  SHARD_DEADLINE_MS,
  buildShardPlan,
  estimateGroupCost,
  excludedFiles,
  fitsBeforeDeadline,
  groupScope,
  packShards,
  resolvePairSchedules,
  shardsNeeded,
  type CostModel,
  type GroupEstimate,
  type GroupOutcome,
  type PairRef,
  type StaticClosure,
  type TestProvenance,
} from '../../../tools/scenario-map/mutation/plan-shards.js';

const MINUTE = 60_000;
const FIVE: GroupEstimate[] = [
  { id: 'ga', estimateMs: 10 },
  { id: 'gb', estimateMs: 9 },
  { id: 'gc', estimateMs: 5 },
  { id: 'gd', estimateMs: 3 },
  { id: 'ge', estimateMs: 1 },
];
const DIGEST = 'manifest-digest';
const A = 'test/unit/a.test.ts#A > one';
const B = 'test/unit/a.test.ts#A > two';
const C = 'test/unit/c.test.ts#C > three';

const outcome = (overrides: Partial<GroupOutcome>): GroupOutcome => ({
  group: 'ga',
  shard: 0,
  manifestDigest: DIGEST,
  status: 'complete',
  reason: null,
  detail: null,
  tests: [A, B],
  ...overrides,
});

const pair = (group: string): PairRef => ({ a: A, b: B, group });

describe('packShards', () => {
  it('packs five groups into two shards, the same way on every call and in any input order', () => {
    const first = packShards(FIVE, 2, 100);
    expect(first).toEqual({
      shards: [
        { index: 0, groups: ['ga', 'gd', 'ge'], estimateMs: 14 },
        { index: 1, groups: ['gb', 'gc'], estimateMs: 14 },
      ],
      overBudget: [],
    });
    expect(packShards(FIVE, 2, 100)).toEqual(first);
    expect(packShards([...FIVE].reverse(), 2, 100)).toEqual(first);
  });

  it('puts every group in exactly one shard', () => {
    const assigned = packShards(FIVE, 2, 100).shards.flatMap((shard) => shard.groups);
    expect(assigned.sort()).toEqual(['ga', 'gb', 'gc', 'gd', 'ge']);
  });

  it('runs no group whose estimate exceeds one shard budget', () => {
    expect(packShards(FIVE, 2, 9)).toEqual({
      shards: [
        { index: 0, groups: ['gb'], estimateMs: 9 },
        { index: 1, groups: ['gc', 'gd', 'ge'], estimateMs: 9 },
      ],
      overBudget: ['ga'],
    });
  });

  it.each([
    [0, 'zero shards'],
    [1.5, 'a fractional shard count'],
  ])('rejects %s (%s)', (shards) => {
    expect(() => packShards(FIVE, shards, 100)).toThrow(/shard count/);
  });

  it('rejects a group listed twice', () => {
    expect(() => packShards([...FIVE, { id: 'ga', estimateMs: 1 }], 2, 100)).toThrow(/twice/);
  });
});

describe('shardsNeeded', () => {
  it.each([
    [28, 1],
    [14, 2],
    [10, 3],
  ])('needs the fewest shards whose loads fit a budget of %i: %i', (budget, expected) => {
    expect(shardsNeeded(FIVE, budget, 8)).toBe(expected);
  });

  it('caps at the maximum when no packing fits', () => {
    expect(shardsNeeded(FIVE, 10, 2)).toBe(2);
  });
});

describe('fitsBeforeDeadline', () => {
  it.each([
    [280 * MINUTE, 30 * MINUTE, false],
    [280 * MINUTE, 20 * MINUTE, true],
    [0, 300 * MINUTE, true],
    [0, 301 * MINUTE, false],
  ])('after %i ms a group estimated at %i ms starts: %s', (elapsed, estimate, expected) => {
    expect(fitsBeforeDeadline(estimate, elapsed)).toBe(expected);
  });

  it('defaults to the 300-minute deadline', () => {
    expect(SHARD_DEADLINE_MS).toBe(300 * MINUTE);
  });
});

describe('estimateGroupCost', () => {
  const model: CostModel = {
    perRunMs: 1000,
    perByteTestMs: 2,
    mutantsPerByte: 0.5,
    freshProcessMs: 10,
  };

  it('adds the fixed run cost, mutated bytes times tests and the isolation term', () => {
    // 1000 + 100 * 3 * 2 + 2 pairs * (100 * 0.5) mutants * 3 runs * 10
    expect(estimateGroupCost({ tests: 3, pairs: 2, mutatedBytes: 100 }, model)).toBe(4600);
  });

  it('grows with every candidate pair through the isolation term', () => {
    const one = estimateGroupCost({ tests: 3, pairs: 1, mutatedBytes: 100 }, model);
    const two = estimateGroupCost({ tests: 3, pairs: 2, mutatedBytes: 100 }, model);
    expect(two - one).toBe(1500);
  });
});

describe('groupScope', () => {
  const provenance = new Map<string, TestProvenance>([
    [
      A,
      {
        known: true,
        executedFiles: [
          'gitnexus/test/unit/a.test.ts',
          'gitnexus/src/a.ts',
          'gitnexus/tools/mutation/shared/cli.ts',
          'node_modules/zod/index.js',
        ],
      },
    ],
    [B, { known: true, executedFiles: ['gitnexus/test/unit/a.test.ts', 'gitnexus/src/b.ts'] }],
  ]);
  const closures = new Map<string, StaticClosure>([
    [
      'test/unit/a.test.ts',
      {
        closure: [
          'gitnexus/test/unit/a.test.ts',
          'gitnexus/test/helpers/h.ts',
          'gitnexus/src/a.ts',
          'gitnexus-shared/src/c.ts',
          'gitnexus/src/data.json',
        ],
        complete: true,
      },
    ],
  ]);
  const scope = groupScope({ group: { id: 'g1', tests: [B, A], pairs: 1 }, provenance, closures });

  it('mutates every production file a test executed or statically imports, whole', () => {
    expect(scope.mutate).toEqual([
      'gitnexus-shared/src/c.ts',
      'gitnexus/src/a.ts',
      'gitnexus/src/b.ts',
    ]);
    expect([scope.tests, scope.testFiles]).toEqual([[A, B], ['test/unit/a.test.ts']]);
  });

  it('marks a test that executed a repo file it neither tests with nor mutates', () => {
    expect(scope.excluded).toEqual([
      { test: A, mark: 'excluded-file', files: ['gitnexus/tools/mutation/shared/cli.ts'] },
    ]);
  });

  it('records tests without known provenance and files without a complete closure', () => {
    const partial = groupScope({
      group: { id: 'g2', tests: [A, C], pairs: 1 },
      provenance: new Map([[A, { known: false, executedFiles: ['gitnexus/src/a.ts'] }]]),
      closures: new Map([['test/unit/a.test.ts', { closure: [], complete: false }]]),
    });
    expect([partial.provenanceUnknown, partial.closureIncomplete]).toEqual([
      [A, C],
      ['test/unit/a.test.ts', 'test/unit/c.test.ts'],
    ]);
    expect(partial.mutate).toEqual(['gitnexus/src/a.ts']);
  });

  it("treats a fixture project's src/ modules as production through its extra root", () => {
    const fixture = 'gitnexus/test/fixtures/mutation-scenario-map';
    const id = 'test/fixtures/mutation-scenario-map/x.case.ts#x > y';
    const controls = groupScope({
      group: { id: 'g3', tests: [id], pairs: 0 },
      provenance: new Map([
        [id, { known: true, executedFiles: [`${fixture}/x.case.ts`, `${fixture}/src/x.ts`] }],
      ]),
      closures: new Map(),
      extraRoots: [fixture],
    });
    expect([controls.mutate, controls.excluded]).toEqual([[`${fixture}/src/x.ts`], []]);
  });
});

describe('excludedFiles', () => {
  it('returns an executed src file the mutate list lacks', () => {
    const executed = ['gitnexus/src/a.ts', 'gitnexus/src/b.ts', 'gitnexus/test/unit/a.test.ts'];
    expect(excludedFiles(executed, new Set(['gitnexus/src/b.ts']))).toEqual(['gitnexus/src/a.ts']);
  });

  it.each([
    ['gitnexus/test/helpers/h.ts'],
    ['gitnexus/test/fixtures/mutation-x/a.case.ts'],
    ['gitnexus/src/a.spec.ts'],
    ['node_modules/vitest/index.js'],
    ['outside:/usr/lib/node.js'],
    ['gitnexus-shared/src/c.ts'],
  ])('never excludes %s', (file) => {
    expect(excludedFiles([file], new Set())).toEqual([]);
  });
});

describe('buildShardPlan', () => {
  it('estimates each group from its mutated bytes and packs the groups', () => {
    const plan = buildShardPlan({
      scopes: [
        groupScope({
          group: { id: 'g2', tests: [A, B], pairs: 1 },
          provenance: new Map([[A, { known: true, executedFiles: ['gitnexus/src/a.ts'] }]]),
          closures: new Map(),
        }),
        groupScope({
          group: { id: 'g1', tests: [C], pairs: 0 },
          provenance: new Map([[C, { known: true, executedFiles: ['gitnexus/src/big.ts'] }]]),
          closures: new Map(),
        }),
      ],
      sizeOf: (file) => (file === 'gitnexus/src/big.ts' ? 1_000_000 : 100),
      shards: 2,
      budgetMs: 10_000,
      costModel: { perRunMs: 1000, perByteTestMs: 1, mutantsPerByte: 0, freshProcessMs: 0 },
    });
    expect(plan.groups.map((group) => [group.id, group.mutatedBytes, group.estimateMs])).toEqual([
      ['g1', 1_000_000, 1_001_000],
      ['g2', 100, 1200],
    ]);
    expect([plan.overBudget, plan.shards.map((shard) => shard.groups)]).toEqual([
      ['g1'],
      [['g2'], []],
    ]);
  });
});

describe('resolvePairSchedules', () => {
  const plan = { overBudget: ['gz'] };

  it('marks a pair of an over-budget group group-over-budget', () => {
    const [schedule] = resolvePairSchedules({
      plan,
      manifestDigest: DIGEST,
      pairs: [pair('gz')],
      outcomes: [],
    });
    expect([schedule.status, schedule.reason]).toEqual(['inconclusive', 'group-over-budget']);
  });

  it('marks every pair of a group no shard reported not-scheduled', () => {
    const schedules = resolvePairSchedules({
      plan,
      manifestDigest: DIGEST,
      pairs: [pair('gb'), { a: A, b: C, group: 'gb' }],
      outcomes: [outcome({ group: 'ga' })],
    });
    expect(schedules.map((entry) => [entry.status, entry.reason, entry.shard])).toEqual([
      ['inconclusive', 'not-scheduled', null],
      ['inconclusive', 'not-scheduled', null],
    ]);
  });

  it('marks a pair whose tests did not both run in the group run not-scheduled', () => {
    const [schedule] = resolvePairSchedules({
      plan,
      manifestDigest: DIGEST,
      pairs: [{ a: A, b: C, group: 'ga' }],
      outcomes: [outcome({})],
    });
    expect(schedule.reason).toBe('not-scheduled');
  });

  it.each([
    ['a result verified against another run manifest', outcome({ manifestDigest: 'other' })],
    [
      'a shard whose prepared copy differs from the run manifest',
      outcome({ status: 'inconclusive', reason: 'manifest-mismatch', detail: 'gitnexus/src/a.ts' }),
    ],
  ])('marks the pairs of %s manifest-mismatch', (_title, result) => {
    const [schedule] = resolvePairSchedules({
      plan,
      manifestDigest: DIGEST,
      pairs: [pair('ga')],
      outcomes: [result],
    });
    expect([schedule.status, schedule.reason]).toEqual(['inconclusive', 'manifest-mismatch']);
  });

  it('passes a failed group run reason on to its pairs', () => {
    const [schedule] = resolvePairSchedules({
      plan,
      manifestDigest: DIGEST,
      pairs: [pair('ga')],
      outcomes: [outcome({ status: 'inconclusive', reason: 'baseline-unstable', detail: 'ids' })],
    });
    expect([schedule.reason, schedule.detail, schedule.shard]).toEqual([
      'baseline-unstable',
      'ids',
      0,
    ]);
  });

  it('marks a pair of a complete group run evaluated', () => {
    const [schedule] = resolvePairSchedules({
      plan,
      manifestDigest: DIGEST,
      pairs: [pair('ga')],
      outcomes: [outcome({ shard: 3 })],
    });
    expect([schedule.status, schedule.reason, schedule.shard]).toEqual(['evaluated', null, 3]);
  });

  it('keeps a group Inconclusive when one of two results for it is', () => {
    const [schedule] = resolvePairSchedules({
      plan,
      manifestDigest: DIGEST,
      pairs: [pair('ga')],
      outcomes: [
        outcome({}),
        outcome({ shard: 1, status: 'inconclusive', reason: 'stryker-failed' }),
      ],
    });
    expect([schedule.status, schedule.reason]).toEqual(['inconclusive', 'stryker-failed']);
  });
});
