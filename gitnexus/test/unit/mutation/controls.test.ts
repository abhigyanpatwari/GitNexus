/**
 * Locks gate 4's rules (U8, KTD17, KTD19): a planted control must be killed with an assertion by
 * exactly its expected killers and pass under every other test, a control or test missing from
 * the run means "re-select", the two determinism profiles must agree on every mutant's outcome
 * class and kill sets, and selection is deterministic and covers the required tags (relocated
 * `gitnexus-shared` code, an `as const` table). Every input is synthetic.
 */
import { describe, expect, it } from 'vitest';
import {
  EXIT_FAILURES,
  EXIT_PASS,
  EXIT_RESELECT,
  EXIT_USAGE,
  PLANTED_KIND,
  asConstRanges,
  checkControls,
  checkRequirements,
  compareDeterminism,
  formatPlanted,
  gateExitCode,
  mutantTags,
  parsePlanted,
  runBounded,
  selectScopeControls,
  type ControlFailure,
  type ControlTag,
  type DeterminismDifference,
  type GateInput,
  type PlantedControl,
  type PlantedControls,
  type PlantedScope,
  type RunMutantView,
  type RunView,
} from '../../../tools/mutation/controls/run-controls.js';

const FILE = 'test/unit/a.test.ts';
const K = `${FILE}#S > kills`;
const K2 = `${FILE}#S > also kills (#2415)`;
const N = `${FILE}#S > runs and passes`;
const U = `${FILE}#S > unrelated`;
const TESTS = [K, K2, N, U];
const SRC = 'gitnexus/src/a.ts';
const M = `${SRC}@0123456789abcdef:3:1-3:9:StringLiteral:aaaaaaaaaaaaaaaa`;
const M2 = `${SRC}@0123456789abcdef:5:1-5:9:ConditionalExpression:bbbbbbbbbbbbbbbb`;

const mutant = (overrides: Partial<RunMutantView> = {}): RunMutantView => ({
  globalId: M,
  file: SRC,
  location: { start: { line: 3, column: 1 }, end: { line: 3, column: 9 } },
  mutatorName: 'StringLiteral',
  static: false,
  status: 'Killed',
  outcome: 'killed-by-test:assertion',
  killedBy: [K],
  assertionKilledBy: [K],
  ran: [
    { id: K, outcome: 'killed-by-test:assertion' },
    { id: N, outcome: 'survived' },
  ],
  attempts: 1,
  flags: [],
  ...overrides,
});

const run = (mutants: RunMutantView[], overrides: Partial<RunView> = {}): RunView => ({
  profile: 'A',
  tests: TESTS.map((id) => ({ id, skipped: false })),
  mutants,
  ...overrides,
});

const control = (overrides: Partial<PlantedControl> = {}): PlantedControl => ({
  id: M,
  tags: [],
  static: false,
  expectedKillers: [K],
  expectedNonKillers: { ran: [N], notRun: [U] },
  ...overrides,
});

const scope = (controls: PlantedControl[] = [control()]): PlantedScope => ({
  name: 's',
  scope: { testFiles: [FILE], mutate: [SRC] },
  mutants: 2,
  tests: TESTS.length,
  controls,
});

const noTags = (): ControlTag[] => [];

const kinds = (failures: readonly ControlFailure[]): [string, string | null][] =>
  failures.map((failure) => [failure.kind, failure.test]);

const differences = (
  diffs: readonly DeterminismDifference[],
): [string, string | null, string | null][] =>
  diffs.map((diff) => [diff.kind, diff.mutant, diff.test]);

describe('checkControls', () => {
  it('passes a control killed by exactly its expected killers whose covering non-killer passed', () => {
    expect(checkControls(scope(), run([mutant()]), noTags)).toEqual([]);
  });

  it.each([
    [
      'a listed covering non-killer',
      mutant({
        killedBy: [K, N],
        assertionKilledBy: [K, N],
        ran: [
          { id: K, outcome: 'killed-by-test:assertion' },
          { id: N, outcome: 'killed-by-test:assertion' },
        ],
      }),
      N,
    ],
    [
      'an unlisted test, with a runtime error',
      mutant({
        killedBy: [K, K2],
        ran: [
          { id: K, outcome: 'killed-by-test:assertion' },
          { id: K2, outcome: 'killed-by-test:runtime' },
          { id: N, outcome: 'survived' },
        ],
      }),
      K2,
    ],
  ])('fails a control killed by a test outside its expected killers: %s', (_name, killed, test) => {
    expect(kinds(checkControls(scope(), run([killed]), noTags))).toEqual([
      ['unexpected-killer', test],
    ]);
  });

  it.each([
    [
      'the mutant survived',
      mutant({
        status: 'Survived',
        outcome: 'survived',
        killedBy: [],
        assertionKilledBy: [],
        ran: [
          { id: K, outcome: 'survived' },
          { id: N, outcome: 'survived' },
        ],
      }),
    ],
    [
      'the killer failed with a runtime error, not an assertion',
      mutant({
        outcome: 'killed-by-test:runtime',
        assertionKilledBy: [],
        ran: [
          { id: K, outcome: 'killed-by-test:runtime' },
          { id: N, outcome: 'survived' },
        ],
      }),
    ],
  ])('fails a control that survives its expected killer: %s', (_name, survived) => {
    expect(kinds(checkControls(scope(), run([survived]), noTags))).toEqual([['killer-missed', K]]);
  });

  it('reports a control missing from a run of a changed source file as stale (re-select)', () => {
    const changed = `${SRC}@fedcba9876543210:3:1-3:9:StringLiteral:aaaaaaaaaaaaaaaa`;
    const failures = checkControls(scope(), run([mutant({ globalId: changed })]), noTags);
    expect(kinds(failures)).toEqual([['stale-mutant', null]]);
    expect(gateExitCode({ staleRuns: 0, problems: 0, failures, differences: 0 })).toBe(
      EXIT_RESELECT,
    );
  });

  it('fails a control missing from a run whose source file is unchanged (not generated)', () => {
    const failures = checkControls(scope(), run([mutant({ globalId: M2 })]), noTags);
    expect(kinds(failures)).toEqual([['mutant-missing', null]]);
    expect(gateExitCode({ staleRuns: 0, problems: 0, failures, differences: 0 })).toBe(
      EXIT_FAILURES,
    );
  });

  it('reports a planted test missing from the run as stale and checks nothing else of it', () => {
    const renamed = `${FILE}#S > renamed`;
    const stale = control({ expectedKillers: [renamed] });
    expect(kinds(checkControls(scope([stale]), run([mutant()]), noTags))).toEqual([
      ['stale-test', renamed],
    ]);
  });

  it('fails a listed covering non-killer that did not run with the mutant active', () => {
    const notRun = mutant({ ran: [{ id: K, outcome: 'killed-by-test:assertion' }] });
    expect(kinds(checkControls(scope(), run([notRun]), noTags))).toEqual([
      ['non-killer-not-run', N],
    ]);
  });

  it('fails a control whose recorded tags differ from the facts of its source', () => {
    const tagged = control({ tags: ['as-const', 'relocated-shared'] });
    const facts = (): ControlTag[] => ['relocated-shared'];
    expect(kinds(checkControls(scope([tagged]), run([mutant()]), facts))).toEqual([['tags', null]]);
  });

  it('names the scope, profile and control of every failure', () => {
    const [failure] = checkControls(scope(), run([], { profile: 'B' }), noTags);
    expect(failure).toMatchObject({ scope: 's', profile: 'B', control: M });
  });
});

describe('compareDeterminism', () => {
  it('passes two runs with identical outcome classes and kill sets', () => {
    expect(compareDeterminism(run([mutant()]), run([mutant()], { profile: 'B' }))).toEqual([]);
  });

  it('names the mutant and the test when the kill sets differ in one test', () => {
    const b = run([mutant({ killedBy: [K, K2], assertionKilledBy: [K, K2] })], { profile: 'B' });
    expect(differences(compareDeterminism(run([mutant()]), b))).toEqual([
      ['killed-by', M, K2],
      ['assertion-killed-by', M, K2],
    ]);
  });

  it('fails when the outcome class of a mutant differs between the profiles', () => {
    const b = run(
      [mutant({ status: 'Timeout', outcome: 'timeout', killedBy: [], assertionKilledBy: [] })],
      { profile: 'B' },
    );
    expect(differences(compareDeterminism(run([mutant()]), b))).toEqual([
      ['outcome', M, null],
      ['status', M, null],
      ['killed-by', M, K],
      ['assertion-killed-by', M, K],
    ]);
  });

  it('fails when a mutant is in one profile only', () => {
    const b = run([mutant()], { profile: 'B' });
    expect(differences(compareDeterminism(run([mutant(), mutant({ globalId: M2 })]), b))).toEqual([
      ['mutant-inventory', M2, null],
    ]);
  });

  it('fails when a test is in one profile only', () => {
    const b = run([mutant()], {
      profile: 'B',
      tests: [K, K2, N].map((id) => ({ id, skipped: false })),
    });
    expect(differences(compareDeterminism(run([mutant()]), b))).toEqual([
      ['test-inventory', null, U],
    ]);
  });
});

const TABLE_SOURCE = [
  "export const NAME = 'Code';",
  'export const TABLES = [',
  "  'File',",
  "  'Folder',",
  '] as const;',
  'const n = 1 as number;',
  '',
].join('\n');

describe('asConstRanges and mutantTags', () => {
  it('finds the operand of each `as const` assertion and ignores other `as` assertions', () => {
    const ranges = asConstRanges(TABLE_SOURCE);
    expect(ranges.map((range) => TABLE_SOURCE.slice(range.start, range.end))).toEqual([
      "[\n  'File',\n  'Folder',\n]",
    ]);
  });

  it.each([
    [
      'inside an `as const` table of relocated shared code',
      'gitnexus-shared/src/lbug/t.ts',
      { start: { line: 3, column: 3 }, end: { line: 3, column: 9 } },
      ['relocated-shared', 'as-const'],
    ],
    [
      'outside the table, in relocated shared code',
      'gitnexus-shared/src/lbug/t.ts',
      { start: { line: 1, column: 21 }, end: { line: 1, column: 27 } },
      ['relocated-shared'],
    ],
    [
      'inside a plain `as` assertion under gitnexus/src',
      SRC,
      { start: { line: 6, column: 11 }, end: { line: 6, column: 12 } },
      [],
    ],
  ])('tags a mutant %s', (_name, file, location, tags) => {
    expect(mutantTags({ file, location }, TABLE_SOURCE)).toEqual(tags);
  });
});

describe('selectScopeControls', () => {
  const MT = `${SRC}@0123456789abcdef:7:1-7:9:ArrayDeclaration:cccccccccccccccc`;
  const MS = `${SRC}@0123456789abcdef:9:1-9:9:BooleanLiteral:dddddddddddddddd`;
  const MD = `${SRC}@0123456789abcdef:11:1-11:9:EqualityOperator:eeeeeeeeeeeeeeee`;
  const MR = `${SRC}@0123456789abcdef:13:1-13:9:BlockStatement:ffffffffffffffff`;
  const MW = `${SRC}@0123456789abcdef:15:1-15:9:MethodExpression:1111111111111111`;
  const tagsOf = (entry: { file: string; location: unknown }): ControlTag[] =>
    entry.location === TAGGED ? ['as-const'] : [];
  const TAGGED = { start: { line: 7, column: 1 }, end: { line: 7, column: 9 } };
  const mutants = (variant: 'A' | 'B'): RunMutantView[] => [
    mutant(),
    mutant({
      globalId: MT,
      location: TAGGED,
      mutatorName: 'ArrayDeclaration',
      static: true,
      killedBy: [K, K2],
      assertionKilledBy: [K, K2],
      ran: [
        { id: K, outcome: 'killed-by-test:assertion' },
        { id: K2, outcome: 'killed-by-test:assertion' },
        { id: N, outcome: 'survived' },
        { id: U, outcome: 'survived' },
      ],
    }),
    mutant({
      globalId: MS,
      status: 'Survived',
      outcome: 'survived',
      killedBy: [],
      assertionKilledBy: [],
    }),
    mutant({
      globalId: MD,
      mutatorName: 'EqualityOperator',
      killedBy: [variant === 'A' ? K : K2],
      assertionKilledBy: [variant === 'A' ? K : K2],
    }),
    mutant({
      globalId: MR,
      mutatorName: 'BlockStatement',
      outcome: 'killed-by-test:runtime',
      assertionKilledBy: [],
    }),
    mutant({
      globalId: MW,
      mutatorName: 'MethodExpression',
      killedBy: [K2],
      assertionKilledBy: [K2],
      ran: [{ id: K2, outcome: 'killed-by-test:assertion' }],
    }),
  ];
  const runs = [run(mutants('A')), run(mutants('B'), { profile: 'B' })];
  const options = { seed: 'seed-1', perScope: 3, maxKillers: 3, maxNonKillers: 3 };

  it('picks the required tag first, then stable assertion kills with small killer sets', () => {
    const selection = selectScopeControls(runs, options, tagsOf);
    expect(selection.candidates).toBe(3);
    // Sorted by global id: line 15 sorts before lines 3 and 7.
    expect(selection.controls).toEqual([
      {
        id: MW,
        tags: [],
        static: false,
        expectedKillers: [K2],
        expectedNonKillers: { ran: [], notRun: [K, N, U] },
      },
      {
        id: M,
        tags: [],
        static: false,
        expectedKillers: [K],
        expectedNonKillers: { ran: [N], notRun: [K2, U] },
      },
      {
        id: MT,
        tags: ['as-const'],
        static: true,
        expectedKillers: [K2, K],
        expectedNonKillers: { ran: [N, U], notRun: [] },
      },
    ]);
  });

  it('selects the same controls for the same seed whatever the order of the mutants', () => {
    const reversed = runs.map((entry) => ({ ...entry, mutants: [...entry.mutants].reverse() }));
    expect(selectScopeControls(reversed, options, tagsOf)).toEqual(
      selectScopeControls(runs, options, tagsOf),
    );
  });

  it('caps the listed non-killers at maxNonKillers', () => {
    const selection = selectScopeControls(runs, { ...options, maxNonKillers: 1 }, tagsOf);
    expect(selection.controls.map((entry) => entry.expectedNonKillers.notRun.length)).toEqual([
      1, 1, 0,
    ]);
  });
});

const planted = (scopes: PlantedScope[]): PlantedControls => ({
  schemaVersion: 1,
  kind: PLANTED_KIND,
  description: 'synthetic',
  reselect: 'npm run test:mutation:controls -- --select --work <dir>',
  profiles: [
    { name: 'A', concurrency: 1, maxTestRunnerReuse: 0 },
    { name: 'B', concurrency: 3, maxTestRunnerReuse: 1 },
  ],
  timeoutMS: 10000,
  selection: { seed: 's', perScope: 3, maxKillers: 3, maxNonKillers: 3, selectedFrom: ['A', 'B'] },
  scopes,
});

describe('planted file', () => {
  it('parses what it formats', () => {
    const file = planted([scope([control({ tags: ['relocated-shared', 'as-const'] })])]);
    expect(parsePlanted(formatPlanted(file))).toEqual(file);
  });

  it.each([
    ['another kind', { kind: 'gitnexus-mutation-oracle-manifest' }, /kind/],
    ['another schema version', { schemaVersion: 2 }, /schemaVersion/],
    ['an unknown tag', { scopes: [scope([control({ tags: [] })])].map(withTag('nope')) }, /tag/],
  ])('rejects a file with %s', (_name, overrides, message) => {
    const text = JSON.stringify({ ...planted([scope()]), ...overrides });
    expect(() => parsePlanted(text)).toThrow(message);
  });

  it.each([
    ['no tagged control', [control()], ['as-const', 'relocated-shared']],
    ['a relocated shared control only', [control({ tags: ['relocated-shared'] })], ['as-const']],
    ['both tags on one control', [control({ tags: ['relocated-shared', 'as-const'] })], []],
  ])('lists the required tags no control carries: %s', (_name, controls, missing) => {
    expect(checkRequirements(planted([scope(controls)]))).toEqual(missing);
  });
});

function withTag(tag: string): (entry: PlantedScope) => unknown {
  return (entry) => ({
    ...entry,
    controls: entry.controls.map((item) => ({ ...item, tags: [tag] })),
  });
}

describe('gateExitCode', () => {
  const failure = (kind: ControlFailure['kind']): ControlFailure => ({
    scope: 's',
    profile: 'A',
    control: M,
    kind,
    test: null,
    detail: '',
  });
  const clean: GateInput = { staleRuns: 0, problems: 0, failures: [], differences: 0 };

  it.each([
    ['a clean gate', clean, EXIT_PASS],
    ['a stale run, before everything else', { ...clean, staleRuns: 1, differences: 1 }, EXIT_USAGE],
    ['a determinism difference', { ...clean, differences: 1 }, EXIT_FAILURES],
    ['a run problem', { ...clean, problems: 1 }, EXIT_FAILURES],
    [
      'a failed control, before a stale one',
      { ...clean, failures: [failure('stale-mutant'), failure('killer-missed')] },
      EXIT_FAILURES,
    ],
    ['only stale controls', { ...clean, failures: [failure('stale-test')] }, EXIT_RESELECT],
  ])('%s', (_name, input, expected) => {
    expect(gateExitCode(input)).toBe(expected);
  });
});

describe('runBounded', () => {
  interface Item {
    name: string;
    cost: number;
  }
  /** Each item takes one macrotask; returns who was running when each item started. */
  const schedule = async (
    items: Item[],
    budget: number,
  ): Promise<{ starts: [string, string[]][]; peak: number }> => {
    const active = new Map<string, number>();
    const starts: [string, string[]][] = [];
    let peak = 0;
    await runBounded(items, budget, async (item) => {
      starts.push([item.name, [...active.keys()].sort()]);
      active.set(item.name, item.cost);
      peak = Math.max(
        peak,
        [...active.values()].reduce((sum, cost) => sum + cost, 0),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      active.delete(item.name);
    });
    return { starts, peak };
  };

  it('starts items while the running costs fit the budget', async () => {
    const items = [
      { name: 'a1', cost: 1 },
      { name: 'a2', cost: 1 },
      { name: 'a3', cost: 1 },
      { name: 'b1', cost: 3 },
      { name: 'b2', cost: 3 },
    ];
    expect(await schedule(items, 3)).toEqual({
      starts: [
        ['a1', []],
        ['a2', ['a1']],
        ['a3', ['a1', 'a2']],
        ['b1', []],
        ['b2', []],
      ],
      peak: 3,
    });
  });

  it('runs an item costlier than the budget alone, after the items that fit', async () => {
    const items = [
      { name: 'x', cost: 1 },
      { name: 'big', cost: 5 },
      { name: 'y', cost: 1 },
    ];
    expect((await schedule(items, 3)).starts).toEqual([
      ['x', []],
      ['y', ['x']],
      ['big', []],
    ]);
  });
});
