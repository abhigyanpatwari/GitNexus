/**
 * Sequential and parallel partitions of a scenario-map Vitest run (fingerprint plan E2, E3).
 *
 * gitnexus/vitest.config.ts runs the files of its `fileParallelism: false` projects (`lbug-db`:
 * native LadybugDB handles conflict when two forks hold one database; `cli-e2e`: real CLI spawns)
 * one at a time.
 * The mutation config (tools/mutation/vitest.mutation.config.ts, gate-3 hashed) replaces the
 * projects with one, so a scenario-map run that holds such files (the fingerprint's unit and
 * integration tests, F8) runs them in a partition of their own with one worker, and every other
 * file with the caller's workers. {@link sequentialMatcherFor} reads those projects' `include`
 * patterns (package-relative globs) from the base config.
 *
 * The prepare step (tools/mutation/prepare/prepare.ts, gate-3 hashed) leaves `vendor/` and `dist/`
 * out of the prepared copy; integration tests load both (vendored grammars, leiden, native
 * extensions; the built CLI and its worker scripts), so {@link copyBuildOutput} copies them from
 * the checkout into the copy a normal-mode fingerprint run uses (fingerprint plan E6).
 *
 * Library only; pure but for {@link sequentialMatcherFor}, which reads the base config module,
 * {@link runVitestPartitioned}, which runs the injected Vitest runner, and {@link copyBuildOutput}.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
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

/** Whether a package path matches any of the patterns (Node's glob matching, as Vitest's). */
export function sequentialMatcher(patterns: readonly string[]): (file: string) => boolean {
  return (file) => patterns.some((pattern) => path.posix.matchesGlob(file, pattern));
}

/** A run mode's sequential files: the base config's in normal mode, none in controls mode. */
export const sequentialMatcherFor = (mode: RunMode['kind']): ((file: string) => boolean) =>
  mode === 'controls' ? () => false : sequentialMatcher(sequentialPatterns(baseConfig));

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
  const { sequential, parallel } = partitionFiles(options.testIds, (id) =>
    isSequential(parseTestId(id).file),
  );
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
const BUILD_OUTPUT = ['vendor', 'prebuilds', 'dist'] as const;

/** Restore tracked inventory inputs without sharing the checkout's writable Git state. */
function copyGitInventory(checkoutRoot: string, preparedRoot: string): void {
  if (!existsSync(path.join(checkoutRoot, '.git'))) return;
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_COMMON_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete env[key];
  const listing = execFileSync('git', ['ls-files', '--stage', '-z'], {
    cwd: checkoutRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const entries: string[] = [];
  for (const entry of listing.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0 || entry.startsWith('160000 ')) continue; // Do not enter submodule repositories.
    const file = entry.slice(tab + 1);
    const basename = path.basename(file);
    if (basename.startsWith('.env') && !basename.endsWith('.example')) continue;
    const from = path.join(checkoutRoot, file);
    const to = path.join(preparedRoot, file);
    // Repo-wide source guards need the public files outside the prepared package too.
    // Existing prepared files may be mutated: never overwrite them with checkout bytes.
    if (!existsSync(to) && existsSync(from)) {
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(from, to, { verbatimSymlinks: true });
    }
    if (existsSync(to)) entries.push(entry);
  }
  execFileSync('git', ['init', '--quiet', '--template=', preparedRoot], { env });
  execFileSync('git', ['read-tree', '--empty'], { cwd: preparedRoot, env });
  // Index metadata only: no source object store, history, hooks or remote configuration.
  execFileSync('git', ['update-index', '-z', '--index-info'], {
    cwd: preparedRoot,
    env,
    input: entries.length === 0 ? '' : `${entries.join('\0')}\0`,
  });
}

/**
 * Copies {@link BUILD_OUTPUT} from the checkout's package into a prepared package of a normal-mode
 * run (the controls fixture needs neither); an entry the checkout lacks is skipped (the tests that
 * load it fail, and the fingerprint holds their pairs Inconclusive).
 */
export function copyBuildOutput(
  mode: RunMode['kind'],
  checkoutPackage: string,
  preparedPackage: string,
): void {
  if (mode === 'controls') return;
  for (const entry of BUILD_OUTPUT) {
    const from = path.join(checkoutPackage, entry);
    if (existsSync(from)) cpSync(from, path.join(preparedPackage, entry), { recursive: true });
  }
  copyGitInventory(path.resolve(checkoutPackage, '..'), path.resolve(preparedPackage, '..'));
}
