/**
 * Locks the comparison logic of gate 1 (U6): test identities and outcomes, the effective config
 * against the allowed-difference list, the KTD19 path rule and module comparison, the runtime
 * load check, and the envelope record. Pure functions on synthetic inputs; the real runs are
 * exercised by `npm run test:mutation:fidelity`.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_CONFIG_DIFFS,
  compareConfigs,
  normalisePaths,
  type ConfigView,
} from '../../../tools/mutation/fidelity/allowed-config-diffs.js';
import {
  buildEnvelope,
  checkPathRule,
  checkRuntimeLoads,
  compareModuleSets,
  compareTests,
  locateModule,
  runPathRoots,
  basePathRoots,
  type EnvelopeInput,
  type ObservedTest,
  type Roots,
} from '../../../tools/mutation/fidelity/fidelity.js';
import type {
  JsonValue,
  LoadEvent,
  WorkerRecord,
} from '../../../tools/mutation/fidelity/record.js';

const REPO = '/repo';
const PREPARED = '/out/stryker/prepared';
const SANDBOX = `${PREPARED}/gitnexus/.stryker-tmp/sandbox-AbC123`;
const ROOTS: Roots = { repoRoot: REPO, preparedRoot: PREPARED, sandbox: SANDBOX };
const FILE = 'test/unit/schema.test.ts';

const test = (fullName: string, line: number, outcome: ObservedTest['outcome']): ObservedTest => ({
  file: FILE,
  fullName,
  location: { line, column: 5 },
  outcome,
});

const BASE_TESTS: ObservedTest[] = [
  test('schema > has a table', 10, 'passed'),
  test('schema > has an index', 14, 'passed'),
  test('schema > is skipped on win32', 20, 'skipped'),
];

describe('compareTests', () => {
  it('passes identical identity lists', () => {
    expect(compareTests(BASE_TESTS, BASE_TESTS)).toEqual([]);
  });

  it('fails a line shifted by one and names the shifted test', () => {
    const run = [
      BASE_TESTS[0],
      { ...BASE_TESTS[1], location: { line: 15, column: 5 } },
      BASE_TESTS[2],
    ];
    const differences = compareTests(BASE_TESTS, run);
    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatchObject({
      kind: 'location',
      subject: `${FILE} > schema > has an index`,
    });
    expect(differences[0].detail).toContain('14:5');
    expect(differences[0].detail).toContain('15:5');
  });

  it('fails a test that passes in one run and is skipped in the other', () => {
    const run = [BASE_TESTS[0], { ...BASE_TESTS[1], outcome: 'skipped' as const }, BASE_TESTS[2]];
    expect(compareTests(BASE_TESTS, run)).toEqual([
      {
        kind: 'outcome',
        subject: `${FILE} > schema > has an index`,
        detail: 'base passed, run skipped',
      },
    ]);
  });

  it('fails a test that only one run collected, and a file only one run has', () => {
    const other: ObservedTest = { ...BASE_TESTS[0], file: 'test/unit/other.test.ts' };
    const kinds = compareTests(BASE_TESTS, [BASE_TESTS[0], BASE_TESTS[2], other]).map(
      (difference) => [difference.kind, difference.subject],
    );
    expect(kinds).toEqual([
      ['test-missing', `${FILE} > schema > has an index`],
      ['file-extra', 'test/unit/other.test.ts'],
    ]);
  });

  it('pairs tests that share a full name by location order', () => {
    const rows = [test('each row', 30, 'passed'), test('each row', 30, 'failed')];
    const swapped = [rows[1], rows[0]];
    expect(compareTests(rows, swapped).map((difference) => difference.kind)).toEqual([
      'outcome',
      'outcome',
    ]);
  });
});

const view = (project: { [key: string]: JsonValue }, root: string): ConfigView => ({
  project: { root, testTimeout: 30000, sequence: { shuffle: false, seed: 1 }, ...project },
  global: { root },
  vite: {},
  env: { VITEST: 'true' },
});

describe('compareConfigs', () => {
  const base = view({ dangerouslyIgnoreUnhandledErrors: true }, '<package>');

  it('passes an allowed difference and lists it', () => {
    const result = compareConfigs(
      base,
      view({ dangerouslyIgnoreUnhandledErrors: false }, '<package>'),
    );
    expect(result.failures).toEqual([]);
    expect(result.allowed).toEqual([
      {
        name: 'dangerouslyIgnoreUnhandledErrors',
        paths: ['project.dangerouslyIgnoreUnhandledErrors'],
      },
    ]);
  });

  it('fails a difference outside the allowed list', () => {
    const run = view({ dangerouslyIgnoreUnhandledErrors: true, testTimeout: 5000 }, '<package>');
    expect(compareConfigs(base, run).failures).toEqual([
      { path: 'project.testTimeout', base: 30000, run: 5000 },
    ]);
  });

  it.each([
    ['ignored while shuffling is off', false, []],
    ['a failure when shuffling is on', true, ['project.sequence.seed']],
  ])('treats a different sequence.seed as %s', (_label, shuffle, failures) => {
    const sequence = { shuffle, seed: 2 };
    const left = view(
      { dangerouslyIgnoreUnhandledErrors: true, sequence: { shuffle, seed: 1 } },
      '<package>',
    );
    const right = view({ dangerouslyIgnoreUnhandledErrors: true, sequence }, '<package>');
    expect(compareConfigs(left, right).failures.map((failure) => failure.path)).toEqual(failures);
  });

  it.each([
    ['the sandbox maps to the checkout', SANDBOX, []],
    ['a root in the prepared copy still differs', `${PREPARED}/gitnexus`, ['project.root']],
    ['a root in the checkout still differs', `${REPO}/gitnexus`, ['project.root']],
  ])('compares root after mapping paths: %s', (_label, runRoot, failures) => {
    const left = normalisePaths(`${REPO}/gitnexus`, basePathRoots(REPO));
    const right = normalisePaths(runRoot, runPathRoots(ROOTS));
    const result = compareConfigs(
      { ...base, project: { root: left, sequence: null } },
      { ...base, project: { root: right, sequence: null } },
    );
    expect(result.failures.map((failure) => failure.path)).toEqual(failures);
  });

  it('documents every allowed entry with a reason', () => {
    expect(ALLOWED_CONFIG_DIFFS.filter((entry) => entry.reason.length < 40)).toEqual([]);
  });
});

const load = (
  source: LoadEvent['source'],
  module: string,
  parent: string | null,
  phase: LoadEvent['phase'] = 'run',
): LoadEvent => ({
  source,
  module,
  parent,
  phase,
  test: phase === 'run' ? 'schema > has a table' : null,
});

const record = (file: string, root: string, loads: LoadEvent[]): WorkerRecord => ({
  schemaVersion: 1,
  pid: 1,
  ppid: 0,
  file,
  root,
  project: 'default',
  loads,
  envReadsAtLoad: [],
  env: {},
});

const runRecord = (loads: LoadEvent[]): WorkerRecord =>
  record(`${SANDBOX}/${FILE}`, SANDBOX, [
    load('module-runner', `${SANDBOX}/${FILE}`, null),
    ...loads,
  ]);
const baseRecord = (loads: LoadEvent[]): WorkerRecord =>
  record(`${REPO}/gitnexus/${FILE}`, `${REPO}/gitnexus`, [
    load('module-runner', `${REPO}/gitnexus/${FILE}`, null),
    ...loads,
  ]);

describe('path rule (KTD19)', () => {
  it.each([
    ['the sandbox', `${SANDBOX}/src/core/lbug/schema.ts`, []],
    [
      'the sandbox relocated shared sources',
      `${SANDBOX}/relocated/gitnexus-shared/src/index.ts`,
      [],
    ],
    [
      'the prepared copy outside the sandbox',
      `${PREPARED}/gitnexus/src/core/lbug/schema.ts`,
      ['prepared copy'],
    ],
    ['the original checkout', `${REPO}/gitnexus/src/core/lbug/schema.ts`, ['checkout']],
    ['the checkout shared build', `${REPO}/gitnexus-shared/dist/index.js`, ['checkout']],
    [
      'the checkout, a tool module a test imports',
      `${REPO}/gitnexus/tools/mutation/runner/test-ids.ts`,
      ['checkout'],
    ],
    [
      'the prepared copy, the runner setup file next to the plugin (harness)',
      `${PREPARED}/gitnexus/tools/mutation/runner/setup.ts`,
      [],
    ],
  ])('a Stryker-run local module from %s', (_label, module, origins) => {
    const differences = checkPathRule(
      runRecord([load('module-runner', module, `${SANDBOX}/${FILE}`)]),
      ROOTS,
    );
    expect(differences.map((difference) => difference.kind)).toEqual(
      origins.map(() => 'path-rule'),
    );
    expect(differences.map((difference) => difference.detail.includes(origins[0] ?? '-'))).toEqual(
      origins.map(() => true),
    );
  });

  it('maps the base run shared build to the relocated sources', () => {
    expect(
      locateModule(`${REPO}/gitnexus-shared/dist/lbug/schema-constants.js`, 'base', ROOTS),
    ).toEqual({
      key: 'gitnexus-shared/src/lbug/schema-constants.ts',
      kind: 'production',
      origin: 'checkout',
    });
  });

  it('finds the same production modules when the base loads dist and the run the relocated src', () => {
    const base = baseRecord([
      load('module-runner', `${REPO}/gitnexus/src/core/lbug/schema.ts`, `${REPO}/gitnexus/${FILE}`),
      load(
        'module-runner',
        `${REPO}/gitnexus-shared/dist/index.js`,
        `${REPO}/gitnexus/src/core/lbug/schema.ts`,
      ),
    ]);
    const run = runRecord([
      load('module-runner', `${SANDBOX}/src/core/lbug/schema.ts`, `${SANDBOX}/${FILE}`),
      load(
        'module-runner',
        `${SANDBOX}/relocated/gitnexus-shared/src/index.ts`,
        `${SANDBOX}/src/core/lbug/schema.ts`,
      ),
    ]);
    expect(compareModuleSets(base, run, ROOTS)).toEqual([]);
  });

  it('leaves out what the harness imports, such as the runner setup file importing vitest', () => {
    const vitestEntry = `${REPO}/gitnexus/node_modules/vitest/dist/index.js`;
    const run = runRecord([
      load('module-runner', `${PREPARED}/gitnexus/tools/mutation/runner/setup.ts`, null),
      load('module-runner', vitestEntry, `${PREPARED}/gitnexus/tools/mutation/runner/setup.ts`),
    ]);
    expect(compareModuleSets(baseRecord([]), run, ROOTS)).toEqual([]);
  });

  it('reports a production module only one run loads', () => {
    const base = baseRecord([
      load('module-runner', `${REPO}/gitnexus/src/core/lbug/schema.ts`, `${REPO}/gitnexus/${FILE}`),
    ]);
    const differences = compareModuleSets(base, runRecord([]), ROOTS);
    expect(differences.map((difference) => [difference.kind, difference.subject])).toEqual([
      ['module-set', `gitnexus/${FILE}`],
    ]);
    expect(differences[0].detail).toContain('gitnexus/src/core/lbug/schema.ts');
  });
});

describe('runtime load check (KTD19)', () => {
  const testModule = `${REPO}/gitnexus/${FILE}`;
  const pkg = `file://${REPO}/gitnexus/node_modules/some-pkg/index.js`;
  const harness = `file://${REPO}/gitnexus/node_modules/vitest/dist/module-evaluator.js`;

  it.each([
    [
      'the test imports node:child_process',
      load('module-runner', 'child_process', testModule),
      ['child_process'],
    ],
    [
      'a package requires child_process',
      load('node-resolve', 'node:child_process', pkg),
      ['child_process'],
    ],
    [
      'a package loads cluster at load time',
      load('node-resolve', 'node:cluster', pkg, 'load'),
      ['cluster'],
    ],
    [
      'a native addon is opened',
      load('dlopen', `${REPO}/gitnexus/node_modules/x/x.node`, null),
      ['native binding'],
    ],
    [
      'a .node file is resolved',
      load('node-resolve', `file://${REPO}/a/b.node`, pkg),
      ['native binding'],
    ],
    ['a Worker is constructed', load('worker', 'file:///w.js', testModule), ['worker']],
    ['the harness resolves child_process', load('node-resolve', 'node:child_process', harness), []],
    [
      'a package loads worker_threads without a Worker',
      load('node-resolve', 'node:worker_threads', pkg),
      [],
    ],
  ])('%s', (_label, event, kinds) => {
    const result = checkRuntimeLoads(baseRecord([event]), 'base', ROOTS);
    expect(result.failures.map((failure) => failure.kind)).toEqual(kinds.map(() => 'runtime-load'));
    expect(result.failures.map((failure) => failure.detail.split(':')[0])).toEqual(kinds);
  });

  it('names the test that was running', () => {
    const result = checkRuntimeLoads(
      baseRecord([load('module-runner', 'node:child_process', testModule)]),
      'base',
      ROOTS,
    );
    expect(result.failures[0].subject).toBe(`gitnexus/${FILE} > schema > has a table`);
  });

  it('notes worker_threads loads without failing', () => {
    const result = checkRuntimeLoads(
      baseRecord([load('node-resolve', 'node:worker_threads', pkg, 'load')]),
      'base',
      ROOTS,
    );
    expect(result.workerThreadsLoaded).toBe(true);
  });
});

const ENVELOPE_INPUT: EnvelopeInput = {
  versions: { vitest: '5.0.5', stryker: '10.0.0', node: 'v22.23.3' },
  platform: { os: 'linux', release: '6.6.0', arch: 'x64' },
  stryker: { concurrency: 2, maxTestRunnerReuse: 0 },
  config: {
    base: { file: 'gitnexus/vitest.config.ts', project: 'default' },
    run: { file: 'gitnexus/tools/mutation/vitest.mutation.config.ts', project: 'mutation' },
    settings: { pool: 'forks' },
    comparison: {
      failures: [],
      allowed: [{ name: 'setupFiles', paths: ['project.setupFiles'] }],
      volatile: [],
    },
  },
  envReadsAtLoad: [],
  files: [FILE],
  tests: BASE_TESTS,
  differences: [],
  runtimeNotes: { workerThreadsLoadedBy: [] },
};

describe('buildEnvelope', () => {
  it('records the Vitest and Stryker versions of the run', () => {
    expect(buildEnvelope(ENVELOPE_INPUT).versions).toEqual({
      vitest: '5.0.5',
      stryker: '10.0.0',
      node: 'v22.23.3',
    });
  });

  it('lists the allowed config differences that occurred, with their reasons', () => {
    expect(buildEnvelope(ENVELOPE_INPUT).config.allowedDifferences).toEqual([
      {
        name: 'setupFiles',
        paths: ['project.setupFiles'],
        reason: ALLOWED_CONFIG_DIFFS[0].reason,
      },
    ]);
  });

  it('counts tests and lists the skips of this platform', () => {
    const envelope = buildEnvelope(ENVELOPE_INPUT);
    expect(envelope.accepted).toMatchObject({ fileCount: 1, testCount: 3, ran: 2, skipped: 1 });
    expect(envelope.skippedOnThisPlatform).toEqual([`${FILE} > schema > is skipped on win32`]);
  });

  it.each([
    ['pass', [], 'pass'],
    [
      'fail',
      [{ kind: 'outcome' as const, subject: FILE, detail: 'base passed, run failed' }],
      'fail',
    ],
  ])('reports the gate result: %s', (_label, differences, result) => {
    expect(buildEnvelope({ ...ENVELOPE_INPUT, differences }).gate.result).toBe(result);
  });
});
