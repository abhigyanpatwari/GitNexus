/**
 * Gate 1: execution-path fidelity and the validated envelope (U6, R6, KTD9, KTD19).
 *
 * Proves that the vitest5 runner's unmutated run behaves like a normal Vitest 5 run on the pure-JS
 * category (the U5 classifier's accepted test files), and records the envelope it was validated
 * in. Steps:
 *   1. rebuild `gitnexus-shared/dist` (the base run imports `gitnexus-shared` through it) and
 *      check every source file has a current build;
 *   2. classify `test/unit` (U5) for the accepted list;
 *   3. Stryker run: the scope driver (U10, `vitest5`) runs the accepted files with
 *      tools/mutation/fidelity/vitest.fidelity.config.ts (the mutation config plus the gate 1
 *      recorder, project `mutation`). Its only mutate target is {@link UNCOVERED_MUTATE_TARGET},
 *      a production file outside every accepted file's import closure, so every mutant is
 *      NoCoverage and the run is the runner's dry run alone (checked afterwards);
 *   4. base run: `gitnexus/vitest.config.ts`, project `default`, the same files, through the
 *      Vitest Node API with the environment `vitest run` sets, plus the same recorder;
 *   5. compare: test identities `[file, titles, line, column]` and outcomes (base TestCase results
 *      against the runner's run manifest and dry-run sidecar), the effective config
 *      (allowed-config-diffs.ts), the KTD19 path rule (every local module of the Stryker run
 *      resolves inside the active sandbox; base `gitnexus-shared/dist` paths map to the relocated
 *      `src`), the local, package and builtin modules each file loads, and the runtime load check
 *      (no native binding, Worker construction, `child_process` or `cluster` load by the test,
 *      production or package code, in either run);
 *   6. write `<out>/gate1-report.json` and, for a full-category run, the envelope record
 *      (default gitnexus/test/fixtures/mutation-oracle/envelope.json).
 *
 * The Stryker run goes first: the base run sets `TEST`, `VITEST` and `NODE_ENV` in this process,
 * and Stryker would inherit them. `--batch-size` splits the Stryker run into several scope-driver
 * runs (each with its own sandbox) when one dry run would exceed Stryker's dry-run timeout.
 *
 * Usage (from gitnexus/):
 *   npm run test:mutation:fidelity -- [--out <dir>] [--envelope <file>] [--file <path>]...
 *     [--batch-size <n>] [--concurrency <n>] [--max-test-runner-reuse <n>] [--compare-only]
 * `--out` defaults to `<os tmpdir>/gitnexus-mutation-fidelity` and must lie outside the checkout.
 * `--file` runs a subset of the accepted files and writes no envelope. `--compare-only` re-runs
 * step 5 and 6 on the artefacts already in `<out>`.
 * Exit codes: 0 gate 1 passes; 1 a difference (each one named); 2 usage or setup error.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { classify } from '../classify/classify.js';
import { StrykerRunError, runScope } from '../driver/run-scope.js';
import { readRunManifest, type RunManifest } from '../runner/run-manifest.js';
import { readSidecars, type SidecarRecord } from '../runner/sidecar.js';
import type { TestLocation } from '../runner/test-ids.js';
import { resolveVitestInstall } from '../runner/version-guard.js';
import { errorMessage, isMainModule } from '../shared/cli.js';
import { readJsonFile } from '../shared/fs.js';
import {
  ALLOWED_CONFIG_DIFFS,
  VOLATILE_CONFIG_VALUES,
  compareConfigs,
  isJsonObject,
  normalisePaths,
  type ConfigComparison,
  type ConfigView,
  type PathRoot,
} from './allowed-config-diffs.js';
import {
  CONFIG_RECORD_PREFIX,
  FIDELITY_DIR_ENV,
  WORKER_RECORD_PREFIX,
  installRecorder,
  isHarnessModule,
  snapshotConfig,
  type ConfigRecord,
  type ConfigSnapshot,
  type JsonValue,
  type LoadEvent,
  type WorkerRecord,
} from './record.js';

// ── Test identities and outcomes ──────────────────────────────────────────

export type Outcome = 'passed' | 'failed' | 'skipped';

export interface ObservedTest {
  /** Package-relative POSIX path. */
  file: string;
  /** Suite and test titles joined with `' > '` (Vitest's full name). */
  fullName: string;
  location: TestLocation | null;
  outcome: Outcome;
}

export type DifferenceKind =
  | 'file-missing'
  | 'file-extra'
  | 'test-missing'
  | 'test-extra'
  | 'location'
  | 'outcome'
  | 'run-error'
  | 'config'
  | 'path-rule'
  | 'module-set'
  | 'runtime-load'
  | 'record';

export interface GateDifference {
  kind: DifferenceKind;
  /** What differs: a file, `<file> > <test>`, or a config path. */
  subject: string;
  detail: string;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const formatLocation = (location: TestLocation | null): string =>
  location === null ? 'no location' : `${location.line}:${location.column}`;

const byLocation = (a: ObservedTest, b: ObservedTest): number =>
  (a.location?.line ?? 0) - (b.location?.line ?? 0) ||
  (a.location?.column ?? 0) - (b.location?.column ?? 0);

/** Tests per file, then per full name in first-seen order, each group sorted by location. */
function groupTests(tests: readonly ObservedTest[]): Map<string, Map<string, ObservedTest[]>> {
  const files = new Map<string, Map<string, ObservedTest[]>>();
  for (const test of tests) {
    const names = files.get(test.file) ?? new Map<string, ObservedTest[]>();
    files.set(test.file, names);
    names.set(test.fullName, [...(names.get(test.fullName) ?? []), test]);
  }
  for (const names of files.values()) {
    for (const [name, group] of names) names.set(name, [...group].sort(byLocation));
  }
  return files;
}

const unionInOrder = (first: Iterable<string>, second: Iterable<string>): string[] => [
  ...new Set([...first, ...second]),
];

/**
 * Compares two runs' tests as `[file, titles, line, column]` plus outcome. Tests that share a full
 * name pair up in location order (then collection order); every unpaired test, moved location or
 * changed outcome is a difference that names the test.
 */
export function compareTests(
  base: readonly ObservedTest[],
  run: readonly ObservedTest[],
): GateDifference[] {
  const baseFiles = groupTests(base);
  const runFiles = groupTests(run);
  const differences: GateDifference[] = [];
  for (const file of unionInOrder(baseFiles.keys(), runFiles.keys())) {
    const baseNames = baseFiles.get(file);
    const runNames = runFiles.get(file);
    if (baseNames === undefined || runNames === undefined) {
      const count = [...(baseNames ?? runNames ?? new Map()).values()].flat().length;
      differences.push({
        kind: baseNames === undefined ? 'file-extra' : 'file-missing',
        subject: file,
        detail: `only the ${baseNames === undefined ? 'run' : 'base run'} has this file (${count} tests)`,
      });
      continue;
    }
    for (const name of unionInOrder(baseNames.keys(), runNames.keys())) {
      const left = baseNames.get(name) ?? [];
      const right = runNames.get(name) ?? [];
      const size = Math.max(left.length, right.length);
      for (let index = 0; index < size; index += 1) {
        const subject =
          size > 1 ? `${file} > ${name} (${index + 1} of ${size})` : `${file} > ${name}`;
        const b = left[index];
        const r = right[index];
        if (r === undefined) {
          differences.push({
            kind: 'test-missing',
            subject,
            detail: `collected by the base run only (${formatLocation(b.location)})`,
          });
        } else if (b === undefined) {
          differences.push({
            kind: 'test-extra',
            subject,
            detail: `collected by the run only (${formatLocation(r.location)})`,
          });
        } else {
          if (formatLocation(b.location) !== formatLocation(r.location)) {
            differences.push({
              kind: 'location',
              subject,
              detail: `base ${formatLocation(b.location)}, run ${formatLocation(r.location)}`,
            });
          }
          if (b.outcome !== r.outcome) {
            differences.push({
              kind: 'outcome',
              subject,
              detail: `base ${b.outcome}, run ${r.outcome}`,
            });
          }
        }
      }
    }
  }
  return differences;
}

// ── Module locations (KTD19) ──────────────────────────────────────────────

/** Absolute roots of one comparison: the checkout and the Stryker run's prepared copy and sandbox. */
export interface Roots {
  repoRoot: string;
  /** The scope driver's prepared root (`<out>/prepared`). */
  preparedRoot: string;
  /** The Stryker sandbox the run executed in. */
  sandbox: string;
}

export type Side = 'base' | 'run';
export type ModuleKind =
  | 'production'
  | 'test'
  | 'tool'
  | 'package'
  | 'builtin'
  | 'harness'
  | 'other';
export type ModuleOrigin = 'sandbox' | 'prepared-copy' | 'checkout' | 'none';

export interface LocatedModule {
  /**
   * Comparable name: the repo path for local modules (`gitnexus-shared/dist/X.js` and the
   * relocated `src` both become `gitnexus-shared/src/X.ts`), `node_modules/...` for packages,
   * `node:<name>` for builtins.
   */
  key: string;
  kind: ModuleKind;
  /** Where a local module was loaded from. */
  origin: ModuleOrigin;
}

const RELOCATED_SHARED = 'relocated/gitnexus-shared/';

function sharedSource(relative: string): { key: string; kind: ModuleKind } | null {
  if (relative.startsWith('src/'))
    return { key: `gitnexus-shared/${relative}`, kind: 'production' };
  if (relative.startsWith('dist/') && relative.endsWith('.js')) {
    return { key: `gitnexus-shared/src/${relative.slice(5, -3)}.ts`, kind: 'production' };
  }
  return null;
}

function packageSource(relative: string): { key: string; kind: ModuleKind } | null {
  if (relative.startsWith(RELOCATED_SHARED)) {
    return sharedSource(relative.slice(RELOCATED_SHARED.length));
  }
  if (relative.startsWith('src/')) return { key: `gitnexus/${relative}`, kind: 'production' };
  if (relative.startsWith('test/')) return { key: `gitnexus/${relative}`, kind: 'test' };
  if (relative.startsWith('tools/')) return { key: `gitnexus/${relative}`, kind: 'tool' };
  return null;
}

const isUnder = (root: string, file: string): boolean => file.startsWith(`${root}/`);

const asBuiltin = (id: string): string | null => {
  if (id.startsWith('node:')) return id;
  return isBuiltin(id) ? `node:${id}` : null;
};

type Candidate = readonly [root: string, origin: ModuleOrigin, layout: 'package' | 'shared'];

/** Where a recorded module comes from and how both runs name it. */
export function locateModule(module: string, side: Side, roots: Roots): LocatedModule {
  const builtin = asBuiltin(module);
  if (builtin !== null) return { key: builtin, kind: 'builtin', origin: 'none' };
  const bare = module.replace(/[?#].*$/, '');
  const file = (bare.startsWith('file://') ? fileURLToPath(bare) : bare).replace(/\\/g, '/');
  if (!path.posix.isAbsolute(file)) return { key: module, kind: 'other', origin: 'none' };
  if (isHarnessModule(file)) return { key: file, kind: 'harness', origin: 'none' };
  // The runner plugin, and the setup file next to it, load from the prepared copy (KTD16 layout).
  const pluginTools = path.posix.join(roots.preparedRoot, 'gitnexus', 'tools');
  if (side === 'run' && isUnder(pluginTools, file) && !isUnder(roots.sandbox, file)) {
    return { key: file, kind: 'harness', origin: 'prepared-copy' };
  }
  const marker = file.indexOf('/node_modules/');
  if (marker >= 0) {
    const rest = file.slice(marker + '/node_modules/'.length);
    const shared = rest.startsWith('gitnexus-shared/')
      ? sharedSource(rest.slice('gitnexus-shared/'.length))
      : null;
    return shared === null
      ? { key: `node_modules/${rest}`, kind: 'package', origin: 'none' }
      : { ...shared, origin: 'checkout' };
  }
  const runCandidates: Candidate[] =
    side === 'run'
      ? [
          [roots.sandbox, 'sandbox', 'package'],
          [path.posix.join(roots.preparedRoot, 'gitnexus'), 'prepared-copy', 'package'],
        ]
      : [];
  const candidates: Candidate[] = [
    ...runCandidates,
    [path.posix.join(roots.repoRoot, 'gitnexus-shared'), 'checkout', 'shared'],
    [path.posix.join(roots.repoRoot, 'gitnexus'), 'checkout', 'package'],
  ];
  for (const [root, origin, layout] of candidates) {
    if (!isUnder(root, file)) continue;
    const relative = file.slice(root.length + 1);
    const local = layout === 'shared' ? sharedSource(relative) : packageSource(relative);
    return local === null ? { key: file, kind: 'other', origin } : { ...local, origin };
  }
  return { key: file, kind: 'other', origin: 'none' };
}

/** Path roots that make the base run's config comparable (allowed-config-diffs.ts). */
export function basePathRoots(repoRoot: string): PathRoot[] {
  return [
    { from: path.posix.join(repoRoot, 'gitnexus-shared'), to: '<shared>' },
    { from: path.posix.join(repoRoot, 'gitnexus'), to: '<package>' },
    { from: repoRoot, to: '<checkout>' },
  ];
}

/**
 * Path roots of the Stryker run: the sandbox becomes `<package>` (its relocated shared tree
 * `<shared>`), the shared `node_modules` stays comparable, and any other prepared-copy or checkout
 * path keeps a marker of its own, so it differs from the base run.
 */
export function runPathRoots(roots: Roots): PathRoot[] {
  return [
    { from: path.posix.join(roots.sandbox, RELOCATED_SHARED.slice(0, -1)), to: '<shared>' },
    { from: roots.sandbox, to: '<package>' },
    {
      from: path.posix.join(roots.preparedRoot, 'gitnexus', 'node_modules'),
      to: '<package>/node_modules',
    },
    { from: roots.preparedRoot, to: '<prepared>' },
    {
      from: path.posix.join(roots.repoRoot, 'gitnexus', 'node_modules'),
      to: '<package>/node_modules',
    },
    { from: roots.repoRoot, to: '<checkout>' },
  ];
}

/** Whether a load was caused by the test file, production or package code, not the harness. */
function attributed(event: LoadEvent, side: Side, roots: Roots): boolean {
  if (event.source === 'dlopen' || event.source === 'worker') return true;
  if (event.parent === null) return event.source !== 'builtin-getter';
  return locateModule(event.parent, side, roots).kind !== 'harness';
}

const recordKey = (record: WorkerRecord, side: Side, roots: Roots): string =>
  locateModule(record.file, side, roots).key;

const ORIGIN_LABEL: Record<ModuleOrigin, string> = {
  sandbox: 'sandbox',
  'prepared-copy': 'prepared copy outside the sandbox',
  checkout: 'original checkout',
  none: 'unknown location',
};

const LOCAL_KINDS: ReadonlySet<ModuleKind> = new Set(['production', 'test', 'tool']);

/**
 * KTD19 path rule: every local module (production, test or tool code) of a Stryker-run file
 * resolves inside the active sandbox; the runner's own files in the prepared copy are harness.
 */
export function checkPathRule(record: WorkerRecord, roots: Roots): GateDifference[] {
  const subject = recordKey(record, 'run', roots);
  return record.loads.flatMap((event) => {
    if (event.source !== 'module-runner' && event.source !== 'node-resolve') return [];
    const located = locateModule(event.module, 'run', roots);
    const local = LOCAL_KINDS.has(located.kind);
    if (!local || located.origin === 'sandbox') return [];
    return [
      {
        kind: 'path-rule' as const,
        subject,
        detail: `${located.key} loaded from the ${ORIGIN_LABEL[located.origin]} (${event.module})`,
      },
    ];
  });
}

const COMPARED_KINDS: ReadonlySet<ModuleKind> = new Set([
  'production',
  'test',
  'package',
  'builtin',
]);

function loadedModules(record: WorkerRecord, side: Side, roots: Roots): Set<string> {
  return new Set(
    record.loads
      .filter(
        (event) =>
          (event.source === 'module-runner' || event.source === 'node-resolve') &&
          attributed(event, side, roots),
      )
      .map((event) => locateModule(event.module, side, roots))
      .filter((located) => COMPARED_KINDS.has(located.kind))
      .map((located) => located.key),
  );
}

/** The local, package and builtin modules one test file loads must be the same in both runs. */
export function compareModuleSets(
  base: WorkerRecord,
  run: WorkerRecord,
  roots: Roots,
): GateDifference[] {
  const left = loadedModules(base, 'base', roots);
  const right = loadedModules(run, 'run', roots);
  const onlyBase = [...left].filter((key) => !right.has(key)).sort(byText);
  const onlyRun = [...right].filter((key) => !left.has(key)).sort(byText);
  if (onlyBase.length === 0 && onlyRun.length === 0) return [];
  return [
    {
      kind: 'module-set',
      subject: recordKey(base, 'base', roots),
      detail:
        `only in the base run: ${onlyBase.join(', ') || '-'}; ` +
        `only in the run: ${onlyRun.join(', ') || '-'}`,
    },
  ];
}

const FORBIDDEN_BUILTINS: ReadonlySet<string> = new Set(['node:child_process', 'node:cluster']);

export interface RuntimeLoadResult {
  failures: GateDifference[];
  /** The file loaded `worker_threads` (allowed while no Worker is constructed). */
  workerThreadsLoaded: boolean;
}

/**
 * KTD19 runtime load check of one file: a native binding, a Worker construction, or a
 * `child_process`/`cluster` load by the test, production or package code fails. Loads the harness
 * makes (Vitest, the runner and the recorder) do not count.
 */
export function checkRuntimeLoads(
  record: WorkerRecord,
  side: Side,
  roots: Roots,
): RuntimeLoadResult {
  const file = recordKey(record, side, roots);
  const failures: GateDifference[] = [];
  let workerThreadsLoaded = false;
  for (const event of record.loads) {
    if (!attributed(event, side, roots)) continue;
    const located = locateModule(event.module, side, roots);
    const reason =
      event.source === 'dlopen' || located.key.endsWith('.node')
        ? 'native binding'
        : event.source === 'worker'
          ? 'worker'
          : FORBIDDEN_BUILTINS.has(located.key)
            ? located.key.slice('node:'.length)
            : null;
    if (located.key === 'node:worker_threads') workerThreadsLoaded = true;
    if (reason === null) continue;
    failures.push({
      kind: 'runtime-load',
      subject: event.test === null ? file : `${file} > ${event.test}`,
      detail:
        `${reason}: ${event.module} (${event.source}, during ${event.phase}` +
        `${event.parent === null ? '' : `, from ${event.parent}`})`,
    });
  }
  return { failures, workerThreadsLoaded };
}

// ── Envelope record ───────────────────────────────────────────────────────

export const ENVELOPE_SCHEMA_VERSION = 1;

export interface StrykerSettings {
  concurrency: number;
  maxTestRunnerReuse: number;
  testRunner?: string;
  coverageAnalysis?: string;
  disableTypeChecks?: boolean;
  timeoutMS?: number;
}

export interface EnvelopeEnvRead {
  name: string;
  set: boolean;
  /** Kept for `GITNEXUS_*` names only. */
  value: string | null;
  /** Repo paths (or package paths) of the modules that read it at load. */
  readers: string[];
}

export interface EnvelopeInput {
  versions: { vitest: string; stryker: string; node: string };
  platform: { os: string; release: string; arch: string };
  stryker: StrykerSettings;
  config: {
    base: { file: string; project: string };
    run: { file: string; project: string };
    /** A summary of the effective settings (base run project config). */
    settings: JsonValue;
    comparison: ConfigComparison;
  };
  envReadsAtLoad: EnvelopeEnvRead[];
  /** The accepted pure-JS files that both runs executed. */
  files: string[];
  /** The base run's tests. */
  tests: ObservedTest[];
  differences: GateDifference[];
  runtimeNotes: { workerThreadsLoadedBy: string[] };
}

export interface Envelope {
  schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
  description: string;
  versions: EnvelopeInput['versions'];
  platform: EnvelopeInput['platform'];
  stryker: StrykerSettings;
  config: {
    base: EnvelopeInput['config']['base'];
    run: EnvelopeInput['config']['run'];
    settings: JsonValue;
    allowedDifferences: { name: string; paths: string[]; reason: string }[];
    ignoredVolatileValues: { name: string; paths: string[]; reason: string }[];
  };
  envReadsAtLoad: EnvelopeEnvRead[];
  accepted: { fileCount: number; testCount: number; ran: number; skipped: number; files: string[] };
  skippedOnThisPlatform: string[];
  runtimeLoads: { workerThreadsLoadedBy: string[] };
  gate: { result: 'pass' | 'fail'; differences: GateDifference[] };
}

const withReasons = (
  used: readonly { name: string; paths: string[] }[],
  documented: readonly { name: string; reason: string }[],
) =>
  used.map(({ name, paths }) => ({
    name,
    paths,
    reason: documented.find((entry) => entry.name === name)?.reason ?? '',
  }));

/** The envelope record (gitnexus/test/fixtures/mutation-oracle/envelope.json). */
export function buildEnvelope(input: EnvelopeInput): Envelope {
  const skipped = input.tests.filter((test) => test.outcome === 'skipped');
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    description:
      'Gate 1 (U6): the vitest5 runner’s unmutated run matched a normal Vitest 5 run on the ' +
      'pure-JS category under these versions and settings. Results from other Vitest or Stryker ' +
      'versions are unvalidated until gates 2 and 3 pass again (KTD2). Regenerate with ' +
      '`npm run test:mutation:fidelity` (from gitnexus/).',
    versions: input.versions,
    platform: input.platform,
    stryker: input.stryker,
    config: {
      base: input.config.base,
      run: input.config.run,
      settings: input.config.settings,
      allowedDifferences: withReasons(input.config.comparison.allowed, ALLOWED_CONFIG_DIFFS),
      ignoredVolatileValues: withReasons(input.config.comparison.volatile, VOLATILE_CONFIG_VALUES),
    },
    envReadsAtLoad: input.envReadsAtLoad,
    accepted: {
      fileCount: input.files.length,
      testCount: input.tests.length,
      ran: input.tests.length - skipped.length,
      skipped: skipped.length,
      files: input.files,
    },
    skippedOnThisPlatform: skipped.map((test) => `${test.file} > ${test.fullName}`),
    runtimeLoads: input.runtimeNotes,
    gate: {
      result: input.differences.length === 0 ? 'pass' : 'fail',
      differences: input.differences,
    },
  };
}

export const formatDifference = (difference: GateDifference): string =>
  `${difference.kind}: ${difference.subject}: ${difference.detail}`;

// ── Runs ──────────────────────────────────────────────────────────────────

/** A production file outside every accepted file's import closure (checked at run time). */
export const UNCOVERED_MUTATE_TARGET = 'gitnexus/src/core/ingestion/utils/verbose.ts';
export const FIDELITY_CONFIG = 'tools/mutation/fidelity/vitest.fidelity.config.ts';
export const RUN_PROJECT = 'mutation';
export const BASE_CONFIG = 'vitest.config.ts';
export const BASE_PROJECT = 'default';
export const DEFAULT_ENVELOPE = 'test/fixtures/mutation-oracle/envelope.json';
const MARKER_FILE = '.gitnexus-mutation-fidelity';

export class UsageError extends Error {
  override name = 'UsageError';
}

export interface GateOptions {
  repoRoot: string;
  outDir: string;
  /** Absolute envelope path; null writes none. */
  envelopeFile: string | null;
  /** A subset of the accepted files; undefined runs the whole category. */
  files: readonly string[] | undefined;
  /** Files per Stryker run; 0 runs them all in one. */
  batchSize: number;
  concurrency: number;
  maxTestRunnerReuse: number;
  timeoutMS: number;
  compareOnly: boolean;
}

interface Layout {
  outDir: string;
  filesFile: string;
  baseRecords: string;
  runRecords: string;
  baseRunFile: string;
  strykerRunFile: string;
  reportFile: string;
  batchDir: (index: number) => string;
}

const layoutOf = (outDir: string): Layout => ({
  outDir,
  filesFile: path.join(outDir, 'files.json'),
  baseRecords: path.join(outDir, 'base-records'),
  runRecords: path.join(outDir, 'stryker-records'),
  baseRunFile: path.join(outDir, 'base-run.json'),
  strykerRunFile: path.join(outDir, 'stryker-run.json'),
  reportFile: path.join(outDir, 'gate1-report.json'),
  batchDir: (index) => path.join(outDir, `stryker-${index}`),
});

const readJson = <T>(file: string): T => readJsonFile(file) as T;
const writeJson = (file: string, value: unknown): void =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

function resetOutDir(repoRoot: string, outDir: string): void {
  if (isInside(repoRoot, outDir) || isInside(outDir, repoRoot)) {
    throw new UsageError(`--out ${outDir} must lie outside the checkout ${repoRoot}`);
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    if (!existsSync(path.join(outDir, MARKER_FILE))) {
      throw new UsageError(
        `${outDir} is not empty and was not created by gate 1; choose another --out`,
      );
    }
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, MARKER_FILE), '');
}

/** Rebuilds gitnexus-shared/dist as gitnexus/scripts/build.js does, then checks it is current. */
function buildShared(repoRoot: string): void {
  const sharedRoot = path.join(repoRoot, 'gitnexus-shared');
  const tscJs = path.join(repoRoot, 'gitnexus', 'node_modules', 'typescript', 'lib', 'tsc.js');
  execFileSync(process.execPath, [tscJs], { cwd: sharedRoot, stdio: 'inherit' });
  const stale: string[] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(path.join(sharedRoot, 'src', relative), {
      withFileTypes: true,
    })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const source = path.join(sharedRoot, 'src', child);
        const built = path.join(sharedRoot, 'dist', child.replace(/\.ts$/, '.js'));
        if (!existsSync(built) || statSync(built).mtimeMs < statSync(source).mtimeMs)
          stale.push(child);
      }
    }
  };
  visit('');
  if (stale.length > 0) {
    throw new UsageError(`gitnexus-shared/dist is stale after the build: ${stale.join(', ')}`);
  }
}

interface FileSelection {
  files: string[];
  /** Static closure union of the selected files (repo paths). */
  closure: string[];
  category: number;
}

function selectFiles(repoRoot: string, subset: readonly string[] | undefined): FileSelection {
  const result = classify({ repoRoot });
  const accepted = new Set(result.accepted);
  const notAccepted = (subset ?? []).filter((file) => !accepted.has(file));
  if (notAccepted.length > 0) {
    throw new UsageError(`not in the pure-JS category (U5): ${notAccepted.join(', ')}`);
  }
  const files = subset === undefined ? result.accepted : [...new Set(subset)].sort(byText);
  const chosen = new Set(files);
  const closure = [
    ...new Set(result.files.filter((v) => chosen.has(v.file)).flatMap((v) => v.closure)),
  ].sort(byText);
  if (closure.includes(UNCOVERED_MUTATE_TARGET)) {
    throw new UsageError(
      `${UNCOVERED_MUTATE_TARGET} is imported by an accepted file; choose another uncovered ` +
        'mutate target (UNCOVERED_MUTATE_TARGET)',
    );
  }
  return { files, closure, category: result.accepted.length };
}

interface StrykerBatch {
  index: number;
  outDir: string;
  files: string[];
  wallClockMs: number;
  /** Null when Stryker succeeded. */
  error: string | null;
  mutants: { status: string }[];
  strykerConfig: Record<string, JsonValue>;
}

async function runStrykerBatches(
  options: GateOptions,
  layout: Layout,
  files: string[],
): Promise<StrykerBatch[]> {
  mkdirSync(layout.runRecords, { recursive: true });
  process.env[FIDELITY_DIR_ENV] = layout.runRecords;
  const size = options.batchSize > 0 ? options.batchSize : files.length;
  const batches: StrykerBatch[] = [];
  for (let start = 0, index = 0; start < files.length; start += size, index += 1) {
    const batchFiles = files.slice(start, start + size);
    const outDir = layout.batchDir(index);
    const scopeFile = path.join(layout.outDir, `scope-${index}.json`);
    writeJson(scopeFile, { testFiles: batchFiles, mutate: [UNCOVERED_MUTATE_TARGET] });
    console.log(`gate 1: Stryker run ${index + 1}: ${batchFiles.length} files`);
    const started = performance.now();
    let error: string | null = null;
    let mutants: { status: string }[] = [];
    try {
      const { results } = await runScope({
        repoRoot: options.repoRoot,
        scopeFile,
        outDir,
        variant: 'vitest5',
        concurrency: options.concurrency,
        maxTestRunnerReuse: options.maxTestRunnerReuse,
        timeoutMS: options.timeoutMS,
        command: undefined,
        vitest: { configFile: FIDELITY_CONFIG, project: RUN_PROJECT },
      });
      mutants = results.mutants.map((mutant) => ({ status: mutant.status }));
    } catch (caught) {
      if (!(caught instanceof StrykerRunError)) throw caught;
      error = caught.message;
    }
    const configFile = path.join(outDir, 'stryker.config.json');
    batches.push({
      index,
      outDir,
      files: batchFiles,
      wallClockMs: Math.round(performance.now() - started),
      error,
      mutants,
      strykerConfig: existsSync(configFile) ? readJson<Record<string, JsonValue>>(configFile) : {},
    });
  }
  delete process.env[FIDELITY_DIR_ENV];
  return batches;
}

interface BaseRun {
  wallClockMs: number;
  tests: ObservedTest[];
  fileErrors: { file: string; errors: string[] }[];
  unhandledErrors: string[];
  config: ConfigSnapshot;
}

const toOutcome = (state: string): Outcome =>
  state === 'passed' ? 'passed' : state === 'failed' ? 'failed' : 'skipped';

const errorText = (error: unknown): string =>
  isRecordLike(error) && typeof error.message === 'string' ? error.message : String(error);

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The base run: what `vitest run --project default <files>` does, plus the gate 1 recorder. */
async function runBase(repoRoot: string, layout: Layout, files: string[]): Promise<BaseRun> {
  const packageDir = path.join(repoRoot, 'gitnexus');
  mkdirSync(layout.baseRecords, { recursive: true });
  process.env[FIDELITY_DIR_ENV] = layout.baseRecords;
  // The environment startVitest/prepareVitest sets before creating Vitest.
  process.env.TEST = 'true';
  process.env.VITEST = 'true';
  process.env.NODE_ENV ??= 'test';
  const started = performance.now();
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest({
    root: packageDir,
    config: path.join(packageDir, BASE_CONFIG),
    project: [BASE_PROJECT],
    watch: false,
    reporters: [],
  });
  try {
    const project = vitest.projects.find((candidate) => candidate.name === BASE_PROJECT);
    if (project === undefined) throw new UsageError(`no Vitest project ${BASE_PROJECT}`);
    installRecorder(project);
    const specs = files.map((file) => project.createSpecification(path.join(packageDir, file)));
    console.log(`gate 1: base run: ${files.length} files`);
    const result = await vitest.runTestSpecifications(specs, true);
    const tests: ObservedTest[] = [];
    const fileErrors: BaseRun['fileErrors'] = [];
    for (const module of result.testModules) {
      const file = path.relative(packageDir, module.moduleId).split(path.sep).join('/');
      const errors = module.errors().map(errorText);
      if (errors.length > 0) fileErrors.push({ file, errors });
      for (const test of module.children.allTests()) {
        tests.push({
          file,
          fullName: test.fullName,
          location: test.location ?? null,
          outcome: toOutcome(test.result().state),
        });
      }
    }
    return {
      wallClockMs: Math.round(performance.now() - started),
      tests,
      fileErrors,
      unhandledErrors: result.unhandledErrors.map(errorText),
      config: snapshotConfig(project, vitest),
    };
  } finally {
    await vitest.close();
    delete process.env[FIDELITY_DIR_ENV];
  }
}

// ── Evaluation ────────────────────────────────────────────────────────────

const readRecords = <T>(dir: string, prefix: string): T[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
        .sort(byText)
        .map((name) => readJson<T>(path.join(dir, name)))
    : [];

/** The run's tests: the manifest's collected tests with the dry-run sidecar's outcome classes. */
function runTests(manifest: RunManifest, dryRun: SidecarRecord | undefined): ObservedTest[] {
  const outcomeOf = new Map(dryRun?.result.tests.map((test) => [test.id, test.outcome]) ?? []);
  return manifest.files.flatMap((file) => [
    ...file.tests.map((test) => ({
      file: file.file,
      fullName: test.fullName,
      location: test.location,
      outcome: outcomeOf.get(test.id) === 'survived' ? ('passed' as const) : ('failed' as const),
    })),
    ...file.skipped.map((test) => ({
      file: file.file,
      fullName: test.fullName,
      location: test.location,
      outcome: 'skipped' as const,
    })),
  ]);
}

/** Sandbox and prepared root of a Stryker-run record: `<prepared>/gitnexus/.stryker-tmp/sandbox-*`. */
function rootsOf(repoRoot: string, sandbox: string): Roots | null {
  const tempDir = path.posix.dirname(sandbox);
  const packageDir = path.posix.dirname(tempDir);
  const ok =
    path.posix.basename(sandbox).startsWith('sandbox-') &&
    path.posix.basename(tempDir) === '.stryker-tmp' &&
    path.posix.basename(packageDir) === 'gitnexus';
  return ok ? { repoRoot, preparedRoot: path.posix.dirname(packageDir), sandbox } : null;
}

const SETTINGS_KEYS = [
  'pool',
  'isolate',
  'fileParallelism',
  'maxWorkers',
  'globals',
  'environment',
  'testTimeout',
  'hookTimeout',
  'teardownTimeout',
  'clearMocks',
  'mockReset',
  'restoreMocks',
  'unstubEnvs',
  'unstubGlobals',
  'includeTaskLocation',
  'retry',
  'env',
  'sequence',
];

function settingsSummary(project: JsonValue): JsonValue {
  if (!isJsonObject(project)) return null;
  const summary: { [key: string]: JsonValue } = {};
  for (const key of SETTINGS_KEYS) {
    const value = project[key];
    if (key === 'sequence' && isJsonObject(value)) {
      // seed is a start time; setupFiles: 'list' is set by the gate 1 recorder installation.
      const { seed: _seed, setupFiles: _setupFiles, sequencer, ...rest } = value;
      summary[key] = { ...rest, sequencer: sequencer ?? null };
    } else if (value !== undefined) {
      summary[key] = value;
    }
  }
  return summary;
}

function sameEnv(
  records: readonly WorkerRecord[],
  side: string,
): { env: Record<string, string | null>; differences: GateDifference[] } {
  const env = records[0]?.env ?? {};
  const text = JSON.stringify(env);
  const differences = records
    .filter((record) => JSON.stringify(record.env) !== text)
    .map((record) => ({
      kind: 'record' as const,
      subject: record.file,
      detail: `the ${side} worker environment differs from the first worker's`,
    }));
  return { env, differences };
}

function aggregateEnvReads(records: readonly WorkerRecord[], roots: Roots): EnvelopeEnvRead[] {
  const reads = new Map<string, EnvelopeEnvRead>();
  for (const record of records) {
    for (const read of record.envReadsAtLoad) {
      if (read.reader === null) continue;
      const reader = locateModule(read.reader, 'base', roots).key;
      const entry = reads.get(read.name) ?? {
        name: read.name,
        set: read.set,
        value: read.value,
        readers: [],
      };
      if (!entry.readers.includes(reader)) entry.readers.push(reader);
      reads.set(read.name, entry);
    }
  }
  return [...reads.values()]
    .map((entry) => ({ ...entry, readers: [...entry.readers].sort(byText) }))
    .sort((a, b) => byText(a.name, b.name));
}

const packageVersion = (packageDir: string, name: string): string =>
  readJson<{ version: string }>(path.join(packageDir, 'node_modules', name, 'package.json'))
    .version;

export interface GateReport {
  result: 'pass' | 'fail';
  differences: GateDifference[];
  envelope: Envelope;
  wallClockMs: { base: number; stryker: number[] };
  counts: { files: number; baseTests: number; runTests: number; category: number };
  mutants: Record<string, number>;
}

function evaluate(options: GateOptions, layout: Layout): GateReport {
  const { repoRoot } = options;
  const packageDir = path.join(repoRoot, 'gitnexus');
  const selection = readJson<FileSelection>(layout.filesFile);
  const base = readJson<BaseRun>(layout.baseRunFile);
  const batches = readJson<StrykerBatch[]>(layout.strykerRunFile);
  const differences: GateDifference[] = [];

  // Run errors.
  for (const batch of batches) {
    if (batch.error !== null) {
      differences.push({
        kind: 'run-error',
        subject: `Stryker run ${batch.index + 1}`,
        detail: batch.error,
      });
    }
    const covered = batch.mutants.filter((mutant) => mutant.status !== 'NoCoverage');
    if (covered.length > 0) {
      differences.push({
        kind: 'run-error',
        subject: `Stryker run ${batch.index + 1}`,
        detail: `${covered.length} mutants of ${UNCOVERED_MUTATE_TARGET} were covered; the run was not a dry run alone`,
      });
    }
  }
  for (const { file, errors } of base.fileErrors) {
    differences.push({
      kind: 'run-error',
      subject: file,
      detail: `base run: ${errors.join('; ')}`,
    });
  }
  for (const error of base.unhandledErrors) {
    differences.push({
      kind: 'run-error',
      subject: 'base run',
      detail: `unhandled error: ${error}`,
    });
  }

  // Tests.
  const run: ObservedTest[] = [];
  for (const batch of batches) {
    const runDir = path.join(batch.outDir, 'run');
    if (!existsSync(path.join(runDir, 'run-manifest.json'))) {
      differences.push({
        kind: 'record',
        subject: `Stryker run ${batch.index + 1}`,
        detail: 'no run manifest',
      });
      continue;
    }
    const sidecarDir = path.join(batch.outDir, 'sidecars');
    const dryRuns = existsSync(sidecarDir)
      ? readSidecars(sidecarDir).filter((record) => record.kind === 'dry-run')
      : [];
    const dryRun = dryRuns.sort((a, b) => a.attempt - b.attempt).at(-1);
    if (dryRun === undefined) {
      differences.push({
        kind: 'record',
        subject: `Stryker run ${batch.index + 1}`,
        detail: 'no dry-run sidecar',
      });
    }
    for (const row of dryRun?.result.outsideTest ?? []) {
      differences.push({
        kind: 'run-error',
        subject: row.file,
        detail: `run: ${row.outcome}: ${row.message}`,
      });
    }
    run.push(...runTests(readRunManifest(runDir), dryRun));
  }
  differences.push(...compareTests(base.tests, run));

  // Records.
  const baseRoots: Roots = {
    repoRoot,
    preparedRoot: '/nonexistent-prepared',
    sandbox: '/nonexistent-sandbox',
  };
  const baseRecords = readRecords<WorkerRecord>(layout.baseRecords, WORKER_RECORD_PREFIX);
  const runRecords = readRecords<WorkerRecord>(layout.runRecords, WORKER_RECORD_PREFIX);
  const configRecords = readRecords<ConfigRecord>(layout.runRecords, CONFIG_RECORD_PREFIX);
  const baseByFile = new Map(
    baseRecords.map((record) => [recordKey(record, 'base', baseRoots), record]),
  );
  const runByFile = new Map<string, { record: WorkerRecord; roots: Roots }>();
  for (const record of runRecords) {
    const roots = rootsOf(repoRoot, record.root);
    if (roots === null) {
      differences.push({
        kind: 'path-rule',
        subject: record.file,
        detail: `run root ${record.root} is not a Stryker sandbox`,
      });
      continue;
    }
    runByFile.set(recordKey(record, 'run', roots), { record, roots });
  }
  const workerThreadsLoadedBy: string[] = [];
  for (const file of selection.files.map((entry) => `gitnexus/${entry}`)) {
    const baseRecord = baseByFile.get(file);
    const runEntry = runByFile.get(file);
    if (baseRecord === undefined || runEntry === undefined) {
      differences.push({
        kind: 'record',
        subject: file,
        detail: `no recorder output from the ${baseRecord === undefined ? 'base run' : 'Stryker run'} (collection failed?)`,
      });
      continue;
    }
    differences.push(...checkPathRule(runEntry.record, runEntry.roots));
    differences.push(...compareModuleSets(baseRecord, runEntry.record, runEntry.roots));
    const baseLoads = checkRuntimeLoads(baseRecord, 'base', baseRoots);
    const runLoads = checkRuntimeLoads(runEntry.record, 'run', runEntry.roots);
    differences.push(
      ...baseLoads.failures,
      ...runLoads.failures.map((failure) => ({
        ...failure,
        detail: `Stryker run: ${failure.detail}`,
      })),
    );
    if (baseLoads.workerThreadsLoaded) workerThreadsLoadedBy.push(file);
  }

  // Config.
  const baseEnv = sameEnv(baseRecords, 'base');
  const runEnv = sameEnv(runRecords, 'run');
  differences.push(...baseEnv.differences, ...runEnv.differences);
  const comparisons: ConfigComparison[] = [];
  const dryRunPids = new Set(runRecords.map((record) => record.ppid));
  for (const pid of dryRunPids) {
    const configRecord = configRecords.find(
      (candidate) => candidate.pid === pid && candidate.final,
    );
    const sample = runRecords.find((record) => record.ppid === pid);
    const roots = sample === undefined ? null : rootsOf(repoRoot, sample.root);
    if (configRecord === undefined || roots === null) {
      differences.push({
        kind: 'record',
        subject: `runner process ${pid}`,
        detail: 'no final config record',
      });
      continue;
    }
    const baseView: ConfigView = normaliseView(base.config, baseEnv.env, basePathRoots(repoRoot));
    const runView: ConfigView = normaliseView(
      configRecord.snapshot,
      runEnv.env,
      runPathRoots(roots),
    );
    const comparison = compareConfigs(baseView, runView);
    comparisons.push(comparison);
    for (const failure of comparison.failures) {
      differences.push({
        kind: 'config',
        subject: failure.path,
        detail: `base ${JSON.stringify(failure.base ?? '<absent>')}, run ${JSON.stringify(failure.run ?? '<absent>')}`,
      });
    }
  }
  const comparison: ConfigComparison = mergeComparisons(comparisons);

  const strykerConfig = batches[0]?.strykerConfig ?? {};
  const envelope = buildEnvelope({
    versions: {
      vitest: resolveVitestInstall(packageDir)?.version ?? 'unknown',
      stryker: packageVersion(packageDir, '@stryker-mutator/core'),
      node: process.version,
    },
    platform: { os: os.platform(), release: os.release(), arch: os.arch() },
    stryker: {
      concurrency: options.concurrency,
      maxTestRunnerReuse: options.maxTestRunnerReuse,
      testRunner: String(strykerConfig.testRunner ?? ''),
      coverageAnalysis: String(strykerConfig.coverageAnalysis ?? ''),
      disableTypeChecks: strykerConfig.disableTypeChecks === true,
      timeoutMS: options.timeoutMS,
    },
    config: {
      base: { file: `gitnexus/${BASE_CONFIG}`, project: BASE_PROJECT },
      run: { file: 'gitnexus/tools/mutation/vitest.mutation.config.ts', project: RUN_PROJECT },
      settings: normalisePaths(settingsSummary(base.config.project), basePathRoots(repoRoot)),
      comparison,
    },
    envReadsAtLoad: aggregateEnvReads(baseRecords, baseRoots),
    files: selection.files,
    tests: base.tests,
    differences,
    runtimeNotes: { workerThreadsLoadedBy: workerThreadsLoadedBy.sort(byText) },
  });
  const mutants: Record<string, number> = {};
  for (const mutant of batches.flatMap((batch) => batch.mutants)) {
    mutants[mutant.status] = (mutants[mutant.status] ?? 0) + 1;
  }
  return {
    result: envelope.gate.result,
    differences,
    envelope,
    wallClockMs: { base: base.wallClockMs, stryker: batches.map((batch) => batch.wallClockMs) },
    counts: {
      files: selection.files.length,
      baseTests: base.tests.length,
      runTests: run.length,
      category: selection.category,
    },
    mutants,
  };
}

function normaliseView(
  snapshot: ConfigSnapshot,
  env: Record<string, string | null>,
  roots: PathRoot[],
): ConfigView {
  const normalisedEnv = normalisePaths({ ...env }, roots);
  return {
    project: normalisePaths(snapshot.project, roots),
    global: normalisePaths(snapshot.global, roots),
    vite: normalisePaths(snapshot.vite, roots),
    env: isJsonObject(normalisedEnv)
      ? Object.fromEntries(
          Object.entries(normalisedEnv).map(([key, value]) => [
            key,
            typeof value === 'string' ? value : null,
          ]),
        )
      : {},
  };
}

function mergeComparisons(comparisons: readonly ConfigComparison[]): ConfigComparison {
  const merge = (lists: { name: string; paths: string[] }[][]) => {
    const byName = new Map<string, Set<string>>();
    for (const entry of lists.flat()) {
      byName.set(entry.name, new Set([...(byName.get(entry.name) ?? []), ...entry.paths]));
    }
    return [...byName.entries()].map(([name, paths]) => ({ name, paths: [...paths].sort(byText) }));
  };
  return {
    failures: comparisons.flatMap((comparison) => comparison.failures),
    allowed: merge(comparisons.map((comparison) => comparison.allowed)),
    volatile: merge(comparisons.map((comparison) => comparison.volatile)),
  };
}

/** Runs gate 1 end to end (or only its comparison) and writes the report and envelope. */
export async function runGate(options: GateOptions): Promise<GateReport> {
  const layout = layoutOf(options.outDir);
  if (!options.compareOnly) {
    resetOutDir(options.repoRoot, options.outDir);
    buildShared(options.repoRoot);
    const selection = selectFiles(options.repoRoot, options.files);
    writeJson(layout.filesFile, selection);
    const batches = await runStrykerBatches(options, layout, selection.files);
    writeJson(layout.strykerRunFile, batches);
    const base = await runBase(options.repoRoot, layout, selection.files);
    writeJson(layout.baseRunFile, base);
  }
  const report = evaluate(options, layout);
  writeJson(layout.reportFile, report);
  if (options.envelopeFile !== null && options.files === undefined) {
    mkdirSync(path.dirname(options.envelopeFile), { recursive: true });
    writeJson(options.envelopeFile, report.envelope);
  }
  return report;
}

// ── CLI ────────────────────────────────────────────────────────────────────

const parseInteger = (value: string | undefined, name: string, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} must be an integer, got ${value}`);
  return Number(value);
};

export function parseCliArgs(argv: readonly string[], cwd: string, repoRoot: string): GateOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      out: { type: 'string' },
      envelope: { type: 'string' },
      file: { type: 'string', multiple: true },
      'batch-size': { type: 'string' },
      concurrency: { type: 'string' },
      'max-test-runner-reuse': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'compare-only': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    repoRoot,
    outDir: path.resolve(cwd, values.out ?? path.join(os.tmpdir(), 'gitnexus-mutation-fidelity')),
    envelopeFile: path.resolve(
      cwd,
      values.envelope ?? path.join(repoRoot, 'gitnexus', DEFAULT_ENVELOPE),
    ),
    files: values.file === undefined || values.file.length === 0 ? undefined : values.file,
    batchSize: parseInteger(values['batch-size'], 'batch-size', 0),
    concurrency: parseInteger(values.concurrency, 'concurrency', 2),
    maxTestRunnerReuse: parseInteger(values['max-test-runner-reuse'], 'max-test-runner-reuse', 0),
    timeoutMS: parseInteger(values['timeout-ms'], 'timeout-ms', 10000),
    compareOnly: values['compare-only'] === true,
  };
}

const formatSeconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
  const started = performance.now();
  try {
    const options = parseCliArgs(process.argv.slice(2), process.cwd(), repoRoot);
    const report = await runGate(options);
    const { counts, envelope } = report;
    console.log(
      [
        `gate 1: ${report.result.toUpperCase()}: ${counts.files} of ${counts.category} pure-JS files, ` +
          `${counts.baseTests} base tests, ${counts.runTests} run tests, ${report.differences.length} differences`,
        `  allowed config differences: ${envelope.config.allowedDifferences.map((entry) => entry.name).join(', ') || '-'}`,
        `  ignored volatile values: ${envelope.config.ignoredVolatileValues.map((entry) => entry.name).join(', ') || '-'}`,
        `  mutants of the uncovered target: ${JSON.stringify(report.mutants)}`,
        `  wall clock: base ${formatSeconds(report.wallClockMs.base)}, Stryker ` +
          `${report.wallClockMs.stryker.map(formatSeconds).join(' + ')}, total ${formatSeconds(performance.now() - started)}`,
        ...report.differences.slice(0, 40).map((difference) => `  ${formatDifference(difference)}`),
        `  report: ${path.join(options.outDir, 'gate1-report.json')}`,
        ...(options.files === undefined && options.envelopeFile !== null
          ? [`  envelope: ${options.envelopeFile}`]
          : []),
      ].join('\n'),
    );
    process.exitCode = report.result === 'pass' ? 0 : 1;
  } catch (error) {
    console.error(errorMessage(error));
    if (error instanceof TypeError || error instanceof UsageError) {
      console.error(
        'usage: npm run test:mutation:fidelity -- [--out <dir>] [--envelope <file>] ' +
          '[--file <path>]... [--batch-size <n>] [--concurrency <n>] [--max-test-runner-reuse <n>] ' +
          '[--timeout-ms <n>] [--compare-only]',
      );
    }
    process.exitCode = 2;
  }
}

if (isMainModule(import.meta.url)) {
  void main();
}
