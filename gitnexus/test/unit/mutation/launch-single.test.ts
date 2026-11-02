/**
 * Locks the oracle's single-test launch rules (U12, KTD15, KTD17): which launches are valid
 * observations, how a launch's outcome is classified, how the test is selected (`<file>:<line>`
 * plus an escaped, anchored `-t`), the launch environment, the wall-clock default, and the
 * benchmark's cost projection. Everything here runs on synthetic launch results; no process is
 * spawned.
 */
import { describe, expect, it } from 'vitest';
import {
  BASE_HOOK_TIMEOUT_MS,
  BASE_TEST_TIMEOUT_MS,
  DEFAULT_WALL_CLOCK_MS,
  buildLaunchEnv,
  classifyLaunch,
  escapeRegExp,
  locationFilter,
  testNamePattern,
  type LaunchEvidence,
  type LaunchTarget,
} from '../../../tools/mutation/oracle/launch-single.js';
import {
  ORACLE_RECORD_SCHEMA_VERSION,
  toOracleError,
  type OracleError,
  type OracleModuleRecord,
  type OracleRunRecord,
  type OracleTestRecord,
} from '../../../tools/mutation/oracle/oracle-classify.js';
import {
  PROBE_SCHEMA_VERSION,
  checkActivation,
  parseOracleProbe,
  type OracleProbe,
  type ProbeHits,
} from '../../../tools/mutation/oracle/probe.js';
import {
  evenlySpaced,
  planLaunches,
  projectOracleCost,
  summarizeTimings,
  type CostProjectionInput,
} from '../../../tools/mutation/bench/oracle-cost.js';
import type { CommandRunMutant } from '../../../tools/mutation/oracle/launch-single.js';

const FILE = 'test/unit/a.test.ts';
const TARGET: LaunchTarget = {
  id: `${FILE}#S > one`,
  file: FILE,
  fullName: 'S > one',
  location: { line: 10, column: 3 },
};
const OTHER_ID = `${FILE}#S > two`;

const assertionError = toOracleError({
  message: 'expected 1 to be 2',
  stack: 'AssertionError: expected 1 to be 2\n    at test/unit/a.test.ts:11:15',
});
const testTimeoutError: OracleError = {
  name: 'Error',
  message:
    'Test timed out in 30000ms.\nIf this is a long-running test, pass a timeout value as the ' +
    'last argument or configure it globally with "testTimeout".',
};

const testRecord = (
  fullName: string,
  line: number,
  overrides: Partial<OracleTestRecord> = {},
): OracleTestRecord => ({
  fullName,
  location: { line, column: 3 },
  state: 'skipped',
  errors: [],
  failedHooks: [],
  retry: 0,
  retryCount: 0,
  ...overrides,
});

/** `S > one` (the target, line 10) and `S > two` (line 20), skipped unless overridden. */
const twoTests = (
  one: Partial<OracleTestRecord> = {},
  two: Partial<OracleTestRecord> = {},
): OracleTestRecord[] => [testRecord('S > one', 10, one), testRecord('S > two', 20, two)];

const moduleRecord = (
  tests: OracleTestRecord[],
  overrides: Partial<OracleModuleRecord> = {},
): OracleModuleRecord => ({
  file: FILE,
  state: tests.some((test) => test.state === 'failed') ? 'failed' : 'passed',
  errors: [],
  failedHooks: [],
  suites: [{ fullName: 'S', errors: [], failedHooks: [], tests: tests.map((_, index) => index) }],
  tests,
  ...overrides,
});

/** A launch record whose Vitest JSON totals and exit code agree with its tests. */
const runRecord = (module: OracleModuleRecord, mutantId: string | null = '7'): OracleRunRecord => {
  const { tests } = module;
  const failed =
    tests.some((test) => test.state === 'failed') ||
    module.errors.length > 0 ||
    module.suites.some((suite) => suite.errors.length > 0);
  return {
    schemaVersion: ORACLE_RECORD_SCHEMA_VERSION,
    kind: mutantId === null ? 'dry-run' : 'mutant',
    mutantId,
    attempt: 1,
    pid: 4242,
    root: '/sandbox',
    configFile: '/sandbox/tools/mutation/vitest.mutation.config.ts',
    vitestVersion: '5.0.5',
    exitCode: failed ? 1 : 0,
    wallClockMs: 1500,
    wrapperError: null,
    run: { reason: failed ? 'failed' : 'passed', unhandledErrors: [], modules: [module] },
    vitestJson: {
      numTotalTests: tests.length,
      numPassedTests: tests.filter((test) => test.state === 'passed').length,
      numFailedTests: tests.filter((test) => test.state === 'failed').length,
    },
    vitestJsonFile: '/out/mutant-7.attempt-1.vitest.json',
  };
};

const NO_HITS: ProbeHits = { loadAndCollection: 0, hook: 0, perTest: [] };

const probe = (
  hits: ProbeHits | null,
  activation: { intended: string | null; installed: string | null } = {
    intended: '7',
    installed: '7',
  },
): OracleProbe => ({
  schemaVersion: PROBE_SCHEMA_VERSION,
  pid: 4243,
  activation: checkActivation({
    ...activation,
    namespaceExists: false,
    namespaceActiveMutant: null,
  }),
  hits,
  complete: hits !== null,
});

const targetHits = (count: number): ProbeHits => ({
  loadAndCollection: 0,
  hook: 0,
  perTest: [{ taskId: 'abc_0_0', fullName: 'S > one', location: { line: 10, column: 3 }, count }],
});

const evidence = (overrides: Partial<LaunchEvidence>): LaunchEvidence => ({
  target: TARGET,
  intendedMutantId: '7',
  wallClockLimitMs: DEFAULT_WALL_CLOCK_MS,
  killedByWallClock: false,
  exitCode: 0,
  signal: null,
  record: null,
  probe: null,
  ...overrides,
});

describe('classifyLaunch: observation validity', () => {
  it('a launch that executes zero tests is invalid', () => {
    const observation = classifyLaunch(
      evidence({ record: runRecord(moduleRecord(twoTests())), probe: probe(NO_HITS) }),
    );
    expect(observation).toMatchObject({ validity: 'invalid', outcome: 'invalid', executed: [] });
    expect(observation.reason).toMatch(/zero tests executed/);
  });

  it('a launch that executes two tests is invalid', () => {
    const record = runRecord(moduleRecord(twoTests({ state: 'passed' }, { state: 'passed' })));
    const observation = classifyLaunch(evidence({ record, probe: probe(NO_HITS), exitCode: 0 }));
    expect(observation).toMatchObject({
      validity: 'invalid',
      outcome: 'invalid',
      executed: [TARGET.id, OTHER_ID],
    });
    expect(observation.reason).toMatch(/2 tests executed/);
  });

  it('a launch that executes one test other than the intended one is invalid', () => {
    const record = runRecord(moduleRecord(twoTests({}, { state: 'passed' })));
    const observation = classifyLaunch(evidence({ record, probe: probe(NO_HITS) }));
    expect(observation).toMatchObject({ validity: 'invalid', executed: [OTHER_ID] });
    expect(observation.reason).toMatch(/is not the intended test/);
  });

  it('a location filter that matched no test is invalid, not a collection kill', () => {
    const module = moduleRecord(twoTests(), {
      state: 'failed',
      errors: [{ name: 'Error', message: `No test found in ${FILE} in line 11` }],
    });
    const observation = classifyLaunch(
      evidence({ record: runRecord(module), probe: probe(null), exitCode: 1 }),
    );
    expect(observation).toMatchObject({ validity: 'invalid', outcome: 'invalid' });
    expect(observation.reason).toMatch(/location filter/);
  });

  it('a passing launch that never hits the mutant is a valid non-covering observation', () => {
    const record = runRecord(moduleRecord(twoTests({ state: 'passed' })));
    const observation = classifyLaunch(evidence({ record, probe: probe(NO_HITS) }));
    expect(observation).toMatchObject({
      validity: 'valid',
      outcome: 'survived',
      executed: [TARGET.id],
      covering: false,
      hits: { loadAndCollection: 0, hook: 0, test: 0, otherTests: 0 },
      killedBy: [],
    });
  });

  it('a passing launch that hits the mutant is a valid covering survivor', () => {
    const record = runRecord(moduleRecord(twoTests({ state: 'passed' })));
    const observation = classifyLaunch(evidence({ record, probe: probe(targetHits(3)) }));
    expect(observation).toMatchObject({
      validity: 'valid',
      outcome: 'survived',
      covering: true,
      hits: { loadAndCollection: 0, hook: 0, test: 3, otherTests: 0 },
    });
  });

  it('a launch whose installed mutant id differs from the intended one is invalid', () => {
    const module = moduleRecord([], {
      state: 'failed',
      suites: [],
      errors: [{ name: 'Error', message: 'oracle setup: installed mutant "8" differs from "7"' }],
    });
    const observation = classifyLaunch(
      evidence({
        record: runRecord(module),
        probe: probe(null, { intended: '7', installed: '8' }),
        exitCode: 1,
      }),
    );
    expect(observation).toMatchObject({
      validity: 'invalid',
      outcome: 'invalid',
      installedMutantId: '8',
    });
    expect(observation.reason).toMatch(/installed mutant "8" differs from the intended "7"/);
  });

  it('a launch whose probe names another intended id than the launcher is invalid', () => {
    const record = runRecord(moduleRecord(twoTests({ state: 'passed' })));
    const observation = classifyLaunch(
      evidence({ record, probe: probe(NO_HITS, { intended: '9', installed: '9' }) }),
    );
    expect(observation).toMatchObject({ validity: 'invalid', outcome: 'invalid' });
  });

  it('a launch without a record is infrastructure', () => {
    const observation = classifyLaunch(evidence({ exitCode: 1, probe: probe(null) }));
    expect(observation).toMatchObject({ validity: 'invalid', outcome: 'infrastructure' });
  });
});

describe('classifyLaunch: outcome classes', () => {
  it('a launch killed by the wall-clock limit is a timeout observation', () => {
    const observation = classifyLaunch(
      evidence({ killedByWallClock: true, exitCode: null, signal: 'SIGKILL', probe: probe(null) }),
    );
    expect(observation).toMatchObject({
      validity: 'valid',
      outcome: 'timeout',
      killedBy: [],
      covering: null,
    });
    expect(observation.reason).toMatch(/wall-clock limit/);
  });

  it('a wall-clock kill before the setup file ran is infrastructure', () => {
    const observation = classifyLaunch(
      evidence({ killedByWallClock: true, exitCode: null, signal: 'SIGKILL', probe: null }),
    );
    expect(observation).toMatchObject({ validity: 'invalid', outcome: 'infrastructure' });
  });

  it('a Vitest testTimeout failure is a timeout observation', () => {
    const record = runRecord(
      moduleRecord(twoTests({ state: 'failed', errors: [testTimeoutError] })),
    );
    const observation = classifyLaunch(
      evidence({ record, probe: probe(targetHits(1)), exitCode: 1 }),
    );
    expect(observation).toMatchObject({ validity: 'valid', outcome: 'timeout', killedBy: [] });
  });

  it('an assertion failure is killed-by-test assertion', () => {
    const record = runRecord(moduleRecord(twoTests({ state: 'failed', errors: [assertionError] })));
    const observation = classifyLaunch(
      evidence({ record, probe: probe(targetHits(2)), exitCode: 1 }),
    );
    expect(observation).toMatchObject({
      validity: 'valid',
      outcome: 'killed-by-test:assertion',
      killedBy: [TARGET.id],
      assertionKilledBy: [TARGET.id],
      covering: true,
    });
  });

  it('a failing beforeAll that skips the intended test is killed outside the test', () => {
    const module = moduleRecord(twoTests(), {
      state: 'failed',
      failedHooks: ['beforeAll'],
      errors: [{ name: 'TypeError', message: 'boom' }],
    });
    const observation = classifyLaunch(
      evidence({ record: runRecord(module), probe: probe({ ...NO_HITS, hook: 1 }), exitCode: 1 }),
    );
    expect(observation).toMatchObject({
      validity: 'valid',
      outcome: 'killed-outside-test:hook',
      killedBy: [TARGET.id],
      assertionKilledBy: [],
      hits: { hook: 1 },
    });
  });

  it('an unmutated baseline launch that passes is a valid survivor without hits', () => {
    const record = runRecord(moduleRecord(twoTests({ state: 'passed' })), null);
    const observation = classifyLaunch(
      evidence({
        intendedMutantId: null,
        record,
        probe: probe(NO_HITS, { intended: null, installed: null }),
      }),
    );
    expect(observation).toMatchObject({
      validity: 'valid',
      outcome: 'survived',
      mutantId: null,
      covering: false,
    });
  });
});

describe('test selection', () => {
  const META_TITLE = 'a|b (c) [d] e? f. g* h+ ^i$ {j} \\k';

  it.each([
    ['every metacharacter', META_TITLE, `${META_TITLE}!`],
    ['a dot', 'S > a.c', 'S > abc'],
    ['a plus', 'S > a+', 'S > aa'],
    ['parentheses', 'S > (x)', 'S > x'],
    ['an alternation', 'S > a|b', 'S > b'],
    ['a character class', 'S > [ab]', 'S > a'],
    ['a quantifier brace', 'S > a{2}', 'S > aa'],
    ['a trailing backslash', 'S > back\\', 'S > back\\\\'],
    ['a prefix of a longer name', 'S > one', 'S > one two'],
  ])('the anchored pattern for %s matches only the exact name', (_label, name, other) => {
    const pattern = new RegExp(testNamePattern(name));
    expect([pattern.test(name), pattern.test(other), pattern.test(`x${name}`)]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('escapes each regex metacharacter with a backslash', () => {
    expect(escapeRegExp('|()[]?.*+^${}\\')).toBe('\\|\\(\\)\\[\\]\\?\\.\\*\\+\\^\\$\\{\\}\\\\');
  });

  it('anchors the escaped full name', () => {
    expect(testNamePattern('S > a.b')).toBe('^S > a\\.b$');
  });

  it('filters by the test file and the line of the test', () => {
    expect(locationFilter(TARGET)).toBe(`${FILE}:10`);
  });

  it('refuses a target without a location', () => {
    expect(() => locationFilter({ ...TARGET, location: null })).toThrow(/has no location/);
  });
});

describe('launch environment and wall clock', () => {
  const base = {
    PATH: '/usr/bin',
    __STRYKER_ACTIVE_MUTANT__: '99',
    STRYKER_MUTATOR_WORKER: '3',
    GITNEXUS_MUTATION_SCOPE: '/old/scope.json',
  };

  it('installs the mutant and the probe settings and drops stale Stryker variables', () => {
    const env = buildLaunchEnv(base, {
      scopeFile: '/run/scope.json',
      probeFile: '/launch/probe.json',
      intendedMutantId: '7',
      installedMutantId: '7',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      __STRYKER_ACTIVE_MUTANT__: '7',
      GITNEXUS_MUTATION_SCOPE: '/run/scope.json',
      GITNEXUS_ORACLE_PROBE_FILE: '/launch/probe.json',
      GITNEXUS_ORACLE_INTENDED_MUTANT: '7',
    });
  });

  it('installs no mutant for a baseline launch', () => {
    const env = buildLaunchEnv(base, {
      scopeFile: '/run/scope.json',
      probeFile: '/launch/probe.json',
      intendedMutantId: null,
      installedMutantId: null,
    });
    expect([env.__STRYKER_ACTIVE_MUTANT__, env.GITNEXUS_ORACLE_INTENDED_MUTANT]).toEqual([
      undefined,
      '',
    ]);
  });

  it('defaults the wall-clock limit above testTimeout plus hookTimeout', () => {
    expect(DEFAULT_WALL_CLOCK_MS).toBeGreaterThan(BASE_TEST_TIMEOUT_MS + BASE_HOOK_TIMEOUT_MS);
  });
});

describe('probe file', () => {
  it('round-trips through JSON', () => {
    const value = probe(targetHits(4));
    expect(parseOracleProbe(JSON.stringify(value))).toEqual(value);
  });

  it('rejects another schema version', () => {
    expect(() => parseOracleProbe(JSON.stringify({ ...probe(null), schemaVersion: 2 }))).toThrow(
      /schemaVersion/,
    );
  });

  it.each([
    ['matching ids', '7', '7', false, true],
    ['differing ids', '7', '8', false, false],
    ['instrumented code before the setup file', '7', '7', true, false],
    ['a baseline launch', null, null, false, true],
  ])('activation check with %s', (_label, intended, installed, namespaceExists, matches) => {
    expect(
      checkActivation({ intended, installed, namespaceExists, namespaceActiveMutant: null })
        .matches,
    ).toBe(matches);
  });
});

describe('oracle cost projection', () => {
  const input: CostProjectionInput = {
    model: {
      vcpus: 4,
      launchWallMs: 4000,
      launchCpuMs: 2000,
      wallClockLimitMs: 180000,
      jobLimitMs: 6 * 3600 * 1000,
      fixedOverheadMs: 600000,
    },
    scopes: [
      {
        name: 'a',
        population: 1000,
        tests: 100,
        sampleSize: 100,
        topUps: 20,
        timeoutMutants: 10,
        hangingTestsPerTimeoutMutant: 5,
        commandRunnerMs: 1200000,
        commandRunnerConcurrency: 4,
      },
      {
        name: 'b',
        population: 50,
        tests: 10,
        sampleSize: 100,
        topUps: 20,
        timeoutMutants: 0,
        hangingTestsPerTimeoutMutant: 0,
        commandRunnerMs: 60000,
        commandRunnerConcurrency: 2,
      },
    ],
  };

  it('is deterministic for a fixed list of timings', () => {
    expect(projectOracleCost(input)).toEqual(projectOracleCost(structuredClone(input)));
  });

  it('projects launches, hangs, command passes and the job-limit verdict', () => {
    const projection = projectOracleCost(input);
    // a: 120 mutants x 100 tests; 120 x (10 / 1000) x 5 = 6 hanging launches.
    // launches: 11994 x 4000 / 4 + 6 x 180000 / 4 = 11994000 + 270000.
    // b: the whole population of 50 mutants x 10 tests = 500 launches; command 60000 x 2 / 2.
    expect(projection.scopes).toEqual([
      {
        name: 'a',
        sampledMutants: 120,
        launches: 12000,
        hangingLaunches: 6,
        launchSerialMs: 11994 * 4000 + 6 * 180000,
        launchMs: 12264000,
        commandMs: 1200000,
        totalMs: 13464000,
      },
      {
        name: 'b',
        sampledMutants: 50,
        launches: 500,
        hangingLaunches: 0,
        launchSerialMs: 2000000,
        launchMs: 500000,
        commandMs: 60000,
        totalMs: 560000,
      },
    ]);
    expect(projection).toMatchObject({
      launches: 12500,
      totalMs: 13464000 + 560000 + 600000,
      cpuBoundFloorMs: (11994 + 500) * 500 + 270000 + 1260000 + 600000,
      fits: true,
      // (6 h - 600000 overhead - 1260000 command - 270000 hanging) x 4 vCPU / 12494 launches.
      breakEvenLaunchMs: Math.round(((21600000 - 600000 - 1260000 - 270000) * 4) / 12494),
    });
  });

  it('reports a projection above the job limit as not fitting', () => {
    const slow = { ...input, model: { ...input.model, launchWallMs: 8000 } };
    expect(projectOracleCost(slow).fits).toBe(false);
  });

  it('summarises timings with nearest-rank percentiles', () => {
    expect(summarizeTimings([5, 1, 4, 2, 3, 10, 6, 7, 9, 8])).toEqual({
      count: 10,
      meanMs: 5.5,
      medianMs: 5,
      p90Ms: 9,
      minMs: 1,
      maxMs: 10,
    });
  });
});

describe('benchmark launch sample', () => {
  const inventory: LaunchTarget[] = ['t0', 't1', 't2', 't3', 't4', 't5'].map((name, index) => ({
    id: `${FILE}#S > ${name}`,
    file: FILE,
    fullName: `S > ${name}`,
    location: { line: 10 + index, column: 3 },
  }));
  const mutant = (
    localId: string,
    oracleClass: CommandRunMutant['oracleClass'],
    killers: string[] = [],
  ): CommandRunMutant => ({
    localId,
    globalId: `g${localId}`,
    oracleClass,
    killedBy: killers,
    assertionKilledBy: killers,
    wallClockMs: 1000,
  });

  it('picks evenly spaced entries in order', () => {
    expect(evenlySpaced([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toEqual([1, 5, 8]);
  });

  it('plans killer, non-killer, survivor and baseline launches deterministically', () => {
    const mutants = [
      mutant('3', 'killed-by-test:assertion', [`${FILE}#S > t2`]),
      mutant('1', 'survived'),
      mutant('2', 'timeout'),
    ];
    const plan = planLaunches(mutants, inventory, { mutants: 1, testsPerMutant: 2, baselines: 1 });
    expect(
      plan.map((launch) => [launch.role, launch.mutantId, launch.target.fullName, launch.expected]),
    ).toEqual([
      ['killer', '3', 'S > t2', 'killed-by-test:assertion'],
      ['non-killer', '3', 'S > t3', 'survived'],
      ['survivor', '1', 'S > t1', 'survived'],
      ['survivor', '1', 'S > t4', 'survived'],
      ['baseline', null, 'S > t3', 'survived'],
    ]);
  });
});
