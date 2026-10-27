/**
 * Layer 1 of the scenario map: per-test V8 coverage, provenance and candidate retrieval (U4, R3,
 * R4, KTD4, KTD5, KTD7, design §5.2).
 *
 *   1. The fingerprint's test files (inventory/eligible.ts `fingerprintFiles`: every unit and
 *      integration test in normal mode), or a `--file` subset of them.
 *   2. A prepared copy (tools/mutation/prepare/prepare.ts, nothing blanked), so `gitnexus-shared`
 *      runs from its relocated source and every path maps back through path-map.ts (KTD4); in
 *      normal mode the checkout's `vendor/` and `dist/` are copied in (./partitions.ts
 *      `copyBuildOutput`).
 *   3. Two partitions (./partitions.ts): the base config's sequential project files with one
 *      worker, then the rest; each has its `<out>/scope-<partition>.json`
 *      (tools/mutation/scope-file.ts) naming its files. They run in the prepared
 *      package, through the Vitest Node API with the environment `vitest run` sets, under
 *      tools/mutation/vitest.mutation.config.ts (project `mutation`) or, in controls mode, the
 *      fixture project's own vitest.config.ts, with at most `maxWorkers` worker processes
 *      (`--concurrency`; the scenario-map CLI passes its own). Every test runs twice (`repeats: 1`,
 *      design §5.2: the warm run gives the blocks). The coverage hook (coverage.setup.ts) is put first among the
 *      setup files and writes one raw record per test file (records.ts).
 *   4. The raw records become the work file `<out>/coverage.json` ({@link buildWorkFile}).
 *   5. The tests are joined to the static inventory (inventory/identity.ts), their
 *      checks-and-context keys computed (facet/checks.ts) and candidates retrieved
 *      (candidates.ts) into `<out>/candidates.json`.
 *
 * Work file (schema version {@link WORK_FILE_SCHEMA_VERSION}, {@link CoverageWorkFile}):
 *   mode, extraRoots, repeats   the run's mode, its extra path-map roots, Vitest `repeats`
 *   blocks: string[]            sorted block ids `<repo path>#<function or <anon>>@<start>` and
 *                               `<repo path>#<function>@<start>|<start>-<end>:<1|0>` (a nested
 *                               range and whether it ran); production files only (KTD7), and only
 *                               blocks some test owns; offsets are in Vite's transformed code
 *   files[]                     per test file (package path): `recorded` (the hook wrote a record),
 *                               module `errors`, and `unattributed` provenance (module load,
 *                               `afterAll` hooks, the tail), which no test's provenance includes
 *   tests[]                     per collected test, files in order, collection order within one:
 *     id                        Phase 0 test id (tools/mutation/runner/test-ids.ts)
 *     taskId, file, fullName, location   what inventory/identity.ts `joinRuntime` takes
 *     state, concurrent, attempts        Vitest result; concurrent task; windows seen (0: not run)
 *     blocks: number[]          indices into `blocks`: the warm attempt's own blocks and those of
 *                               the `beforeAll` windows of its suites; empty for a concurrent test,
 *                               whose windows interleave with its siblings' (path unattributable)
 *     suiteBlocks: number[]     the part of `blocks` that came from its suites' `beforeAll`
 *     provenance                every attempt and every `beforeAll` window that reached it:
 *       known                   false for a concurrent test or one without a window (R4: unknown
 *                               provenance caps at weak; a concurrent test is path-unattributable)
 *       executedFiles           executed scripts: repo paths (`gitnexus/…`, `gitnexus-shared/src/…`),
 *                               `node_modules/<path>` for packages, `outside:<path>` for anything
 *                               else; Vitest and its runtime packages are left out
 *       nativeEntries           executed files of native packages (tree-sitter*, @ladybugdb/core,
 *                               onnxruntime*), `*.node` files and every `process.dlopen` target
 *       workerSpawns            `{ api, target, site }` for each worker_threads Worker and
 *                               child_process spawn/fork/exec*, with the calling frame as a key
 *       excludedCandidates      executed files that are neither production nor test files, such
 *                               as `gitnexus/tools/…` and `outside:` paths (KTD7 excluded files)
 *   unhandledErrors             Vitest's unhandled errors, as text
 *
 * Usage (from gitnexus/):
 *   node --import tsx tools/scenario-map/path-coverage/run-coverage.ts [--out <dir>]
 *     [--controls [--fixture <repo path>]] [--file <package path>]... [--concurrency <n>]
 * `--out` defaults to `<os tmpdir>/gitnexus-scenario-coverage` and must lie outside the checkout;
 * `--concurrency` bounds Vitest's worker processes (default {@link DEFAULT_COVERAGE_CONCURRENCY}).
 * Exit codes: 0 every file recorded without errors; 1 written, but a file failed or wrote no
 * record; 2 usage or setup error.
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isHarnessModule } from '../../mutation/fidelity/record.js';
import { buildPathMap, toRepoPath, type PathMapEntry } from '../../mutation/prepare/path-map.js';
import { prepare } from '../../mutation/prepare/prepare.js';
import {
  assignPortableTestIds,
  portableTestName,
  type TestLocation,
} from '../../mutation/runner/test-ids.js';
import { MUTATION_SCOPE_ENV, parseMutationScope } from '../../mutation/scope-file.js';
import { errorMessage, isMainModule } from '../../mutation/shared/cli.js';
import { overlaps, readJsonFile } from '../../mutation/shared/fs.js';
import { checksContextKey, fsModuleReader, fsSnapshotReader } from '../facet/checks.js';
import { loadStaticInventory } from '../inventory/cases.js';
import { fingerprintScope } from '../inventory/eligible.js';
import { joinRuntime } from '../inventory/identity.js';
import { inProcessVitestOptions } from '../mutation/vitest-run.js';
import {
  extraRootsOf,
  productionFilePredicate,
  toPackagePath,
  type Eligibility,
  type RunMode,
} from '../types.js';
import { ascending, byText, sortedUnique, toPosixSeparators } from '../util.js';
import { findCandidates, type CandidateResult, type CandidateTest } from './candidates.js';
import { copyBuildOutput, partitionFiles, sequentialMatcherFor } from './partitions.js';
import {
  COVERAGE_KEY,
  RAW_RECORD_PREFIX,
  RAW_RECORD_SCHEMA_VERSION,
  scriptPath,
  type CoverageContext,
  type RawCoverageRecord,
  type RawWindow,
} from './records.js';

export const WORK_FILE_SCHEMA_VERSION = 1;
/** Vitest `repeats` of the coverage run: each test runs twice, the second (warm) run is kept. */
export const COVERAGE_REPEATS = 1;
/** The default controls fixture project (Phase 1 U17). */
export const DEFAULT_FIXTURE_ROOT = 'gitnexus/test/fixtures/mutation-scenario-map';
/** Marks an output directory as created by this tool, so a re-run may replace it. */
export const OUT_MARKER_FILE = '.gitnexus-scenario-coverage';
/** The hook, relative to the (prepared) package dir. */
export const COVERAGE_SETUP_FILE = 'tools/scenario-map/path-coverage/coverage.setup.ts';
const MUTATION_CONFIG = 'tools/mutation/vitest.mutation.config.ts';
const MUTATION_PROJECT = 'mutation';

// ── Work file ──────────────────────────────────────────────────────────────

export type TestState = 'passed' | 'failed' | 'skipped' | 'pending';

export interface WorkerSpawn {
  api: string;
  target: string;
  site: string | null;
}

export interface Provenance {
  known: boolean;
  executedFiles: string[];
  nativeEntries: string[];
  workerSpawns: WorkerSpawn[];
  excludedCandidates: string[];
}

export interface CoverageTest {
  id: string;
  taskId: string;
  /** Package path of the test file. */
  file: string;
  fullName: string;
  location: TestLocation | null;
  state: TestState;
  concurrent: boolean;
  attempts: number;
  blocks: number[];
  suiteBlocks: number[];
  provenance: Provenance;
}

export interface CoverageFile {
  /** Package path. */
  file: string;
  recorded: boolean;
  errors: string[];
  unattributed: Provenance;
}

export interface CoverageWorkFile {
  schemaVersion: typeof WORK_FILE_SCHEMA_VERSION;
  mode: RunMode['kind'];
  extraRoots: string[];
  repeats: number;
  blocks: string[];
  files: CoverageFile[];
  tests: CoverageTest[];
  unhandledErrors: string[];
}

/** One collected test, as the Vitest Node API reports it. */
export interface RuntimeTest {
  taskId: string;
  fullName: string;
  location: TestLocation | undefined;
  state: TestState;
  concurrent: boolean;
}

/** One test file's collected tests, in collection order. */
export interface RuntimeModule {
  /** Package path. */
  file: string;
  errors: string[];
  tests: RuntimeTest[];
}

export interface WorkFileInput {
  mode: RunMode;
  /** Absolute prepared root (holding `gitnexus/`), as the workers saw it. */
  preparedRoot: string;
  repeats: number;
  modules: readonly RuntimeModule[];
  raws: readonly RawCoverageRecord[];
  unhandledErrors: readonly string[];
}

/** Where the workers ran: the prepared root and its path map. */
export interface PathContext {
  preparedRoot: string;
  pathMap: readonly PathMapEntry[];
}

/**
 * The provenance key of an absolute script path: `node_modules/<rest>` for package code, the repo
 * path for a file of the prepared copy (path-map translation, else the path below the prepared
 * root), `outside:<path>` for anything else.
 */
export function scriptKey(file: string, context: PathContext): string {
  const posix = toPosixSeparators(file);
  const at = posix.indexOf('/node_modules/');
  if (at >= 0) return `node_modules/${posix.slice(at + '/node_modules/'.length)}`;
  const relative = path.posix.relative(context.preparedRoot, posix);
  if (relative === '' || relative === '..' || relative.startsWith('../')) return `outside:${posix}`;
  if (path.posix.isAbsolute(relative)) return `outside:${posix}`;
  try {
    return toRepoPath(relative, context.pathMap);
  } catch {
    return relative;
  }
}

/** Packages whose code loads native bindings (design §2 "Execution provenance"). */
const NATIVE_PACKAGE = /^(?:tree-sitter(?:-[^/]+)?|@ladybugdb\/core|onnxruntime(?:-[^/]+)?)$/;

/** Whether a provenance key is a native-package entry: a native package's file or a `*.node`. */
export function isNativeEntry(key: string): boolean {
  if (key.endsWith('.node')) return true;
  const marker = 'node_modules/';
  const at = key.lastIndexOf(marker);
  if (at < 0) return false;
  const [scope, name] = key.slice(at + marker.length).split('/');
  return NATIVE_PACKAGE.test(scope.startsWith('@') ? `${scope}/${name ?? ''}` : scope);
}

const TEST_NAME = /\.(test|spec|case)\.[mc]?[jt]sx?$/;

/** KTD7 excluded-file candidate: executed, under the packages, neither production nor a test. */
function isExcludedCandidate(key: string, production: (repoPath: string) => boolean): boolean {
  if (key.startsWith('outside:')) return true;
  if (!key.startsWith('gitnexus/') && !key.startsWith('gitnexus-shared/')) return false;
  if (key.startsWith('gitnexus/test/') || TEST_NAME.test(key)) return false;
  return !production(key);
}

const SITE = /^(.*):(\d+):(\d+)$/;

function spawnOf(spawn: WorkerSpawn, context: PathContext): WorkerSpawn {
  const targetFile = scriptPath(spawn.target);
  const site = spawn.site === null ? null : SITE.exec(spawn.site);
  return {
    api: spawn.api,
    target: targetFile === null ? spawn.target : scriptKey(targetFile, context),
    site: site === null ? spawn.site : `${scriptKey(site[1], context)}:${site[2]}:${site[3]}`,
  };
}

function provenanceOf(
  windows: readonly RawWindow[],
  raw: RawCoverageRecord,
  context: PathContext,
  production: (repoPath: string) => boolean,
  known: boolean,
): Provenance {
  const executed = new Set<string>();
  const natives = new Set<string>();
  const spawns = new Map<string, WorkerSpawn>();
  for (const window of windows) {
    for (const index of window.scripts) {
      const file = raw.scripts[index];
      if (file !== undefined && !isHarnessModule(file)) executed.add(scriptKey(file, context));
    }
    for (const native of window.natives) {
      natives.add(scriptKey(scriptPath(native) ?? native, context));
    }
    for (const spawn of window.spawns) {
      const mapped = spawnOf(spawn, context);
      spawns.set(JSON.stringify(mapped), mapped);
    }
  }
  const executedFiles = sortedUnique(executed);
  return {
    known,
    executedFiles,
    nativeEntries: sortedUnique([...executedFiles.filter(isNativeEntry), ...natives]),
    workerSpawns: [...spawns.values()],
    excludedCandidates: executedFiles.filter((key) => isExcludedCandidate(key, production)),
  };
}

/** Provenance of a test or file the hook did not observe (R4: caps at weak evidence). */
export const unknownProvenance = (): Provenance => ({
  known: false,
  executedFiles: [],
  nativeEntries: [],
  workerSpawns: [],
  excludedCandidates: [],
});

/** The work file of a run from its collected tests and the hook's raw records; pure. */
export function buildWorkFile(input: WorkFileInput): CoverageWorkFile {
  const extraRoots = extraRootsOf(input.mode);
  const context: PathContext = {
    preparedRoot: toPosixSeparators(input.preparedRoot).replace(/\/+$/, ''),
    pathMap: buildPathMap(extraRoots),
  };
  const production = productionFilePredicate(extraRoots);
  const packageDir = `${context.preparedRoot}/gitnexus`;

  const rawByFile = new Map<string, RawCoverageRecord>();
  for (const raw of input.raws) {
    const file = path.posix.relative(packageDir, toPosixSeparators(raw.file));
    if (rawByFile.has(file)) throw new Error(`coverage: two raw records for ${file}`);
    rawByFile.set(file, raw);
  }
  const modules = [...input.modules].sort((a, b) => byText(a.file, b.file));

  // Raw block index → repo-keyed block id, production files only.
  const translate = (raw: RawCoverageRecord): (string | null)[] =>
    raw.blocks.map((key): string | null => {
      const hash = key.indexOf('#');
      const file = hash < 0 ? undefined : raw.scripts[Number(key.slice(0, hash))];
      if (file === undefined) return null;
      const repoPath = scriptKey(file, context);
      return production(repoPath) ? `${repoPath}${key.slice(hash)}` : null;
    });
  const idsOf = (translated: readonly (string | null)[], rawBlocks: readonly number[]): string[] =>
    sortedUnique(
      rawBlocks.flatMap((rawIndex) => {
        const id = translated[rawIndex];
        return id === null || id === undefined ? [] : [id];
      }),
    );

  // Tests first with block ids as text, so the table holds only blocks some test owns.
  const files: CoverageFile[] = [];
  const drafts: {
    test: Omit<CoverageTest, 'blocks' | 'suiteBlocks'>;
    own: string[];
    suite: string[];
  }[] = [];
  for (const module of modules) {
    const raw = rawByFile.get(module.file);
    const translated = raw === undefined ? [] : translate(raw);
    files.push({
      file: module.file,
      recorded: raw !== undefined,
      errors: [...module.errors],
      unattributed:
        raw === undefined
          ? unknownProvenance()
          : provenanceOf([raw.unattributed], raw, context, production, true),
    });
    const identified = assignPortableTestIds(
      module.file,
      module.tests.map(({ taskId, fullName, location }) => ({ taskId, fullName, location })),
      packageDir,
    );
    const rawTests = new Map((raw?.tests ?? []).map((test) => [test.taskId, test]));
    module.tests.forEach((test, index) => {
      const rawTest = rawTests.get(test.taskId);
      const concurrent = test.concurrent || rawTest?.concurrent === true;
      const attempts = rawTest?.attempts ?? 0;
      const base = {
        id: identified[index].id,
        taskId: test.taskId,
        file: module.file,
        fullName: portableTestName(test.fullName, packageDir),
        location: test.location ?? null,
        state: test.state,
        concurrent,
        attempts,
      };
      if (raw === undefined || rawTest === undefined || attempts === 0) {
        drafts.push({ test: { ...base, provenance: unknownProvenance() }, own: [], suite: [] });
        return;
      }
      const chain = new Set(rawTest.suiteChain);
      // Blocks: windows whose deepest new suite is the test's; provenance: whose outermost is.
      const blockWindows = raw.suiteWindows.filter(({ suites }) => chain.has(suites.at(-1) ?? ''));
      const provenanceWindows = raw.suiteWindows.filter(({ suites }) => chain.has(suites[0]));
      const provenance = provenanceOf(
        [rawTest.all, ...provenanceWindows.map(({ window }) => window)],
        raw,
        context,
        production,
        !concurrent,
      );
      // A concurrent test's windows interleave with its siblings': it has no attributable path.
      const suiteRaw = concurrent ? [] : blockWindows.flatMap(({ window }) => window.blocks);
      const ownRaw = concurrent ? [] : rawTest.warm.blocks;
      drafts.push({
        test: { ...base, provenance },
        own: idsOf(translated, ownRaw),
        suite: idsOf(translated, suiteRaw),
      });
    });
  }
  const blocks = sortedUnique(drafts.flatMap(({ own, suite }) => [...own, ...suite]));
  const blockIndex = new Map(blocks.map((id, index) => [id, index]));
  const indicesOf = (ids: readonly string[]): number[] =>
    [...new Set(ids.map((id) => blockIndex.get(id) ?? -1))].sort(ascending);
  const tests: CoverageTest[] = drafts.map(({ test, own, suite }) => ({
    ...test,
    blocks: indicesOf([...own, ...suite]),
    suiteBlocks: indicesOf(suite),
  }));
  return {
    schemaVersion: WORK_FILE_SCHEMA_VERSION,
    mode: input.mode.kind,
    extraRoots,
    repeats: input.repeats,
    blocks,
    files,
    tests,
    unhandledErrors: [...input.unhandledErrors],
  };
}

/** Reads a work file written by this module; a wrong schema version throws. */
export function readWorkFile(file: string): CoverageWorkFile {
  const data = readJsonFile(file);
  const version =
    typeof data === 'object' && data !== null && 'schemaVersion' in data
      ? data.schemaVersion
      : undefined;
  if (version !== WORK_FILE_SCHEMA_VERSION) {
    throw new Error(`coverage: ${file} is not a version ${WORK_FILE_SCHEMA_VERSION} work file`);
  }
  return data as CoverageWorkFile;
}

// ── Candidates ─────────────────────────────────────────────────────────────

/**
 * Checks-and-context key of every test by Phase 0 id (facet/checks.ts), through the static
 * inventory of the work file's test files (read from `repoRoot`) and the runtime join.
 */
export function checksContextKeys(
  repoRoot: string,
  work: CoverageWorkFile,
): Map<string, string | null> {
  const files = sortedUnique(work.tests.map((test) => test.file));
  const join = joinRuntime(
    loadStaticInventory(repoRoot, files),
    work.tests.map(({ file, taskId, fullName, location }) => ({
      file,
      taskId,
      fullName,
      location: location ?? undefined,
    })),
  );
  const options = { snapshots: fsSnapshotReader(repoRoot), modules: fsModuleReader(repoRoot) };
  return new Map(
    join.instances.map((instance) => [instance.id, checksContextKey(instance, options)]),
  );
}

/**
 * The candidate inputs of a work file: every test that ran (a window, or a passed or failed
 * result: a concurrent test may have no window of its own), with its key.
 */
export function candidateTestsOf(
  work: CoverageWorkFile,
  keys: ReadonlyMap<string, string | null>,
): CandidateTest[] {
  return work.tests
    .filter((test) => test.attempts > 0 || test.state === 'passed' || test.state === 'failed')
    .map((test) => ({
      id: test.id,
      blocks: test.blocks,
      concurrent: test.concurrent,
      checksContext: keys.get(test.id) ?? null,
    }));
}

// ── The run ────────────────────────────────────────────────────────────────

export class UsageError extends Error {
  override name = 'UsageError';
}

export interface CoverageOptions {
  /** Absolute repo checkout. */
  repoRoot: string;
  /** Output directory, outside the checkout. */
  outDir: string;
  mode: RunMode;
  /** Package paths: a subset of the eligible files; undefined runs them all. */
  files?: readonly string[];
  /** Upper bound of Vitest's worker processes; undefined leaves Vitest's default. */
  maxWorkers?: number;
}

/** The standalone CLI's worker bound: the scenario-map CLI's default concurrency. */
export const DEFAULT_COVERAGE_CONCURRENCY = 2;

export interface CoverageRun {
  work: CoverageWorkFile;
  workFile: string;
  /** Prepare and Vitest run, in milliseconds. */
  wallClockMs: number;
}

interface Layout {
  outDir: string;
  preparedRoot: string;
  packageDir: string;
  rawDir: string;
  cacheDir: string;
  workFile: string;
  candidatesFile: string;
}

const layoutOf = (outDir: string): Layout => ({
  outDir,
  preparedRoot: path.join(outDir, 'prepared'),
  packageDir: path.join(outDir, 'prepared', 'gitnexus'),
  rawDir: path.join(outDir, 'raw'),
  cacheDir: path.join(outDir, 'vite-cache'),
  workFile: path.join(outDir, 'coverage.json'),
  candidatesFile: path.join(outDir, 'candidates.json'),
});

function resetOutDir(repoRoot: string, outDir: string): void {
  if (overlaps(repoRoot, outDir)) {
    throw new UsageError(`--out ${outDir} must lie outside the checkout ${repoRoot}`);
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    if (!existsSync(path.join(outDir, OUT_MARKER_FILE))) {
      throw new UsageError(`${outDir} is not empty and was not created by this tool`);
    }
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, OUT_MARKER_FILE), '');
}

function selectFiles(
  scope: Pick<Eligibility, 'fingerprintFiles'>,
  subset: readonly string[] | undefined,
): string[] {
  if (subset === undefined) return [...scope.fingerprintFiles];
  const eligible = new Set(scope.fingerprintFiles);
  const outside = subset.filter((file) => !eligible.has(file));
  if (outside.length > 0) throw new UsageError(`not eligible: ${outside.join(', ')}`);
  return sortedUnique(subset);
}

const isRawRecord = (value: unknown): value is RawCoverageRecord =>
  typeof value === 'object' &&
  value !== null &&
  'schemaVersion' in value &&
  value.schemaVersion === RAW_RECORD_SCHEMA_VERSION &&
  'tests' in value &&
  Array.isArray(value.tests);

function readRawRecords(dir: string): RawCoverageRecord[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith(RAW_RECORD_PREFIX) && name.endsWith('.json'))
    .sort(byText)
    .map((name) => {
      const data = readJsonFile(path.join(dir, name));
      if (!isRawRecord(data)) throw new Error(`coverage: ${name} is not a raw coverage record`);
      return data;
    });
}

const errorText = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'message' in error
    ? String(error.message)
    : String(error);

const ENV_NAMES = ['TEST', 'VITEST', 'NODE_ENV', MUTATION_SCOPE_ENV] as const;

/**
 * Prepares the copy, runs the files under the coverage hook and writes the work file. An explicit
 * empty `files` (a slice or diff scope with nothing to run) writes an empty work file and prepares
 * nothing.
 */
export async function runCoverage(options: CoverageOptions): Promise<CoverageRun> {
  const repoRoot = path.resolve(options.repoRoot);
  const scope = fingerprintScope({ repoRoot, mode: options.mode });
  const files = selectFiles(scope, options.files);
  if (files.length === 0 && options.files === undefined) {
    throw new UsageError('no eligible test files');
  }
  const layout = layoutOf(path.resolve(options.outDir));
  resetOutDir(repoRoot, layout.outDir);
  if (files.length === 0) {
    const work = buildWorkFile({
      mode: options.mode,
      preparedRoot: layout.preparedRoot,
      repeats: COVERAGE_REPEATS,
      modules: [],
      raws: [],
      unhandledErrors: [],
    });
    writeFileSync(layout.workFile, JSON.stringify(work));
    return { work, workFile: layout.workFile, wallClockMs: 0 };
  }
  const started = performance.now();

  const pathMap = buildPathMap(scope.extraRoots);
  prepare({ repoRoot, outDir: layout.preparedRoot, mutate: [], pathMap });
  const preparedRoot = toPosixSeparators(realpathSync(layout.preparedRoot));
  const packageDir = `${preparedRoot}/gitnexus`;
  copyBuildOutput(options.mode.kind, path.join(repoRoot, 'gitnexus'), packageDir);
  const setupFile = path.join(packageDir, COVERAGE_SETUP_FILE);
  if (!existsSync(setupFile))
    throw new UsageError(`the prepared copy has no ${COVERAGE_SETUP_FILE}`);
  mkdirSync(layout.rawDir, { recursive: true });

  const { config, project: projectName } =
    options.mode.kind === 'controls'
      ? {
          config: `${toPackagePath(options.mode.fixtureRoot)}/vitest.config.ts`,
          project: undefined,
        }
      : { config: MUTATION_CONFIG, project: MUTATION_PROJECT };
  // The base config's sequential files run in a partition of their own, one worker (E2).
  const { sequential, parallel } = partitionFiles(files, sequentialMatcherFor(options.mode.kind));
  const partitions = [
    { name: 'sequential', files: sequential, maxWorkers: 1 },
    { name: 'parallel', files: parallel, maxWorkers: options.maxWorkers },
  ].filter((partition) => partition.files.length > 0);
  const savedEnv = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
  const savedCwd = process.cwd();
  // The environment startVitest/prepareVitest sets before creating Vitest, plus the scope file.
  process.env.TEST = 'true';
  process.env.VITEST = 'true';
  process.env.NODE_ENV ??= 'test';
  process.chdir(packageDir);
  const modules: RuntimeModule[] = [];
  const unhandledErrors: string[] = [];
  try {
    const { createVitest } = await import('vitest/node');
    for (const partition of partitions) {
      const scopeFile = path.join(layout.outDir, `scope-${partition.name}.json`);
      const scopeText = `${JSON.stringify({ testFiles: partition.files }, null, 2)}\n`;
      parseMutationScope(scopeText);
      writeFileSync(scopeFile, scopeText);
      process.env[MUTATION_SCOPE_ENV] = scopeFile;
      const vitest = await createVitest(
        inProcessVitestOptions({
          root: packageDir,
          configFile: config,
          projects: projectName === undefined ? undefined : [projectName],
          maxWorkers: partition.maxWorkers,
          repeats: COVERAGE_REPEATS,
        }),
        { cacheDir: path.join(layout.cacheDir, partition.name) },
      );
      try {
        if (vitest.projects.length !== 1) {
          throw new UsageError(
            `expected one Vitest project in ${config}, found ` +
              JSON.stringify(vitest.projects.map((project) => project.name)),
          );
        }
        const [project] = vitest.projects;
        if (!project.config.includeTaskLocation) {
          throw new UsageError(`${config}: includeTaskLocation is off; test ids need locations`);
        }
        project.config.setupFiles = [setupFile, ...project.config.setupFiles];
        project.config.sequence.setupFiles = 'list';
        const context: CoverageContext = {
          outDir: layout.rawDir,
          blockRoots: pathMap.map((entry) => `${preparedRoot}/${entry.prepared}`),
        };
        project.provide(COVERAGE_KEY, context);
        const specs = partition.files.map((file) =>
          project.createSpecification(path.join(packageDir, file)),
        );
        const result = await vitest.runTestSpecifications(specs, true);
        const byFile = new Map(
          result.testModules.map((module) => [
            path.posix.relative(packageDir, toPosixSeparators(module.moduleId)),
            module,
          ]),
        );
        for (const file of partition.files) {
          const module = byFile.get(file);
          modules.push(
            module === undefined
              ? { file, errors: ['not run'], tests: [] }
              : {
                  file,
                  errors: module.errors().map(errorText),
                  tests: [...module.children.allTests()].map((test) => ({
                    taskId: test.id,
                    fullName: test.fullName,
                    location: test.location,
                    state: test.result().state,
                    concurrent: test.options.concurrent === true,
                  })),
                },
          );
        }
        unhandledErrors.push(...result.unhandledErrors.map(errorText));
      } finally {
        await vitest.close();
      }
    }
  } finally {
    process.chdir(savedCwd);
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const work = buildWorkFile({
    mode: options.mode,
    preparedRoot,
    repeats: COVERAGE_REPEATS,
    modules,
    raws: readRawRecords(layout.rawDir),
    unhandledErrors,
  });
  const wallClockMs = Math.round(performance.now() - started);
  writeFileSync(layout.workFile, JSON.stringify(work));
  return { work, workFile: layout.workFile, wallClockMs };
}

// ── CLI ────────────────────────────────────────────────────────────────────

export interface CliOptions {
  outDir: string;
  mode: RunMode;
  files: string[] | undefined;
  maxWorkers: number;
}

export function parseCliArgs(argv: readonly string[], cwd: string): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      out: { type: 'string' },
      controls: { type: 'boolean', default: false },
      fixture: { type: 'string' },
      file: { type: 'string', multiple: true },
      concurrency: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.fixture !== undefined && !values.controls) {
    throw new UsageError('--fixture needs --controls');
  }
  const concurrency = values.concurrency ?? String(DEFAULT_COVERAGE_CONCURRENCY);
  if (!/^[1-9]\d*$/.test(concurrency)) {
    throw new UsageError(`--concurrency must be a positive integer, got ${concurrency}`);
  }
  return {
    outDir: path.resolve(cwd, values.out ?? path.join(os.tmpdir(), 'gitnexus-scenario-coverage')),
    mode: values.controls
      ? { kind: 'controls', fixtureRoot: values.fixture ?? DEFAULT_FIXTURE_ROOT }
      : { kind: 'normal' },
    files: values.file,
    maxWorkers: Number(concurrency),
  };
}

/** One-line summaries of a run and its candidates. */
export function formatSummary(
  run: CoverageRun,
  candidates: CandidateResult,
  retrievalMs: number,
): string[] {
  const { work } = run;
  const ran = work.tests.filter((test) => test.attempts > 0);
  const count = (predicate: (test: CoverageTest) => boolean): number =>
    work.tests.filter(predicate).length;
  const { stats } = candidates;
  const largest = stats.largestGroup;
  return [
    `scenario-map coverage: ${work.files.length} files, ${work.tests.length} tests ` +
      `(${ran.length} ran, ${count((t) => t.state === 'failed')} failed), ` +
      `${(run.wallClockMs / 1000).toFixed(1)} s`,
    `  ${work.blocks.length} distinct blocks; ${count((t) => t.attempts > 0 && t.blocks.length === 0)} ` +
      `tests ran no production block; ${count((t) => t.concurrent)} concurrent; ` +
      `${count((t) => !t.provenance.known)} with unknown provenance; ` +
      `${work.files.filter((f) => !f.recorded || f.errors.length > 0).length} files failed or ` +
      `unrecorded; ${work.unhandledErrors.length} unhandled errors`,
    `candidates (${(retrievalMs / 1000).toFixed(1)} s): ${stats.pairs} pairs (jaccard only ` +
      `${stats.bySource.jaccard}, checks-context only ${stats.bySource.checksContext}, both ` +
      `${stats.bySource.both}), ${stats.groups} groups, largest group ` +
      (largest === null ? 'none' : `${largest.id}: ${largest.tests} tests, ${largest.pairs} pairs`),
  ];
}

async function main(): Promise<number> {
  const packageDir = fileURLToPath(new URL('../../../', import.meta.url));
  const repoRoot = path.dirname(path.resolve(packageDir));
  const options = parseCliArgs(process.argv.slice(2), process.cwd());
  const run = await runCoverage({ repoRoot, ...options });
  const retrievalStart = performance.now();
  const keys = checksContextKeys(repoRoot, run.work);
  const candidates = findCandidates(candidateTestsOf(run.work, keys));
  const retrievalMs = Math.round(performance.now() - retrievalStart);
  const candidatesFile = layoutOf(path.resolve(options.outDir)).candidatesFile;
  writeFileSync(
    candidatesFile,
    `${JSON.stringify({ schemaVersion: WORK_FILE_SCHEMA_VERSION, ...candidates })}\n`,
  );
  for (const line of formatSummary(run, candidates, retrievalMs)) console.log(line);
  console.log(`work file ${run.workFile}; candidates ${candidatesFile}`);
  const incomplete = run.work.files.some((file) => !file.recorded || file.errors.length > 0);
  return incomplete ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`scenario-map coverage: ${errorMessage(error)}`);
      process.exitCode = 2;
    },
  );
}
