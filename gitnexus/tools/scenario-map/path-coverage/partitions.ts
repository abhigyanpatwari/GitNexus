/**
 * Sequential and parallel partitions of a scenario-map Vitest run (fingerprint plan E2, E3).
 *
 * gitnexus/vitest.config.ts runs the files of its `fileParallelism: false` projects (`lbug-db`:
 * native LadybugDB handles conflict when two forks hold one database; `cli-e2e`: real CLI spawns)
 * one at a time.
 * The mutation config (tools/mutation/vitest.mutation.config.ts, gate-3 hashed) replaces the
 * projects with one, so a scenario-map run that holds such files (the fingerprint's unit and
 * integration tests, F8) runs them in a partition of their own with one worker, and every other
 * file with the caller's workers. {@link sequentialMatcher} reads those projects' `include`
 * patterns (paths and `*` / `**` globs, package-relative) from the base config.
 *
 * The prepare step (tools/mutation/prepare/prepare.ts, gate-3 hashed) leaves `vendor/` and `dist/`
 * out of the prepared copy; integration tests load both (vendored grammars, leiden, native
 * extensions; the built CLI and its worker scripts), so {@link copyBuildOutput} copies them from
 * the checkout into the copy the fingerprint's runs use (fingerprint plan E6).
 *
 * Library only; pure but for {@link baseSequentialMatcher}, which reads the base config module,
 * {@link runVitestPartitioned}, which runs the injected Vitest runner, and {@link copyBuildOutput}.
 */
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import baseConfig from '../../../vitest.config.js';
import { parseTestId } from '../../mutation/runner/test-ids.js';
import type { VitestRunOptions, VitestRunResult } from '../mutation/vitest-run.js';
import type { RunMode } from '../types.js';
import { isRecord } from '../util.js';

/** The `include` patterns of a Vitest config's `fileParallelism: false` projects; empty if none. */
export function sequentialPatterns(config: unknown): string[] {
  const test = isRecord(config) ? config.test : undefined;
  const projects = isRecord(test) && Array.isArray(test.projects) ? test.projects : [];
  return projects.flatMap((project: unknown): string[] => {
    const inner = isRecord(project) ? project.test : undefined;
    if (!isRecord(inner) || inner.fileParallelism !== false || !Array.isArray(inner.include)) {
      return [];
    }
    return inner.include.filter((entry: unknown): entry is string => typeof entry === 'string');
  });
}

const globToRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split('**')
      .map((part) =>
        part
          .split('*')
          .map((text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*'),
      )
      .join('.*')}$`,
  );

/** Whether a package path matches any of the patterns. */
export function sequentialMatcher(patterns: readonly string[]): (file: string) => boolean {
  const expressions = patterns.map(globToRegExp);
  return (file) => expressions.some((expression) => expression.test(file));
}

/** The matcher of gitnexus/vitest.config.ts's sequential projects. */
export const baseSequentialMatcher = (): ((file: string) => boolean) =>
  sequentialMatcher(sequentialPatterns(baseConfig));

/** A run mode's sequential files: the base config's in normal mode, none in controls mode. */
export const sequentialMatcherFor = (mode: RunMode['kind']): ((file: string) => boolean) =>
  mode === 'controls' ? () => false : baseSequentialMatcher();

/** Splits package paths into the sequential and the parallel partition, keeping their order. */
export function partitionFiles(
  files: readonly string[],
  isSequential: (file: string) => boolean,
): { sequential: string[]; parallel: string[] } {
  return {
    sequential: files.filter(isSequential),
    parallel: files.filter((file) => !isSequential(file)),
  };
}

/**
 * Several partial runs of one request as one result: the tests in request order, the first run
 * that did not end `survived` deciding status, outcome and reason (every run survived: the
 * first's), the other lists joined, the wall clocks added. Pure.
 */
export function mergeVitestRuns(
  testIds: readonly string[],
  runs: readonly VitestRunResult[],
): VitestRunResult {
  const [first] = runs;
  if (first === undefined) throw new Error('mergeVitestRuns: no run to merge');
  const decisive = runs.find((run) => run.outcome !== 'survived') ?? first;
  const byId = new Map(runs.flatMap((run) => run.tests.map((test) => [test.id, test] as const)));
  const loaded = runs.flatMap((run) => run.loadedFiles ?? []);
  return {
    tests: testIds.flatMap((id) => {
      const test = byId.get(id);
      return test === undefined ? [] : [test];
    }),
    status: decisive.status,
    outcome: decisive.outcome,
    reason: decisive.reason,
    outsideTest: runs.flatMap((run) => run.outsideTest),
    problems: runs.flatMap((run) => run.problems),
    unhandledErrors: runs.flatMap((run) => run.unhandledErrors),
    wallClockMs: runs.reduce((total, run) => total + run.wallClockMs, 0),
    ...(runs.some((run) => run.loadedFiles !== undefined) ? { loadedFiles: loaded } : {}),
  };
}

/**
 * Runs a Vitest request in its two partitions ({@link partitionFiles} over the tests' files): the
 * sequential tests with one worker, then the rest with the request's workers, each in a
 * subdirectory of its work dir; one partition is the request itself.
 */
export async function runVitestPartitioned(
  run: (options: VitestRunOptions) => Promise<VitestRunResult>,
  options: VitestRunOptions,
  isSequential: (file: string) => boolean,
): Promise<VitestRunResult> {
  const sequential = options.testIds.filter((id) => isSequential(parseTestId(id).file));
  const parallel = options.testIds.filter((id) => !isSequential(parseTestId(id).file));
  if (sequential.length === 0 || parallel.length === 0) {
    return run(sequential.length === 0 ? options : { ...options, maxWorkers: 1 });
  }
  const runs = [
    await run({
      ...options,
      testIds: sequential,
      maxWorkers: 1,
      workDir: path.join(options.workDir, 'sequential'),
    }),
    await run({ ...options, testIds: parallel, workDir: path.join(options.workDir, 'parallel') }),
  ];
  return mergeVitestRuns(options.testIds, runs);
}

/** Package entries the prepare step leaves out and integration tests load (E6). */
export const BUILD_OUTPUT = ['vendor', 'dist'] as const;

/**
 * Copies {@link BUILD_OUTPUT} from the checkout's package into a prepared package; an entry the
 * checkout lacks is skipped (the tests that load it fail, and the fingerprint holds their pairs
 * Inconclusive).
 */
export function copyBuildOutput(checkoutPackage: string, preparedPackage: string): void {
  for (const entry of BUILD_OUTPUT) {
    const from = path.join(checkoutPackage, entry);
    if (existsSync(from)) cpSync(from, path.join(preparedPackage, entry), { recursive: true });
  }
}
