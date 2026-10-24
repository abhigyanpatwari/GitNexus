/**
 * Oracle command-runner run (U13, KTD17, KTD18): the oracle's own Stryker run over one scope.
 *
 *   1. The scope driver (U10, driver/run-scope.ts) prepares the copy and runs Stryker with the
 *      `command` test runner (`coverageAnalysis: off`, `cleanTempDir: false`, no runner plugin).
 *      The command is command-wrapper.ts from the prepared copy, so every run, the dry run
 *      included, runs every scope test file in the sandbox and leaves a record in
 *      `<out>/oracle-reports/` (record schema in oracle-classify.ts).
 *   2. The dry run's latest record is the baseline: it must classify as survived, and its
 *      executed tests are the expected test set of every mutant run (KTD17 invalid row).
 *   3. Every mutant of `mutation.json` gets an oracle class from its raw Stryker status and its
 *      latest record (oracle-classify.ts `classifyMutant`).
 *   4. `<out>/oracle-command-run.json` ({@link OracleCommandRun}) records the classes, the
 *      per-test rows and the kept, instrumented sandbox for single-test launches (U12).
 *
 * `<out>/oracle-command-run.json`, schemaVersion 1:
 *   scope {testFiles, mutate}            what ran (`mutate` as given in the scope file)
 *   paths                                 output dir, prepared package, report dir, Stryker's
 *                                         mutation.json, the driver's results.json and log,
 *                                         the mutation scope file, the kept `sandboxDir` (null
 *                                         unless exactly one exists) and every `sandboxDirs` entry
 *   command                               the wrapper command Stryker ran
 *   stryker {exitCode, wallClockMs}       the driver's Stryker run
 *   spanMapFailures                       span-map failures of the driver (U2)
 *   baseline                              the dry run: record path, class, reason and executed
 *                                         test ids (KTD3)
 *   mutants[]                             {@link OracleMutantResult}, in report order
 *   problems[]                            anything that makes the run unusable for gate 3
 *   summary                               counts by Stryker status and oracle class, records
 *                                         found, mean wrapper wall clock per mutant run
 * Per-test rows: `tests` lists every test whose outcome is not `survived` (failed tests, tests a
 * failed `beforeAll` skipped); every other test in `executed` passed.
 *
 * Usage (from gitnexus/):
 *   npm run test:mutation:oracle:command -- --scope <scope.json> --out <dir>
 *     [--concurrency <n>] [--timeout-ms <n>]
 * Exit codes: 0 every mutant classified with a clean baseline and one kept sandbox; 1 results
 * written with problems; 2 usage, setup or Stryker failure.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { RESULTS_SCHEMA_VERSION } from '../driver/normalise-results.js';
import { StrykerRunError, UsageError, runScope } from '../driver/run-scope.js';
import { runLayout } from '../driver/stryker-config.js';
import {
  MUTANT_STATUSES,
  readMutationReport,
  type MutantStatus,
  type ReportLocation,
} from '../prepare/mutant-identity.js';
import {
  ORACLE_CLASSES,
  classifyMutant,
  classifyRecord,
  parseOracleRunRecord,
  parseRecordFileName,
  strykerStatuses,
  type OracleClass,
  type OracleRunRecord,
  type OutcomeSource,
  type OutsideTestOutcome,
} from './oracle-classify.js';

export const ORACLE_RUN_SCHEMA_VERSION = 1;
export const REPORT_DIR_NAME = 'oracle-reports';
export const RESULT_FILE_NAME = 'oracle-command-run.json';
/** The wrapper, relative to the prepared `gitnexus/` package. */
export const WRAPPER_FILE = 'tools/mutation/oracle/command-wrapper.ts';
const ROW_MESSAGE_LIMIT = 300;

export interface CommandRunCliOptions {
  scopeFile: string;
  outDir: string;
  concurrency: number;
  timeoutMS: number;
}

export interface OracleTestRow {
  id: string;
  outcome: OracleClass;
  message: string | null;
}

export interface OracleMutantResult {
  globalId: string;
  localId: string;
  file: string;
  location: ReportLocation;
  mutatorName: string;
  replacement: string;
  static: boolean | null;
  /** Stryker's raw status (`mutation.json`). */
  strykerStatus: MutantStatus;
  statusReason: string | null;
  oracleClass: OracleClass;
  source: OutcomeSource;
  reason: string | null;
  /** The latest record file, or null. */
  record: string | null;
  attempts: number;
  exitCode: number | null;
  wallClockMs: number | null;
  executed: number;
  killedBy: string[];
  assertionKilledBy: string[];
  tests: OracleTestRow[];
  outsideTest: OutsideTestOutcome[];
}

export interface OracleCommandRun {
  schemaVersion: typeof ORACLE_RUN_SCHEMA_VERSION;
  kind: 'oracle-command-run';
  scope: { testFiles: string[]; mutate: string[] };
  paths: {
    outDir: string;
    packageDir: string;
    reportDir: string;
    mutationReport: string;
    driverResults: string;
    logFile: string;
    scopeFile: string;
    sandboxDir: string | null;
    sandboxDirs: string[];
  };
  command: string;
  stryker: { exitCode: number; wallClockMs: number };
  spanMapFailures: number;
  baseline: {
    record: string | null;
    outcome: OracleClass | null;
    reason: string | null;
    executed: string[];
  };
  mutants: OracleMutantResult[];
  problems: string[];
  summary: {
    mutants: number;
    byStrykerStatus: Record<MutantStatus, number>;
    byClass: Record<OracleClass, number>;
    withRecord: number;
    meanWrapperWallClockMs: number | null;
  };
}

const parseInteger = (value: string | undefined, name: string, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new UsageError(`--${name} must be a positive integer, got ${value}`);
  }
  return Number(value);
};

export function parseCommandRunArgs(argv: readonly string[], cwd: string): CommandRunCliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      scope: { type: 'string' },
      out: { type: 'string' },
      concurrency: { type: 'string' },
      'timeout-ms': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.scope === undefined) throw new UsageError('--scope is required');
  if (values.out === undefined) throw new UsageError('--out is required');
  return {
    scopeFile: path.resolve(cwd, values.scope),
    outDir: path.resolve(cwd, values.out),
    concurrency: parseInteger(values.concurrency, 'concurrency', 2),
    timeoutMS: parseInteger(values['timeout-ms'], 'timeout-ms', 10000),
  };
}

/** Quotes one word for `/bin/sh`, which Stryker's command runner uses on POSIX systems. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The `commandRunner.command`: the wrapper of the prepared copy, under `node --import tsx`. */
export function wrapperCommand(nodePath: string, packageDir: string, reportDir: string): string {
  return [
    shellQuote(nodePath),
    '--import',
    'tsx',
    shellQuote(path.join(packageDir, WRAPPER_FILE)),
    '--report-dir',
    shellQuote(reportDir),
  ].join(' ');
}

export interface RecordEntry {
  record: OracleRunRecord;
  file: string;
  attempts: number;
}

/** The latest record per key (`dry-run` or the local mutant id) in the report dir. */
export function readRecords(reportDir: string): {
  latest: Map<string, RecordEntry>;
  problems: string[];
} {
  const latest = new Map<string, RecordEntry>();
  const problems: string[] = [];
  const entries = existsSync(reportDir) ? readdirSync(reportDir).sort() : [];
  for (const name of entries) {
    const parsed = parseRecordFileName(name);
    if (parsed === null) continue;
    const file = path.join(reportDir, name);
    let record: OracleRunRecord;
    try {
      record = parseOracleRunRecord(readFileSync(file, 'utf8'));
    } catch (error) {
      problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (
      record.kind !== parsed.kind ||
      record.mutantId !== parsed.mutantId ||
      record.attempt !== parsed.attempt
    ) {
      problems.push(`${file}: kind, mutant id or attempt differ from the file name`);
      continue;
    }
    const key = parsed.mutantId ?? 'dry-run';
    const previous = latest.get(key);
    const attempts = (previous?.attempts ?? 0) + 1;
    if (previous === undefined || previous.record.attempt < record.attempt) {
      latest.set(key, { record, file, attempts });
    } else {
      latest.set(key, { ...previous, attempts });
    }
  }
  return { latest, problems };
}

const firstLine = (message: string | null): string | null => {
  if (message === null) return null;
  const line = message.split('\n', 1)[0] ?? '';
  return line.length > ROW_MESSAGE_LIMIT ? `${line.slice(0, ROW_MESSAGE_LIMIT)}...` : line;
};

const zeroCounts = <T extends string>(keys: readonly T[]): Record<T, number> =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;

/** Runs the oracle's Stryker run for one scope and classifies every mutant. */
export async function runOracleCommand(
  options: CommandRunCliOptions & { repoRoot: string },
): Promise<{ result: OracleCommandRun; exitCode: number }> {
  const layout = runLayout(options.outDir);
  const reportDir = path.join(layout.outDir, REPORT_DIR_NAME);
  const command = wrapperCommand(process.execPath, layout.packageDir, reportDir);
  const { results } = await runScope({
    repoRoot: options.repoRoot,
    scopeFile: options.scopeFile,
    outDir: options.outDir,
    variant: 'command',
    command,
    concurrency: options.concurrency,
    maxTestRunnerReuse: 0,
    timeoutMS: options.timeoutMS,
  });
  if (results.schemaVersion !== RESULTS_SCHEMA_VERSION) {
    throw new Error(`driver results schemaVersion ${results.schemaVersion} is not supported`);
  }

  const problems: string[] = [];
  const statuses = strykerStatuses(readMutationReport(layout.reportFile));
  const { latest, problems: recordProblems } = readRecords(reportDir);
  problems.push(...recordProblems);

  const dryRun = latest.get('dry-run');
  const baseline = dryRun === undefined ? null : classifyRecord(dryRun.record, null);
  if (baseline === null) problems.push('the dry run left no record');
  else if (baseline.outcome !== 'survived' || baseline.executed.length === 0) {
    problems.push(`the dry run classifies as ${baseline.outcome}: ${baseline.reason ?? ''}`);
  }
  const expected = baseline === null ? null : baseline.executed;

  const known = new Set(results.mutants.map((mutant) => mutant.localId));
  for (const key of latest.keys()) {
    if (key !== 'dry-run' && !known.has(key)) {
      problems.push(`a record exists for local id ${key}, which mutation.json lacks`);
    }
  }

  const mutants = results.mutants.map((mutant): OracleMutantResult => {
    const strykerStatus = statuses.get(mutant.localId);
    if (strykerStatus === undefined) {
      problems.push(`mutation.json lacks local id ${mutant.localId}`);
    }
    const entry = latest.get(mutant.localId);
    const classified = classifyMutant({
      strykerStatus: strykerStatus ?? mutant.status,
      record: entry?.record ?? null,
      expected,
    });
    return {
      globalId: mutant.globalId,
      localId: mutant.localId,
      file: mutant.file,
      location: mutant.location,
      mutatorName: mutant.mutatorName,
      replacement: mutant.replacement,
      static: mutant.static,
      strykerStatus: strykerStatus ?? mutant.status,
      statusReason: mutant.statusReason,
      oracleClass: classified.outcome,
      source: classified.source,
      reason: classified.reason,
      record: entry?.file ?? null,
      attempts: entry?.attempts ?? 0,
      exitCode: entry?.record.exitCode ?? null,
      wallClockMs: entry?.record.wallClockMs ?? null,
      executed: classified.executed.length,
      killedBy: classified.killedBy,
      assertionKilledBy: classified.assertionKilledBy,
      tests: classified.tests
        .filter((test) => test.outcome !== 'survived')
        .map((test) => ({ id: test.id, outcome: test.outcome, message: firstLine(test.message) })),
      outsideTest: classified.outsideTest,
    };
  });

  const sandboxDirs = results.paths.sandboxDirs;
  const sandboxDir =
    sandboxDirs.length === 1 && existsSync(sandboxDirs[0] ?? '') ? (sandboxDirs[0] ?? null) : null;
  if (sandboxDir === null) {
    problems.push(
      `expected one kept Stryker sandbox, found ${JSON.stringify(sandboxDirs)} (cleanTempDir false)`,
    );
  }
  if (results.spanMap.failures.length > 0) {
    problems.push(`${results.spanMap.failures.length} span-map failures (see results.json)`);
  }

  const byStrykerStatus = zeroCounts(MUTANT_STATUSES);
  const byClass = zeroCounts(ORACLE_CLASSES);
  for (const mutant of mutants) {
    byStrykerStatus[mutant.strykerStatus]++;
    byClass[mutant.oracleClass]++;
  }
  const wallClocks = mutants.flatMap((mutant) => mutant.wallClockMs ?? []);
  const result: OracleCommandRun = {
    schemaVersion: ORACLE_RUN_SCHEMA_VERSION,
    kind: 'oracle-command-run',
    scope: results.scope,
    paths: {
      outDir: layout.outDir,
      packageDir: layout.packageDir,
      reportDir,
      mutationReport: layout.reportFile,
      driverResults: layout.resultsFile,
      logFile: layout.logFile,
      scopeFile: layout.scopeFile,
      sandboxDir,
      sandboxDirs,
    },
    command,
    stryker: results.stryker,
    spanMapFailures: results.spanMap.failures.length,
    baseline: {
      record: dryRun?.file ?? null,
      outcome: baseline?.outcome ?? null,
      reason: baseline?.reason ?? null,
      executed: baseline?.executed ?? [],
    },
    mutants,
    problems,
    summary: {
      mutants: mutants.length,
      byStrykerStatus,
      byClass,
      withRecord: mutants.filter((mutant) => mutant.record !== null).length,
      meanWrapperWallClockMs:
        wallClocks.length === 0
          ? null
          : Math.round(wallClocks.reduce((sum, ms) => sum + ms, 0) / wallClocks.length),
    },
  };
  writeFileSync(path.join(layout.outDir, RESULT_FILE_NAME), `${JSON.stringify(result, null, 2)}\n`);
  return { result, exitCode: problems.length === 0 ? 0 : 1 };
}

const formatCounts = (counts: Readonly<Record<string, number>>): string =>
  Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${count} ${key}`)
    .join(', ');

const formatDuration = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
};

export function formatOracleSummary(result: OracleCommandRun): string {
  const { summary } = result;
  return [
    `oracle command run: ${summary.mutants} mutants; Stryker: ${formatCounts(summary.byStrykerStatus)}`,
    `  oracle classes: ${formatCounts(summary.byClass)}`,
    `  records: ${summary.withRecord}/${summary.mutants}; mean wrapper run ` +
      `${summary.meanWrapperWallClockMs ?? '-'} ms; baseline ${result.baseline.outcome ?? 'missing'} ` +
      `(${result.baseline.executed.length} tests)`,
    `  Stryker: exit ${result.stryker.exitCode} in ${formatDuration(result.stryker.wallClockMs)}`,
    `  kept sandbox: ${result.paths.sandboxDir ?? 'none'}`,
    ...result.problems.slice(0, 10).map((problem) => `  problem: ${problem}`),
    `  results: ${path.join(result.paths.outDir, RESULT_FILE_NAME)}`,
  ].join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const started = performance.now();
  try {
    const options = parseCommandRunArgs(process.argv.slice(2), process.cwd());
    const { result, exitCode } = await runOracleCommand({ ...options, repoRoot });
    console.log(formatOracleSummary(result));
    console.log(`  total wall clock: ${formatDuration(performance.now() - started)}`);
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError || error instanceof TypeError) {
      console.error(
        'usage: npm run test:mutation:oracle:command -- --scope <scope.json> --out <dir> ' +
          '[--concurrency <n>] [--timeout-ms <n>]',
      );
    }
    if (!(error instanceof StrykerRunError || error instanceof UsageError)) {
      console.error(error instanceof Error ? error.stack : '');
    }
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
