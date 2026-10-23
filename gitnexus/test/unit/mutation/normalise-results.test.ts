/**
 * Locks the scope driver's result normalisation (U10, KTD6, KTD16, KTD17): report test ids map to
 * the runner's Stryker ids through the run manifest, sidecar records join their mutant through the
 * local id map (latest attempt wins), and integrity problems are flagged instead of hidden.
 */
import { describe, expect, it } from 'vitest';
import {
  mapReportTestIds,
  normaliseRun,
  orderAttempts,
  parseReportTestFiles,
  type NormaliseInput,
  type ReportTestFiles,
  type SidecarInput,
} from '../../../tools/mutation/driver/normalise-results.js';
import {
  identifyMutants,
  type MutationReport,
  type ReportMutant,
} from '../../../tools/mutation/prepare/mutant-identity.js';
import type { RunClassification } from '../../../tools/mutation/runner/classify-outcome.js';
import type { RunManifest } from '../../../tools/mutation/runner/run-manifest.js';
import type { SidecarRecord } from '../../../tools/mutation/runner/sidecar.js';

const PACKAGE_DIR = '/prepared/gitnexus';
const SOURCE = 'export const a = 1 + 2;\nexport const b = a > 0;\n';
const FILE = 'src/x.ts';
const T_ONE = 'test/unit/a.test.ts#A > one';
const T_TWO = 'test/unit/a.test.ts#A > two';

const manifest: RunManifest = {
  schemaVersion: 1,
  project: 'mutation',
  vitestVersion: '5.0.5',
  files: [
    {
      file: 'test/unit/a.test.ts',
      tests: [
        {
          id: T_ONE,
          taskId: 'h_0',
          fullName: 'A > one',
          location: null,
          notOracleValidated: false,
        },
        {
          id: T_TWO,
          taskId: 'h_1',
          fullName: 'A > two',
          location: null,
          notOracleValidated: false,
        },
      ],
      skipped: [],
    },
  ],
};

const testFiles: ReportTestFiles = {
  'test/unit/a.test.ts': {
    tests: [
      { id: '0', name: 'A > one' },
      { id: '1', name: 'A > two' },
    ],
  },
};

const mutant = (id: string, overrides: Partial<ReportMutant>): ReportMutant => ({
  id,
  mutatorName: 'ArithmeticOperator',
  replacement: `r${id}`,
  location: { start: { line: 1, column: 18 }, end: { line: 1, column: 23 } },
  status: 'Survived',
  ...overrides,
});

const identities = (mutants: ReportMutant[]) => {
  const report: MutationReport = {
    schemaVersion: '1.0',
    projectRoot: PACKAGE_DIR,
    files: { [FILE]: { language: 'typescript', source: SOURCE, mutants } },
  };
  return identifyMutants(report, { packageDir: PACKAGE_DIR, readOriginal: () => SOURCE });
};

const classification = (overrides: Partial<RunClassification>): RunClassification => ({
  status: 'survived',
  outcome: 'survived',
  reason: undefined,
  killedBy: [],
  failureMessage: undefined,
  nrOfTests: 2,
  hitCount: 1,
  tests: [],
  outsideTest: [],
  ...overrides,
});

const killedByOne = classification({
  status: 'killed',
  outcome: 'killed-by-test:assertion',
  killedBy: [T_ONE],
  failureMessage: 'expected 3 to be 4',
  tests: [
    { id: T_ONE, outcome: 'killed-by-test:assertion', message: 'expected 3 to be 4' },
    { id: T_TWO, outcome: 'survived', message: undefined },
  ],
});

const sidecar = (
  mutantId: string | null,
  result: RunClassification,
  where: { worker?: string; attempt?: number; at?: number } = {},
): SidecarInput => {
  const record: SidecarRecord = {
    schemaVersion: 1,
    kind: mutantId === null ? 'dry-run' : 'mutant',
    mutantId,
    worker: where.worker ?? '1',
    attempt: where.attempt ?? 1,
    pid: 100,
    mutantActivation: mutantId === null ? null : 'runtime',
    hitLimit: null,
    requestedTestIds: [T_ONE, T_TWO],
    result,
  };
  return {
    record,
    file: `/out/sidecars/${mutantId ?? 'dry-run'}.json`,
    writtenAtMs: where.at ?? 0,
  };
};

const dryRun = sidecar(null, classification({ nrOfTests: 2 }));

const run = (mutants: ReportMutant[], sidecars: SidecarInput[]): NormaliseInput => ({
  identities: identities(mutants),
  testFiles,
  manifest,
  sidecars: [dryRun, ...sidecars],
});

describe('normaliseRun: sidecar join through the local id map', () => {
  const ids = identities([
    mutant('7', { status: 'Killed', killedBy: ['0'], coveredBy: ['0', '1'] }),
  ]);
  const result = normaliseRun({
    identities: ids,
    testFiles,
    manifest,
    sidecars: [dryRun, sidecar('7', killedByOne, { worker: '2' })],
  });
  const [only] = result.mutants;

  it('carries the global id of the local mutant', () => {
    expect(only.globalId).toBe(ids.localToGlobal.get('7'));
    expect(only.localId).toBe('7');
    expect(only.file).toBe(`gitnexus/${FILE}`);
  });

  it('takes the outcome class from the sidecar record of that local id', () => {
    expect(only).toMatchObject({
      outcome: 'killed-by-test:assertion',
      outcomeSource: 'sidecar',
      sidecar: { worker: '2', attempt: 1, status: 'killed', killedBy: [T_ONE], nrOfTests: 2 },
      assertionKilledBy: [T_ONE],
    });
  });

  it('maps report killers and coverage to runner test ids', () => {
    expect(only.killedBy).toEqual([T_ONE]);
    expect(only.coveredBy).toEqual([T_ONE, T_TWO]);
  });

  it('builds per-test kill sets keyed by runner test id', () => {
    expect(result.tests.find((test) => test.id === T_ONE)).toMatchObject({
      killed: [only.globalId],
      assertionKilled: [only.globalId],
    });
    expect(result.tests.find((test) => test.id === T_TWO)?.killed).toEqual([]);
  });

  it('raises no flag', () => {
    expect(result.flags).toEqual([]);
  });
});

describe('normaliseRun: integrity flags', () => {
  it('flags a killedBy entry with no sidecar record, and the Killed mutant without one', () => {
    const result = normaliseRun(run([mutant('3', { status: 'Killed', killedBy: ['1'] })], []));
    expect(result.flags.map((flag) => [flag.kind, flag.localId])).toEqual([
      ['killed-by-without-sidecar', '3'],
      ['killed-without-sidecar', '3'],
    ]);
    expect(result.flags[0].detail).toContain(T_TWO);
    expect(result.mutants[0]).toMatchObject({ outcome: null, outcomeSource: 'none' });
  });

  it('flags a killedBy entry the sidecar does not list', () => {
    const result = normaliseRun(
      run([mutant('3', { status: 'Killed', killedBy: ['0', '1'] })], [sidecar('3', killedByOne)]),
    );
    expect(result.flags.map((flag) => flag.kind)).toEqual(['killed-by-not-in-sidecar']);
    expect(result.flags[0].detail).toContain(T_TWO);
  });

  it('flags a mutant run that executed zero tests', () => {
    const invalid = classification({ status: 'error', outcome: 'invalid', nrOfTests: 0 });
    const result = normaliseRun(
      run([mutant('4', { status: 'RuntimeError' })], [sidecar('4', invalid)]),
    );
    expect(result.flags.map((flag) => flag.kind)).toEqual(['zero-tests']);
    expect(result.summary.zeroTestRuns).toBe(1);
  });

  it('does not flag zero tests when the file failed to collect', () => {
    const collection = classification({
      status: 'killed',
      outcome: 'killed-outside-test:collection',
      nrOfTests: 0,
    });
    const result = normaliseRun(
      run([mutant('4', { status: 'Killed', static: true })], [sidecar('4', collection)]),
    );
    expect(result.flags).toEqual([]);
  });

  it('flags a sidecar status that disagrees with the Stryker status', () => {
    const result = normaliseRun(
      run([mutant('5', { status: 'Survived' })], [sidecar('5', killedByOne)]),
    );
    expect(result.flags.map((flag) => flag.kind)).toEqual(['status-mismatch']);
  });

  it('flags a Survived mutant without a sidecar record', () => {
    const result = normaliseRun(run([mutant('5', { status: 'Survived' })], []));
    expect(result.flags.map((flag) => flag.kind)).toEqual(['missing-sidecar']);
  });

  it('flags a sidecar record whose local id is not in the report', () => {
    const result = normaliseRun(run([], [sidecar('99', killedByOne)]));
    expect(result.flags).toEqual([
      expect.objectContaining({ kind: 'orphan-sidecar', localId: '99', globalId: null }),
    ]);
  });

  it('flags a vitest5 run without a dry-run record', () => {
    const result = normaliseRun({ ...run([], []), sidecars: [] });
    expect(result.flags.map((flag) => flag.kind)).toEqual(['dry-run-missing']);
    expect(result.dryRun).toBeNull();
  });

  it('flags a report test id that maps to no runner test', () => {
    const result = normaliseRun({
      ...run(
        [mutant('6', { status: 'Survived', coveredBy: ['42'] })],
        [sidecar('6', classification({}))],
      ),
    });
    expect(result.flags.map((flag) => [flag.kind, flag.localId])).toEqual([
      ['unmapped-test-id', '6'],
    ]);
    expect(result.mutants[0].coveredBy).toEqual(['42']);
  });
});

describe('normaliseRun: outcomes without a sidecar record', () => {
  it.each([
    ['NoCoverage', 'survived', 'no-coverage'],
    ['Timeout', 'timeout', 'stryker-timeout'],
    ['Ignored', null, 'none'],
  ] as const)('%s -> %s (%s), no flag', (status, outcome, outcomeSource) => {
    const result = normaliseRun(run([mutant('8', { status })], []));
    expect(result.mutants[0]).toMatchObject({ outcome, outcomeSource });
    expect(result.flags).toEqual([]);
  });
});

describe('normaliseRun: attempts', () => {
  it('records every attempt and lets the latest one win', () => {
    const timeout = classification({ status: 'timeout', outcome: 'timeout', nrOfTests: 1 });
    const result = normaliseRun(
      run(
        [mutant('9', { status: 'Killed', killedBy: ['0'] })],
        [
          sidecar('9', killedByOne, { worker: '3', at: 20 }),
          sidecar('9', timeout, { worker: '1', at: 10 }),
        ],
      ),
    );
    expect(result.mutants[0].attempts.map((attempt) => [attempt.worker, attempt.outcome])).toEqual([
      ['1', 'timeout'],
      ['3', 'killed-by-test:assertion'],
    ]);
    expect(result.mutants[0].sidecar?.worker).toBe('3');
    expect(result.flags).toEqual([]);
  });

  it('orders attempts by write time, then numeric worker, then attempt number', () => {
    const records = [
      sidecar('1', killedByOne, { worker: '10', attempt: 1, at: 5 }),
      sidecar('1', killedByOne, { worker: '9', attempt: 2, at: 5 }),
      sidecar('1', killedByOne, { worker: '9', attempt: 1, at: 5 }),
      sidecar('1', killedByOne, { worker: '2', attempt: 1, at: 1 }),
    ];
    expect(
      orderAttempts(records).map(({ record }) => `${record.worker}/${record.attempt}`),
    ).toEqual(['2/1', '9/1', '9/2', '10/1']);
  });
});

describe('normaliseRun: summary and dry run', () => {
  const result = normaliseRun(
    run(
      [
        mutant('1', { status: 'Killed', killedBy: ['0'] }),
        mutant('2', { status: 'NoCoverage' }),
        mutant('3', { status: 'Survived' }),
      ],
      [sidecar('1', killedByOne), sidecar('3', classification({}))],
    ),
  );

  it('counts statuses and outcome classes', () => {
    expect(result.summary).toMatchObject({
      mutants: 3,
      byStatus: { Killed: 1, NoCoverage: 1, Survived: 1 },
      byOutcome: { 'killed-by-test:assertion': 1, survived: 2 },
      mutantsWithSidecar: 2,
      mutantsWithOutcome: 3,
      testsWithKills: 1,
      testsWithAssertionKills: 1,
      zeroTestRuns: 0,
      flags: 0,
    });
  });

  it('summarises the dry-run record', () => {
    expect(result.dryRun).toMatchObject({ outcome: 'survived', nrOfTests: 2, attempts: 1 });
  });
});

describe('normaliseRun: command variant (no manifest, no sidecars)', () => {
  const commandFiles: ReportTestFiles = { '': { tests: [{ id: '0', name: 'All tests' }] } };
  const result = normaliseRun({
    identities: identities([
      mutant('1', { status: 'Survived' }),
      mutant('2', { status: 'Killed', killedBy: ['0'] }),
    ]),
    testFiles: commandFiles,
    manifest: null,
    sidecars: null,
  });

  it('maps report test ids to report test names and joins no sidecar', () => {
    expect(result.mutants.map((m) => [m.status, m.killedBy, m.outcomeSource])).toEqual([
      ['Survived', [], 'none'],
      ['Killed', ['All tests'], 'none'],
    ]);
    expect(result.tests).toEqual([
      expect.objectContaining({
        id: 'All tests',
        taskId: null,
        killed: [result.mutants[1].globalId],
      }),
    ]);
  });

  it('raises no sidecar flag', () => {
    expect(result.flags).toEqual([]);
    expect(result.dryRun).toBeNull();
  });
});

describe('mapReportTestIds', () => {
  const twin = (id: string, taskId: string, skipped = false) => ({
    id,
    taskId,
    fullName: 'T > row',
    location: { line: 3, column: 5 },
    notOracleValidated: skipped,
  });

  it('pairs tests that share a full name by collection order, across ran and skipped tests', () => {
    const twins: RunManifest = {
      ...manifest,
      files: [
        {
          file: 'test/unit/t.test.ts',
          tests: [
            twin('test/unit/t.test.ts#T > row:3:5:0', 'h_0'),
            twin('test/unit/t.test.ts#T > row:3:5:2', 'h_2'),
          ],
          skipped: [{ ...twin('test/unit/t.test.ts#T > other', 'h_1'), fullName: 'T > other' }],
        },
      ],
    };
    const files: ReportTestFiles = {
      'test/unit/t.test.ts': {
        tests: [
          { id: '0', name: 'T > row' },
          { id: '1', name: 'T > other' },
          { id: '2', name: 'T > row' },
        ],
      },
    };
    const mapped = mapReportTestIds(files, twins);
    expect([...mapped.ids]).toEqual([
      ['0', 'test/unit/t.test.ts#T > row:3:5:0'],
      ['1', 'test/unit/t.test.ts#T > other'],
      ['2', 'test/unit/t.test.ts#T > row:3:5:2'],
    ]);
    expect(mapped.problems).toEqual([]);
  });

  it('reports a report test that the manifest does not list, and a manifest test the report lacks', () => {
    const files: ReportTestFiles = {
      'test/unit/a.test.ts': {
        tests: [
          { id: '0', name: 'A > one' },
          { id: '1', name: 'A > ghost' },
        ],
      },
      'test/unit/z.test.ts': { tests: [{ id: '2', name: 'Z' }] },
    };
    const mapped = mapReportTestIds(files, manifest);
    expect([...mapped.ids]).toEqual([['0', T_ONE]]);
    expect(mapped.problems).toEqual([
      expect.stringContaining('"A > ghost"'),
      expect.stringContaining(T_TWO),
      expect.stringContaining('test/unit/z.test.ts'),
    ]);
  });
});

describe('parseReportTestFiles', () => {
  it('reads the testFiles section of a Stryker report', () => {
    const text = JSON.stringify({ schemaVersion: '1.0', files: {}, testFiles });
    expect(parseReportTestFiles(text)).toEqual(testFiles);
  });

  it('returns no files when the report has no testFiles section', () => {
    expect(parseReportTestFiles(JSON.stringify({ schemaVersion: '1.0', files: {} }))).toEqual({});
  });

  it.each([
    ['a non-object section', { testFiles: [] }, /testFiles must be an object/],
    ['a file without tests', { testFiles: { a: {} } }, /tests must be an array/],
    ['a test without a name', { testFiles: { a: { tests: [{ id: '0' }] } } }, /id and name/],
  ])('rejects %s', (_label, value, message) => {
    expect(() => parseReportTestFiles(JSON.stringify(value))).toThrow(message);
  });
});
