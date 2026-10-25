/**
 * Layer 3 group and shard runs of the scenario map (U7, R6, R7, R11, KTD7, KTD8, KTD14, KTD17).
 *
 * Run manifest (KTD14, {@link ScenarioRunManifest}, `scenario-run-manifest.json`, schema 1). The
 * plan stage writes it from its freshly prepared copy, before anything runs there; every shard and
 * the value-flow job verify their own prepared copy against it ({@link verifyPreparedCopy}):
 *   mode                 run mode (`normal`, or `controls` with the fixture root)
 *   tests[]              the eligible tests: Phase 0 id and package path, sorted by id
 *   files                prepared-root-relative POSIX path (`gitnexus/…`, including the relocated
 *                        `gitnexus/relocated/gitnexus-shared/…`) to the sha256 of its content, for
 *                        every file of the prepared package; a symlink hashes as `symlink:<target>`;
 *                        the package's `node_modules` link and run caches (`.stryker-tmp`,
 *                        `.vitest5-runner`) are left out
 *   versions             installed `vitest` and `@stryker-mutator/core`
 *   digest               sha256 over `files` and `versions`
 * A mismatch makes the shard's results invalid: each of its groups gets a `manifest-mismatch`
 * result and nothing runs.
 *
 * Group run ({@link runGroup}), for one planned group (plan-shards.ts `GroupScope`):
 *   1. every group test must be in the run manifest;
 *   2. two plain Vitest 5 baselines of the group's tests in the shard's verified copy
 *      (vitest-run.ts, a fresh Vitest each): each must pass every test, and both must run the
 *      same identities (Phase 0 id and location), else the group is Inconclusive
 *      (`baseline-failed`, `baseline-unstable`) and emits no observations (KTD8);
 *   3. the driver scope (`testFiles`, `testIds`, the whole-file `mutate` list, KTD7) and its
 *      Stryker config: the config must carry perTest coverage, `disableBail` and static mutants
 *      ({@link assertMutationConfig}) before any mutant runs, else `config-invalid`;
 *   4. the scope driver (tools/mutation/driver/run-scope.ts) runs Stryker on the vitest5 runner;
 *      the config it wrote is checked again, and its dry run must pass with the baselines'
 *      identities (`dry-run-unstable`); a driver failure is `stryker-failed`;
 *   5. the run universe and the explicit observations (observations.ts, compact model: the
 *      unstored ones are implied by the universe) are extracted and the group result is written at
 *      once to `<work>/observations/<group>.json` ({@link GroupObservations}), whatever the
 *      outcome, so a later failure of the shard loses nothing (KTD17).
 * Group result file (schema 2, {@link writeGroupObservations}, {@link readGroupObservations}): the
 * group outcome, scope, baselines and Stryker summary, `runUniverse` (null unless complete) and
 * `observations`, the explicit observations as rows of the universe (observations.ts
 * `ObservationRow`). Schema 1 materialised one observation per test and mutant, which overflowed
 * V8's string limit on large runs; a schema 1 file is rejected.
 * Steps 1 to 4 are {@link runMutationRun}, which the isolation pass's together and alone runs
 * (isolation.ts, U8) share, so every Layer 3 Stryker run passes the same KTD8 checks.
 *
 * Shard run ({@link runShard}): prepares `<work>/shard-<n>/prepared` (tools/mutation/prepare,
 * nothing blanked), verifies it against the run manifest, then runs its planned groups in order,
 * starting each only when its estimate fits before the deadline (plan-shards.ts); a group it does
 * not start writes no result (its pairs are `not-scheduled`). It writes `<work>/shard-<n>.json`
 * ({@link ShardReport}). Work layout, every path under the work directory (outside the checkout):
 *   observations/<group>.json   group results      groups/<group>/baseline-{1,2}/   Vitest scratch
 *   groups/<group>/scope.json   driver scope       groups/<group>/stryker/          driver run
 *   shard-<n>/prepared/         verified copy      shard-<n>.json                   shard report
 *
 * Library only; the scenario-map CLI (U14) calls {@link runShard}. Every runner is injected
 * ({@link GroupRunDeps}), so unit tests never spawn Vitest or Stryker.
 */
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { RunResults } from '../../mutation/driver/normalise-results.js';
import { runScope, type RunScopeOptions } from '../../mutation/driver/run-scope.js';
import {
  DEFAULT_IGNORED_DIRS,
  buildStrykerConfig,
  parseDriverScope,
  type StrykerConfigInput,
} from '../../mutation/driver/stryker-config.js';
import { PACKAGE_DIR, buildPathMap } from '../../mutation/prepare/path-map.js';
import {
  prepare,
  type PrepareOptions,
  type PrepareReport,
} from '../../mutation/prepare/prepare.js';
import type { OutcomeClass } from '../../mutation/runner/classify-outcome.js';
import { readRunManifest, type RunManifest } from '../../mutation/runner/run-manifest.js';
import { parseTestId, type TestLocation } from '../../mutation/runner/test-ids.js';
import { errorMessage } from '../../mutation/shared/cli.js';
import { isInside, readJsonFile } from '../../mutation/shared/fs.js';
import { extraRootsOf, toPackagePath, type RunMode } from '../types.js';
import {
  MAIN_LINEAGE,
  decodeObservations,
  encodeObservations,
  extractObservations,
  isEvaluated,
  isRunUniverse,
  type Observation,
  type ObservationRow,
  type RunUniverse,
} from './observations.js';
import {
  fitsBeforeDeadline,
  type GroupOutcome,
  type GroupScope,
  type GroupStatusReason,
  type ShardPlan,
} from './plan-shards.js';
import {
  runVitest,
  vitestSelectionOf,
  type VitestRunOptions,
  type VitestRunResult,
} from './vitest-run.js';

// ── Run manifest (KTD14) ──────────────────────────────────────────────────

export const RUN_MANIFEST_SCHEMA_VERSION = 1;
export const RUN_MANIFEST_FILE = 'scenario-run-manifest.json';

export interface ToolVersions {
  vitest: string;
  stryker: string;
}

export interface ScenarioRunManifest {
  schemaVersion: typeof RUN_MANIFEST_SCHEMA_VERSION;
  mode: RunMode;
  /** Eligible tests, sorted by id. */
  tests: { id: string; file: string }[];
  digest: string;
  files: Record<string, string>;
  versions: ToolVersions;
}

export interface ManifestCheck {
  ok: boolean;
  /** `changed: <path>`, `missing: <path>`, `extra: <path>`, `<tool> <a> -> <b>`; capped. */
  mismatches: string[];
}

/** Top-level entries of the prepared package that are no input: the dependency link, run caches. */
const UNHASHED = new Set(['node_modules', '.stryker-tmp', '.vitest5-runner']);
const MAX_MISMATCHES = 20;

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every file of the prepared package, as `{<prepared-root-relative path>: sha256}`, sorted. */
export function hashPreparedTree(preparedRoot: string): Record<string, string> {
  const hashes: [string, string][] = [];
  const visit = (relative: string, top: boolean): void => {
    for (const entry of readdirSync(path.join(preparedRoot, relative)).sort(byText)) {
      if (top && UNHASHED.has(entry)) continue;
      const child = `${relative}/${entry}`;
      const absolute = path.join(preparedRoot, child);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) hashes.push([child, sha256(`symlink:${readlinkSync(absolute)}`)]);
      else if (stat.isDirectory()) visit(child, false);
      else if (stat.isFile()) hashes.push([child, sha256(readFileSync(absolute))]);
    }
  };
  visit(PACKAGE_DIR, true);
  return Object.fromEntries(hashes.sort(([a], [b]) => byText(a, b)));
}

function installedVersion(preparedRoot: string, name: string): string {
  const file = path.join(preparedRoot, PACKAGE_DIR, 'node_modules', name, 'package.json');
  const data = readJsonFile(file);
  if (typeof data !== 'object' || data === null || !('version' in data)) {
    throw new Error(`run manifest: ${file} names no version`);
  }
  return String(data.version);
}

const toolVersions = (preparedRoot: string): ToolVersions => ({
  vitest: installedVersion(preparedRoot, 'vitest'),
  stryker: installedVersion(preparedRoot, '@stryker-mutator/core'),
});

const digestOf = (files: Readonly<Record<string, string>>, versions: ToolVersions): string =>
  sha256(
    JSON.stringify({
      files: Object.entries(files).sort(([a], [b]) => byText(a, b)),
      versions: [versions.vitest, versions.stryker],
    }),
  );

/** The run manifest of a freshly prepared copy and the eligible tests (Phase 0 ids). */
export function buildRunManifest(input: {
  preparedRoot: string;
  mode: RunMode;
  tests: readonly string[];
}): ScenarioRunManifest {
  const files = hashPreparedTree(input.preparedRoot);
  const versions = toolVersions(input.preparedRoot);
  return {
    schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
    mode: input.mode,
    tests: [...new Set(input.tests)].sort(byText).map((id) => ({ id, file: parseTestId(id).file })),
    digest: digestOf(files, versions),
    files,
    versions,
  };
}

/** Compares a prepared copy with the run manifest; see the module comment. */
export function verifyPreparedCopy(
  manifest: ScenarioRunManifest,
  preparedRoot: string,
): ManifestCheck {
  const mismatches: string[] = [];
  if (digestOf(manifest.files, manifest.versions) !== manifest.digest) {
    mismatches.push('the run manifest digest does not match its own files');
  }
  const files = hashPreparedTree(preparedRoot);
  const paths = [...new Set([...Object.keys(manifest.files), ...Object.keys(files)])].sort(byText);
  for (const file of paths) {
    const [expected, actual] = [manifest.files[file], files[file]];
    if (expected === actual) continue;
    if (actual === undefined) mismatches.push(`missing: ${file}`);
    else if (expected === undefined) mismatches.push(`extra: ${file}`);
    else mismatches.push(`changed: ${file}`);
  }
  const versions = toolVersions(preparedRoot);
  for (const tool of ['vitest', 'stryker'] as const) {
    if (manifest.versions[tool] !== versions[tool]) {
      mismatches.push(`${tool} ${manifest.versions[tool]} -> ${versions[tool]}`);
    }
  }
  const shown =
    mismatches.length > MAX_MISMATCHES
      ? [...mismatches.slice(0, MAX_MISMATCHES), `and ${mismatches.length - MAX_MISMATCHES} more`]
      : mismatches;
  return { ok: mismatches.length === 0, mismatches: shown };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isRunManifest = (value: unknown): value is ScenarioRunManifest =>
  isRecord(value) &&
  value.schemaVersion === RUN_MANIFEST_SCHEMA_VERSION &&
  isRecord(value.mode) &&
  isRecord(value.files) &&
  isRecord(value.versions) &&
  Array.isArray(value.tests) &&
  typeof value.digest === 'string';

/** Reads a run manifest file; a wrong schema or an inconsistent digest throws. */
export function readScenarioRunManifest(file: string): ScenarioRunManifest {
  const manifest = readJsonFile(file);
  if (!isRunManifest(manifest)) {
    throw new Error(`run manifest: ${file} is not a scenario-map run manifest`);
  }
  if (digestOf(manifest.files, manifest.versions) !== manifest.digest) {
    throw new Error(`run manifest: ${file} has a digest that does not match its files`);
  }
  return manifest;
}

export function writeScenarioRunManifest(dir: string, manifest: ScenarioRunManifest): string {
  const file = path.join(dir, RUN_MANIFEST_FILE);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

// ── Checks (KTD8) ─────────────────────────────────────────────────────────

/**
 * Throws unless a generated Stryker config carries perTest coverage, `disableBail` and static
 * mutants (Stryker's `ignoreStatic` not set) (KTD8).
 */
export function assertMutationConfig(config: unknown): void {
  if (!isRecord(config)) throw new Error('mutation config: not a config object');
  const missing = [
    config.coverageAnalysis === 'perTest' ? '' : 'perTest coverage (coverageAnalysis)',
    config.disableBail === true ? '' : 'disableBail',
    config.ignoreStatic === undefined || config.ignoreStatic === false
      ? ''
      : 'static mutants (ignoreStatic is set)',
  ].filter((entry) => entry !== '');
  if (missing.length > 0) {
    throw new Error(`mutation config: the generated config lacks ${missing.join(', ')}`);
  }
}

export interface BaselineSummary {
  wallClockMs: number;
  /** The run's outcome class (classify-outcome.ts). */
  outcome: OutcomeClass;
  /** `<id>@<line>:<column>` of every requested test that ran, sorted. */
  identities: string[];
  /** Requested tests that did not pass. */
  failing: { test: string; outcome: OutcomeClass | null; message: string | null }[];
  /** Selection problems and unhandled errors. */
  problems: string[];
}

/** A test's execution identity: its Phase 0 id and location (KTD3). */
const identityOf = (test: { id: string; location: TestLocation | null }): string =>
  `${test.id}@${test.location === null ? '?' : `${test.location.line}:${test.location.column}`}`;

export function summarizeBaseline(run: VitestRunResult): BaselineSummary {
  return {
    wallClockMs: run.wallClockMs,
    outcome: run.outcome,
    identities: run.tests
      .filter((test) => test.state === 'passed' || test.state === 'failed')
      .map(identityOf)
      .sort(byText),
    failing: run.tests
      .filter((test) => test.outcome !== 'survived')
      .map((test) => ({ test: test.id, outcome: test.outcome, message: test.message })),
    problems: [...run.problems, ...run.unhandledErrors.map((error) => `unhandled error: ${error}`)],
  };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((entry, index) => b[index] === entry);

const listDifference = (a: readonly string[], b: readonly string[]): string[] =>
  a.filter((entry) => !b.includes(entry));

/** The KTD8 baseline rule: every baseline passes, all with the first one's identities. */
export function checkBaselines(
  baselines: readonly BaselineSummary[],
): { reason: 'baseline-failed' | 'baseline-unstable'; detail: string } | null {
  for (const [index, baseline] of baselines.entries()) {
    const why = [
      ...baseline.problems,
      ...baseline.failing.map(
        (entry) =>
          `${entry.test} ${entry.outcome ?? 'no result'}` +
          (entry.message === null ? '' : `: ${entry.message}`),
      ),
    ];
    if (why.length === 0 && baseline.outcome !== 'survived') why.push(`run ${baseline.outcome}`);
    if (why.length > 0) {
      return { reason: 'baseline-failed', detail: `baseline ${index + 1}: ${why.join('; ')}` };
    }
  }
  const [first, ...rest] = baselines;
  for (const [index, baseline] of rest.entries()) {
    if (!sameList(first.identities, baseline.identities)) {
      return {
        reason: 'baseline-unstable',
        detail:
          `baseline ${index + 2} ran other identities than baseline 1: only in 1: ` +
          `${JSON.stringify(listDifference(first.identities, baseline.identities))}; only in ` +
          `${index + 2}: ${JSON.stringify(listDifference(baseline.identities, first.identities))}`,
      };
    }
  }
  return null;
}

/** Why Stryker's dry run does not match the baselines (KTD8); null when it does. */
function dryRunProblem(
  results: RunResults,
  readManifest: (runDir: string) => RunManifest,
  identities: readonly string[],
): string | null {
  if (results.dryRun === null) return 'the run wrote no dry-run record';
  if (results.dryRun.outcome !== 'survived') return `the dry run is ${results.dryRun.outcome}`;
  if (results.paths.runDir === null) return 'the run has no run directory';
  const ran = readManifest(results.paths.runDir)
    .files.flatMap((file) => file.tests.map(identityOf))
    .sort(byText);
  if (sameList(ran, identities)) return null;
  return (
    `the dry run ran other identities: only in the baselines: ` +
    `${JSON.stringify(listDifference(identities, ran))}; only in the dry run: ` +
    JSON.stringify(listDifference(ran, identities))
  );
}

/**
 * The Stryker sandbox's ignored directories: the driver's defaults, and in controls mode
 * `test/fixtures` replaced by each of its entries except the fixture project (as gate 2's
 * conformance driver does), so the sandbox holds the fixture and no other.
 */
export function sandboxIgnoredDirs(mode: RunMode, fixtureEntries: readonly string[]): string[] {
  if (mode.kind !== 'controls') return [...DEFAULT_IGNORED_DIRS];
  const fixture = toPackagePath(mode.fixtureRoot).replace(/\/+$/, '');
  const parent = path.posix.dirname(fixture);
  const own = path.posix.basename(fixture);
  return [
    ...DEFAULT_IGNORED_DIRS.filter((dir) => dir !== parent),
    ...[...fixtureEntries]
      .filter((entry) => entry !== own)
      .sort(byText)
      .map((entry) => `${parent}/${entry}`),
  ];
}

const fixtureEntriesOf = (repoRoot: string, mode: RunMode): string[] =>
  mode.kind === 'controls'
    ? readdirSync(path.join(repoRoot, path.posix.dirname(mode.fixtureRoot.replace(/\/+$/, ''))))
    : [];

// ── Group run ─────────────────────────────────────────────────────────────

/** 2: the compact model, a run universe plus explicit observations as rows (observations.ts). */
export const GROUP_OBSERVATIONS_SCHEMA_VERSION = 2;

export interface StrykerSettings {
  concurrency: number;
  maxTestRunnerReuse: number;
  timeoutMS: number;
}

/** The scope driver CLI's defaults. */
export const DEFAULT_STRYKER_SETTINGS: Readonly<StrykerSettings> = Object.freeze({
  concurrency: 2,
  maxTestRunnerReuse: 0,
  timeoutMS: 10_000,
});

export interface StrykerSummary {
  exitCode: number;
  wallClockMs: number;
  /** Absolute path of the driver's `results.json`. */
  resultsFile: string;
  mutants: number;
  /** Mutants in the universe (neither Ignored nor Pending). */
  evaluated: number;
  /** Integrity flags of the run (normalise-results.ts). */
  flags: number;
}

/** One group's result file; see the module comment. */
export interface GroupObservations extends GroupOutcome {
  schemaVersion: typeof GROUP_OBSERVATIONS_SCHEMA_VERSION;
  scope: GroupScope;
  baselines: BaselineSummary[];
  stryker: StrykerSummary | null;
  /** The run universe that implies the unstored observations; null unless complete. */
  runUniverse: RunUniverse | null;
  /** Explicit observations; empty unless the group is complete. */
  observations: Observation[];
  wallClockMs: number;
}

/** A group result as written: its explicit observations as rows of its run universe. */
export type GroupObservationsFile = Omit<GroupObservations, 'observations'> & {
  observations: ObservationRow[];
};

export interface GroupRunDeps {
  runVitest: (options: VitestRunOptions) => Promise<VitestRunResult>;
  runScope: (options: RunScopeOptions) => Promise<{ results: RunResults; exitCode: number }>;
  buildConfig: (input: StrykerConfigInput) => unknown;
  readJson: (file: string) => unknown;
  readDryRunManifest: (runDir: string) => RunManifest;
  /** Milliseconds on a monotonic clock. */
  now: () => number;
}

export const defaultGroupRunDeps: GroupRunDeps = {
  runVitest,
  runScope,
  buildConfig: buildStrykerConfig,
  readJson: readJsonFile,
  readDryRunManifest: readRunManifest,
  now: () => performance.now(),
};

export interface GroupRunOptions {
  /** Absolute repo checkout. */
  repoRoot: string;
  /** Absolute work directory, outside the checkout. */
  workDir: string;
  shard: number;
  /** The run manifest the shard verified its prepared copy against. */
  manifest: ScenarioRunManifest;
  /** Absolute prepared `gitnexus/` package of the shard's verified copy. */
  packageDir: string;
  scope: GroupScope;
  stryker?: Partial<StrykerSettings>;
}

const SAFE_GROUP_ID = /^[A-Za-z0-9_-]+$/;

/** `<work>/observations/<group>.json`. */
export function observationsFile(workDir: string, group: string): string {
  if (!SAFE_GROUP_ID.test(group)) {
    throw new Error(`group run: unsafe group id ${JSON.stringify(group)}`);
  }
  return path.join(workDir, 'observations', `${group}.json`);
}

const isGroupObservationsFile = (value: unknown): value is GroupObservationsFile =>
  isRecord(value) &&
  value.schemaVersion === GROUP_OBSERVATIONS_SCHEMA_VERSION &&
  typeof value.group === 'string' &&
  typeof value.manifestDigest === 'string' &&
  isRecord(value.scope) &&
  (value.runUniverse === null || isRunUniverse(value.runUniverse)) &&
  Array.isArray(value.observations) &&
  Array.isArray(value.tests);

/** Writes a group result (any extra fields kept), its observations as universe rows. */
export function writeGroupObservations<T extends GroupObservations>(file: string, result: T): void {
  const written: GroupObservationsFile = {
    ...result,
    observations: encodeObservations(result.runUniverse, result.observations),
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(written)}\n`);
}

/** Reads a group result file; another schema (schema 1 included) or a malformed row throws. */
export function readGroupObservations(file: string): GroupObservations {
  const data = readJsonFile(file);
  if (isRecord(data) && data.schemaVersion !== GROUP_OBSERVATIONS_SCHEMA_VERSION) {
    throw new Error(
      `group run: ${file} has schema ${JSON.stringify(data.schemaVersion)}, not ` +
        `${GROUP_OBSERVATIONS_SCHEMA_VERSION}: it was written before the compact observation ` +
        'model (one observation per test and mutant); re-run its shard',
    );
  }
  if (!isGroupObservationsFile(data)) {
    throw new Error(`group run: ${file} is not a group observations file`);
  }
  return { ...data, observations: decodeObservations(data.runUniverse, data.observations) };
}

interface GroupResultInput {
  scope: GroupScope;
  shard: number;
  manifestDigest: string;
  status: GroupObservations['status'];
  reason: GroupStatusReason | null;
  detail: string | null;
  baselines: BaselineSummary[];
  stryker: StrykerSummary | null;
  runUniverse: RunUniverse | null;
  observations: Observation[];
  wallClockMs: number;
}

/** Builds a group result and writes it at once (KTD17). */
function writeGroupResult(workDir: string, input: GroupResultInput): GroupObservations {
  const result: GroupObservations = {
    schemaVersion: GROUP_OBSERVATIONS_SCHEMA_VERSION,
    group: input.scope.id,
    shard: input.shard,
    manifestDigest: input.manifestDigest,
    status: input.status,
    reason: input.reason,
    detail: input.detail,
    tests: [...input.scope.tests],
    scope: scopeOf(input.scope),
    baselines: input.baselines,
    stryker: input.stryker,
    runUniverse: input.runUniverse,
    observations: input.observations,
    wallClockMs: input.wallClockMs,
  };
  writeGroupObservations(observationsFile(workDir, result.group), result);
  return result;
}

const scopeOf = (scope: GroupScope): GroupScope => ({
  id: scope.id,
  tests: scope.tests,
  testFiles: scope.testFiles,
  pairs: scope.pairs,
  mutate: scope.mutate,
  excluded: scope.excluded,
  closureIncomplete: scope.closureIncomplete,
  provenanceUnknown: scope.provenanceUnknown,
});

const strykerSummary = (results: RunResults): StrykerSummary => ({
  exitCode: results.stryker.exitCode,
  wallClockMs: results.stryker.wallClockMs,
  resultsFile: path.join(results.paths.outDir, 'results.json'),
  mutants: results.mutants.length,
  evaluated: results.mutants.filter(isEvaluated).length,
  flags: results.flags.length,
});

/**
 * One validated Stryker run of a set of tests (steps 1 to 4 of the module comment), shared by the
 * group run and the isolation pass's together and alone runs (isolation.ts, U8).
 */
export interface MutationRunInput {
  /** Absolute repo checkout. */
  repoRoot: string;
  manifest: ScenarioRunManifest;
  /** Absolute prepared `gitnexus/` package of the shard's verified copy. */
  packageDir: string;
  /** Absolute scratch directory: `baseline-{1,2}/`, `scope.json`, `stryker/`; must exist. */
  runDir: string;
  /** Phase 0 ids of the tests to run, sorted. */
  tests: readonly string[];
  /** Package paths of their files, sorted. */
  testFiles: readonly string[];
  /** Driver mutate entries: whole files (KTD7) or Stryker ranges (KTD9). */
  mutate: readonly string[];
  settings: StrykerSettings;
}

export interface MutationRunOutcome {
  baselines: BaselineSummary[];
  stryker: StrykerSummary | null;
  /** The driver's results; null unless the run passed every KTD8 check. */
  results: RunResults | null;
  /** Why the run gives no usable observations; null when it does. */
  failure: { reason: GroupStatusReason; detail: string } | null;
}

/** Runs and checks one Stryker run (KTD8); see {@link MutationRunInput}. Never throws. */
export async function runMutationRun(
  input: MutationRunInput,
  deps: GroupRunDeps = defaultGroupRunDeps,
): Promise<MutationRunOutcome> {
  const { manifest, runDir } = input;
  const baselines: BaselineSummary[] = [];
  let stryker: StrykerSummary | null = null;
  const inconclusive = (reason: GroupStatusReason, detail: string): MutationRunOutcome => ({
    baselines,
    stryker,
    results: null,
    failure: { reason, detail },
  });

  const listed = new Set(manifest.tests.map((test) => test.id));
  const unlisted = input.tests.filter((test) => !listed.has(test));
  if (unlisted.length > 0) {
    return inconclusive('manifest-mismatch', `not in the run manifest: ${unlisted.join(', ')}`);
  }

  const selection = vitestSelectionOf(manifest.mode);
  for (const index of [1, 2]) {
    try {
      const run = await deps.runVitest({
        packageDir: input.packageDir,
        testIds: input.tests,
        vitest: selection,
        workDir: path.join(runDir, `baseline-${index}`),
      });
      baselines.push(summarizeBaseline(run));
    } catch (error) {
      return inconclusive('baseline-failed', `baseline ${index}: ${errorMessage(error)}`);
    }
    const problem = checkBaselines(baselines);
    if (problem !== null) return inconclusive(problem.reason, problem.detail);
  }

  const extraRoots = extraRootsOf(manifest.mode);
  const pathMap = buildPathMap(extraRoots);
  const scopeText = `${JSON.stringify(
    { testFiles: input.testFiles, mutate: input.mutate, testIds: input.tests },
    null,
    2,
  )}\n`;
  const scopeFile = path.join(runDir, 'scope.json');
  const strykerDir = path.join(runDir, 'stryker');
  const ignoredDirs = sandboxIgnoredDirs(
    manifest.mode,
    fixtureEntriesOf(input.repoRoot, manifest.mode),
  );
  // Normal mode keeps the runner's default config and project, as every Phase 0 run does.
  const strykerVitest = manifest.mode.kind === 'controls' ? selection : undefined;
  const { settings } = input;
  try {
    const driverScope = parseDriverScope(scopeText, pathMap);
    writeFileSync(scopeFile, scopeText);
    assertMutationConfig(
      deps.buildConfig({
        variant: 'vitest5',
        outDir: strykerDir,
        mutate: driverScope.mutate,
        ...settings,
        ignoredDirs,
        pathMap,
        vitest: strykerVitest,
        testIds: driverScope.testIds,
      }),
    );
  } catch (error) {
    return inconclusive('config-invalid', errorMessage(error));
  }

  let results: RunResults;
  try {
    ({ results } = await deps.runScope({
      repoRoot: input.repoRoot,
      scopeFile,
      outDir: strykerDir,
      variant: 'vitest5',
      ...settings,
      command: undefined,
      ignoredDirs,
      extraRoots,
      vitest: strykerVitest,
    }));
  } catch (error) {
    return inconclusive('stryker-failed', errorMessage(error));
  }
  stryker = strykerSummary(results);
  try {
    assertMutationConfig(deps.readJson(results.paths.configFile));
  } catch (error) {
    return inconclusive('config-invalid', `${results.paths.configFile}: ${errorMessage(error)}`);
  }
  let dryRun: string | null;
  try {
    dryRun = dryRunProblem(results, deps.readDryRunManifest, baselines[0].identities);
  } catch (error) {
    dryRun = errorMessage(error);
  }
  if (dryRun !== null) return inconclusive('dry-run-unstable', dryRun);
  return { baselines, stryker, results, failure: null };
}

/** Runs one group; see the module comment. Always writes and returns its result. */
export async function runGroup(
  options: GroupRunOptions,
  deps: GroupRunDeps = defaultGroupRunDeps,
): Promise<GroupObservations> {
  const started = deps.now();
  const { scope, manifest } = options;
  // Validates the group id before any path is built from it.
  observationsFile(options.workDir, scope.id);
  const groupDir = path.join(options.workDir, 'groups', scope.id);
  mkdirSync(groupDir, { recursive: true });
  const run = await runMutationRun(
    {
      repoRoot: options.repoRoot,
      manifest,
      packageDir: options.packageDir,
      runDir: groupDir,
      tests: scope.tests,
      testFiles: scope.testFiles,
      mutate: scope.mutate,
      settings: { ...DEFAULT_STRYKER_SETTINGS, ...options.stryker },
    },
    deps,
  );
  const extracted =
    run.results === null
      ? null
      : extractObservations(run.results, {
          group: scope.id,
          kind: 'main',
          lineage: MAIN_LINEAGE,
          shard: options.shard,
        });
  return writeGroupResult(options.workDir, {
    scope,
    shard: options.shard,
    manifestDigest: manifest.digest,
    status: run.failure === null ? 'complete' : 'inconclusive',
    reason: run.failure?.reason ?? null,
    detail: run.failure?.detail ?? null,
    baselines: run.baselines,
    stryker: run.stryker,
    runUniverse: extracted?.universe ?? null,
    observations: extracted?.observations ?? [],
    wallClockMs: Math.round(deps.now() - started),
  });
}

// ── Shard run ─────────────────────────────────────────────────────────────

export const SHARD_REPORT_SCHEMA_VERSION = 1;

export interface ShardReport {
  schemaVersion: typeof SHARD_REPORT_SCHEMA_VERSION;
  shard: number;
  manifestDigest: string;
  manifestCheck: ManifestCheck;
  /** Groups with a result file, in run order. */
  ran: {
    group: string;
    status: GroupObservations['status'];
    reason: GroupStatusReason | null;
    wallClockMs: number;
  }[];
  /** Groups not started: their estimate did not fit before the deadline. */
  notStarted: { group: string; estimateMs: number; elapsedMs: number }[];
  wallClockMs: number;
}

export interface ShardRunDeps extends GroupRunDeps {
  prepare: (options: PrepareOptions) => PrepareReport;
}

export const defaultShardRunDeps: ShardRunDeps = { ...defaultGroupRunDeps, prepare };

export interface ShardRunOptions {
  repoRoot: string;
  /** Absolute work directory, outside the checkout; shared with the other stages. */
  workDir: string;
  /** 0-based shard index of the plan. */
  shard: number;
  plan: ShardPlan;
  manifest: ScenarioRunManifest;
  stryker?: Partial<StrykerSettings>;
  /** Defaults to plan-shards.ts `SHARD_DEADLINE_MS`. */
  deadlineMs?: number;
}

/** `<work>/shard-<n>.json`. */
export const shardReportFile = (workDir: string, shard: number): string =>
  path.join(workDir, `shard-${shard}.json`);

/** Runs one shard of the plan; see the module comment. */
export async function runShard(
  options: ShardRunOptions,
  deps: ShardRunDeps = defaultShardRunDeps,
): Promise<ShardReport> {
  const started = deps.now();
  const { plan, manifest, shard, workDir, repoRoot } = options;
  const assignment = plan.shards.find((entry) => entry.index === shard);
  if (assignment === undefined) throw new Error(`shard run: the plan has no shard ${shard}`);
  if (isInside(repoRoot, workDir) || isInside(workDir, repoRoot)) {
    throw new Error(`shard run: the work directory ${workDir} must lie outside ${repoRoot}`);
  }
  const planned = new Map(plan.groups.map((group) => [group.id, group]));
  mkdirSync(workDir, { recursive: true });
  // A result left by an earlier run would read as this run's.
  for (const group of assignment.groups) rmSync(observationsFile(workDir, group), { force: true });

  const preparedRoot = path.join(workDir, `shard-${shard}`, 'prepared');
  deps.prepare({
    repoRoot,
    outDir: preparedRoot,
    mutate: [],
    pathMap: buildPathMap(extraRootsOf(manifest.mode)),
  });
  const manifestCheck = verifyPreparedCopy(manifest, preparedRoot);
  const ran: ShardReport['ran'] = [];
  const notStarted: ShardReport['notStarted'] = [];
  for (const id of assignment.groups) {
    const group = planned.get(id);
    if (group === undefined) throw new Error(`shard run: group ${id} is not in the plan`);
    if (!manifestCheck.ok) {
      writeGroupResult(workDir, {
        scope: group,
        shard,
        manifestDigest: manifest.digest,
        status: 'inconclusive',
        reason: 'manifest-mismatch',
        detail: `the prepared copy differs from the run manifest: ${manifestCheck.mismatches.join('; ')}`,
        baselines: [],
        stryker: null,
        runUniverse: null,
        observations: [],
        wallClockMs: 0,
      });
      ran.push({ group: id, status: 'inconclusive', reason: 'manifest-mismatch', wallClockMs: 0 });
      continue;
    }
    const elapsedMs = deps.now() - started;
    if (!fitsBeforeDeadline(group.estimateMs, elapsedMs, options.deadlineMs)) {
      notStarted.push({
        group: id,
        estimateMs: group.estimateMs,
        elapsedMs: Math.round(elapsedMs),
      });
      continue;
    }
    const result = await runGroup(
      {
        repoRoot,
        workDir,
        shard,
        manifest,
        packageDir: path.join(preparedRoot, PACKAGE_DIR),
        scope: group,
        stryker: options.stryker,
      },
      deps,
    );
    ran.push({
      group: id,
      status: result.status,
      reason: result.reason,
      wallClockMs: result.wallClockMs,
    });
  }
  const report: ShardReport = {
    schemaVersion: SHARD_REPORT_SCHEMA_VERSION,
    shard,
    manifestDigest: manifest.digest,
    manifestCheck,
    ran,
    notStarted,
    wallClockMs: Math.round(deps.now() - started),
  };
  writeFileSync(shardReportFile(workDir, shard), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
