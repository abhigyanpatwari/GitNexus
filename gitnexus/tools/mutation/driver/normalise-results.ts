/**
 * Normalised results of one scope-driver run (U10): Stryker's report, the vitest5 run manifest
 * (KTD16) and the sidecar records (KTD6), joined per mutant through U2's local-to-global id map.
 *
 * `<out>/results.json` ({@link RunResults}, schemaVersion 1):
 *   variant, scope {testFiles, mutate}       what ran (`mutate` as given in the scope file)
 *   paths                                    output dir, prepared copy, config, report, log,
 *                                            runDir/sidecarDir (null for command), sandboxDirs
 *                                            (kept Stryker sandboxes; empty once cleaned)
 *   stryker {exitCode, wallClockMs}
 *   spanMap {checked, failures[]}            span-map-check.ts over every mutant
 *   manifest                                 run-manifest counts (null for command)
 *   dryRun                                   latest dry-run sidecar (null for command or missing)
 *   mutants[]                                {@link NormalisedMutant}, in report order
 *   tests[]                                  {@link NormalisedTest}: per-test kill sets
 *   flags[]                                  {@link Flag}: run-level first, then per mutant
 *   summary                                  {@link RunSummary}
 *
 * Test ids. Stryker's report renumbers test ids (`"0"`, `"1"`, ...) in the dry run's test order
 * and lists each test under its file with the runner's reported name (the Vitest full name). The
 * vitest5 runner reports a file's tests in collection order, ran and skipped interleaved, and the
 * run manifest keeps each of those two lists in collection order. So report tests pair with
 * manifest tests by walking both in order and matching full names: tests that share a full name
 * (KTD3 suffixes) pair by position, and a name that matches neither list is a problem. Every
 * `killedBy`/`coveredBy` entry is mapped to the runner's Stryker id (KTD3); an entry that cannot
 * be mapped stays as the report id and is flagged. The command variant has no manifest: its
 * report ids map to the report's test names.
 *
 * Outcome classes (KTD17). A mutant's class comes from its latest sidecar record: records are
 * ordered by write time, then numeric worker id (Stryker numbers replacement processes upwards),
 * then attempt number; every attempt is listed. Without a record: NoCoverage is `survived`
 * (KTD13 treats them as one class), a Stryker Timeout is `timeout` (Stryker killed the process
 * before it could write, KTD6), anything else has no class. The command variant joins no sidecar.
 * `assertionKilledBy` lists the latest record's `killed-by-test:assertion` rows: the only kills
 * gates 3 and 4 count.
 *
 * Flags (vitest5 only, except unmapped test ids):
 *   dry-run-missing            no dry-run record
 *   unmapped-test-id           a report test that pairs with no manifest test, a manifest test
 *                              the report lacks, or a mutant killer/coverage id that cannot be mapped
 *   orphan-sidecar             a record whose local id is not in the report
 *   killed-by-without-sidecar  a killedBy entry of a mutant that has no record (one per entry)
 *   killed-without-sidecar     a Killed mutant without a record
 *   missing-sidecar            a Survived or RuntimeError mutant (the runner ran it) without a record
 *   killed-by-not-in-sidecar   a killedBy entry the latest record does not list
 *   status-mismatch            the latest record's status disagrees with Stryker's status
 *   zero-tests                 an attempt that ran zero tests, unless the file failed to collect
 *                              or a file-level hook failed (killed-outside-test rows)
 */
import {
  MUTANT_STATUSES,
  type MutantStatus,
  type ReportLocation,
  type RunIdentities,
} from '../prepare/mutant-identity.js';
import type { SpanMapFailure } from '../prepare/span-map-check.js';
import type { OutcomeClass, OutsideTestOutcome, RunnerStatus } from '../runner/classify-outcome.js';
import type { RunManifest } from '../runner/run-manifest.js';
import type { SidecarRecord } from '../runner/sidecar.js';
import type { Variant } from './stryker-config.js';

export const RESULTS_SCHEMA_VERSION = 1;

export interface ReportTest {
  /** The report's renumbered test id. */
  id: string;
  name: string;
}

/** Stryker report `testFiles`: package-relative file (or `''`) to its tests, in dry-run order. */
export type ReportTestFiles = Record<string, { tests: ReportTest[] }>;

export interface SidecarInput {
  record: SidecarRecord;
  /** Absolute path of the record file. */
  file: string;
  /** The record file's modification time. */
  writtenAtMs: number;
}

export type OutcomeSource = 'sidecar' | 'no-coverage' | 'stryker-timeout' | 'none';

export interface SidecarAttempt {
  file: string;
  worker: string;
  attempt: number;
  pid: number;
  writtenAtMs: number;
  status: RunnerStatus;
  outcome: OutcomeClass;
  nrOfTests: number;
}

export interface SidecarSummary extends SidecarAttempt {
  reason: string | null;
  failureMessage: string | null;
  /** Runner Stryker ids that Stryker saw as killers. */
  killedBy: string[];
  hitCount: number;
  mutantActivation: SidecarRecord['mutantActivation'];
  outsideTest: OutsideTestOutcome[];
}

export type FlagKind =
  | 'dry-run-missing'
  | 'unmapped-test-id'
  | 'orphan-sidecar'
  | 'killed-by-without-sidecar'
  | 'killed-without-sidecar'
  | 'missing-sidecar'
  | 'killed-by-not-in-sidecar'
  | 'status-mismatch'
  | 'zero-tests';

export interface Flag {
  kind: FlagKind;
  localId: string | null;
  globalId: string | null;
  detail: string;
}

export interface NormalisedMutant {
  globalId: string;
  localId: string;
  /** Repo-relative path of the original file. */
  file: string;
  location: ReportLocation;
  mutatorName: string;
  replacement: string;
  static: boolean | null;
  /** Stryker's raw status. */
  status: MutantStatus;
  statusReason: string | null;
  testsCompleted: number | null;
  outcome: OutcomeClass | null;
  outcomeSource: OutcomeSource;
  /** Runner test ids (report ids that cannot be mapped stay as-is and are flagged). */
  killedBy: string[];
  coveredBy: string[] | null;
  assertionKilledBy: string[];
  /** The latest attempt; null when there is none. */
  sidecar: SidecarSummary | null;
  /** Every attempt, oldest first. */
  attempts: SidecarAttempt[];
  flags: FlagKind[];
}

export interface NormalisedTest {
  /** Runner Stryker id (KTD3); the report name for the command variant. */
  id: string;
  file: string;
  fullName: string;
  /** Vitest task id; null for the command variant. */
  taskId: string | null;
  skipped: boolean;
  notOracleValidated: boolean;
  /** Global ids of mutants whose Stryker `killedBy` lists this test. */
  killed: string[];
  /** Global ids of mutants this test killed with an assertion (KTD17). */
  assertionKilled: string[];
}

export interface DryRunSummary {
  file: string;
  status: RunnerStatus;
  outcome: OutcomeClass;
  reason: string | null;
  nrOfTests: number;
  attempts: number;
}

export interface ManifestSummary {
  project: string;
  vitestVersion: string;
  files: number;
  tests: number;
  skipped: number;
}

export interface RunSummary {
  mutants: number;
  byStatus: Record<MutantStatus, number>;
  /** Outcome class counts; `unclassified` counts mutants without a class. */
  byOutcome: Record<string, number>;
  mutantsWithSidecar: number;
  mutantsWithOutcome: number;
  testsWithKills: number;
  testsWithAssertionKills: number;
  zeroTestRuns: number;
  flags: number;
}

export interface NormalisedRun {
  manifest: ManifestSummary | null;
  dryRun: DryRunSummary | null;
  mutants: NormalisedMutant[];
  tests: NormalisedTest[];
  flags: Flag[];
  summary: RunSummary;
}

/** The full `results.json` document; see the module comment. */
export interface RunResults extends NormalisedRun {
  schemaVersion: typeof RESULTS_SCHEMA_VERSION;
  variant: Variant;
  scope: { testFiles: string[]; mutate: string[] };
  paths: {
    outDir: string;
    preparedRoot: string;
    packageDir: string;
    configFile: string;
    reportFile: string;
    logFile: string;
    runDir: string | null;
    sidecarDir: string | null;
    sandboxDirs: string[];
  };
  stryker: { exitCode: number; wallClockMs: number };
  spanMap: { checked: number; failures: SpanMapFailure[] };
}

export interface NormaliseInput {
  identities: RunIdentities;
  testFiles: ReportTestFiles;
  /** Null for the command variant. */
  manifest: RunManifest | null;
  /** Every published record of the run; null for the command variant. */
  sidecars: readonly SidecarInput[] | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parses the `testFiles` section of Stryker's report text; a report without one has no tests. */
export function parseReportTestFiles(text: string): ReportTestFiles {
  const data: unknown = JSON.parse(text);
  const section = isRecord(data) ? data.testFiles : undefined;
  if (section === undefined) return {};
  if (!isRecord(section)) throw new Error('mutation report: testFiles must be an object');
  return Object.fromEntries(
    Object.entries(section).map(([file, value]) => {
      const tests: unknown = isRecord(value) ? value.tests : undefined;
      if (!Array.isArray(tests)) {
        throw new Error(
          `mutation report: testFiles[${JSON.stringify(file)}].tests must be an array`,
        );
      }
      return [
        file,
        {
          tests: tests.map((test: unknown): ReportTest => {
            if (!isRecord(test) || typeof test.id !== 'string' || typeof test.name !== 'string') {
              throw new Error(
                `mutation report: every test of testFiles[${JSON.stringify(file)}] needs an id and name`,
              );
            }
            return { id: test.id, name: test.name };
          }),
        },
      ];
    }),
  );
}

/** Report test id to runner test id; see the module comment. */
export function mapReportTestIds(
  testFiles: ReportTestFiles,
  manifest: RunManifest | null,
): { ids: Map<string, string>; problems: string[] } {
  const ids = new Map<string, string>();
  const problems: string[] = [];
  if (manifest === null) {
    for (const { tests } of Object.values(testFiles)) {
      for (const test of tests) ids.set(test.id, test.name);
    }
    return { ids, problems };
  }
  const byFile = new Map(manifest.files.map((file) => [file.file, file]));
  const seen = new Set<string>();
  for (const [file, { tests }] of Object.entries(testFiles)) {
    const entry = byFile.get(file);
    if (entry === undefined) {
      problems.push(`report test file ${JSON.stringify(file)} is not in the run manifest`);
      continue;
    }
    seen.add(file);
    let ran = 0;
    let skipped = 0;
    for (const test of tests) {
      const nextRan = entry.tests[ran];
      const nextSkipped = entry.skipped[skipped];
      const ranMatches = nextRan !== undefined && nextRan.fullName === test.name;
      const skippedMatches = nextSkipped !== undefined && nextSkipped.fullName === test.name;
      if (ranMatches && skippedMatches) {
        problems.push(
          `report test ${test.id} ${JSON.stringify(test.name)} in ${file} matches both a ran and a ` +
            'skipped manifest test; paired with the ran test',
        );
      }
      if (ranMatches) {
        ids.set(test.id, nextRan.id);
        ran++;
      } else if (skippedMatches) {
        ids.set(test.id, nextSkipped.id);
        skipped++;
      } else {
        problems.push(
          `report test ${test.id} ${JSON.stringify(test.name)} in ${file} matches no run manifest test`,
        );
      }
    }
    for (const left of [...entry.tests.slice(ran), ...entry.skipped.slice(skipped)]) {
      problems.push(`run manifest test ${left.id} is missing from the report`);
    }
  }
  for (const entry of manifest.files.filter((file) => !seen.has(file.file))) {
    for (const left of [...entry.tests, ...entry.skipped]) {
      problems.push(`run manifest test ${left.id} is missing from the report`);
    }
  }
  return { ids, problems };
}

const compareWorkers = (a: string, b: string): number => {
  const [x, y] = [Number(a), Number(b)];
  if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;
  return a < b ? -1 : a > b ? 1 : 0;
};

/** Attempts oldest first: write time, then numeric worker id, then attempt number. */
export function orderAttempts(inputs: readonly SidecarInput[]): SidecarInput[] {
  return [...inputs].sort(
    (a, b) =>
      a.writtenAtMs - b.writtenAtMs ||
      compareWorkers(a.record.worker, b.record.worker) ||
      a.record.attempt - b.record.attempt,
  );
}

const STRYKER_STATUS: Record<RunnerStatus, MutantStatus> = {
  killed: 'Killed',
  survived: 'Survived',
  timeout: 'Timeout',
  error: 'RuntimeError',
};

const toAttempt = ({ record, file, writtenAtMs }: SidecarInput): SidecarAttempt => ({
  file,
  worker: record.worker,
  attempt: record.attempt,
  pid: record.pid,
  writtenAtMs,
  status: record.result.status,
  outcome: record.result.outcome,
  nrOfTests: record.result.nrOfTests,
});

const toSummary = (input: SidecarInput): SidecarSummary => {
  const { result, mutantActivation } = input.record;
  return {
    ...toAttempt(input),
    reason: result.reason ?? null,
    failureMessage: result.failureMessage ?? null,
    killedBy: [...result.killedBy],
    hitCount: result.hitCount,
    mutantActivation,
    outsideTest: result.outsideTest,
  };
};

const isOutsideTestKill = (outcome: OutcomeClass): boolean =>
  outcome === 'killed-outside-test:collection' || outcome === 'killed-outside-test:hook';

/** Joins report, manifest and sidecars; pure. See the module comment for every rule. */
export function normaliseRun(input: NormaliseInput): NormalisedRun {
  const { identities, manifest, sidecars } = input;
  const flags: Flag[] = [];
  const flag = (kind: FlagKind, detail: string, localId: string | null = null): void => {
    const globalId = localId === null ? null : (identities.localToGlobal.get(localId) ?? null);
    flags.push({ kind, localId, globalId, detail });
  };

  const byMutant = new Map<string, SidecarInput[]>();
  const dryRuns: SidecarInput[] = [];
  for (const entry of orderAttempts(sidecars ?? [])) {
    const { kind, mutantId } = entry.record;
    if (kind === 'dry-run' || mutantId === null) {
      dryRuns.push(entry);
      continue;
    }
    byMutant.set(mutantId, [...(byMutant.get(mutantId) ?? []), entry]);
  }
  const latestDryRun = dryRuns.at(-1);
  if (sidecars !== null && latestDryRun === undefined) {
    flag('dry-run-missing', 'the run wrote no dry-run sidecar record');
  }

  const mapping = mapReportTestIds(input.testFiles, manifest);
  for (const problem of mapping.problems) flag('unmapped-test-id', problem);
  for (const mutantId of byMutant.keys()) {
    if (!identities.localToGlobal.has(mutantId)) {
      flag(
        'orphan-sidecar',
        `sidecar records for local id ${mutantId}, which the report lacks`,
        mutantId,
      );
    }
  }

  const mapIds = (list: readonly string[] | undefined, unmapped: string[]): string[] =>
    (list ?? []).map((id) => {
      const mapped = mapping.ids.get(id);
      if (mapped === undefined) unmapped.push(id);
      return mapped ?? id;
    });

  let zeroTestRuns = 0;
  const mutants = identities.mutants.map(({ localId, globalId, identity, mutant }) => {
    const before = flags.length;
    const unmapped: string[] = [];
    const killedBy = mapIds(mutant.killedBy, unmapped);
    const coveredBy = mutant.coveredBy === undefined ? null : mapIds(mutant.coveredBy, unmapped);
    if (unmapped.length > 0) {
      flag(
        'unmapped-test-id',
        `report test ids ${JSON.stringify(unmapped)} map to no test`,
        localId,
      );
    }
    const attempts = byMutant.get(localId) ?? [];
    const latest = attempts.at(-1);
    let outcome: OutcomeClass | null = null;
    let outcomeSource: OutcomeSource = 'none';
    if (latest !== undefined) {
      outcome = latest.record.result.outcome;
      outcomeSource = 'sidecar';
    } else if (sidecars !== null && mutant.status === 'NoCoverage') {
      outcome = 'survived';
      outcomeSource = 'no-coverage';
    } else if (sidecars !== null && mutant.status === 'Timeout') {
      outcome = 'timeout';
      outcomeSource = 'stryker-timeout';
    }

    if (sidecars !== null && latest === undefined) {
      for (const killer of killedBy) {
        flag(
          'killed-by-without-sidecar',
          `killedBy entry ${killer} has no sidecar record`,
          localId,
        );
      }
      if (mutant.status === 'Killed') {
        flag(
          'killed-without-sidecar',
          'Stryker reports Killed but no sidecar record exists',
          localId,
        );
      } else if (mutant.status === 'Survived' || mutant.status === 'RuntimeError') {
        flag(
          'missing-sidecar',
          `Stryker reports ${mutant.status} but no sidecar record exists`,
          localId,
        );
      }
    }
    if (latest !== undefined) {
      const recorded = new Set(latest.record.result.killedBy);
      for (const killer of killedBy.filter((id) => !recorded.has(id))) {
        flag(
          'killed-by-not-in-sidecar',
          `killedBy entry ${killer} is not a killer in ${latest.file}`,
          localId,
        );
      }
      const expected = STRYKER_STATUS[latest.record.result.status];
      if (expected !== mutant.status) {
        flag(
          'status-mismatch',
          `Stryker reports ${mutant.status}, the latest sidecar ${latest.record.result.status}`,
          localId,
        );
      }
    }
    for (const attempt of attempts) {
      const { nrOfTests, outcome: attemptOutcome } = attempt.record.result;
      if (nrOfTests === 0 && !isOutsideTestKill(attemptOutcome)) {
        zeroTestRuns++;
        flag('zero-tests', `${attempt.file} ran zero tests (${attemptOutcome})`, localId);
      }
    }

    const normalised: NormalisedMutant = {
      globalId,
      localId,
      file: identity.file,
      location: identity.location,
      mutatorName: identity.mutatorName,
      replacement: identity.replacement,
      static: mutant.static ?? null,
      status: mutant.status,
      statusReason: mutant.statusReason ?? null,
      testsCompleted: mutant.testsCompleted ?? null,
      outcome,
      outcomeSource,
      killedBy,
      coveredBy,
      assertionKilledBy: (latest?.record.result.tests ?? [])
        .filter((test) => test.outcome === 'killed-by-test:assertion')
        .map((test) => test.id),
      sidecar: latest === undefined ? null : toSummary(latest),
      attempts: attempts.map(toAttempt),
      flags: flags.slice(before).map((entry) => entry.kind),
    };
    return normalised;
  });

  const tests = new Map<string, NormalisedTest>();
  if (manifest === null) {
    for (const [file, { tests: reportTests }] of Object.entries(input.testFiles)) {
      for (const test of reportTests) {
        tests.set(test.name, {
          id: test.name,
          file,
          fullName: test.name,
          taskId: null,
          skipped: false,
          notOracleValidated: false,
          killed: [],
          assertionKilled: [],
        });
      }
    }
  } else {
    for (const entry of manifest.files) {
      for (const [list, skipped] of [
        [entry.tests, false],
        [entry.skipped, true],
      ] as const) {
        for (const test of list) {
          tests.set(test.id, {
            id: test.id,
            file: entry.file,
            fullName: test.fullName,
            taskId: test.taskId,
            skipped,
            notOracleValidated: test.notOracleValidated,
            killed: [],
            assertionKilled: [],
          });
        }
      }
    }
  }
  for (const mutant of mutants) {
    for (const id of mutant.killedBy) tests.get(id)?.killed.push(mutant.globalId);
    for (const id of mutant.assertionKilledBy) tests.get(id)?.assertionKilled.push(mutant.globalId);
  }

  const byStatus = Object.fromEntries(MUTANT_STATUSES.map((status) => [status, 0])) as Record<
    MutantStatus,
    number
  >;
  const byOutcome: Record<string, number> = {};
  for (const mutant of mutants) {
    byStatus[mutant.status]++;
    const key = mutant.outcome ?? 'unclassified';
    byOutcome[key] = (byOutcome[key] ?? 0) + 1;
  }
  const testList = [...tests.values()];
  return {
    manifest:
      manifest === null
        ? null
        : {
            project: manifest.project,
            vitestVersion: manifest.vitestVersion,
            files: manifest.files.length,
            tests: manifest.files.reduce((sum, file) => sum + file.tests.length, 0),
            skipped: manifest.files.reduce((sum, file) => sum + file.skipped.length, 0),
          },
    dryRun:
      latestDryRun === undefined
        ? null
        : {
            file: latestDryRun.file,
            status: latestDryRun.record.result.status,
            outcome: latestDryRun.record.result.outcome,
            reason: latestDryRun.record.result.reason ?? null,
            nrOfTests: latestDryRun.record.result.nrOfTests,
            attempts: dryRuns.length,
          },
    mutants,
    tests: testList,
    flags,
    summary: {
      mutants: mutants.length,
      byStatus,
      byOutcome,
      mutantsWithSidecar: mutants.filter((mutant) => mutant.sidecar !== null).length,
      mutantsWithOutcome: mutants.filter((mutant) => mutant.outcome !== null).length,
      testsWithKills: testList.filter((test) => test.killed.length > 0).length,
      testsWithAssertionKills: testList.filter((test) => test.assertionKilled.length > 0).length,
      zeroTestRuns,
      flags: flags.length,
    },
  };
}
