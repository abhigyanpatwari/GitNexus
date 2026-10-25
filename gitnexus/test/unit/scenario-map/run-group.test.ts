/**
 * Locks Layer 3 group and shard runs (U7, R7, KTD8, KTD14, KTD17) without spawning Vitest or
 * Stryker: every runner is a fake. The run manifest's prepared-copy hashes and their check, the
 * KTD8 config check before any mutant runs, the two baselines (failing or unstable identities make
 * the group Inconclusive and emit no observations), Stryker's dry run against the baselines, the
 * group result written as soon as the group finishes (schema 2: the run universe and the explicit
 * observations as its rows; a schema 1 file is rejected), and a shard that refuses a foreign
 * prepared copy or a group that does not fit before its deadline.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  NormalisedMutant,
  RunResults,
} from '../../../tools/mutation/driver/normalise-results.js';
import type { RunScopeOptions } from '../../../tools/mutation/driver/run-scope.js';
import {
  DEFAULT_IGNORED_DIRS,
  buildStrykerConfig,
} from '../../../tools/mutation/driver/stryker-config.js';
import type { RunManifest } from '../../../tools/mutation/runner/run-manifest.js';
import {
  type GroupScope,
  type ShardPlan,
} from '../../../tools/scenario-map/mutation/plan-shards.js';
import {
  assertMutationConfig,
  buildRunManifest,
  checkBaselines,
  readGroupObservations,
  runGroup,
  runShard,
  sandboxIgnoredDirs,
  verifyPreparedCopy,
  type BaselineSummary,
  type GroupRunDeps,
  type ScenarioRunManifest,
  type ShardRunDeps,
} from '../../../tools/scenario-map/mutation/run-group.js';
import type {
  VitestRunOptions,
  VitestRunResult,
} from '../../../tools/scenario-map/mutation/vitest-run.js';

const T1 = 'test/unit/a.test.ts#A > one';
const T2 = 'test/unit/a.test.ts#A > two';
const M1 = 'gitnexus/src/a.ts@0123456789abcdef:1:1-1:5:ArithmeticOperator:aaaaaaaaaaaaaaaa';
const MINUTE = 60_000;

const temps: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'scenario-map-u7-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A prepared tree: `gitnexus/` sources plus the two tool versions under node_modules. */
function writeTree(root: string, files: Record<string, string>, vitest = '5.0.5'): void {
  const all: Record<string, string> = {
    'gitnexus/node_modules/vitest/package.json': JSON.stringify({ version: vitest }),
    'gitnexus/node_modules/@stryker-mutator/core/package.json': JSON.stringify({
      version: '10.0.0',
    }),
    ...files,
  };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
}

const SOURCES = {
  'gitnexus/src/a.ts': 'export const a = 1;\n',
  'gitnexus/test/unit/a.test.ts': 'it("one", () => {});\n',
};

function manifestFor(files: Record<string, string> = SOURCES): ScenarioRunManifest {
  const root = tempDir();
  writeTree(root, files);
  return buildRunManifest({
    preparedRoot: root,
    mode: { kind: 'normal' },
    tests: [T1, T2],
  });
}

const scope: GroupScope = {
  id: 'g1',
  tests: [T1, T2],
  testFiles: ['test/unit/a.test.ts'],
  pairs: 1,
  mutate: ['gitnexus/src/a.ts'],
  excluded: [],
  closureIncomplete: [],
  provenanceUnknown: [],
};

const passing = (overrides: Partial<VitestRunResult> = {}): VitestRunResult => ({
  tests: [T1, T2].map((id, index) => ({
    id,
    taskId: `t_${index}`,
    fullName: id.split('#')[1],
    location: { line: index + 1, column: 3 },
    state: 'passed',
    outcome: 'survived',
    message: null,
  })),
  status: 'survived',
  outcome: 'survived',
  reason: null,
  outsideTest: [],
  problems: [],
  unhandledErrors: [],
  wallClockMs: 5,
  ...overrides,
});

const mutant: NormalisedMutant = {
  globalId: M1,
  localId: '1',
  file: 'gitnexus/src/a.ts',
  location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } },
  mutatorName: 'ArithmeticOperator',
  replacement: '-',
  static: false,
  status: 'Killed',
  statusReason: null,
  testsCompleted: 2,
  outcome: 'killed-by-test:assertion',
  outcomeSource: 'sidecar',
  killedBy: [T1, T2],
  coveredBy: [T1, T2],
  assertionKilledBy: [T1, T2],
  sidecar: null,
  attempts: [
    {
      file: '/s/1.json',
      worker: '0',
      attempt: 0,
      pid: 1,
      writtenAtMs: 1,
      status: 'killed',
      outcome: 'killed-by-test:assertion',
      nrOfTests: 2,
    },
  ],
  perTest: [
    { testId: T1, outcome: 'killed-by-test:assertion', attempt: 0 },
    { testId: T2, outcome: 'killed-by-test:assertion', attempt: 0 },
  ],
  attemptsDisagree: false,
  hookAttributedTests: [],
  flags: [],
};

function strykerResults(outDir: string): RunResults {
  return {
    schemaVersion: 2,
    variant: 'vitest5',
    scope: { testFiles: ['test/unit/a.test.ts'], mutate: ['gitnexus/src/a.ts'], testIds: [T1, T2] },
    paths: {
      outDir,
      preparedRoot: path.join(outDir, 'prepared'),
      packageDir: path.join(outDir, 'prepared', 'gitnexus'),
      configFile: path.join(outDir, 'stryker.config.json'),
      reportFile: path.join(outDir, 'mutation.json'),
      logFile: path.join(outDir, 'stryker.log'),
      runDir: path.join(outDir, 'run'),
      sidecarDir: path.join(outDir, 'sidecars'),
      sandboxDirs: [],
    },
    stryker: { exitCode: 0, wallClockMs: 10 },
    spanMap: { checked: 1, failures: [] },
    manifest: null,
    dryRun: {
      file: '/s/dry.json',
      status: 'survived',
      outcome: 'survived',
      reason: null,
      nrOfTests: 2,
      attempts: 1,
    },
    mutants: [mutant],
    tests: [],
    flags: [],
    summary: {
      mutants: 1,
      byStatus: {
        Killed: 1,
        Survived: 0,
        NoCoverage: 0,
        CompileError: 0,
        RuntimeError: 0,
        Timeout: 0,
        Ignored: 0,
        Pending: 0,
      },
      byOutcome: {},
      mutantsWithSidecar: 1,
      mutantsWithOutcome: 1,
      testsWithKills: 2,
      testsWithAssertionKills: 2,
      zeroTestRuns: 0,
      flags: 0,
    },
  };
}

const dryRunManifest = (location = 3): RunManifest => ({
  schemaVersion: 1,
  project: 'mutation',
  vitestVersion: '5.0.5',
  files: [
    {
      file: 'test/unit/a.test.ts',
      tests: [
        {
          id: T1,
          taskId: 't_0',
          fullName: 'A > one',
          location: { line: 1, column: 3 },
          notOracleValidated: false,
        },
        {
          id: T2,
          taskId: 't_1',
          fullName: 'A > two',
          location: { line: 2, column: location },
          notOracleValidated: false,
        },
      ],
      skipped: [],
    },
  ],
});

interface Fakes {
  deps: GroupRunDeps;
  vitestCalls: VitestRunOptions[];
  scopeCalls: RunScopeOptions[];
}

function fakes(
  overrides: {
    baselines?: VitestRunResult[];
    config?: (config: Record<string, unknown>) => Record<string, unknown>;
    dryRun?: RunManifest;
  } = {},
): Fakes {
  const vitestCalls: VitestRunOptions[] = [];
  const scopeCalls: RunScopeOptions[] = [];
  const baselines = overrides.baselines ?? [passing(), passing()];
  const edit = overrides.config ?? ((config) => config);
  let clock = 0;
  const deps: GroupRunDeps = {
    runVitest: async (options) => {
      vitestCalls.push(options);
      return baselines[vitestCalls.length - 1] ?? passing();
    },
    runScope: async (options) => {
      scopeCalls.push(options);
      return { results: strykerResults(options.outDir), exitCode: 0 };
    },
    buildConfig: (input) => edit({ ...buildStrykerConfig(input) }),
    readJson: () =>
      buildStrykerConfig({
        variant: 'vitest5',
        outDir: '/tmp/x',
        mutate: [{ file: 'gitnexus/src/a.ts', range: null }],
        concurrency: 1,
        maxTestRunnerReuse: 0,
        timeoutMS: 1000,
      }),
    readDryRunManifest: () => overrides.dryRun ?? dryRunManifest(),
    now: () => (clock += 1000),
  };
  return { deps, vitestCalls, scopeCalls };
}

const groupOptions = (workDir: string, manifest: ScenarioRunManifest) => ({
  repoRoot: '/repo',
  workDir,
  shard: 0,
  manifest,
  packageDir: path.join(workDir, 'prepared', 'gitnexus'),
  scope,
});

describe('assertMutationConfig', () => {
  const generated = (): Record<string, unknown> => ({
    ...buildStrykerConfig({
      variant: 'vitest5',
      outDir: '/tmp/x',
      mutate: [{ file: 'gitnexus/src/a.ts', range: null }],
      concurrency: 1,
      maxTestRunnerReuse: 0,
      timeoutMS: 1000,
      testIds: [T1],
    }),
  });

  it('accepts the scope driver generated config', () => {
    expect(() => assertMutationConfig(generated())).not.toThrow();
  });

  it.each([
    ['disableBail', { disableBail: false }, /disableBail/],
    ['perTest coverage', { coverageAnalysis: 'off' }, /perTest/],
    ['static mutants', { ignoreStatic: true }, /static/],
  ])('rejects a config without %s', (_name, change, message) => {
    expect(() => assertMutationConfig({ ...generated(), ...change })).toThrow(message);
  });

  it('rejects a value that is not a config object', () => {
    expect(() => assertMutationConfig(null)).toThrow(/object/);
  });
});

describe('checkBaselines', () => {
  const summary = (overrides: Partial<BaselineSummary> = {}): BaselineSummary => ({
    wallClockMs: 1,
    outcome: 'survived',
    identities: [`${T1}@1:3`, `${T2}@2:3`],
    failing: [],
    problems: [],
    ...overrides,
  });

  it('accepts two passing baselines with identical identities', () => {
    expect(checkBaselines([summary(), summary()])).toBeNull();
  });

  it('calls baselines with different identity sets unstable', () => {
    const moved = summary({ identities: [`${T1}@1:3`, `${T2}@9:3`] });
    expect(checkBaselines([summary(), moved])?.reason).toBe('baseline-unstable');
  });

  it('calls a baseline with a failing test failed', () => {
    const failing = summary({
      outcome: 'killed-by-test:assertion',
      failing: [{ test: T2, outcome: 'killed-by-test:assertion', message: 'expected 1' }],
    });
    expect(checkBaselines([summary(), failing])).toEqual({
      reason: 'baseline-failed',
      detail: `baseline 2: ${T2} killed-by-test:assertion: expected 1`,
    });
  });
});

describe('run manifest', () => {
  it('verifies a prepared copy with the same content', () => {
    const copy = tempDir();
    writeTree(copy, SOURCES);
    expect(verifyPreparedCopy(manifestFor(), copy)).toEqual({ ok: true, mismatches: [] });
  });

  it('names the files and versions a different prepared copy changes', () => {
    const copy = tempDir();
    writeTree(
      copy,
      { ...SOURCES, 'gitnexus/src/a.ts': 'export const a = 2;\n', 'gitnexus/src/new.ts': '' },
      '5.0.6',
    );
    expect(verifyPreparedCopy(manifestFor(), copy)).toEqual({
      ok: false,
      mismatches: [
        'changed: gitnexus/src/a.ts',
        'extra: gitnexus/src/new.ts',
        'vitest 5.0.5 -> 5.0.6',
      ],
    });
  });

  it('lists the eligible tests and hashes neither node_modules nor files outside gitnexus/', () => {
    const manifest = manifestFor();
    expect(manifest.tests).toEqual([
      { id: T1, file: 'test/unit/a.test.ts' },
      { id: T2, file: 'test/unit/a.test.ts' },
    ]);
    expect(Object.keys(manifest.files)).toEqual([
      'gitnexus/src/a.ts',
      'gitnexus/test/unit/a.test.ts',
    ]);
  });
});

describe('sandboxIgnoredDirs', () => {
  it('keeps the default ignored directories in normal mode', () => {
    expect(sandboxIgnoredDirs({ kind: 'normal' }, [])).toEqual([...DEFAULT_IGNORED_DIRS]);
  });

  it('keeps the controls fixture in the sandbox and no other fixture', () => {
    const dirs = sandboxIgnoredDirs(
      { kind: 'controls', fixtureRoot: 'gitnexus/test/fixtures/mutation-scenario-map' },
      ['mutation-scenario-map', 'mutation-conformance', 'sample.json'],
    );
    expect(dirs.filter((dir) => dir.startsWith('test/fixtures'))).toEqual([
      'test/fixtures/mutation-conformance',
      'test/fixtures/sample.json',
    ]);
  });
});

describe('runGroup', () => {
  it('runs two baselines, then Stryker, and writes the observations at once', async () => {
    const workDir = tempDir();
    const { deps, vitestCalls, scopeCalls } = fakes();
    const result = await runGroup(groupOptions(workDir, manifestFor()), deps);
    expect([result.status, result.reason, vitestCalls.length, scopeCalls.length]).toEqual([
      'complete',
      null,
      2,
      1,
    ]);
    expect(result.observations.map((entry) => [entry.test, entry.outcome])).toEqual([
      [T1, 'killed-by-test:assertion'],
      [T2, 'killed-by-test:assertion'],
    ]);
    expect([
      result.runUniverse?.tests,
      result.runUniverse?.mutants.map((entry) => entry.id),
    ]).toEqual([[T1, T2], [M1]]);
    expect(readGroupObservations(path.join(workDir, 'observations', 'g1.json'))).toEqual(result);
  });

  it('writes the observations as rows of the run universe and rejects a schema 1 file', async () => {
    const workDir = tempDir();
    const { deps } = fakes();
    const result = await runGroup(groupOptions(workDir, manifestFor()), deps);
    const file = path.join(workDir, 'observations', 'g1.json');
    const written = JSON.parse(readFileSync(file, 'utf8')) as { observations: unknown[] };
    writeFileSync(file, JSON.stringify({ ...result, schemaVersion: 1 }));
    expect(written.observations).toEqual([
      [0, 0, 0, 'killed-by-test:assertion', 'row', true, false, []],
      [1, 0, 0, 'killed-by-test:assertion', 'row', true, false, []],
    ]);
    expect(() => readGroupObservations(file)).toThrow(/has schema 1, not 2: .*re-run its shard/);
  });

  it('passes testFiles, testIds and the whole-file mutate list to the scope driver', async () => {
    const workDir = tempDir();
    const { deps, scopeCalls } = fakes();
    await runGroup(groupOptions(workDir, manifestFor()), deps);
    expect(JSON.parse(readFileSync(scopeCalls[0].scopeFile, 'utf8'))).toEqual({
      testFiles: ['test/unit/a.test.ts'],
      mutate: ['gitnexus/src/a.ts'],
      testIds: [T1, T2],
    });
  });

  it('fails a group whose generated config lacks disableBail before any mutant runs', async () => {
    const workDir = tempDir();
    const { deps, scopeCalls } = fakes({ config: (config) => ({ ...config, disableBail: false }) });
    const result = await runGroup(groupOptions(workDir, manifestFor()), deps);
    expect([result.status, result.reason, scopeCalls.length]).toEqual([
      'inconclusive',
      'config-invalid',
      0,
    ]);
  });

  it('makes a group with unstable baseline identities Inconclusive without observations', async () => {
    const workDir = tempDir();
    const moved = passing();
    moved.tests[1] = { ...moved.tests[1], location: { line: 9, column: 3 } };
    const { deps, scopeCalls } = fakes({ baselines: [passing(), moved] });
    const result = await runGroup(groupOptions(workDir, manifestFor()), deps);
    expect([result.status, result.reason, result.observations, scopeCalls.length]).toEqual([
      'inconclusive',
      'baseline-unstable',
      [],
      0,
    ]);
    expect(readGroupObservations(path.join(workDir, 'observations', 'g1.json')).reason).toBe(
      'baseline-unstable',
    );
  });

  it('makes a group whose second baseline has a failing test Inconclusive', async () => {
    const workDir = tempDir();
    const failing = passing({ status: 'killed', outcome: 'killed-by-test:assertion' });
    failing.tests[0] = {
      ...failing.tests[0],
      state: 'failed',
      outcome: 'killed-by-test:assertion',
    };
    const { deps } = fakes({ baselines: [passing(), failing] });
    const result = await runGroup(groupOptions(workDir, manifestFor()), deps);
    expect([result.status, result.reason]).toEqual(['inconclusive', 'baseline-failed']);
  });

  it("makes a group whose Stryker dry run moved a test's identity Inconclusive", async () => {
    const workDir = tempDir();
    const { deps } = fakes({ dryRun: dryRunManifest(7) });
    const result = await runGroup(groupOptions(workDir, manifestFor()), deps);
    expect([result.status, result.reason, result.observations]).toEqual([
      'inconclusive',
      'dry-run-unstable',
      [],
    ]);
  });

  it('refuses a group test that the run manifest does not list', async () => {
    const workDir = tempDir();
    const { deps, vitestCalls } = fakes();
    const manifest = { ...manifestFor(), tests: [{ id: T1, file: 'test/unit/a.test.ts' }] };
    const result = await runGroup(groupOptions(workDir, manifest), deps);
    expect([result.reason, vitestCalls.length]).toEqual(['manifest-mismatch', 0]);
  });
});

describe('runShard', () => {
  const plan = (estimateMs: number): ShardPlan => ({
    schemaVersion: 1,
    budgetMs: 300 * MINUTE,
    costModel: { perRunMs: 0, perByteTestMs: 0, mutantsPerByte: 0, freshProcessMs: 0 },
    groups: [{ ...scope, mutatedBytes: 20, estimateMs }],
    shards: [{ index: 0, groups: ['g1'], estimateMs }],
    overBudget: [],
  });

  function shardDeps(
    files: Record<string, string>,
    clock: () => number,
  ): {
    deps: ShardRunDeps;
    vitestCalls: VitestRunOptions[];
  } {
    const group = fakes();
    return {
      deps: {
        ...group.deps,
        now: clock,
        prepare: (options) => {
          writeTree(options.outDir, files);
          return {
            version: 1,
            repoRoot: options.repoRoot,
            outDir: options.outDir,
            packageDir: 'gitnexus',
            relocatedShared: 'gitnexus/relocated/gitnexus-shared',
            pathMap: [],
            copiedFiles: Object.keys(files).length,
            blanked: [],
            failed: [],
          };
        },
      },
      vitestCalls: group.vitestCalls,
    };
  }

  it('marks every group of a shard with a foreign prepared copy manifest-mismatch', async () => {
    const workDir = tempDir();
    const changed = { ...SOURCES, 'gitnexus/src/a.ts': 'export const a = 3;\n' };
    const { deps, vitestCalls } = shardDeps(changed, () => 0);
    const report = await runShard(
      { repoRoot: '/repo', workDir, shard: 0, plan: plan(MINUTE), manifest: manifestFor() },
      deps,
    );
    expect([report.manifestCheck, vitestCalls.length]).toEqual([
      { ok: false, mismatches: ['changed: gitnexus/src/a.ts'] },
      0,
    ]);
    const written = readGroupObservations(path.join(workDir, 'observations', 'g1.json'));
    expect([written.status, written.reason]).toEqual(['inconclusive', 'manifest-mismatch']);
  });

  it('does not start a group estimated at 30 minutes with 20 minutes left', async () => {
    const workDir = tempDir();
    const times = [0, 280 * MINUTE, 281 * MINUTE];
    const { deps, vitestCalls } = shardDeps(SOURCES, () => times.shift() ?? 300 * MINUTE);
    const report = await runShard(
      { repoRoot: '/repo', workDir, shard: 0, plan: plan(30 * MINUTE), manifest: manifestFor() },
      deps,
    );
    expect([report.notStarted.map((entry) => entry.group), report.ran, vitestCalls.length]).toEqual(
      [['g1'], [], 0],
    );
    expect(() => readFileSync(path.join(workDir, 'observations', 'g1.json'))).toThrow(/ENOENT/);
  });

  it('runs a group that fits and records it in the shard report', async () => {
    const workDir = tempDir();
    const { deps } = shardDeps(SOURCES, () => 0);
    const report = await runShard(
      { repoRoot: '/repo', workDir, shard: 0, plan: plan(MINUTE), manifest: manifestFor() },
      deps,
    );
    expect(report.ran.map((entry) => [entry.group, entry.status])).toEqual([['g1', 'complete']]);
    expect(JSON.parse(readFileSync(path.join(workDir, 'shard-0.json'), 'utf8'))).toEqual(report);
  });
});
