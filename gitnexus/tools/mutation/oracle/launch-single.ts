/**
 * Oracle single-test launcher (U12, KTD13, KTD15, KTD17): runs one test with one mutant (or none)
 * in a fresh process inside the kept, instrumented sandbox of an oracle command run (U13,
 * command-run.ts) and classifies what it observed.
 *
 * A launch:
 *   1. selects the test by `<file>:<line>` plus `-t "^<escaped full name>$"` (the full name is the
 *      suite and test titles joined with `' > '`, Vitest's `fullTestName`; every regex
 *      metacharacter is escaped);
 *   2. spawns `node --import tsx launch-single.ts --child <request>` detached (its own process
 *      group), with the sandbox as working directory and Vitest root, the run's scope file in
 *      GITNEXUS_MUTATION_SCOPE, the sandbox's tools/mutation/vitest.mutation.config.ts, and the
 *      mutant installed through `__STRYKER_ACTIVE_MUTANT__` before anything is imported. The child
 *      runs Vitest once through command-wrapper.ts `runOracleVitest` (the `vitest run` code path,
 *      no results cache, no fs module cache, its own Vite cacheDir; KTD5) with the oracle reporter,
 *      and puts oracle-setup.ts first among the mutation project's setup files;
 *   3. enforces a wall-clock limit: when it expires, the whole process group gets SIGKILL. The
 *      group is killed after a normal exit too, so no Vitest worker outlives its launch. The
 *      default, {@link DEFAULT_WALL_CLOCK_MS}, is the base config's testTimeout plus hookTimeout
 *      plus a startup margin, so a hang inside Vitest surfaces as Vitest's own timeout first;
 *   4. classifies the record (oracle-classify.ts) and the probe (probe.ts) with
 *      {@link classifyLaunch}.
 *
 * Validity (KTD17 classes; `validity` is `valid` only for a usable observation):
 *   probe's installed id differs from the intended one, or the probe names
 *   another intended id                                                     invalid
 *   wall-clock kill after the setup file confirmed the installed id          timeout
 *   wall-clock kill before the setup file ran                                infrastructure
 *   no record, a wrapper error, an unhandled error or exit-code mismatch     infrastructure
 *   the location filter matched no test                                      invalid
 *   two or more tests executed, or one test other than the intended one      invalid
 *   zero tests executed, unless a failed `beforeAll` skipped the intended
 *   test (killed-outside-test:hook, or timeout for a hookTimeout) or the
 *   file failed to load (killed-outside-test:collection)                     invalid
 *   exactly the intended test executed: the oracle classifier's class
 *   (assertion, runtime, hook, timeout, survived); `retry` makes it
 *   inconclusive. A survivor that never hit the mutant is a valid
 *   non-covering observation (`covering: false`; KTD13 merges NoCoverage
 *   and survived)                                                            that class
 * An executed launch needs a complete probe; without one it is infrastructure.
 *
 * Launch directory (absolute, empty or new): request.json, the child's stdout.log/stderr.log,
 * probe.json (probe.ts), child.json ({@link ChildInfo}), reports/ (the oracle record and Vitest
 * JSON report) and launch.json ({@link LaunchResult}).
 *
 * Usage (from gitnexus/):
 *   node --import tsx tools/mutation/oracle/launch-single.ts --run <oracle-command-run.json>
 *     --test <KTD3 test id> (--mutant <local id> | --baseline) [--wall-clock-ms <n>]
 *     [--out <launch dir>] [--install-mutant <id>]
 * `--install-mutant` installs another id than `--mutant` intends; it exists to check that such a
 * launch comes out invalid. Exit codes: 0 valid observation, 1 invalid, 2 usage or setup error.
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { INSTRUMENTER_CONSTANTS } from '@stryker-mutator/api/core';
import type { Vite } from 'vitest/node';
import { DEFAULT_VITEST_CONFIG, runOracleVitest } from './command-wrapper.js';
import {
  ORACLE_CLASSES,
  assignTestIds,
  classifyRun,
  isMutantId,
  parseOracleRunRecord,
  recordFileName,
  type OracleClass,
  type OracleRunRecord,
  type OracleTestLocation,
} from './oracle-classify.js';
import {
  INTENDED_MUTANT_ENV,
  PROBE_FILE_ENV,
  parseOracleProbe,
  type OracleProbe,
} from './probe.js';

/** `testTimeout` and `hookTimeout` of gitnexus/vitest.config.ts. */
export const BASE_TEST_TIMEOUT_MS = 30_000;
export const BASE_HOOK_TIMEOUT_MS = 120_000;
/** Room for process start, Vite and the transform of the test file's imports. */
export const STARTUP_MARGIN_MS = 30_000;
/** Default wall-clock limit per launch: 180 000 ms. */
export const DEFAULT_WALL_CLOCK_MS =
  BASE_TEST_TIMEOUT_MS + BASE_HOOK_TIMEOUT_MS + STARTUP_MARGIN_MS;

const MUTATION_SCOPE_ENV = 'GITNEXUS_MUTATION_SCOPE';
const WORKER_ENV = 'STRYKER_MUTATOR_WORKER';
const ORACLE_DIR = path.dirname(fileURLToPath(import.meta.url));
const LAUNCH_FILE = fileURLToPath(import.meta.url);
/** The worker setup file, next to this module. */
export const SETUP_FILE = path.join(ORACLE_DIR, 'oracle-setup.ts');
export const MUTATION_PROJECT = 'mutation';
const NO_TEST_AT_LINE = /^No test found in .+ in line \d+/;
const LAUNCH_SCHEMA_VERSION = 1;

export class LaunchUsageError extends Error {
  override name = 'LaunchUsageError';
}

/** The launch's `signal` aborted it: its process group was killed and no launch.json written. */
export class LaunchAbortedError extends Error {
  override name = 'LaunchAbortedError';
}

// ── test selection ─────────────────────────────────────────────────────────

export interface LaunchTarget {
  /** KTD3 id: `<file>#<full name>`, with the oracle's own suffixes for shared names. */
  id: string;
  /** Package-relative POSIX path of the test file. */
  file: string;
  /** Suite and test titles joined with `' > '`. */
  fullName: string;
  location: OracleTestLocation | null;
}

/** Escapes every regex metacharacter: `| ( ) [ ] ? . * + ^ $ { } \`. */
export const escapeRegExp = (text: string): string => text.replace(/[|()[\]?.*+^${}\\]/g, '\\$&');

/** Vitest's `-t` value that matches exactly one full name. */
export const testNamePattern = (fullName: string): string => `^${escapeRegExp(fullName)}$`;

/** Vitest's `<file>:<line>` filter for the target. */
export function locationFilter(target: LaunchTarget): string {
  if (target.location === null) {
    throw new LaunchUsageError(`test ${target.id} has no location; a launch needs its line`);
  }
  return `${target.file}:${target.location.line}`;
}

// ── environment ────────────────────────────────────────────────────────────

export interface LaunchEnvOptions {
  scopeFile: string;
  probeFile: string;
  intendedMutantId: string | null;
  installedMutantId: string | null;
}

/** The child's environment: no stale Stryker variables, the mutant and probe settings set. */
export function buildLaunchEnv(
  base: Readonly<Record<string, string | undefined>>,
  options: LaunchEnvOptions,
): Record<string, string> {
  const dropped = new Set([
    INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE,
    WORKER_ENV,
    MUTATION_SCOPE_ENV,
    PROBE_FILE_ENV,
    INTENDED_MUTANT_ENV,
  ]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !dropped.has(key)) env[key] = value;
  }
  if (options.installedMutantId !== null) {
    env[INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE] = options.installedMutantId;
  }
  env[MUTATION_SCOPE_ENV] = options.scopeFile;
  env[PROBE_FILE_ENV] = options.probeFile;
  env[INTENDED_MUTANT_ENV] = options.intendedMutantId ?? '';
  return env;
}

// ── classification ─────────────────────────────────────────────────────────

export interface LaunchEvidence {
  target: LaunchTarget;
  /** Null for an unmutated baseline launch. */
  intendedMutantId: string | null;
  wallClockLimitMs: number;
  killedByWallClock: boolean;
  /** The child's exit code; null when a signal ended it. */
  exitCode: number | null;
  signal: string | null;
  record: OracleRunRecord | null;
  probe: OracleProbe | null;
}

export interface LaunchHits {
  loadAndCollection: number;
  hook: number;
  /** Hits while the intended test was current. */
  test: number;
  /** Hits while another test was current (none in a valid launch). */
  otherTests: number;
}

export interface LaunchObservation {
  testId: string;
  mutantId: string | null;
  validity: 'valid' | 'invalid';
  outcome: OracleClass;
  reason: string | null;
  /** KTD3 ids of the tests that ran. */
  executed: string[];
  /** The id the worker had installed, from the probe; null when unknown or none. */
  installedMutantId: string | null;
  /** Whether the mutant was hit during the launch; null when the probe has no hits. */
  covering: boolean | null;
  hits: LaunchHits | null;
  killedBy: string[];
  assertionKilledBy: string[];
}

const UNUSABLE: readonly OracleClass[] = ['invalid', 'infrastructure', 'inconclusive'];

/** Classifies one launch; pure. See the module comment for the rules. */
export function classifyLaunch(evidence: LaunchEvidence): LaunchObservation {
  const { target, probe, record } = evidence;
  const base = {
    testId: target.id,
    mutantId: evidence.intendedMutantId,
    installedMutantId: probe?.activation.installed ?? null,
  };
  const reject = (
    outcome: OracleClass,
    reason: string,
    executed: string[] = [],
  ): LaunchObservation => ({
    ...base,
    validity: 'invalid',
    outcome,
    reason,
    executed,
    covering: null,
    hits: null,
    killedBy: [],
    assertionKilledBy: [],
  });

  if (probe !== null && probe.activation.intended !== evidence.intendedMutantId) {
    return reject(
      'invalid',
      `the probe's intended mutant ${JSON.stringify(probe.activation.intended)} is not the ` +
        `launch's ${JSON.stringify(evidence.intendedMutantId)}`,
    );
  }
  if (probe !== null && !probe.activation.matches) {
    const { installed, intended, instrumentedBeforeSetup } = probe.activation;
    return reject(
      'invalid',
      instrumentedBeforeSetup
        ? 'instrumented code ran before the oracle setup file'
        : `installed mutant ${JSON.stringify(installed)} differs from the intended ` +
            `${JSON.stringify(intended)}`,
    );
  }
  if (evidence.killedByWallClock) {
    if (probe === null) {
      return reject(
        'infrastructure',
        `the wall-clock limit of ${evidence.wallClockLimitMs} ms expired before the oracle setup ` +
          'file ran',
      );
    }
    return {
      ...base,
      validity: 'valid',
      outcome: 'timeout',
      reason: `the wall-clock limit of ${evidence.wallClockLimitMs} ms expired; the process group was killed`,
      executed: [],
      covering: null,
      hits: null,
      killedBy: [],
      assertionKilledBy: [],
    };
  }
  if (record === null) {
    return reject(
      'infrastructure',
      `the launch left no record (exit ${evidence.exitCode ?? '-'}, signal ${evidence.signal ?? '-'})`,
    );
  }
  if (record.wrapperError !== null || record.run === null) {
    return reject(
      'infrastructure',
      record.wrapperError ?? 'the oracle reporter saw no end of the Vitest run',
    );
  }
  const filterMiss = record.run.modules
    .flatMap((module) => module.errors)
    .find((error) => NO_TEST_AT_LINE.test(error.message));
  if (filterMiss !== undefined) {
    return reject('invalid', `the location filter matched no test: ${filterMiss.message}`);
  }

  const classified = classifyRun(record.run, {
    exitCode: record.exitCode,
    expected: [target.id],
    vitestJson: record.vitestJson,
  });
  const { executed } = classified;
  if (classified.outcome === 'infrastructure') {
    return reject('infrastructure', classified.reason ?? 'infrastructure', executed);
  }
  if (executed.length > 1) {
    return reject('invalid', `${executed.length} tests executed: ${executed.join(', ')}`, executed);
  }
  if (executed.length === 1 && executed[0] !== target.id) {
    return reject('invalid', `${executed[0]} executed, which is not the intended test`, executed);
  }
  if (executed.length === 0) {
    const skippedByHook = classified.tests.some(
      (test) =>
        test.id === target.id &&
        (test.outcome === 'killed-outside-test:hook' || test.outcome === 'timeout'),
    );
    const loadFailed =
      classified.outcome === 'killed-outside-test:collection' &&
      classified.outsideTest.some((row) => row.file === target.file && row.suite === null);
    if (loadFailed && probe === null) {
      return reject(
        'infrastructure',
        'the test file failed to load and the oracle setup file left no probe',
      );
    }
    if (!skippedByHook && !loadFailed) {
      return reject(
        'invalid',
        `zero tests executed${classified.reason === null ? '' : ` (${classified.reason})`}`,
      );
    }
  }
  if (UNUSABLE.includes(classified.outcome)) {
    return reject(classified.outcome, classified.reason ?? classified.outcome, executed);
  }

  const hits = probe?.hits ?? null;
  if (executed.length === 1 && hits === null) {
    return reject(
      'infrastructure',
      probe === null
        ? 'the oracle setup file left no probe'
        : 'the probe is incomplete: the setup file did not see the end of the run',
      executed,
    );
  }
  const isTarget = (entry: { fullName: string; location: OracleTestLocation | null }): boolean =>
    entry.fullName === target.fullName &&
    entry.location?.line === target.location?.line &&
    entry.location?.column === target.location?.column;
  const launchHits: LaunchHits | null =
    hits === null
      ? null
      : {
          loadAndCollection: hits.loadAndCollection,
          hook: hits.hook,
          test: hits.perTest.filter(isTarget).reduce((sum, entry) => sum + entry.count, 0),
          otherTests: hits.perTest
            .filter((entry) => !isTarget(entry))
            .reduce((sum, entry) => sum + entry.count, 0),
        };
  const covering =
    launchHits === null
      ? null
      : launchHits.loadAndCollection + launchHits.hook + launchHits.test + launchHits.otherTests >
        0;
  return {
    ...base,
    validity: 'valid',
    outcome: classified.outcome,
    reason:
      classified.outcome !== 'survived'
        ? classified.reason
        : evidence.intendedMutantId === null
          ? 'the unmutated test passed'
          : covering === false
            ? 'the test passed and never hit the mutant'
            : 'the test passed and hit the mutant',
    executed,
    covering,
    hits: launchHits,
    killedBy: classified.killedBy,
    assertionKilledBy: classified.assertionKilledBy,
  };
}

// ── oracle command run and test inventory ──────────────────────────────────

/** The parts of an `oracle-command-run.json` (command-run.ts) a launch needs. */
export interface CommandRunView {
  file: string;
  outDir: string;
  sandboxDir: string;
  scopeFile: string;
  baselineRecord: string;
  baselineExecuted: string[];
  mutants: CommandRunMutant[];
}

export interface CommandRunMutant {
  localId: string;
  globalId: string;
  oracleClass: OracleClass;
  killedBy: string[];
  assertionKilledBy: string[];
  wallClockMs: number | null;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function member(data: unknown, key: string, at: string): unknown {
  if (!isObject(data) || !(key in data)) {
    throw new LaunchUsageError(`oracle command run: ${at}.${key} is missing`);
  }
  return data[key];
}

function text(data: unknown, key: string, at: string): string {
  const value = member(data, key, at);
  if (typeof value !== 'string') {
    throw new LaunchUsageError(`oracle command run: ${at}.${key} must be a string`);
  }
  return value;
}

function texts(data: unknown, key: string, at: string): string[] {
  const value = member(data, key, at);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new LaunchUsageError(`oracle command run: ${at}.${key} must be an array of strings`);
  }
  return value.map(String);
}

function oracleClass(value: string, at: string): OracleClass {
  const found = ORACLE_CLASSES.find((entry) => entry === value);
  if (found === undefined) {
    throw new LaunchUsageError(`oracle command run: ${at}.oracleClass ${value} is unknown`);
  }
  return found;
}

/** Reads the fields of an oracle command run a launch needs. */
export function readCommandRun(file: string): CommandRunView {
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (member(data, 'kind', 'root') !== 'oracle-command-run') {
    throw new LaunchUsageError(`${file} is not an oracle command run`);
  }
  const paths = member(data, 'paths', 'root');
  const baseline = member(data, 'baseline', 'root');
  const sandboxDir = member(paths, 'sandboxDir', 'paths');
  const baselineRecord = member(baseline, 'record', 'baseline');
  if (typeof sandboxDir !== 'string' || !existsSync(sandboxDir)) {
    throw new LaunchUsageError(`${file}: the run kept no usable sandbox (paths.sandboxDir)`);
  }
  if (typeof baselineRecord !== 'string') {
    throw new LaunchUsageError(`${file}: the run has no baseline record`);
  }
  const mutants = member(data, 'mutants', 'root');
  if (!Array.isArray(mutants)) throw new LaunchUsageError(`${file}: mutants must be an array`);
  return {
    file,
    outDir: text(paths, 'outDir', 'paths'),
    sandboxDir,
    scopeFile: text(paths, 'scopeFile', 'paths'),
    baselineRecord,
    baselineExecuted: texts(baseline, 'executed', 'baseline'),
    mutants: mutants.map((entry: unknown, index): CommandRunMutant => {
      const at = `mutants[${index}]`;
      const wallClockMs = member(entry, 'wallClockMs', at);
      return {
        localId: text(entry, 'localId', at),
        globalId: text(entry, 'globalId', at),
        oracleClass: oracleClass(text(entry, 'oracleClass', at), at),
        killedBy: texts(entry, 'killedBy', at),
        assertionKilledBy: texts(entry, 'assertionKilledBy', at),
        wallClockMs: typeof wallClockMs === 'number' ? wallClockMs : null,
      };
    }),
  };
}

/**
 * The tests of the run's baseline (dry-run) record in collection order, with the oracle's own
 * KTD3 ids; the executed ones must equal the run's recorded baseline.
 */
export function readTestInventory(run: CommandRunView): LaunchTarget[] {
  const record = parseOracleRunRecord(readFileSync(run.baselineRecord, 'utf8'));
  if (record.run === null) throw new LaunchUsageError(`${run.baselineRecord} has no observed run`);
  const targets = record.run.modules.flatMap((module) => {
    const ids = assignTestIds(
      module.tests.map((test) => ({
        file: module.file,
        fullName: test.fullName,
        location: test.location,
      })),
    );
    return module.tests.flatMap((test, index): LaunchTarget[] =>
      test.state === 'passed'
        ? [{ id: ids[index], file: module.file, fullName: test.fullName, location: test.location }]
        : [],
    );
  });
  const expected = [...run.baselineExecuted].sort();
  const found = targets.map((target) => target.id).sort();
  if (expected.length !== found.length || expected.some((id, index) => id !== found[index])) {
    throw new LaunchUsageError(
      `${run.baselineRecord}: its passing tests differ from the run's baseline.executed`,
    );
  }
  return targets;
}

// ── launching ──────────────────────────────────────────────────────────────

export interface LaunchOptions {
  /** The kept, instrumented Stryker sandbox (Vitest root and working directory). */
  sandboxDir: string;
  /** The run's mutation scope file (GITNEXUS_MUTATION_SCOPE). */
  scopeFile: string;
  /** Vitest config, relative to the sandbox. */
  configFile?: string;
  target: LaunchTarget;
  /** Local mutant id to install; null for an unmutated baseline launch. */
  mutantId: string | null;
  /** Self-check only: install this id instead of `mutantId`; the launch must come out invalid. */
  installMutantId?: string | null;
  wallClockMs?: number;
  /** Absolute launch directory; created, and must be empty. */
  launchDir: string;
  /**
   * Aborting kills the launch's process group; the launch then rejects with
   * {@link LaunchAbortedError} and writes no launch.json, so the directory stays unfinished.
   */
  signal?: AbortSignal;
}

/** What the child reports about its own Vitest run (`child.json`). */
export interface ChildInfo {
  schemaVersion: 1;
  pid: number;
  /** Resolved `testTimeout`/`hookTimeout` of the mutation project; null if it was not seen. */
  testTimeout: number | null;
  hookTimeout: number | null;
  /** The mutation project's setup files after the oracle setup file was added. */
  setupFiles: string[];
  mutationProjects: number;
  /** CPU time of the child and its reaped children (Vitest's workers); null off Linux. */
  cpuMs: number | null;
}

export interface LaunchResult {
  schemaVersion: typeof LAUNCH_SCHEMA_VERSION;
  launchDir: string;
  target: LaunchTarget;
  mutantId: string | null;
  installedMutantId: string | null;
  wallClockLimitMs: number;
  /** Spawn to exit, measured by the launcher. */
  wallClockMs: number;
  /** Vitest's run inside the child (the record's wall clock). */
  vitestWallClockMs: number | null;
  cpuMs: number | null;
  exitCode: number | null;
  signal: string | null;
  killedByWallClock: boolean;
  child: ChildInfo | null;
  /** Launch-level problems that do not change the observation (e.g. a too-small limit). */
  problems: string[];
  observation: LaunchObservation;
}

interface ChildRequest {
  root: string;
  configFile: string;
  reportDir: string;
  childInfoFile: string;
  mutantId: string | null;
  filter: string;
  testNamePattern: string;
  setupFile: string;
}

/** The real directory of `node_modules/<name>` as Node resolves it from `fromDir`, or null. */
export function findPackageDir(fromDir: string, name: string): string | null {
  for (let dir = path.resolve(fromDir); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return realpathSync(path.dirname(candidate));
    if (path.dirname(dir) === dir) return null;
  }
}

const writeJson = (file: string, value: unknown): void => {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
};

const readOptional = <T>(file: string, parse: (text: string) => T): T | null =>
  existsSync(file) ? parse(readFileSync(file, 'utf8')) : null;

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is gone already.
  }
}

function parseChildInfo(text: string): ChildInfo {
  const data: unknown = JSON.parse(text);
  const number = (key: string): number | null => {
    const value = member(data, key, 'child');
    return typeof value === 'number' ? value : null;
  };
  return {
    schemaVersion: 1,
    pid: number('pid') ?? 0,
    testTimeout: number('testTimeout'),
    hookTimeout: number('hookTimeout'),
    setupFiles: texts(data, 'setupFiles', 'child'),
    mutationProjects: number('mutationProjects') ?? 0,
    cpuMs: number('cpuMs'),
  };
}

/** Runs one launch as described in the module comment. */
export async function launchSingle(options: LaunchOptions): Promise<LaunchResult> {
  const { sandboxDir, target, mutantId, launchDir } = options;
  const wallClockLimitMs = options.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const installedMutantId =
    options.installMutantId === undefined ? mutantId : options.installMutantId;
  for (const id of [mutantId, installedMutantId]) {
    if (id !== null && !isMutantId(id)) {
      throw new LaunchUsageError(`mutant id ${JSON.stringify(id)} is not numeric`);
    }
  }
  if (!path.isAbsolute(launchDir)) throw new LaunchUsageError('the launch dir must be absolute');
  if (options.signal?.aborted === true) throw new LaunchAbortedError('the launch was aborted');
  mkdirSync(launchDir, { recursive: true });
  if (readdirSync(launchDir).length > 0) {
    throw new LaunchUsageError(`the launch dir ${launchDir} is not empty`);
  }
  const ownVitest = findPackageDir(ORACLE_DIR, 'vitest');
  const sandboxVitest = findPackageDir(sandboxDir, 'vitest');
  if (ownVitest === null || ownVitest !== sandboxVitest) {
    throw new LaunchUsageError(
      `the oracle setup file would load Vitest from ${ownVitest ?? 'nowhere'}, the sandbox from ` +
        `${sandboxVitest ?? 'nowhere'}; both must be one copy`,
    );
  }

  const files = {
    request: path.join(launchDir, 'request.json'),
    probe: path.join(launchDir, 'probe.json'),
    child: path.join(launchDir, 'child.json'),
    stdout: path.join(launchDir, 'stdout.log'),
    stderr: path.join(launchDir, 'stderr.log'),
    reports: path.join(launchDir, 'reports'),
    result: path.join(launchDir, 'launch.json'),
  };
  const request: ChildRequest = {
    root: sandboxDir,
    configFile: path.resolve(sandboxDir, options.configFile ?? DEFAULT_VITEST_CONFIG),
    reportDir: files.reports,
    childInfoFile: files.child,
    mutantId,
    filter: locationFilter(target),
    testNamePattern: testNamePattern(target.fullName),
    setupFile: SETUP_FILE,
  };
  writeJson(files.request, request);
  const env = buildLaunchEnv(process.env, {
    scopeFile: options.scopeFile,
    probeFile: files.probe,
    intendedMutantId: mutantId,
    installedMutantId,
  });

  const out = openSync(files.stdout, 'w');
  const err = openSync(files.stderr, 'w');
  const started = performance.now();
  let killedByWallClock = false;
  let aborted = false;
  const { exitCode, signal } = await new Promise<{
    exitCode: number | null;
    signal: string | null;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', LAUNCH_FILE, '--child', files.request],
      { cwd: sandboxDir, env, detached: true, stdio: ['ignore', out, err] },
    );
    const timer = setTimeout(() => {
      killedByWallClock = true;
      killGroup(child.pid);
    }, wallClockLimitMs);
    const onAbort = (): void => {
      aborted = true;
      killGroup(child.pid);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('exit', (code, exitSignal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      killGroup(child.pid);
      resolve({ exitCode: code, signal: exitSignal });
    });
  }).finally(() => {
    closeSync(out);
    closeSync(err);
  });
  if (aborted) throw new LaunchAbortedError(`the launch in ${launchDir} was aborted`);
  const wallClockMs = Math.round(performance.now() - started);

  const kind = mutantId === null ? 'dry-run' : 'mutant';
  const record = readOptional(
    path.join(files.reports, recordFileName(kind, mutantId, 1)),
    parseOracleRunRecord,
  );
  const probe = readOptional(files.probe, parseOracleProbe);
  const child = readOptional(files.child, parseChildInfo);
  const observation = classifyLaunch({
    target,
    intendedMutantId: mutantId,
    wallClockLimitMs,
    killedByWallClock,
    exitCode,
    signal,
    record,
    probe,
  });
  const problems: string[] = [];
  if (child !== null && child.testTimeout !== null && child.hookTimeout !== null) {
    if (wallClockLimitMs <= child.testTimeout + child.hookTimeout) {
      problems.push(
        `the wall-clock limit ${wallClockLimitMs} ms does not exceed testTimeout ` +
          `${child.testTimeout} + hookTimeout ${child.hookTimeout}`,
      );
    }
  }
  if (child !== null && child.mutationProjects !== 1) {
    problems.push(`the oracle setup file was added to ${child.mutationProjects} mutation projects`);
  }
  const result: LaunchResult = {
    schemaVersion: LAUNCH_SCHEMA_VERSION,
    launchDir,
    target,
    mutantId,
    installedMutantId,
    wallClockLimitMs,
    wallClockMs,
    vitestWallClockMs: record?.wallClockMs ?? null,
    cpuMs: child?.cpuMs ?? null,
    exitCode,
    signal,
    killedByWallClock,
    child,
    problems,
    observation,
  };
  writeJson(files.result, result);
  return result;
}

// ── child ──────────────────────────────────────────────────────────────────

/** CPU time of this process and its reaped children from /proc/self/stat; null off Linux. */
function selfAndChildrenCpuMs(): number | null {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // Fields 14-17 of proc(5) (utime, stime, cutime, cstime) in clock ticks of 10 ms (USER_HZ).
    const ticks = [11, 12, 13, 14].reduce((sum, index) => sum + Number(fields[index] ?? 0), 0);
    return ticks * 10;
  } catch {
    return null;
  }
}

function parseChildRequest(textValue: string): ChildRequest {
  const data: unknown = JSON.parse(textValue);
  const mutantId = member(data, 'mutantId', 'request');
  return {
    root: text(data, 'root', 'request'),
    configFile: text(data, 'configFile', 'request'),
    reportDir: text(data, 'reportDir', 'request'),
    childInfoFile: text(data, 'childInfoFile', 'request'),
    mutantId: typeof mutantId === 'string' ? mutantId : null,
    filter: text(data, 'filter', 'request'),
    testNamePattern: text(data, 'testNamePattern', 'request'),
    setupFile: text(data, 'setupFile', 'request'),
  };
}

/** The child: one Vitest run with the oracle setup file; returns Vitest's exit code. */
async function runChild(requestFile: string): Promise<number> {
  const request = parseChildRequest(readFileSync(requestFile, 'utf8'));
  const info: ChildInfo = {
    schemaVersion: 1,
    pid: process.pid,
    testTimeout: null,
    hookTimeout: null,
    setupFiles: [],
    mutationProjects: 0,
    cpuMs: null,
  };
  const plugin: Vite.Plugin = {
    name: 'gitnexus-oracle-setup',
    configureVitest({ project }) {
      if (project.name !== MUTATION_PROJECT) return;
      const { config } = project;
      if (config.setupFiles.length > 0) config.sequence.setupFiles = 'list';
      config.setupFiles = [request.setupFile, ...config.setupFiles];
      info.mutationProjects++;
      info.testTimeout = config.testTimeout;
      info.hookTimeout = config.hookTimeout;
      info.setupFiles = [...config.setupFiles];
    },
  };
  const record = await runOracleVitest({
    root: request.root,
    configFile: request.configFile,
    reportDir: request.reportDir,
    kind: request.mutantId === null ? 'dry-run' : 'mutant',
    mutantId: request.mutantId,
    filters: [request.filter],
    testNamePattern: request.testNamePattern,
    plugins: [plugin],
  });
  info.cpuMs = selfAndChildrenCpuMs();
  writeJson(request.childInfoFile, info);
  if (record.wrapperError !== null) console.error(`oracle launch: ${record.wrapperError}`);
  return record.exitCode;
}

// ── CLI ────────────────────────────────────────────────────────────────────

interface LaunchCliOptions {
  runFile: string;
  testId: string;
  mutantId: string | null;
  installMutantId: string | null | undefined;
  wallClockMs: number;
  outDir: string | null;
}

export function parseLaunchArgs(argv: readonly string[], cwd: string): LaunchCliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      run: { type: 'string' },
      test: { type: 'string' },
      mutant: { type: 'string' },
      baseline: { type: 'boolean', default: false },
      'install-mutant': { type: 'string' },
      'wall-clock-ms': { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.run === undefined) throw new LaunchUsageError('--run is required');
  if (values.test === undefined) throw new LaunchUsageError('--test is required');
  if ((values.mutant === undefined) === !values.baseline) {
    throw new LaunchUsageError('give exactly one of --mutant <local id> and --baseline');
  }
  const limit = values['wall-clock-ms'];
  if (limit !== undefined && (!/^\d+$/.test(limit) || Number(limit) < 1)) {
    throw new LaunchUsageError(`--wall-clock-ms must be a positive integer, got ${limit}`);
  }
  return {
    runFile: path.resolve(cwd, values.run),
    testId: values.test,
    mutantId: values.mutant ?? null,
    installMutantId: values['install-mutant'],
    wallClockMs: limit === undefined ? DEFAULT_WALL_CLOCK_MS : Number(limit),
    outDir: values.out === undefined ? null : path.resolve(cwd, values.out),
  };
}

/** `<run out>/oracle-launches/launch-<n>`, the first that does not exist. */
export function nextLaunchDir(runOutDir: string): string {
  const root = path.join(runOutDir, 'oracle-launches');
  const used = existsSync(root) ? readdirSync(root) : [];
  const numbers = used.flatMap((name) => /^launch-(\d+)$/.exec(name)?.[1] ?? []).map(Number);
  return path.join(root, `launch-${String(Math.max(0, ...numbers) + 1).padStart(4, '0')}`);
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === '--child' && argv[1] !== undefined) {
    let code = 1;
    try {
      code = await runChild(argv[1]);
    } catch (error) {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
    // Vitest is closed; leftover handles must not keep the launch alive.
    process.exit(code);
  }
  try {
    const options = parseLaunchArgs(argv, process.cwd());
    const run = readCommandRun(options.runFile);
    const target = readTestInventory(run).find((entry) => entry.id === options.testId);
    if (target === undefined) {
      throw new LaunchUsageError(`test ${options.testId} is not in the run's baseline`);
    }
    const result = await launchSingle({
      sandboxDir: run.sandboxDir,
      scopeFile: run.scopeFile,
      target,
      mutantId: options.mutantId,
      ...(options.installMutantId === undefined
        ? {}
        : { installMutantId: options.installMutantId }),
      wallClockMs: options.wallClockMs,
      launchDir: options.outDir ?? nextLaunchDir(run.outDir),
    });
    const { observation } = result;
    console.log(
      `${observation.validity} ${observation.outcome}: ${target.id} with ` +
        `${options.mutantId === null ? 'no mutant' : `mutant ${options.mutantId}`} in ` +
        `${result.wallClockMs} ms` +
        (observation.reason === null ? '' : `\n  ${observation.reason}`),
    );
    for (const problem of result.problems) console.log(`  problem: ${problem}`);
    console.log(`  launch: ${path.join(result.launchDir, 'launch.json')}`);
    process.exitCode = observation.validity === 'valid' ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof LaunchUsageError || error instanceof TypeError) {
      console.error(
        'usage: node --import tsx tools/mutation/oracle/launch-single.ts --run <oracle-command-run.json> ' +
          '--test <test id> (--mutant <local id> | --baseline) [--wall-clock-ms <n>] [--out <dir>] ' +
          '[--install-mutant <id>]',
      );
    }
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main(process.argv.slice(2));
}
