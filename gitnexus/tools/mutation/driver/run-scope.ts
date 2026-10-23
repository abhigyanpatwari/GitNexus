/**
 * Scope driver (U10): turns a scope file into a prepared copy, a generated Stryker config, a
 * Stryker run and normalised results.
 *
 *   1. prepare.ts builds `<out>/prepared` with the mutate files' `as` assertions blanked (KTD7);
 *   2. `<out>/scope.json` names the test files for tools/mutation/vitest.mutation.config.ts;
 *   3. `<out>/stryker.config.json` comes from stryker-config.ts (never with `testFiles`, KTD4);
 *   4. Stryker runs as `node --import tsx <prepared>/gitnexus/node_modules/@stryker-mutator/core/
 *      bin/stryker.js run <config>` from `<prepared>/gitnexus`, with `GITNEXUS_MUTATION_SCOPE` set
 *      and the inherited `__STRYKER_ACTIVE_MUTANT__` and `STRYKER_MUTATOR_WORKER` removed; its
 *      output goes to `<out>/stryker.log`;
 *   5. the report gets global mutant ids and the span-map check (U2), and is joined with the run
 *      manifest and sidecars (normalise-results.ts) into `<out>/results.json`.
 *
 * The scope file format and the run layout are documented in stryker-config.ts, the results
 * schema in normalise-results.ts. The output directory must lie outside the checkout; an existing
 * non-empty one is replaced only when it holds a previous driver run's marker file.
 *
 * Usage (from gitnexus/):
 *   npm run test:mutation:run -- --scope <scope.json> --out <dir> [--variant vitest5|command]
 *     [--command <cmd>] [--concurrency <n>] [--max-test-runner-reuse <n>] [--timeout-ms <n>]
 * Exit codes: 0 clean run; 1 results written but with integrity flags or span-map failures;
 * 2 usage, setup or Stryker failure.
 */
import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { INSTRUMENTER_CONSTANTS } from '@stryker-mutator/api/core';
import { identifyMutants, readMutationReport, readRepoFile } from '../prepare/mutant-identity.js';
import { prepare } from '../prepare/prepare.js';
import { assertSpanMap, checkSpanMap } from '../prepare/span-map-check.js';
import { readRunManifest } from '../runner/run-manifest.js';
import { readSidecars, sidecarFileName } from '../runner/sidecar.js';
import { MUTATION_SCOPE_ENV, parseMutationScope } from '../scope-file.js';
import {
  RESULTS_SCHEMA_VERSION,
  normaliseRun,
  parseReportTestFiles,
  type RunResults,
  type SidecarInput,
} from './normalise-results.js';
import {
  DEFAULT_IGNORED_DIRS,
  assertTestFilesInSandbox,
  buildStrykerConfig,
  parseDriverScope,
  parseVariant,
  runLayout,
  type RunLayout,
  type Variant,
} from './stryker-config.js';

/** Marks an output directory as created by this driver, so a re-run may replace it. */
export const RUN_MARKER_FILE = '.gitnexus-mutation-run';

/** Stryker's worker id variable: an inherited value would override each worker's own id. */
const WORKER_ENV = 'STRYKER_MUTATOR_WORKER';
const LOG_TAIL_LINES = 40;

export interface CliOptions {
  scopeFile: string;
  outDir: string;
  variant: Variant;
  concurrency: number;
  maxTestRunnerReuse: number;
  timeoutMS: number;
  command: string | undefined;
}

export interface RunScopeOptions extends CliOptions {
  /** Absolute repo checkout. */
  repoRoot: string;
  /** Defaults to {@link DEFAULT_IGNORED_DIRS}. */
  ignoredDirs?: readonly string[];
}

export class UsageError extends Error {
  override name = 'UsageError';
}

const parseInteger = (value: string | undefined, name: string, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} must be an integer, got ${value}`);
  return Number(value);
};

/** Parses the CLI arguments; relative paths resolve against `cwd`. */
export function parseCliArgs(argv: readonly string[], cwd: string): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      scope: { type: 'string' },
      out: { type: 'string' },
      variant: { type: 'string', default: 'vitest5' },
      command: { type: 'string' },
      concurrency: { type: 'string' },
      'max-test-runner-reuse': { type: 'string' },
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
    variant: parseVariant(values.variant),
    concurrency: parseInteger(values.concurrency, 'concurrency', 2),
    maxTestRunnerReuse: parseInteger(values['max-test-runner-reuse'], 'max-test-runner-reuse', 0),
    timeoutMS: parseInteger(values['timeout-ms'], 'timeout-ms', 10000),
    command: values.command,
  };
}

/** The Stryker process environment: the scope file named, Stryker's own variables removed. */
export function strykerChildEnv(
  env: Readonly<Record<string, string | undefined>>,
  scopeFile: string,
): Record<string, string> {
  const scrubbed = new Set([INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE, WORKER_ENV]);
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !scrubbed.has(key)) child[key] = value;
  }
  child[MUTATION_SCOPE_ENV] = scopeFile;
  return child;
}

export function strykerCommand(
  layout: RunLayout,
  nodePath: string,
): { command: string; args: string[]; cwd: string } {
  return {
    command: nodePath,
    args: ['--import', 'tsx', layout.strykerBin, 'run', layout.configFile],
    cwd: layout.packageDir,
  };
}

/** Kept Stryker sandboxes among the entries of its temp dir, sorted. */
export function findSandboxes(tempDir: string, entries: readonly string[]): string[] {
  return entries
    .filter((entry) => entry.startsWith('sandbox-'))
    .sort()
    .map((entry) => path.join(tempDir, entry));
}

const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  const escapes = relative === '..' || relative.startsWith(`..${path.sep}`);
  return !escapes && !path.isAbsolute(relative);
};

function resetOutDir(repoRoot: string, outDir: string): void {
  if (isInside(repoRoot, outDir) || isInside(outDir, repoRoot)) {
    throw new UsageError(`--out ${outDir} must lie outside the checkout ${repoRoot}`);
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    if (!existsSync(path.join(outDir, RUN_MARKER_FILE))) {
      throw new UsageError(
        `${outDir} is not empty and was not created by this driver; choose another --out`,
      );
    }
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, RUN_MARKER_FILE), '');
}

/** Every published sidecar record with its file path and modification time. */
export function readSidecarInputs(sidecarDir: string): SidecarInput[] {
  if (!existsSync(sidecarDir)) return [];
  return readSidecars(sidecarDir).map((record) => {
    const file = path.join(
      sidecarDir,
      sidecarFileName(record.kind, record.mutantId, record.worker, record.attempt),
    );
    return { record, file, writtenAtMs: statSync(file).mtimeMs };
  });
}

function runStryker(layout: RunLayout): Promise<{ exitCode: number; wallClockMs: number }> {
  const { command, args, cwd } = strykerCommand(layout, process.execPath);
  const log = createWriteStream(layout.logFile);
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: strykerChildEnv(process.env, layout.scopeFile),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    process.once('SIGINT', forward);
    process.once('SIGTERM', forward);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      log.end(() =>
        resolve({
          exitCode: code ?? (signal === null ? 1 : 128),
          wallClockMs: Math.round(performance.now() - started),
        }),
      );
    });
  });
}

const logTail = (file: string): string =>
  existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(-LOG_TAIL_LINES).join('\n') : '';

const formatMutateEntry = ({ file, range }: { file: string; range: string | null }): string =>
  range === null ? file : `${file}:${range}`;

export class StrykerRunError extends Error {
  override name = 'StrykerRunError';
}

/** Runs one scope end to end; returns the results and the exit code they imply. */
export async function runScope(
  options: RunScopeOptions,
): Promise<{ results: RunResults; exitCode: number }> {
  const scope = parseDriverScope(readFileSync(options.scopeFile, 'utf8'));
  const ignoredDirs = options.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
  assertTestFilesInSandbox(scope.testFiles, ignoredDirs);
  const layout = runLayout(options.outDir);
  const config = buildStrykerConfig({
    variant: options.variant,
    outDir: layout.outDir,
    mutate: scope.mutate,
    concurrency: options.concurrency,
    maxTestRunnerReuse: options.maxTestRunnerReuse,
    timeoutMS: options.timeoutMS,
    command: options.command,
    ignoredDirs,
  });

  resetOutDir(options.repoRoot, layout.outDir);
  const prepared = prepare({
    repoRoot: options.repoRoot,
    outDir: layout.preparedRoot,
    mutate: scope.mutate.map((entry) => entry.file),
  });
  if (prepared.failed.length > 0) {
    throw new UsageError(
      `prepare rejected ${prepared.failed.map((f) => `${f.file} (${f.reason})`).join(', ')}`,
    );
  }
  const missing = scope.testFiles.filter((file) => !existsSync(path.join(layout.packageDir, file)));
  if (missing.length > 0) throw new UsageError(`test files not found: ${missing.join(', ')}`);

  const scopeText = `${JSON.stringify({ testFiles: scope.testFiles }, null, 2)}\n`;
  parseMutationScope(scopeText);
  writeFileSync(layout.scopeFile, scopeText);
  writeFileSync(layout.configFile, `${JSON.stringify(config, null, 2)}\n`);
  if (options.variant === 'vitest5') {
    mkdirSync(layout.runDir, { recursive: true });
    mkdirSync(layout.sidecarDir, { recursive: true });
  }

  console.log(`mutation run: Stryker ${options.variant} running; log ${layout.logFile}`);
  const stryker = await runStryker(layout);
  if (stryker.exitCode !== 0 || !existsSync(layout.reportFile)) {
    throw new StrykerRunError(
      `Stryker exited with ${stryker.exitCode} after ${stryker.wallClockMs} ms` +
        `${existsSync(layout.reportFile) ? '' : ' and wrote no report'}; last lines of ` +
        `${layout.logFile}:\n${logTail(layout.logFile)}`,
    );
  }

  const report = readMutationReport(layout.reportFile);
  const identities = identifyMutants(report, {
    packageDir: report.projectRoot ?? layout.packageDir,
    readOriginal: readRepoFile(options.repoRoot),
  });
  const spanMap = checkSpanMap(report, identities);
  const isVitest5 = options.variant === 'vitest5';
  const normalised = normaliseRun({
    identities,
    testFiles: parseReportTestFiles(readFileSync(layout.reportFile, 'utf8')),
    manifest: isVitest5 ? readRunManifest(layout.runDir) : null,
    sidecars: isVitest5 ? readSidecarInputs(layout.sidecarDir) : null,
  });
  const results: RunResults = {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    variant: options.variant,
    scope: { testFiles: scope.testFiles, mutate: scope.mutate.map(formatMutateEntry) },
    paths: {
      outDir: layout.outDir,
      preparedRoot: layout.preparedRoot,
      packageDir: layout.packageDir,
      configFile: layout.configFile,
      reportFile: layout.reportFile,
      logFile: layout.logFile,
      runDir: isVitest5 ? layout.runDir : null,
      sidecarDir: isVitest5 ? layout.sidecarDir : null,
      sandboxDirs: existsSync(layout.tempDir)
        ? findSandboxes(layout.tempDir, readdirSync(layout.tempDir))
        : [],
    },
    stryker,
    spanMap: { checked: spanMap.checked, failures: spanMap.failures },
    ...normalised,
  };
  writeFileSync(layout.resultsFile, `${JSON.stringify(results, null, 2)}\n`);
  const clean = spanMap.failures.length === 0 && normalised.flags.length === 0;
  return { results, exitCode: clean ? 0 : 1 };
}

const formatDuration = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
};

const formatCounts = (counts: Readonly<Record<string, number>>): string =>
  Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${count} ${key}`)
    .join(', ');

/** A short human summary of a results document. */
export function formatSummary(results: RunResults): string {
  const { summary, spanMap, stryker, tests } = results;
  const ran = tests.filter((test) => !test.skipped).length;
  return [
    `mutation run (${results.variant}): ${summary.mutants} mutants: ${formatCounts(summary.byStatus)}`,
    `  outcome classes: ${formatCounts(summary.byOutcome)}`,
    `  tests with kills: ${summary.testsWithKills}/${ran} ` +
      `(assertion kills: ${summary.testsWithAssertionKills}); zero-test runs: ${summary.zeroTestRuns}`,
    `  mutants with a sidecar record: ${summary.mutantsWithSidecar}; with an outcome class: ` +
      `${summary.mutantsWithOutcome}`,
    `  span map: ${spanMap.checked} checked, ${spanMap.failures.length} failed; ` +
      `flags: ${summary.flags}`,
    ...results.flags
      .slice(0, 10)
      .map((flag) => `    ${flag.kind} ${flag.localId ?? '-'}: ${flag.detail}`),
    `  Stryker: exit ${stryker.exitCode} in ${formatDuration(stryker.wallClockMs)}`,
    ...results.paths.sandboxDirs.map((dir) => `  kept sandbox: ${dir}`),
    `  results: ${path.join(results.paths.outDir, 'results.json')}`,
  ].join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const started = performance.now();
  try {
    const options = parseCliArgs(process.argv.slice(2), process.cwd());
    const { results, exitCode } = await runScope({ ...options, repoRoot });
    console.log(formatSummary(results));
    console.log(`  total wall clock: ${formatDuration(performance.now() - started)}`);
    try {
      assertSpanMap({ ...results.spanMap, mapped: [] });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof TypeError || error instanceof UsageError) {
      console.error(
        'usage: npm run test:mutation:run -- --scope <scope.json> --out <dir> ' +
          '[--variant vitest5|command] [--command <cmd>] [--concurrency <n>] ' +
          '[--max-test-runner-reuse <n>] [--timeout-ms <n>]',
      );
    }
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
