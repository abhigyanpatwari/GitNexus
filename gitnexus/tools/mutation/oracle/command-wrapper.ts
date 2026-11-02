/**
 * Oracle command wrapper (U13, KTD17, KTD18): the `commandRunner.command` of the oracle's own
 * Stryker run (command-run.ts). Stryker's command runner sees only an exit code, so the wrapper
 * runs Vitest itself and leaves one record per run for the oracle's classifier.
 *
 * Stryker runs the command with its working directory in the instrumented sandbox and, for a
 * mutant run, `__STRYKER_ACTIVE_MUTANT__` set to the local mutant id; the dry run has no active
 * mutant. The wrapper:
 *   1. runs Vitest in its own process through `startVitest`, the code path of `vitest run`, with
 *      the sandbox as root, the sandbox's copy of the mutation config (`--config`), no filter (every
 *      test file of the scope named by GITNEXUS_MUTATION_SCOPE), no results cache, no fs module
 *      cache and a Vite cacheDir of its own inside the sandbox (KTD5). The prepared copy's
 *      node_modules is a symlink to the checkout's, so Vitest's default caches would be shared.
 *      The active mutant stays in the environment: Vitest's fresh fork workers inherit it and the
 *      instrumented code activates it;
 *   2. reports with Vitest's JSON reporter and the oracle reporter (oracle-reporter.ts);
 *   3. writes the record (schema in oracle-classify.ts) to `<report dir>/<key>.attempt-<n>.json`
 *      through a temporary name and a rename, next to Vitest's `<key>.attempt-<n>.vitest.json`;
 *   4. exits with Vitest's exit code, so Stryker sees Killed (non-zero) or Survived (0) as usual
 *      and the dry run passes only when every test passes.
 * When Vitest cannot run (missing config, startup error) the record carries `wrapperError` and
 * the wrapper exits 1.
 *
 * Usage (Stryker runs it from the sandbox):
 *   node --import tsx <prepared>/gitnexus/tools/mutation/oracle/command-wrapper.ts \
 *     --report-dir <absolute dir> [--config <package-relative Vitest config>]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { INSTRUMENTER_CONSTANTS } from '@stryker-mutator/api/core';
import type { Vite } from 'vitest/node';
import {
  ORACLE_RECORD_SCHEMA_VERSION,
  isMutantId,
  parseRecordFileName,
  recordFileName,
  vitestJsonFileName,
  type OracleRunRecord,
  type RecordKind,
  type VitestJsonTotals,
} from './oracle-classify.js';
import { OracleReporter } from './oracle-reporter.js';
import { writeFileAtomicSync } from './util.js';

export const DEFAULT_VITEST_CONFIG = 'tools/mutation/vitest.mutation.config.ts';
/** Per-process Vite cache directories live under this sandbox directory (KTD5). */
export const ORACLE_CACHE_DIR = '.oracle-vitest';

export interface WrapperArgs {
  /** Absolute directory for records and Vitest JSON reports, outside the sandbox. */
  reportDir: string;
  /** Vitest config file, relative to the working directory (the sandbox). */
  configFile: string;
}

export function parseWrapperArgs(argv: readonly string[]): WrapperArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'report-dir': { type: 'string' },
      config: { type: 'string', default: DEFAULT_VITEST_CONFIG },
    },
    strict: true,
    allowPositionals: false,
  });
  const reportDir = values['report-dir'];
  if (reportDir === undefined || !path.isAbsolute(reportDir)) {
    throw new Error('oracle wrapper: --report-dir must be an absolute directory');
  }
  return { reportDir, configFile: values.config };
}

/** The run's kind and mutant id from the environment Stryker gives the command. */
export function activeRun(env: Readonly<Record<string, string | undefined>>): {
  kind: RecordKind;
  mutantId: string | null;
} {
  const value = env[INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE];
  if (value === undefined || value === '') return { kind: 'dry-run', mutantId: null };
  if (!isMutantId(value)) {
    throw new Error(`oracle wrapper: active mutant id ${JSON.stringify(value)} is not numeric`);
  }
  return { kind: 'mutant', mutantId: value };
}

/** One more than the highest attempt of the run's key among the report dir's entries. */
export function nextAttempt(
  entries: readonly string[],
  kind: RecordKind,
  mutantId: string | null,
): number {
  const attempts = entries
    .map(parseRecordFileName)
    .filter((entry) => entry !== null && entry.kind === kind && entry.mutantId === mutantId)
    .map((entry) => entry?.attempt ?? 0);
  return Math.max(0, ...attempts) + 1;
}

/** The totals the classifier cross-checks, from Vitest's JSON report; null when unreadable. */
export function readVitestJsonTotals(file: string): VitestJsonTotals | null {
  if (!existsSync(file)) return null;
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof data !== 'object' || data === null) return null;
    const pick = (key: string): number | null => {
      const value: unknown = key in data ? Reflect.get(data, key) : undefined;
      return typeof value === 'number' ? value : null;
    };
    const [numTotalTests, numPassedTests, numFailedTests] = [
      pick('numTotalTests'),
      pick('numPassedTests'),
      pick('numFailedTests'),
    ];
    if (numTotalTests === null || numPassedTests === null || numFailedTests === null) return null;
    return { numTotalTests, numPassedTests, numFailedTests };
  } catch {
    return null;
  }
}

export interface OracleVitestOptions {
  /** Vitest root: the Stryker sandbox (or any prepared `gitnexus/` copy). */
  root: string;
  /** Absolute Vitest config file. */
  configFile: string;
  reportDir: string;
  kind: RecordKind;
  mutantId: string | null;
  /** CLI filters, e.g. `<file>:<line>` for a single-test launch (launch-single.ts); none here. */
  filters?: readonly string[];
  /** Vitest's `-t` pattern for a single-test launch. */
  testNamePattern?: string;
  /** Extra Vite plugins, e.g. one whose `configureVitest` hook adds the oracle setup file. */
  plugins?: readonly Vite.Plugin[];
}

/** Runs Vitest once as described in the module comment; returns the record it wrote. */
export async function runOracleVitest(options: OracleVitestOptions): Promise<OracleRunRecord> {
  const { root, configFile, reportDir, kind, mutantId } = options;
  mkdirSync(reportDir, { recursive: true });
  const attempt = nextAttempt(readdirSync(reportDir), kind, mutantId);
  const recordFile = path.join(reportDir, recordFileName(kind, mutantId, attempt));
  const vitestJsonFile = path.join(reportDir, vitestJsonFileName(kind, mutantId, attempt));
  const reporter = new OracleReporter(root);
  const started = performance.now();
  let wrapperError: string | null = null;
  let vitestVersion = '';
  let exitCode = 1;

  if (!existsSync(configFile)) {
    wrapperError = `the Vitest config ${configFile} does not exist`;
  } else {
    process.exitCode = undefined;
    try {
      const { startVitest } = await import('vitest/node');
      const vitest = await startVitest(
        [...(options.filters ?? [])],
        {
          root,
          config: configFile,
          run: true,
          watch: false,
          cache: false,
          fsModuleCache: false,
          reporters: [['json', { outputFile: vitestJsonFile }], reporter],
          ...(options.testNamePattern === undefined
            ? {}
            : { testNamePattern: options.testNamePattern }),
        },
        {
          cacheDir: path.join(root, ORACLE_CACHE_DIR, `cache-${process.pid}`),
          ...(options.plugins === undefined ? {} : { plugins: [...options.plugins] }),
        },
      );
      vitestVersion = vitest.version;
      exitCode = Number(process.exitCode ?? 0);
    } catch (error) {
      wrapperError = `Vitest failed to run: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
    }
  }

  const record: OracleRunRecord = {
    schemaVersion: ORACLE_RECORD_SCHEMA_VERSION,
    kind,
    mutantId,
    attempt,
    pid: process.pid,
    root,
    configFile,
    vitestVersion,
    exitCode: wrapperError === null ? exitCode : 1,
    wallClockMs: Math.round(performance.now() - started),
    wrapperError,
    run: wrapperError === null ? reporter.run : null,
    vitestJson: readVitestJsonTotals(vitestJsonFile),
    vitestJsonFile: existsSync(vitestJsonFile) ? vitestJsonFile : null,
  };
  writeFileAtomicSync(recordFile, `${JSON.stringify(record)}\n`);
  return record;
}

async function main(): Promise<void> {
  let code = 1;
  try {
    const args = parseWrapperArgs(process.argv.slice(2));
    const root = process.cwd();
    const record = await runOracleVitest({
      root,
      configFile: path.resolve(root, args.configFile),
      reportDir: args.reportDir,
      ...activeRun(process.env),
    });
    if (record.wrapperError !== null) console.error(`oracle wrapper: ${record.wrapperError}`);
    code = record.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  // Vitest is closed; leftover handles must not keep Stryker waiting.
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
