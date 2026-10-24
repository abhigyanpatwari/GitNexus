/**
 * Gate 2 conformance check (U4): runs the conformance fixture project through the scope driver
 * (U10) with the vitest5 runner, in every profile of the expected file, and compares the
 * normalised results with the pinned expectations (compare.ts documents the file and every fact).
 *
 * The fixture lives in test/fixtures/mutation-conformance: tiny production modules under `src/`
 * whose planted mutants are the only ones a `// Stryker restore` comment enables, `*.case.ts`
 * test files (no repo Vitest project collects them), its own Vitest config (project
 * `conformance`) and `expected.json`. Each (profile, scope) pair is one scope-driver run, with:
 *   - the fixture directory as an extra mapped root (path-map.ts `buildPathMap`), so its files
 *     can be mutated and get global ids under their repo path;
 *   - the default ignored directories, except that only the fixture itself is kept from
 *     test/fixtures (every other entry there is ignored);
 *   - Stryker's per-mutant timeout deviation at {@link TIMEOUT_MS}: far above any fixture run, so
 *     only the fixture's own limits (Vitest testTimeout and hookTimeout of 2000 ms, the hit
 *     limit) decide its timeout cases;
 *   - `__STRYKER_ACTIVE_MUTANT__` exported in this process's environment while a profile with an
 *     `environment` case runs.
 * Profiles and scopes run one after another.
 *
 * Usage (from gitnexus/):
 *   npm run test:mutation:conformance -- [--out <dir>] [--expected <file>] [--profile <name>]...
 *     [--scope <name>]... [--compare-only]
 * `--out` defaults to `<os tmpdir>/gitnexus-mutation-conformance` (it must lie outside the
 * checkout); each run lands in `<out>/<profile>/<scope>/` and the observed facts of every run in
 * `<out>/observed.json`, in the shape of expected.json's mutant facts, for refreshing it.
 * `--compare-only` skips the runs and compares the results already in `<out>`.
 * Exit codes: 0 every pinned case holds; 1 a case differs (each difference names its case) or a
 * run failed; 2 usage or setup error.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { INSTRUMENTER_CONSTANTS } from '@stryker-mutator/api/core';
import type { RunResults } from '../driver/normalise-results.js';
import { runScope } from '../driver/run-scope.js';
import { DEFAULT_IGNORED_DIRS } from '../driver/stryker-config.js';
import type { SidecarRecord } from '../runner/sidecar.js';
import { errorMessage, isMainModule } from '../shared/cli.js';
import { isInside, readJsonFile } from '../shared/fs.js';
import {
  compareConformance,
  formatDifference,
  observeScopeRun,
  parseExpected,
  type Difference,
  type ExpectedConformance,
  type ObservedScopeRun,
  type Profile,
  type ScopeSpec,
} from './compare.js';

/** The fixture project, relative to the `gitnexus/` package. */
export const FIXTURE_ROOT = 'test/fixtures/mutation-conformance';
const FIXTURE_REPO_ROOT = `gitnexus/${FIXTURE_ROOT}`;
const VITEST = { configFile: `${FIXTURE_ROOT}/vitest.config.ts`, project: 'conformance' };
/** Stryker `timeoutMS`; see the module comment. */
export const TIMEOUT_MS = 60_000;
const ACTIVE_MUTANT_ENV = INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE;
const MARKER_FILE = '.gitnexus-mutation-conformance';
/** Written into each run directory: what the driver exported while that run ran. */
const RUN_RECORD_FILE = 'conformance-run.json';

class UsageError extends Error {
  override name = 'UsageError';
}

/**
 * The scope driver's default ignored directories, with `test/fixtures` replaced by each of its
 * entries except the fixture project, so the Stryker sandbox holds the fixture and no other.
 */
export function conformanceIgnoredDirs(fixtureEntries: readonly string[]): string[] {
  const parent = path.posix.dirname(FIXTURE_ROOT);
  const own = path.posix.basename(FIXTURE_ROOT);
  return [
    ...DEFAULT_IGNORED_DIRS.filter((dir) => dir !== parent),
    ...[...fixtureEntries]
      .filter((entry) => entry !== own)
      .sort()
      .map((entry) => `${parent}/${entry}`),
  ];
}

/** The scope-driver scope file of one expected scope: package- and repo-relative paths. */
export function driverScope(scope: ScopeSpec): { testFiles: string[]; mutate: string[] } {
  return {
    testFiles: scope.testFiles.map((file) => `${FIXTURE_ROOT}/${file}`),
    mutate: scope.mutate.map((file) => `${FIXTURE_REPO_ROOT}/${file}`),
  };
}

/** The local id a profile exports as `__STRYKER_ACTIVE_MUTANT__`, or null. */
export function exportedActiveMutant(
  expected: ExpectedConformance,
  profile: string,
): string | null {
  const entry = expected.cases.find(
    (candidate) => candidate.kind === 'environment' && candidate.profile === profile,
  );
  return entry?.kind === 'environment' ? entry.localId : null;
}

interface Layout {
  out: string;
  runDir: (profile: Profile, scope: ScopeSpec) => string;
  scopeFile: (scope: ScopeSpec) => string;
  observedFile: string;
}

const layoutOf = (out: string): Layout => ({
  out,
  runDir: (profile, scope) => path.join(out, profile.name, scope.name),
  scopeFile: (scope) => path.join(out, 'scopes', `${scope.name}.json`),
  observedFile: path.join(out, 'observed.json'),
});

/** Reads one finished run back from disk. */
function observeRun(layout: Layout, profile: Profile, scope: ScopeSpec): ObservedScopeRun {
  const runDir = layout.runDir(profile, scope);
  const resultsFile = path.join(runDir, 'results.json');
  if (!existsSync(resultsFile)) throw new Error(`no results at ${resultsFile}`);
  const results = readJsonFile(resultsFile) as RunResults;
  const records = new Map<string, SidecarRecord>();
  for (const file of results.mutants.flatMap((mutant) => mutant.sidecar?.file ?? [])) {
    records.set(file, readJsonFile(file) as SidecarRecord);
  }
  const dryRun =
    results.dryRun === null ? null : (readJsonFile(results.dryRun.file) as SidecarRecord);
  const runRecord = path.join(runDir, RUN_RECORD_FILE);
  const exported = existsSync(runRecord)
    ? (readJsonFile(runRecord) as { exportedActiveMutant: string | null }).exportedActiveMutant
    : null;
  return observeScopeRun({
    profile: profile.name,
    scope: scope.name,
    results,
    records,
    dryRunPid: dryRun?.pid ?? null,
    exportedActiveMutant: exported,
    fixtureRoot: FIXTURE_ROOT,
  });
}

async function runPair(
  repoRoot: string,
  layout: Layout,
  profile: Profile,
  scope: ScopeSpec,
  exported: string | null,
): Promise<void> {
  const scopeFile = layout.scopeFile(scope);
  mkdirSync(path.dirname(scopeFile), { recursive: true });
  writeFileSync(scopeFile, `${JSON.stringify(driverScope(scope), null, 2)}\n`);
  const previous = process.env[ACTIVE_MUTANT_ENV];
  if (exported === null) delete process.env[ACTIVE_MUTANT_ENV];
  else process.env[ACTIVE_MUTANT_ENV] = exported;
  try {
    const fixtureEntries = readdirSync(path.join(repoRoot, 'gitnexus', path.dirname(FIXTURE_ROOT)));
    await runScope({
      repoRoot,
      scopeFile,
      outDir: layout.runDir(profile, scope),
      variant: 'vitest5',
      concurrency: profile.concurrency,
      maxTestRunnerReuse: profile.maxTestRunnerReuse,
      timeoutMS: TIMEOUT_MS,
      command: undefined,
      ignoredDirs: conformanceIgnoredDirs(fixtureEntries),
      extraRoots: [FIXTURE_REPO_ROOT],
      vitest: VITEST,
    });
    writeFileSync(
      path.join(layout.runDir(profile, scope), RUN_RECORD_FILE),
      `${JSON.stringify({ exportedActiveMutant: exported }, null, 2)}\n`,
    );
  } finally {
    if (previous === undefined) delete process.env[ACTIVE_MUTANT_ENV];
    else process.env[ACTIVE_MUTANT_ENV] = previous;
  }
}

function prepareOut(repoRoot: string, out: string, compareOnly: boolean): void {
  if (isInside(repoRoot, out) || isInside(out, repoRoot)) {
    throw new UsageError(`--out ${out} must lie outside the checkout ${repoRoot}`);
  }
  if (compareOnly) {
    if (!existsSync(path.join(out, MARKER_FILE))) {
      throw new UsageError(`--compare-only: ${out} holds no conformance run`);
    }
    return;
  }
  if (existsSync(out) && readdirSync(out).length > 0 && !existsSync(path.join(out, MARKER_FILE))) {
    throw new UsageError(
      `${out} is not empty and was not created by this tool; choose another --out`,
    );
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, MARKER_FILE), '');
}

const select = <T extends { name: string }>(
  items: readonly T[],
  names: readonly string[],
  what: string,
): T[] => {
  const unknown = names.filter((name) => !items.some((item) => item.name === name));
  if (unknown.length > 0) throw new UsageError(`unknown ${what} ${JSON.stringify(unknown[0])}`);
  return names.length === 0 ? [...items] : items.filter((item) => names.includes(item.name));
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

async function main(): Promise<void> {
  const packageDir = fileURLToPath(new URL('../../../', import.meta.url));
  const repoRoot = path.dirname(path.resolve(packageDir));
  const started = performance.now();
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        out: { type: 'string', default: path.join(os.tmpdir(), 'gitnexus-mutation-conformance') },
        expected: { type: 'string', default: path.join(packageDir, FIXTURE_ROOT, 'expected.json') },
        profile: { type: 'string', multiple: true, default: [] },
        scope: { type: 'string', multiple: true, default: [] },
        'compare-only': { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    const full = parseExpected(readFileSync(path.resolve(values.expected), 'utf8'));
    const expected: ExpectedConformance = {
      ...full,
      profiles: select(full.profiles, values.profile, 'profile'),
      scopes: select(full.scopes, values.scope, 'scope'),
    };
    const layout = layoutOf(path.resolve(values.out));
    prepareOut(repoRoot, layout.out, values['compare-only']);

    const observed: ObservedScopeRun[] = [];
    const failures: Difference[] = [];
    for (const profile of expected.profiles) {
      const exported = exportedActiveMutant(expected, profile.name);
      for (const scope of expected.scopes) {
        const runStarted = performance.now();
        try {
          if (!values['compare-only']) {
            console.log(
              `conformance: ${profile.name} / ${scope.name}: running (concurrency ` +
                `${profile.concurrency}, maxTestRunnerReuse ${profile.maxTestRunnerReuse}` +
                `${exported === null ? '' : `, ${ACTIVE_MUTANT_ENV}=${exported} exported`})`,
            );
            await runPair(repoRoot, layout, profile, scope, exported);
          }
          observed.push(observeRun(layout, profile, scope));
          console.log(
            `conformance: ${profile.name} / ${scope.name}: ` +
              `${values['compare-only'] ? 'read' : `done in ${seconds(performance.now() - runStarted)}`}`,
          );
        } catch (error) {
          failures.push({
            profile: profile.name,
            scope: scope.name,
            case: 'run',
            detail: errorMessage(error),
          });
        }
      }
    }
    writeFileSync(layout.observedFile, `${JSON.stringify(observed, null, 2)}\n`);
    const differences = [
      ...failures,
      ...compareConformance(expected, observed).filter(
        (difference) =>
          difference.case !== 'run' ||
          !failures.some((f) => f.profile === difference.profile && f.scope === difference.scope),
      ),
    ];
    const total = seconds(performance.now() - started);
    if (differences.length === 0) {
      const cases = expected.cases.filter((entry) =>
        'scope' in entry
          ? expected.scopes.some((scope) => scope.name === entry.scope)
          : expected.profiles.some((profile) => profile.name === entry.profile),
      ).length;
      console.log(
        `conformance: all ${cases} pinned cases hold in ${expected.profiles.length} profile(s) ` +
          `x ${expected.scopes.length} scope(s); total ${total}; observed facts in ${layout.observedFile}`,
      );
      process.exitCode = 0;
      return;
    }
    console.error(`conformance: ${differences.length} difference(s); total ${total}`);
    for (const difference of differences) console.error(`  ${formatDifference(difference)}`);
    console.error(`  observed facts: ${layout.observedFile}`);
    process.exitCode = 1;
  } catch (error) {
    console.error(errorMessage(error));
    if (error instanceof UsageError || error instanceof TypeError) {
      console.error(
        'usage: npm run test:mutation:conformance -- [--out <dir>] [--expected <file>] ' +
          '[--profile <name>]... [--scope <name>]... [--compare-only]',
      );
    }
    process.exitCode = 2;
  }
}

if (isMainModule(import.meta.url)) {
  void main();
}
