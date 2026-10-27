/**
 * Shared in-memory worlds for the report tests (U13): the verdict engine's positive control
 * (`add(2, 3)` against `add(5, 5)`, a strong repeat) plus a test that kills nothing, so a report
 * has a strong repeat, a Weak pair verdict, a weak test and one production file with gaps. The
 * observations follow the compact model: M3, covered by no test, is implied by the run universe.
 */
import type { InputFacet } from '../../../tools/scenario-map/facet/input-facet.js';
import type {
  MergedObservation,
  RunUniverse,
} from '../../../tools/scenario-map/mutation/observations.js';
import type { MutantFingerprint } from '../../../tools/scenario-map/report/anchors.js';
import type {
  CollectedProvenance,
  ReportInput,
} from '../../../tools/scenario-map/report/report.js';
import type { TestAnchor } from '../../../tools/scenario-map/types.js';
import { computeFingerprints } from '../../../tools/scenario-map/verdict/fingerprint.js';
import {
  computeVerdicts,
  type VerdictInput,
  type VerdictPairInput,
  type VerdictReport,
  type VerdictTestInput,
} from '../../../tools/scenario-map/verdict/verdict.js';

export const A = 'test/unit/add.test.ts#add > adds 2 and 3';
export const B = 'test/unit/add.test.ts#add > adds 5 and 5';
export const C = 'test/unit/add.test.ts#add > logs a sum';
export const FILE = 'gitnexus/src/add.ts';
export const mutantId = (span: string, mutator: string): string =>
  `${FILE}@0123456789abcdef:${span}:${mutator}:aaaaaaaaaaaaaaaa`;
/** Killed by A and B, survived by C. */
export const M1 = mutantId('2:10-2:15', 'ArithmeticOperator');
/** Covered and survived by every test. */
export const M2 = mutantId('3:7-3:16', 'ConditionalExpression');
/** Covered by no test. */
export const M3 = mutantId('6:1-8:2', 'BlockStatement');

export const observation = (
  test: string,
  mutant: string,
  overrides: Partial<MergedObservation> = {},
): MergedObservation => ({
  group: 'g1',
  kind: 'main',
  lineage: 'main',
  test,
  mutant,
  file: FILE,
  covered: true,
  hookAttributed: false,
  static: false,
  outcome: 'killed-by-test:assertion',
  attempts: [0],
  shards: [0],
  sources: ['row'],
  valid: true,
  reasons: [],
  ...overrides,
});

const SURVIVED: Partial<MergedObservation> = { outcome: 'survived' };

export const facet = (values: readonly string[]): InputFacet => ({
  fingerprint: 'facet-add',
  parts: {
    language: '-',
    source: [],
    fixtures: [],
    data: [],
    calls: ['add'],
    order: ['<number>', '<number>'],
  },
  discarded: values.map((value, position) => ({
    position,
    kind: 'number',
    value,
    location: { file: 'gitnexus/test/unit/add.test.ts', line: 3, column: 10 + position * 3 },
    origin: 'literal',
  })),
  unresolved: [],
  skeleton: ['body.0\tcall add', 'body.0.args.0\t<slot>', 'body.0.args.1\t<slot>'],
});

export const testInput = (
  id: string,
  overrides: Partial<VerdictTestInput> = {},
): VerdictTestInput => ({
  id,
  eligible: true,
  fingerprintEligible: true,
  passed: true,
  notOracleValidated: false,
  dupeOk: null,
  joinProblems: [],
  inventoryUnresolved: [],
  provenance: { known: true, nativeEntries: [], workerSpawns: [] },
  concurrent: false,
  excludedFiles: [],
  checksContext: 'checks-add',
  unsupportedForms: [],
  unresolvedSelectors: [],
  facet: facet(['2', '3']),
  ...overrides,
});

export const pairInput = (
  a: string,
  b: string,
  overrides: Partial<VerdictPairInput> = {},
): VerdictPairInput => ({
  a,
  b,
  group: 'g1',
  identicalBlocks: true,
  pathUnattributable: false,
  schedule: { status: 'evaluated', reason: null, detail: null },
  isolation: { status: 'agrees', reason: null, disqualifiers: [] },
  rowDeletion: { outcome: 'not-applicable', reasons: ['no-common-table'] },
  staticValueFlow: { status: 'clean', reasons: [] },
  trace: { status: 'clean', reasons: [] },
  ...overrides,
});

export interface WorldOptions {
  /** Group id of every pair and observation. */
  group?: string;
  degraded?: VerdictInput['valueFlowDegraded'];
}

/** A and B a strong repeat, C kills nothing (the pair A, C is Weak); see the module comment. */
export function world(options: WorldOptions = {}): VerdictInput {
  const group = options.group ?? 'g1';
  const run = (test: string, killsM1: boolean): MergedObservation[] => [
    observation(test, M1, { group, ...(killsM1 ? {} : SURVIVED) }),
    observation(test, M2, { group, ...SURVIVED }),
  ];
  const universe: RunUniverse = {
    group,
    kind: 'main',
    lineage: 'main',
    shard: 0,
    tests: [A, B, C],
    mutants: [M1, M2, M3].map((id) => ({
      id,
      file: FILE,
      static: false,
      status: 'Survived' as const,
      reasons: [],
      hookMarker: true,
    })),
    valid: true,
    reasons: [],
  };
  return {
    tests: [
      testInput(A, { facet: facet(['2', '3']) }),
      testInput(B, { facet: facet(['5', '5']) }),
      testInput(C, { facet: facet(['1', '1']), checksContext: 'checks-log' }),
    ],
    pairs: [pairInput(A, B, { group }), pairInput(A, C, { group })],
    observations: {
      explicit: [...run(A, true), ...run(B, true), ...run(C, false)],
      universes: [universe],
    },
    valueFlowDegraded: options.degraded ?? [],
  };
}

export const anchor = (id: string): TestAnchor => ({
  key: `anchor-${id.slice(id.indexOf('>') + 2).replace(/ /g, '-')}`,
  file: 'test/unit/add.test.ts',
  describePath: ['add'],
  title: id.slice(id.indexOf('>') + 2),
  rowFingerprint: 'row-0',
  bodyFingerprint: `body-${id.slice(id.indexOf('>') + 2)}`,
});

/** Fingerprints that ignore the span: the mutator names the mutant. */
export const fingerprints = (ids: readonly string[]): Map<string, MutantFingerprint> =>
  new Map(
    ids.map((id) => [id, { fingerprint: `m-${id.split(':').at(-2) ?? ''}`, fallback: null }]),
  );

export const PROVENANCE: CollectedProvenance = {
  sourceRevision: '0123456789abcdef0123456789abcdef01234567',
  files: {
    tests: { 'test/unit/add.test.ts': 'a'.repeat(64) },
    production: { [FILE]: 'b'.repeat(64) },
    fixtures: {},
  },
  lockfiles: { 'gitnexus/package-lock.json': 'c'.repeat(64) },
  configs: { 'gitnexus/vitest.config.ts': 'd'.repeat(64) },
  versions: { vitest: '5.0.0', stryker: '10.0.0', typescript: '7.0.2', runner: 'e'.repeat(64) },
  runtime: { node: 'v24.0.0', os: 'linux 6.0 x64', env: { GITNEXUS_HOME: '/tmp/home' } },
};

export interface InputOptions extends WorldOptions {
  verdicts?: (report: VerdictReport) => VerdictReport;
  overrides?: Partial<ReportInput>;
}

/** A report input over {@link world}, with every optional stage present. */
export function reportInput(options: InputOptions = {}): ReportInput {
  const evidence = world(options);
  const computed = computeVerdicts(evidence);
  return {
    run: {
      id: '1001',
      attempt: 1,
      url: 'https://github.com/abhigyanpatwari/GitNexus/actions/runs/1001',
      ref: 'refs/heads/main',
      defaultBranch: true,
    },
    seed: 's1',
    provenance: PROVENANCE,
    eligibility: {
      mode: 'normal',
      files: ['test/unit/add.test.ts'],
      fingerprintFiles: ['test/unit/add.test.ts'],
      delta: { notValidated: [], rejected: [] },
      extraRoots: [],
    },
    layer1Files: 1,
    unrecordedFiles: 0,
    changedFiles: null,
    notRun: { skipped: 0, unfinished: 0 },
    eligibleTests: [A, B, C],
    shards: { planned: 1, complete: 1, incomplete: [] },
    layer0: null,
    evidence,
    fingerprint: computeFingerprints(evidence),
    mutation: 'all',
    verdicts: options.verdicts === undefined ? computed : options.verdicts(computed),
    anchors: new Map([A, B, C].map((id) => [id, anchor(id)])),
    fingerprints: fingerprints([M1, M2, M3]),
    baseline: null,
    ...options.overrides,
  };
}
