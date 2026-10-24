/**
 * Oracle freeze (U7, gate 3; KTD11, KTD12, KTD13, KTD17, KTD18): freezes the oracle's expected
 * outcomes for one KTD11 scope into a manifest that compare.ts (gate 3) checks runner runs against.
 *
 * A freeze of one scope:
 *   1. Oracle command run (U13, command-run.ts): the oracle class of every mutant and the kept,
 *      instrumented sandbox. Reused from `--command-run`, or from `<work>/command/` once it exists.
 *   2. Runner run (U10, vitest5 variant): only its run manifest is used, to check that the oracle's
 *      own test inventory (the command run's dry-run record) equals it (KTD18). Reused from
 *      `--runner-results`, or from `<work>/runner/` once it exists.
 *   3. Baseline: every test of the inventory is launched alone without a mutant (U12,
 *      launch-single.ts) and must pass. The oracle setup file also lists which mutant sites ran
 *      during load and collection, in hooks and in the test (probe.ts `coverage`); their union over
 *      the baseline launches gives the strata populations.
 *   4. Sample and strata (below). A required stratum the sample misses fails the freeze before any
 *      mutant is launched.
 *   5. Per-test outcomes: one launch per (sampled mutant, inventory test), at most
 *      `--launch-concurrency` at a time.
 *   6. The manifest goes to `<work>/manifest.json`, and to `--manifest` only when the freeze has no
 *      problems.
 * Before launching, the inputs (KTD12 hashes) of the checkout are compared with the prepared
 * copies both runs used, so a freeze never records hashes of code other than what ran.
 *
 * Sampling. A mutant's rank is the SHA-256 hex digest of `<seed>\n<global id>` (ties broken by the
 * global id); the random sample is the `--sample-size` lowest ranks, all mutants when the scope has
 * fewer. That is a seeded random permutation that does not depend on input order or on a PRNG
 * implementation: the same seed always gives the same sample. Top-ups then add, per stratum in the
 * order of {@link STRATA}, the lowest-ranked population members not yet selected until the sample
 * holds `min(--top-up-min, population)` of them (`--top-up-min 0` disables top-ups).
 *
 * Strata (populations are mutants of the whole scope):
 *   static        its site ran during module load or collection (baseline coverage)
 *   hook-hit      its site ran in a hook with no current test (baseline coverage); construct: a
 *                 `beforeAll` in a scope test file (U5 classifier hook counts)
 *   multi-killer  the command run kills it with two or more tests ("several killers")
 *   survived      the command run classifies it survived and some baseline launch covers it
 *   no-coverage   no baseline launch ran its site (Stryker's NoCoverage)
 *   each-row      its site ran in an `it.each`/`test.for` row, i.e. a test that shares its file and
 *                 location with another test (KTD3); construct: an `.each`/`.for` call in a scope
 *                 test file. A single-row call is not recognised as a row.
 * Within one scope only construct strata can be required: when the scope's tests contain the
 * construct and the population is not empty (KTD11). A required stratum without a sampled member
 * fails the freeze unless every affected test (the tests of files with `beforeAll`; the rows) is
 * marked not oracle-validated. Empty populations are recorded, never required. Every stratum is
 * also counted across the scopes combined ({@link combineStrata}); gate 3 checks that count.
 *
 * Not oracle-validated tests: the runner's run-manifest flags, tests whose oracle id needed the row
 * ordinal (KTD3), and `--not-oracle-validated <id>`. They are launched and recorded like any other
 * test; gate 3 does not compare their per-test outcomes.
 *
 * Work dir (absolute, outside the checkout); a freeze is resumable:
 *   freeze-work.json      what this work dir freezes (scope, seed, sample options, wall clock,
 *                         reused runs); a restart with other values is refused
 *   scope.json            the driver scope file of steps 1 and 2
 *   command/, runner/     the runs of steps 1 and 2 when they are not given
 *   launches/baseline/<k>/attempt-<n>/, launches/m<local id>/<k>/attempt-<n>/
 *                         launch dirs (launch-single.ts); `<k>` is the first 16 hex digits of the
 *                         SHA-256 of the test id
 *   manifest.json         the manifest, also when the freeze has problems
 * A launch is done once its `launch.json` exists (launch-single writes it last, atomically). A
 * restart skips done launches, deletes unfinished attempt dirs and launches those again;
 * `--retry-invalid` gives a done launch with an invalid observation a new attempt. SIGINT and
 * SIGTERM kill the process group of every running launch and exit 130 once they are gone. A run of
 * Stryker (steps 1 and 2) cannot be interrupted that way; the driver restarts it from scratch.
 *
 * Manifest ({@link OracleManifest}, schemaVersion 1, JSON):
 *   name, description, refreeze        the scope's name, what the file is, the re-freeze command
 *   scope {testFiles, mutate}          the driver scope (driver/stryker-config.ts)
 *   versions {stryker, vitest, nodeMajor}
 *   operators {mutator, names}         Stryker's `mutator` option (null: Stryker's default set,
 *                                      every mutator) and the mutator names of the scope's mutants
 *   inputs {closure, vitestConfig, mutationConfig, prepareTool}
 *                                      repo-relative path to the SHA-256 of the file (KTD12): the
 *                                      U5 static import closure of the scope's test files; of
 *                                      gitnexus/vitest.config.ts; of tools/mutation/
 *                                      vitest.mutation.config.ts plus gitnexus-shared/package.json
 *                                      (its alias source); and of every tools/mutation/prepare/*.ts
 *                                      module (the prepare tool: copy, blanking, path map, mutant
 *                                      identity and span map)
 *   sample {seed, method, size, topUpMin, random, topUps[]}
 *   strata[]                           {@link StratumRecord} per stratum, populations included
 *   baseline {tests, passedAlone}
 *   tests[]                            the oracle's test inventory: KTD3 ids in collection order
 *   notOracleValidated[]               test ids
 *   mutants[]                          [global id, oracle class] of every mutant, by global id
 *   sampled[]                          {@link SampledMutant}: per-test outcomes of the sample
 *   launches {total, valid, invalid, wallClockLimitMs}
 *                                      total counts baseline and mutant launches; valid and
 *                                      invalid count the sampled mutants' observations
 *   warnings[], problems[]             a manifest with problems is never written to `--manifest`
 * Per-test outcomes are compact: `outcomes` lists [test index, class] for every valid observation
 * whose class is not `survived`, `invalid` lists [test index, class, reason] for every invalid one,
 * and every other test of `tests` is a valid `survived` observation. A per-test class is the test's
 * own: its row when it ran, the class of a failed `beforeAll` that skipped it, collection when its
 * file failed to load, and an oracle wall-clock kill is `timeout`; an `afterAll` failure that
 * attributes to no test leaves the test's class alone (KTD17).
 *
 * Usage (from gitnexus/):
 *   npm run test:mutation:oracle:freeze -- (--scope <driver scope.json> | --from-manifest <file>)
 *     --seed <seed> --work <dir> [--manifest <file>] [--name <name>]
 *     [--command-run <oracle-command-run.json>] [--runner-results <vitest5 results.json>]
 *     [--sample-size <n> (100)] [--top-up-min <n> (3)] [--launch-concurrency <n> (4)]
 *     [--concurrency <n> (4, Stryker runs)] [--timeout-ms <n> (10000)]
 *     [--wall-clock-ms <n> (180000)] [--not-oracle-validated <test id>]... [--retry-invalid]
 * `--from-manifest` re-freezes a frozen manifest's scope (name and `--manifest` default to it).
 * Exit codes: 0 manifest written; 1 freeze problems (see `<work>/manifest.json`); 2 usage or setup
 * error; 130 interrupted.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Classifier } from '../classify/classify.js';
import { runScope } from '../driver/run-scope.js';
import { parseDriverScope } from '../driver/stryker-config.js';
import { PACKAGE_DIR, RELOCATED_SHARED_DIR } from '../prepare/path-map.js';
import { RESULT_FILE_NAME, runOracleCommand } from './command-run.js';
import {
  DEFAULT_WALL_CLOCK_MS,
  LaunchAbortedError,
  findPackageDir,
  launchSingle,
  readCommandRun,
  readTestInventory,
  type CommandRunView,
  type LaunchOptions,
  type LaunchTarget,
} from './launch-single.js';
import {
  ORACLE_CLASSES,
  classifyRun,
  isKillClass,
  parseOracleRunRecord,
  recordFileName,
  type OracleClass,
} from './oracle-classify.js';
import { parseOracleProbe, type ProbeCoverage } from './probe.js';

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_KIND = 'gitnexus-mutation-oracle-manifest';
export const WORK_FILE = 'freeze-work.json';
export const WORK_MANIFEST_FILE = 'manifest.json';
export const DEFAULT_SAMPLE_SIZE = 100;
export const DEFAULT_TOP_UP_MIN = 3;
export const DEFAULT_LAUNCH_CONCURRENCY = 4;
export const SAMPLE_METHOD =
  'sha256(seed + "\\n" + globalId) ascending; the size lowest ranks, then strata top-ups';
/** Exit code of an interrupted freeze (128 + SIGINT). */
export const EXIT_INTERRUPTED = 130;

export class FreezeUsageError extends Error {
  override name = 'FreezeUsageError';
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

const isInside = (dir: string, file: string): boolean => {
  const relative = path.relative(dir, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// ── test ids (KTD3, KTD13) ─────────────────────────────────────────────────

const TITLE_ESCAPE = /\\([|()[\]?.*+^${}\\'"`])/g;

/**
 * A test id under gate 3's id normalisations (KTD13): path separators of the file part become `/`;
 * in the title part a backslash before a regex metacharacter, a backslash or a quote is dropped
 * (title escaping), and the title compares in Unicode NFC.
 */
export function normaliseTestId(id: string): string {
  const hash = id.indexOf('#');
  if (hash === -1) return id.replaceAll('\\', '/');
  const file = id.slice(0, hash).replaceAll('\\', '/');
  return `${file}#${id
    .slice(hash + 1)
    .replace(TITLE_ESCAPE, '$1')
    .normalize('NFC')}`;
}

export interface InventoryDiff {
  /** Ids only the first inventory has (original spelling). */
  onlyA: string[];
  onlyB: string[];
  /** Ids that collapse onto one normalised id within the same inventory. */
  ambiguousA: string[];
  ambiguousB: string[];
}

/** The difference of two id inventories after `normalise`; pure. */
export function diffInventory(
  a: readonly string[],
  b: readonly string[],
  normalise: (id: string) => string = (id) => id,
): InventoryDiff {
  const index = (ids: readonly string[]): { keys: Map<string, string>; ambiguous: string[] } => {
    const keys = new Map<string, string>();
    const ambiguous: string[] = [];
    for (const id of ids) {
      const key = normalise(id);
      if (keys.has(key)) ambiguous.push(id);
      else keys.set(key, id);
    }
    return { keys, ambiguous };
  };
  const left = index(a);
  const right = index(b);
  const only = (from: Map<string, string>, other: Map<string, string>): string[] =>
    [...from].flatMap(([key, id]) => (other.has(key) ? [] : [id])).sort();
  return {
    onlyA: only(left.keys, right.keys),
    onlyB: only(right.keys, left.keys),
    ambiguousA: left.ambiguous.sort(),
    ambiguousB: right.ambiguous.sort(),
  };
}

export const inventoryDiffers = (diff: InventoryDiff): boolean =>
  diff.onlyA.length + diff.onlyB.length + diff.ambiguousA.length + diff.ambiguousB.length > 0;

/** Tests whose KTD3 id needed the row ordinal (`:<line>:<column>:<row>`). */
export function ordinalTests(inventory: readonly LaunchTarget[]): string[] {
  return inventory.flatMap((target) => {
    const suffix = target.id.slice(`${target.file}#${target.fullName}`.length);
    return /^:(?:\d+|\?):(?:\d+|\?):\d+$/.test(suffix) ? [target.id] : [];
  });
}

/** `it.each`/`test.for` rows: tests that share their file and location with another test. */
export function eachRowTests(inventory: readonly LaunchTarget[]): string[] {
  const place = (target: LaunchTarget): string | null =>
    target.location === null
      ? null
      : `${target.file}\0${target.location.line}:${target.location.column}`;
  const counts = new Map<string, number>();
  for (const target of inventory) {
    const key = place(target);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return inventory.flatMap((target) => {
    const key = place(target);
    return key !== null && (counts.get(key) ?? 0) > 1 ? [target.id] : [];
  });
}

// ── sampling ───────────────────────────────────────────────────────────────

export const STRATA = [
  'static',
  'hook-hit',
  'multi-killer',
  'survived',
  'no-coverage',
  'each-row',
] as const;
export type StratumName = (typeof STRATA)[number];
export type Construct = 'beforeAll' | 'each';

export const STRATUM_CONSTRUCT: Readonly<Record<StratumName, Construct | null>> = {
  static: null,
  'hook-hit': 'beforeAll',
  'multi-killer': null,
  survived: null,
  'no-coverage': null,
  'each-row': 'each',
};

export type Populations = ReadonlyMap<StratumName, ReadonlySet<string>>;

/** A mutant's sampling rank: the SHA-256 hex digest of `<seed>\n<global id>`. */
export const sampleRank = (seed: string, globalId: string): string =>
  sha256(`${seed}\n${globalId}`);

export interface TopUp {
  globalId: string;
  stratum: StratumName;
}

export interface SampleInput {
  /** Global ids of every mutant of the scope. */
  mutants: readonly string[];
  seed: string;
  sampleSize: number;
  topUpMin: number;
  populations: Populations;
}

export interface SampleSelection {
  /** The random sample, lowest rank first. */
  random: string[];
  topUps: TopUp[];
  /** The random sample, then the top-ups. */
  selected: string[];
}

/** The seeded sample with strata top-ups (see the module comment); pure. */
export function selectSample(input: SampleInput): SampleSelection {
  const ranked = [...new Set(input.mutants)]
    .map((globalId) => ({ globalId, rank: sampleRank(input.seed, globalId) }))
    .sort((a, b) =>
      a.rank === b.rank ? a.globalId.localeCompare(b.globalId) : a.rank < b.rank ? -1 : 1,
    )
    .map((entry) => entry.globalId);
  const random = ranked.slice(0, input.sampleSize);
  const selected = new Set(random);
  const topUps: TopUp[] = [];
  for (const stratum of STRATA) {
    const population = input.populations.get(stratum) ?? new Set<string>();
    const quota = Math.min(input.topUpMin, population.size);
    let have = [...selected].filter((id) => population.has(id)).length;
    for (const globalId of ranked) {
      if (have >= quota) break;
      if (population.has(globalId) && !selected.has(globalId)) {
        selected.add(globalId);
        topUps.push({ globalId, stratum });
        have++;
      }
    }
  }
  return { random, topUps, selected: [...random, ...topUps.map((entry) => entry.globalId)] };
}

// ── strata ─────────────────────────────────────────────────────────────────

export interface PopulationMutant {
  globalId: string;
  localId: string;
  oracleClass: OracleClass;
  killedBy: readonly string[];
}

export interface BaselineCoverage {
  testId: string;
  coverage: ProbeCoverage;
}

/** The strata populations of one scope, as global ids (see the module comment); pure. */
export function computePopulations(
  mutants: readonly PopulationMutant[],
  baseline: readonly BaselineCoverage[],
  eachRows: ReadonlySet<string>,
): Map<StratumName, Set<string>> {
  const toGlobal = new Map(mutants.map((mutant) => [mutant.localId, mutant.globalId]));
  const collect = (pick: (entry: BaselineCoverage) => readonly string[]): Set<string> =>
    new Set(
      baseline.flatMap((entry) => pick(entry).flatMap((localId) => toGlobal.get(localId) ?? [])),
    );
  const loaded = collect((entry) => entry.coverage.loadAndCollection);
  const hooked = collect((entry) => entry.coverage.hook);
  const tested = collect((entry) => entry.coverage.test);
  const rows = collect((entry) => (eachRows.has(entry.testId) ? entry.coverage.test : []));
  const covered = (id: string): boolean => loaded.has(id) || hooked.has(id) || tested.has(id);
  const ids = (keep: (mutant: PopulationMutant) => boolean): Set<string> =>
    new Set(mutants.filter(keep).map((mutant) => mutant.globalId));
  return new Map<StratumName, Set<string>>([
    ['static', loaded],
    ['hook-hit', hooked],
    [
      'multi-killer',
      ids((mutant) => isKillClass(mutant.oracleClass) && new Set(mutant.killedBy).size >= 2),
    ],
    ['survived', ids((mutant) => mutant.oracleClass === 'survived' && covered(mutant.globalId))],
    ['no-coverage', ids((mutant) => !covered(mutant.globalId))],
    ['each-row', rows],
  ]);
}

export type StratumStatus =
  | 'met'
  | 'unmet'
  | 'waived'
  | 'empty-population'
  | 'construct-absent'
  | 'combined';

export interface StratumRecord {
  name: StratumName;
  /** The test construct a per-scope requirement depends on; null for the other strata. */
  construct: Construct | null;
  /** Whether the scope's tests contain the construct; null without a construct. */
  constructPresent: boolean | null;
  population: number;
  /** Members in the final sample (random sample and top-ups). */
  sampled: number;
  toppedUp: number;
  /** Required within this scope (construct strata only). */
  required: boolean;
  /**
   * met / unmet / waived: a required stratum with, without (failing) and without but excused
   * (every affected test not oracle-validated) a sampled member; empty-population; construct-absent;
   * combined: required only across the scopes combined.
   */
  status: StratumStatus;
  /** Tests a construct stratum stands for: tests of files with `beforeAll`, or the rows. */
  affectedTests: number;
}

export interface StrataInput {
  populations: Populations;
  selected: readonly string[];
  topUps: readonly TopUp[];
  constructs: Readonly<Record<Construct, boolean>>;
  affectedTests: Readonly<Record<Construct, readonly string[]>>;
  notOracleValidated: ReadonlySet<string>;
}

/** The per-scope stratum records (KTD11 rules in the module comment); pure. */
export function evaluateStrata(input: StrataInput): StratumRecord[] {
  const selected = new Set(input.selected);
  return STRATA.map((name): StratumRecord => {
    const population = input.populations.get(name) ?? new Set<string>();
    const construct = STRATUM_CONSTRUCT[name];
    const sampled = [...selected].filter((id) => population.has(id)).length;
    const affected = construct === null ? [] : input.affectedTests[construct];
    const base = {
      name,
      construct,
      constructPresent: construct === null ? null : input.constructs[construct],
      population: population.size,
      sampled,
      toppedUp: input.topUps.filter((entry) => entry.stratum === name).length,
      affectedTests: affected.length,
    };
    if (construct !== null && !input.constructs[construct]) {
      return { ...base, required: false, status: 'construct-absent' };
    }
    if (population.size === 0) return { ...base, required: false, status: 'empty-population' };
    if (construct === null) return { ...base, required: false, status: 'combined' };
    if (sampled > 0) return { ...base, required: true, status: 'met' };
    const waived =
      affected.length > 0 && affected.every((testId) => input.notOracleValidated.has(testId));
    return { ...base, required: true, status: waived ? 'waived' : 'unmet' };
  });
}

export interface CombinedStratum {
  name: StratumName;
  /** Population and sampled members over the scopes where the stratum counts. */
  population: number;
  sampled: number;
  status: 'met' | 'unmet' | 'empty-population';
  scopes: { scope: string; population: number; sampled: number; status: StratumStatus }[];
}

/**
 * Every stratum counted across the scopes combined (KTD11); pure. A scope counts unless the
 * stratum's construct is absent there or the stratum is waived there. The combined stratum is
 * unmet when any scope leaves it unmet, or when its combined population has no sampled member.
 */
export function combineStrata(
  scopes: readonly { name: string; strata: readonly StratumRecord[] }[],
): CombinedStratum[] {
  return STRATA.map((name): CombinedStratum => {
    const entries = scopes.flatMap((scope) =>
      scope.strata
        .filter((record) => record.name === name)
        .map((record) => ({
          scope: scope.name,
          population: record.population,
          sampled: record.sampled,
          status: record.status,
        })),
    );
    const counted = entries.filter(
      (entry) => entry.status !== 'construct-absent' && entry.status !== 'waived',
    );
    const population = counted.reduce((sum, entry) => sum + entry.population, 0);
    const sampled = counted.reduce((sum, entry) => sum + entry.sampled, 0);
    const status = entries.some((entry) => entry.status === 'unmet')
      ? 'unmet'
      : population === 0
        ? 'empty-population'
        : sampled > 0
          ? 'met'
          : 'unmet';
    return { name, population, sampled, status, scopes: entries };
  });
}

// ── inputs and versions (KTD12) ────────────────────────────────────────────

export const INPUT_GROUPS = ['closure', 'vitestConfig', 'mutationConfig', 'prepareTool'] as const;
export type InputGroup = (typeof INPUT_GROUPS)[number];
/** Per group: repo-relative POSIX path to the SHA-256 of the file (`absent` when missing). */
export type InputHashes = Record<InputGroup, Record<string, string>>;
export const ABSENT = 'absent';

/** Package-relative entry points of the config and tool groups. */
export const VITEST_CONFIG = 'vitest.config.ts';
export const MUTATION_CONFIG = 'tools/mutation/vitest.mutation.config.ts';
export const PREPARE_DIR = 'tools/mutation/prepare';
/** Repo-relative: the mutation config derives its aliases from this file's `exports`. */
export const SHARED_MANIFEST = 'gitnexus-shared/package.json';

/** The repo-relative files of each input group in the checkout (U5 classifier closures). */
export function inputFiles(
  repoRoot: string,
  testFiles: readonly string[],
): Record<InputGroup, string[]> {
  const classifier = new Classifier(repoRoot);
  const closure = (files: readonly string[]): string[] =>
    [...new Set(files.flatMap((file) => classifier.classifyFile(file).closure))].sort();
  const prepareModules = readdirSync(path.join(repoRoot, PACKAGE_DIR, PREPARE_DIR))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => `${PREPARE_DIR}/${name}`);
  return {
    closure: closure(testFiles),
    vitestConfig: closure([VITEST_CONFIG]),
    mutationConfig: [...closure([MUTATION_CONFIG]), SHARED_MANIFEST].sort(),
    prepareTool: closure(prepareModules),
  };
}

/** Hashes every listed file through `locate` (repo path to absolute path). */
export function hashInputs(
  files: Readonly<Record<InputGroup, readonly string[]>>,
  locate: (repoPath: string) => string,
): InputHashes {
  const hashGroup = (group: InputGroup): Record<string, string> =>
    Object.fromEntries(
      [...files[group]].sort().map((repoPath) => {
        const file = locate(repoPath);
        return [repoPath, existsSync(file) ? sha256(readFileSync(file)) : ABSENT];
      }),
    );
  return {
    closure: hashGroup('closure'),
    vitestConfig: hashGroup('vitestConfig'),
    mutationConfig: hashGroup('mutationConfig'),
    prepareTool: hashGroup('prepareTool'),
  };
}

const SHARED_PREFIX = 'gitnexus-shared/';

/**
 * Where a repo file lives in a prepared copy (prepare.ts layout, KTD8): `gitnexus/` files keep
 * their path, `gitnexus-shared/` files live under the relocated copy inside the package.
 */
export function preparedLocation(preparedRoot: string, repoPath: string): string {
  if (repoPath.startsWith(`${PACKAGE_DIR}/`)) return path.join(preparedRoot, repoPath);
  if (repoPath.startsWith(SHARED_PREFIX)) {
    return path.join(
      preparedRoot,
      PACKAGE_DIR,
      RELOCATED_SHARED_DIR,
      repoPath.slice(SHARED_PREFIX.length),
    );
  }
  throw new FreezeUsageError(`${repoPath} has no place in a prepared copy`);
}

export interface InputMismatch {
  group: InputGroup;
  path: string;
  expected: string;
  actual: string;
}

/** Entries of `actual` that differ from `expected`, including paths only one side lists; pure. */
export function diffInputs(
  expected: InputHashes,
  actual: InputHashes,
  skip: ReadonlySet<string> = new Set(),
): InputMismatch[] {
  return INPUT_GROUPS.flatMap((group) => {
    const paths = [...new Set([...Object.keys(expected[group]), ...Object.keys(actual[group])])];
    return paths.sort().flatMap((repoPath): InputMismatch[] => {
      if (skip.has(repoPath)) return [];
      const want = expected[group][repoPath] ?? ABSENT;
      const have = actual[group][repoPath] ?? ABSENT;
      return want === have ? [] : [{ group, path: repoPath, expected: want, actual: have }];
    });
  });
}

/** The input hashes a prepared copy holds for the files `inputs` lists. */
export function preparedInputs(preparedRoot: string, inputs: InputHashes): InputHashes {
  const files: Record<InputGroup, string[]> = {
    closure: Object.keys(inputs.closure),
    vitestConfig: Object.keys(inputs.vitestConfig),
    mutationConfig: Object.keys(inputs.mutationConfig),
    prepareTool: Object.keys(inputs.prepareTool),
  };
  return hashInputs(files, (repoPath) => preparedLocation(preparedRoot, repoPath));
}

export interface ToolVersions {
  stryker: string;
  vitest: string;
  nodeMajor: number;
}

function packageVersion(fromDir: string, name: string): string {
  const dir = findPackageDir(fromDir, name);
  if (dir === null) throw new FreezeUsageError(`${name} is not installed under ${fromDir}`);
  const data: unknown = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const version = isObject(data) ? data.version : undefined;
  if (typeof version !== 'string') throw new FreezeUsageError(`${name} has no version`);
  return version;
}

/** Stryker, Vitest and Node versions as the checkout's package resolves them. */
export function currentVersions(packageDir: string): ToolVersions {
  return {
    stryker: packageVersion(packageDir, '@stryker-mutator/core'),
    vitest: packageVersion(packageDir, 'vitest'),
    nodeMajor: Number(process.versions.node.split('.')[0]),
  };
}

// ── JSON readers ───────────────────────────────────────────────────────────

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function field(data: unknown, key: string, at: string): unknown {
  if (!isObject(data) || !(key in data)) throw new FreezeUsageError(`${at}.${key} is missing`);
  return data[key];
}

function stringField(data: unknown, key: string, at: string): string {
  const value = field(data, key, at);
  if (typeof value !== 'string') throw new FreezeUsageError(`${at}.${key} must be a string`);
  return value;
}

function nullableStringField(data: unknown, key: string, at: string): string | null {
  const value = field(data, key, at);
  if (value === null) return null;
  if (typeof value !== 'string')
    throw new FreezeUsageError(`${at}.${key} must be a string or null`);
  return value;
}

function numberField(data: unknown, key: string, at: string): number {
  const value = field(data, key, at);
  if (typeof value !== 'number') throw new FreezeUsageError(`${at}.${key} must be a number`);
  return value;
}

function stringsField(data: unknown, key: string, at: string): string[] {
  const value = field(data, key, at);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new FreezeUsageError(`${at}.${key} must be an array of strings`);
  }
  return value.map(String);
}

function arrayField(data: unknown, key: string, at: string): unknown[] {
  const value = field(data, key, at);
  if (!Array.isArray(value)) throw new FreezeUsageError(`${at}.${key} must be an array`);
  return value;
}

export function toOracleClass(value: unknown, at: string): OracleClass {
  const found = ORACLE_CLASSES.find((entry) => entry === value);
  if (found === undefined) {
    throw new FreezeUsageError(`${at}: ${JSON.stringify(value)} is not an outcome class`);
  }
  return found;
}

const toJsonValue = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null));

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

export interface ScopeSpec {
  testFiles: string[];
  mutate: string[];
}

const sameScope = (a: ScopeSpec, b: ScopeSpec): boolean =>
  JSON.stringify([[...a.testFiles].sort(), [...a.mutate].sort()]) ===
  JSON.stringify([[...b.testFiles].sort(), [...b.mutate].sort()]);

function readScopeSpec(data: unknown, at: string): ScopeSpec {
  const scope = field(data, 'scope', at);
  return {
    testFiles: stringsField(scope, 'testFiles', `${at}.scope`),
    mutate: stringsField(scope, 'mutate', `${at}.scope`),
  };
}

/** The `mutator` option of a generated Stryker config; null when Stryker's defaults apply. */
export function readStrykerMutator(configFile: string): JsonValue {
  const data = readJson(configFile);
  return isObject(data) && 'mutator' in data ? toJsonValue(data.mutator) : null;
}

/** The parts of a vitest5 driver run (U10 `results.json`) that freeze and gate 3 read. */
export interface RunnerMutantView {
  globalId: string;
  localId: string;
  /** Stryker's raw status. */
  status: string;
  outcome: OracleClass | null;
  outcomeSource: string;
  /** The latest sidecar record, or null. */
  sidecarFile: string | null;
}

export interface RunnerRunView {
  file: string;
  scope: ScopeSpec;
  runDir: string;
  preparedRoot: string;
  configFile: string;
  mutants: RunnerMutantView[];
  flags: string[];
  spanMapFailures: number;
}

/** Reads a vitest5 driver run's `results.json` with this module's own minimal parser. */
export function readRunnerResults(file: string): RunnerRunView {
  const data = readJson(file);
  const at = path.basename(file);
  if (field(data, 'variant', at) !== 'vitest5') {
    throw new FreezeUsageError(`${file} is not the results.json of a vitest5 run`);
  }
  const paths = field(data, 'paths', at);
  const runDir = nullableStringField(paths, 'runDir', `${at}.paths`);
  if (runDir === null) throw new FreezeUsageError(`${file} has no run directory`);
  const spanMap = field(data, 'spanMap', at);
  return {
    file,
    scope: readScopeSpec(data, at),
    runDir,
    preparedRoot: stringField(paths, 'preparedRoot', `${at}.paths`),
    configFile: stringField(paths, 'configFile', `${at}.paths`),
    mutants: arrayField(data, 'mutants', at).map((entry, index): RunnerMutantView => {
      const where = `${at}.mutants[${index}]`;
      const outcome = field(entry, 'outcome', where);
      const sidecar = field(entry, 'sidecar', where);
      return {
        globalId: stringField(entry, 'globalId', where),
        localId: stringField(entry, 'localId', where),
        status: stringField(entry, 'status', where),
        outcome: outcome === null ? null : toOracleClass(outcome, `${where}.outcome`),
        outcomeSource: stringField(entry, 'outcomeSource', where),
        sidecarFile: sidecar === null ? null : stringField(sidecar, 'file', `${where}.sidecar`),
      };
    }),
    flags: arrayField(data, 'flags', at).map(
      (flag, index) =>
        `${stringField(flag, 'kind', `${at}.flags[${index}]`)}: ` +
        `${stringField(flag, 'detail', `${at}.flags[${index}]`)}`,
    ),
    spanMapFailures: arrayField(spanMap, 'failures', `${at}.spanMap`).length,
  };
}

export interface RunManifestView {
  vitestVersion: string;
  tests: { id: string; notOracleValidated: boolean }[];
}

/** Reads the runner's `<runDir>/run-manifest.json` (KTD16) with this module's own parser. */
export function readRunManifest(runDir: string): RunManifestView {
  const file = path.join(runDir, 'run-manifest.json');
  if (!existsSync(file)) throw new FreezeUsageError(`${file} is missing`);
  const data = readJson(file);
  const at = 'run-manifest.json';
  return {
    vitestVersion: stringField(data, 'vitestVersion', at),
    tests: arrayField(data, 'files', at).flatMap((entry, fileIndex) =>
      arrayField(entry, 'tests', `${at}.files[${fileIndex}]`).map((test, index) => {
        const where = `${at}.files[${fileIndex}].tests[${index}]`;
        return {
          id: stringField(test, 'id', where),
          notOracleValidated: field(test, 'notOracleValidated', where) === true,
        };
      }),
    ),
  };
}

/** The parts of an oracle command run's JSON that launch-single.ts `readCommandRun` skips. */
interface CommandRunExtras {
  scope: ScopeSpec;
  problems: string[];
  mutatorNames: string[];
  configFile: string;
  killedBy: Map<string, string[]>;
}

function readCommandRunExtras(run: CommandRunView): CommandRunExtras {
  const data = readJson(run.file);
  const at = path.basename(run.file);
  const mutants = arrayField(data, 'mutants', at);
  return {
    scope: readScopeSpec(data, at),
    problems: stringsField(data, 'problems', at),
    mutatorNames: [
      ...new Set(
        mutants.map((entry, index) => stringField(entry, 'mutatorName', `${at}.mutants[${index}]`)),
      ),
    ].sort(),
    configFile: path.join(run.outDir, 'stryker.config.json'),
    killedBy: new Map(run.mutants.map((mutant) => [mutant.globalId, mutant.killedBy])),
  };
}

// ── resumable launches ─────────────────────────────────────────────────────

export interface PlannedLaunch {
  /** Directory of the launch's attempts, relative to the launch root. */
  key: string;
  target: LaunchTarget;
  /** Local mutant id of the oracle's command run; null for a baseline launch. */
  mutantId: string | null;
}

export const launchKey = (mutantId: string | null, testId: string): string =>
  `${mutantId === null ? 'baseline' : `m${mutantId}`}/${sha256(testId).slice(0, 16)}`;

export interface CompletedLaunch {
  key: string;
  /** The attempt dir holding launch.json. */
  dir: string;
  attempt: number;
  testId: string;
  mutantId: string | null;
  validity: 'valid' | 'invalid';
  outcome: OracleClass;
  reason: string | null;
  covering: boolean | null;
  /** Found done in the work dir rather than launched by this run. */
  reused: boolean;
}

export interface LaunchProgress {
  done: number;
  total: number;
  launched: number;
  reused: number;
  invalid: number;
}

export interface LaunchRunOptions {
  launchRoot: string;
  sandboxDir: string;
  scopeFile: string;
  wallClockMs: number;
  concurrency: number;
  retryInvalid: boolean;
  signal?: AbortSignal;
  /** Defaults to launch-single.ts `launchSingle`; it must leave launch.json in `launchDir`. */
  launch?: (options: LaunchOptions) => Promise<unknown>;
  onDone?: (launch: CompletedLaunch, progress: LaunchProgress) => void;
}

export interface LaunchRunResult {
  completed: Map<string, CompletedLaunch>;
  launched: number;
  reused: number;
  aborted: boolean;
}

const ATTEMPT_DIR = /^attempt-([1-9]\d*)$/;
const LAUNCH_FILE = 'launch.json';

/** Reads a done attempt's launch.json (launch-single.ts `LaunchResult`). */
export function readCompletedLaunch(key: string, dir: string, attempt: number): CompletedLaunch {
  const at = path.join(dir, LAUNCH_FILE);
  const data = readJson(at);
  const target = field(data, 'target', at);
  const observation = field(data, 'observation', at);
  const validity = field(observation, 'validity', `${at}.observation`);
  const covering = field(observation, 'covering', `${at}.observation`);
  if (validity !== 'valid' && validity !== 'invalid') {
    throw new FreezeUsageError(`${at}: observation.validity must be valid or invalid`);
  }
  return {
    key,
    dir,
    attempt,
    testId: stringField(target, 'id', `${at}.target`),
    mutantId: nullableStringField(data, 'mutantId', at),
    validity,
    outcome: toOracleClass(field(observation, 'outcome', `${at}.observation`), at),
    reason: nullableStringField(observation, 'reason', `${at}.observation`),
    covering: typeof covering === 'boolean' ? covering : null,
    reused: false,
  };
}

/** The done attempt of a launch to reuse, or the attempt number to launch next. */
function scanAttempts(
  plan: PlannedLaunch,
  keyDir: string,
  retryInvalid: boolean,
): { done: CompletedLaunch } | { next: number } {
  const numbers = existsSync(keyDir)
    ? readdirSync(keyDir)
        .flatMap((name) => ATTEMPT_DIR.exec(name)?.[1] ?? [])
        .map(Number)
    : [];
  let latest = 0;
  for (const attempt of numbers.sort((a, b) => a - b)) {
    const dir = path.join(keyDir, `attempt-${attempt}`);
    if (existsSync(path.join(dir, LAUNCH_FILE))) latest = attempt;
    else rmSync(dir, { recursive: true, force: true });
  }
  if (latest === 0) return { next: 1 };
  const done = readCompletedLaunch(plan.key, path.join(keyDir, `attempt-${latest}`), latest);
  if (done.testId !== plan.target.id || done.mutantId !== plan.mutantId) {
    throw new FreezeUsageError(
      `${done.dir} holds test ${done.testId} with mutant ${done.mutantId ?? 'none'}, not ` +
        `${plan.target.id} with ${plan.mutantId ?? 'none'}; use a new work dir`,
    );
  }
  if (retryInvalid && done.validity === 'invalid') return { next: latest + 1 };
  return { done: { ...done, reused: true } };
}

/**
 * Runs the planned launches at most `concurrency` at a time, skipping launches already done in
 * the launch root (see the module comment). An abort stops scheduling, kills running launches and
 * returns with `aborted: true`; any other launch error aborts the rest and is rethrown.
 */
export async function runLaunches(
  plans: readonly PlannedLaunch[],
  options: LaunchRunOptions,
): Promise<LaunchRunResult> {
  const launch = options.launch ?? launchSingle;
  const completed = new Map<string, CompletedLaunch>();
  const progress: LaunchProgress = {
    done: 0,
    total: plans.length,
    launched: 0,
    reused: 0,
    invalid: 0,
  };
  const finish = (entry: CompletedLaunch): void => {
    completed.set(entry.key, entry);
    progress.done++;
    if (entry.reused) progress.reused++;
    else progress.launched++;
    if (entry.validity === 'invalid') progress.invalid++;
    options.onDone?.(entry, { ...progress });
  };
  const pending: { plan: PlannedLaunch; attempt: number }[] = [];
  for (const plan of plans) {
    const scanned = scanAttempts(
      plan,
      path.join(options.launchRoot, plan.key),
      options.retryInvalid,
    );
    if ('done' in scanned) finish(scanned.done);
    else pending.push({ plan, attempt: scanned.next });
  }

  const controller = new AbortController();
  const forward = (): void => controller.abort();
  options.signal?.addEventListener('abort', forward, { once: true });
  if (options.signal?.aborted === true) controller.abort();
  let failure: unknown = null;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted && next < pending.length) {
      const { plan, attempt } = pending[next++];
      const dir = path.join(options.launchRoot, plan.key, `attempt-${attempt}`);
      try {
        await launch({
          sandboxDir: options.sandboxDir,
          scopeFile: options.scopeFile,
          target: plan.target,
          mutantId: plan.mutantId,
          wallClockMs: options.wallClockMs,
          launchDir: dir,
          signal: controller.signal,
        });
      } catch (error) {
        if (!(error instanceof LaunchAbortedError)) {
          failure ??= error;
          controller.abort();
        }
        return;
      }
      finish(readCompletedLaunch(plan.key, dir, attempt));
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(options.concurrency, pending.length) }, worker),
    );
  } finally {
    options.signal?.removeEventListener('abort', forward);
  }
  if (failure !== null) throw failure;
  return {
    completed,
    launched: progress.launched,
    reused: progress.reused,
    aborted: completed.size < plans.length,
  };
}

/**
 * The test's own class in a launch (see "Per-test outcomes" in the module comment): the oracle
 * classifier's row of the target in the launch's record; the launch's outcome when the launch
 * left no observed run (a wall-clock kill) or is invalid.
 */
export function launchTestClass(launch: CompletedLaunch): OracleClass {
  if (launch.validity === 'invalid') return launch.outcome;
  const kind = launch.mutantId === null ? 'dry-run' : 'mutant';
  const file = path.join(launch.dir, 'reports', recordFileName(kind, launch.mutantId, 1));
  if (!existsSync(file)) return launch.outcome;
  const record = parseOracleRunRecord(readFileSync(file, 'utf8'));
  if (record.run === null) return launch.outcome;
  const { tests } = classifyRun(record.run, {
    exitCode: record.exitCode,
    expected: [launch.testId],
    vitestJson: record.vitestJson,
  });
  return tests.find((test) => test.id === launch.testId)?.outcome ?? launch.outcome;
}

/** The baseline launch's coverage from its probe; null when the probe recorded none. */
export function launchCoverage(launch: CompletedLaunch): ProbeCoverage | null {
  const file = path.join(launch.dir, 'probe.json');
  if (!existsSync(file)) return null;
  return parseOracleProbe(readFileSync(file, 'utf8')).coverage ?? null;
}

// ── manifest ───────────────────────────────────────────────────────────────

export interface SampledMutant {
  id: string;
  strata: StratumName[];
  /** Tests whose launch hit the mutant. */
  covering: number;
  /** [test index, class] of every valid observation that is not `survived`. */
  outcomes: [number, OracleClass][];
  /** [test index, class, reason] of every invalid observation. */
  invalid: [number, OracleClass, string][];
}

export interface OracleManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  kind: typeof MANIFEST_KIND;
  name: string;
  description: string;
  refreeze: string;
  scope: ScopeSpec;
  versions: ToolVersions;
  operators: { mutator: JsonValue; names: string[] };
  inputs: InputHashes;
  sample: {
    seed: string;
    method: string;
    size: number;
    topUpMin: number;
    /** Size of the random part of the sample. */
    random: number;
    topUps: TopUp[];
  };
  strata: StratumRecord[];
  baseline: { tests: number; passedAlone: number };
  tests: string[];
  notOracleValidated: string[];
  mutants: [string, OracleClass][];
  sampled: SampledMutant[];
  launches: { total: number; valid: number; invalid: number; wallClockLimitMs: number };
  warnings: string[];
  problems: string[];
}

/**
 * Formats JSON with two-space indentation, keeping arrays of primitives and of primitive rows
 * on one line when they fit 100 columns, and putting each row of a longer one on its own line.
 */
export function formatJson(value: unknown, indent = ''): string {
  const inner = `${indent}  `;
  const isPrimitive = (entry: unknown): boolean => entry === null || typeof entry !== 'object';
  const isRow = (entry: unknown): boolean =>
    isPrimitive(entry) || (Array.isArray(entry) && entry.every(isPrimitive));
  if (isPrimitive(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isRow)) {
      const inline = JSON.stringify(value);
      if (indent.length + inline.length <= 100) return inline;
      return `[\n${value.map((entry) => `${inner}${JSON.stringify(entry)}`).join(',\n')}\n${indent}]`;
    }
    return `[\n${value.map((entry) => `${inner}${formatJson(entry, inner)}`).join(',\n')}\n${indent}]`;
  }
  if (!isObject(value)) return JSON.stringify(value);
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  if (entries.length === 0) return '{}';
  return `{\n${entries
    .map(([key, entry]) => `${inner}${JSON.stringify(key)}: ${formatJson(entry, inner)}`)
    .join(',\n')}\n${indent}}`;
}

function parseInputs(data: unknown, at: string): InputHashes {
  const group = (name: InputGroup): Record<string, string> => {
    const value = field(data, name, at);
    if (!isObject(value) || Object.values(value).some((hash) => typeof hash !== 'string')) {
      throw new FreezeUsageError(`${at}.${name} must map paths to hashes`);
    }
    return Object.fromEntries(Object.entries(value).map(([key, hash]) => [key, String(hash)]));
  };
  return {
    closure: group('closure'),
    vitestConfig: group('vitestConfig'),
    mutationConfig: group('mutationConfig'),
    prepareTool: group('prepareTool'),
  };
}

const toStratum = (value: unknown, at: string): StratumName => {
  const found = STRATA.find((name) => name === value);
  if (found === undefined) throw new FreezeUsageError(`${at}: unknown stratum ${String(value)}`);
  return found;
};

const STRATUM_STATUSES: readonly StratumStatus[] = [
  'met',
  'unmet',
  'waived',
  'empty-population',
  'construct-absent',
  'combined',
];

function parseStratum(data: unknown, at: string): StratumRecord {
  const name = toStratum(field(data, 'name', at), at);
  const status = STRATUM_STATUSES.find((entry) => entry === field(data, 'status', at));
  if (status === undefined) throw new FreezeUsageError(`${at}.status is unknown`);
  const constructPresent = field(data, 'constructPresent', at);
  return {
    name,
    construct: STRATUM_CONSTRUCT[name],
    constructPresent: typeof constructPresent === 'boolean' ? constructPresent : null,
    population: numberField(data, 'population', at),
    sampled: numberField(data, 'sampled', at),
    toppedUp: numberField(data, 'toppedUp', at),
    required: field(data, 'required', at) === true,
    status,
    affectedTests: numberField(data, 'affectedTests', at),
  };
}

function tuple(value: unknown, length: number, at: string): unknown[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new FreezeUsageError(`${at} must be an array of ${length} entries`);
  }
  return value;
}

const index = (value: unknown, at: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new FreezeUsageError(`${at} must be a test index`);
  }
  return value;
};

/** Parses and validates a frozen manifest's text. */
export function parseManifest(text: string): OracleManifest {
  const data: unknown = JSON.parse(text);
  const at = 'manifest';
  if (field(data, 'kind', at) !== MANIFEST_KIND) {
    throw new FreezeUsageError('not an oracle manifest (kind)');
  }
  if (field(data, 'schemaVersion', at) !== MANIFEST_SCHEMA_VERSION) {
    throw new FreezeUsageError(`manifest schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  }
  const versions = field(data, 'versions', at);
  const operators = field(data, 'operators', at);
  const sample = field(data, 'sample', at);
  const baseline = field(data, 'baseline', at);
  const launches = field(data, 'launches', at);
  const tests = stringsField(data, 'tests', at);
  const testIndex = (value: unknown, where: string): number => {
    const found = index(value, where);
    if (found >= tests.length) throw new FreezeUsageError(`${where}: no test ${found}`);
    return found;
  };
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    name: stringField(data, 'name', at),
    description: stringField(data, 'description', at),
    refreeze: stringField(data, 'refreeze', at),
    scope: readScopeSpec(data, at),
    versions: {
      stryker: stringField(versions, 'stryker', `${at}.versions`),
      vitest: stringField(versions, 'vitest', `${at}.versions`),
      nodeMajor: numberField(versions, 'nodeMajor', `${at}.versions`),
    },
    operators: {
      mutator: toJsonValue(field(operators, 'mutator', `${at}.operators`)),
      names: stringsField(operators, 'names', `${at}.operators`),
    },
    inputs: parseInputs(field(data, 'inputs', at), `${at}.inputs`),
    sample: {
      seed: stringField(sample, 'seed', `${at}.sample`),
      method: stringField(sample, 'method', `${at}.sample`),
      size: numberField(sample, 'size', `${at}.sample`),
      topUpMin: numberField(sample, 'topUpMin', `${at}.sample`),
      random: numberField(sample, 'random', `${at}.sample`),
      topUps: arrayField(sample, 'topUps', `${at}.sample`).map((entry, i) => ({
        globalId: stringField(entry, 'globalId', `${at}.sample.topUps[${i}]`),
        stratum: toStratum(field(entry, 'stratum', `${at}.sample.topUps[${i}]`), at),
      })),
    },
    strata: arrayField(data, 'strata', at).map((entry, i) =>
      parseStratum(entry, `${at}.strata[${i}]`),
    ),
    baseline: {
      tests: numberField(baseline, 'tests', `${at}.baseline`),
      passedAlone: numberField(baseline, 'passedAlone', `${at}.baseline`),
    },
    tests,
    notOracleValidated: stringsField(data, 'notOracleValidated', at),
    mutants: arrayField(data, 'mutants', at).map((entry, i): [string, OracleClass] => {
      const [globalId, outcome] = tuple(entry, 2, `${at}.mutants[${i}]`);
      if (typeof globalId !== 'string') {
        throw new FreezeUsageError(`${at}.mutants[${i}][0] must be a global id`);
      }
      return [globalId, toOracleClass(outcome, `${at}.mutants[${i}]`)];
    }),
    sampled: arrayField(data, 'sampled', at).map((entry, i): SampledMutant => {
      const where = `${at}.sampled[${i}]`;
      return {
        id: stringField(entry, 'id', where),
        strata: arrayField(entry, 'strata', where).map((name) => toStratum(name, where)),
        covering: numberField(entry, 'covering', where),
        outcomes: arrayField(entry, 'outcomes', where).map((row, j): [number, OracleClass] => {
          const [test, outcome] = tuple(row, 2, `${where}.outcomes[${j}]`);
          return [testIndex(test, `${where}.outcomes[${j}]`), toOracleClass(outcome, where)];
        }),
        invalid: arrayField(entry, 'invalid', where).map(
          (row, j): [number, OracleClass, string] => {
            const [test, outcome, reason] = tuple(row, 3, `${where}.invalid[${j}]`);
            return [
              testIndex(test, `${where}.invalid[${j}]`),
              toOracleClass(outcome, where),
              String(reason),
            ];
          },
        ),
      };
    }),
    launches: {
      total: numberField(launches, 'total', `${at}.launches`),
      valid: numberField(launches, 'valid', `${at}.launches`),
      invalid: numberField(launches, 'invalid', `${at}.launches`),
      wallClockLimitMs: numberField(launches, 'wallClockLimitMs', `${at}.launches`),
    },
    warnings: stringsField(data, 'warnings', at),
    problems: stringsField(data, 'problems', at),
  };
}

export function readManifest(file: string): OracleManifest {
  try {
    return parseManifest(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new FreezeUsageError(
      `${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const writeAtomic = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  writeFileSync(temporary, text);
  renameSync(temporary, file);
};

export const writeManifest = (file: string, manifest: OracleManifest): void =>
  writeAtomic(file, `${formatJson(manifest)}\n`);

/** The re-freeze command recorded in a manifest (KTD12). */
export const refreezeCommand = (manifestPath: string): string =>
  `npm run test:mutation:oracle:freeze -- --from-manifest ${manifestPath} --seed <new seed> ` +
  '--work <dir outside the checkout>';

const describeManifest = (name: string, manifestPath: string): string =>
  `Gate 3 (U7): the oracle's frozen outcomes for the ${name} scope: a seeded sample of mutants ` +
  'with strata top-ups, the oracle class of every mutant (U13 command run) and the per-test ' +
  'outcome of every sampled mutant with every test, each test launched alone (U12). Check a ' +
  `vitest5 runner run with \`npm run test:mutation:oracle -- --scope ${manifestPath},<results.json>\` ` +
  '(from gitnexus/). When gate 3 reports "re-freeze required", run the refreeze command.';

// ── freeze ─────────────────────────────────────────────────────────────────

export interface FreezeOptions {
  repoRoot: string;
  /** Driver scope file; exactly one of this and `fromManifest`. */
  scopeFile: string | null;
  fromManifest: string | null;
  name: string | null;
  workDir: string;
  /** Where a clean manifest goes; null writes only `<work>/manifest.json`. */
  manifestFile: string | null;
  seed: string;
  sampleSize: number;
  topUpMin: number;
  launchConcurrency: number;
  /** Stryker concurrency of the command and runner runs. */
  concurrency: number;
  timeoutMS: number;
  wallClockMs: number;
  commandRun: string | null;
  runnerResults: string | null;
  notOracleValidated: string[];
  retryInvalid: boolean;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface FreezeResult {
  manifest: OracleManifest | null;
  /** The file the manifest went to (`--manifest` when clean, else the work dir's). */
  manifestFile: string | null;
  exitCode: number;
}

interface WorkIdentity {
  schemaVersion: 1;
  name: string;
  scope: ScopeSpec;
  seed: string;
  sampleSize: number;
  topUpMin: number;
  wallClockMs: number;
  commandRun: string | null;
  runnerResults: string | null;
  notOracleValidated: string[];
}

function claimWorkDir(repoRoot: string, workDir: string, identity: WorkIdentity): void {
  if (!path.isAbsolute(workDir)) throw new FreezeUsageError('--work must be an absolute path');
  if (isInside(repoRoot, workDir) || isInside(workDir, repoRoot)) {
    throw new FreezeUsageError(`--work ${workDir} must lie outside the checkout ${repoRoot}`);
  }
  mkdirSync(workDir, { recursive: true });
  const file = path.join(workDir, WORK_FILE);
  const text = `${JSON.stringify(identity, null, 2)}\n`;
  if (existsSync(file)) {
    const previous = readFileSync(file, 'utf8');
    if (previous !== text) {
      throw new FreezeUsageError(
        `${workDir} belongs to another freeze (${WORK_FILE} differs: scope, seed, sample ` +
          'options, wall clock, reused runs or marked tests); use a new --work dir',
      );
    }
    return;
  }
  if (readdirSync(workDir).length > 0) {
    throw new FreezeUsageError(`${workDir} is not empty and holds no ${WORK_FILE}`);
  }
  writeAtomic(file, text);
}

const formatDuration = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
};

const defaultName = (mutate: readonly string[]): string =>
  path.posix.basename((mutate[0] ?? 'scope').split(':')[0]).replace(/\.ts$/, '');

/** Runs one freeze (see the module comment). */
export async function runFreeze(options: FreezeOptions): Promise<FreezeResult> {
  const log = options.log ?? ((line: string): void => console.log(line));
  const packageDir = path.join(options.repoRoot, PACKAGE_DIR);
  const source = options.fromManifest === null ? null : readManifest(options.fromManifest);
  let scope: ScopeSpec;
  if (source !== null) scope = source.scope;
  else if (options.scopeFile !== null) {
    const parsed = parseDriverScope(readFileSync(options.scopeFile, 'utf8'));
    scope = {
      testFiles: parsed.testFiles,
      mutate: parsed.mutate.map((entry) =>
        entry.range === null ? entry.file : `${entry.file}:${entry.range}`,
      ),
    };
  } else throw new FreezeUsageError('give --scope <driver scope.json> or --from-manifest <file>');
  const name = options.name ?? source?.name ?? defaultName(scope.mutate);
  const manifestFile =
    options.manifestFile ?? (options.fromManifest === null ? null : options.fromManifest);
  const manifestPath =
    manifestFile !== null && isInside(packageDir, manifestFile)
      ? path.relative(packageDir, manifestFile).split(path.sep).join('/')
      : `test/fixtures/mutation-oracle/${name}.json`;

  claimWorkDir(options.repoRoot, options.workDir, {
    schemaVersion: 1,
    name,
    scope,
    seed: options.seed,
    sampleSize: options.sampleSize,
    topUpMin: options.topUpMin,
    wallClockMs: options.wallClockMs,
    commandRun: options.commandRun,
    runnerResults: options.runnerResults,
    notOracleValidated: [...options.notOracleValidated].sort(),
  });
  const scopeFile = path.join(options.workDir, 'scope.json');
  writeAtomic(scopeFile, `${JSON.stringify(scope, null, 2)}\n`);
  const started = performance.now();
  const problems: string[] = [];
  const warnings: string[] = [];

  // 1-2. Runs.
  let commandRunFile = options.commandRun;
  if (commandRunFile === null) {
    commandRunFile = path.join(options.workDir, 'command', RESULT_FILE_NAME);
    if (!existsSync(commandRunFile)) {
      log(`freeze ${name}: oracle command run in ${path.dirname(commandRunFile)}`);
      await runOracleCommand({
        repoRoot: options.repoRoot,
        scopeFile,
        outDir: path.dirname(commandRunFile),
        concurrency: options.concurrency,
        timeoutMS: options.timeoutMS,
      });
    }
  }
  let runnerFile = options.runnerResults;
  if (runnerFile === null) {
    runnerFile = path.join(options.workDir, 'runner', 'results.json');
    if (!existsSync(runnerFile)) {
      log(`freeze ${name}: vitest5 runner run in ${path.dirname(runnerFile)}`);
      await runScope({
        repoRoot: options.repoRoot,
        scopeFile,
        outDir: path.dirname(runnerFile),
        variant: 'vitest5',
        concurrency: options.concurrency,
        maxTestRunnerReuse: 0,
        timeoutMS: options.timeoutMS,
        command: undefined,
      });
    }
  }
  if (options.signal?.aborted === true) {
    return { manifest: null, manifestFile: null, exitCode: EXIT_INTERRUPTED };
  }
  const run = readCommandRun(commandRunFile);
  const extras = readCommandRunExtras(run);
  const runner = readRunnerResults(runnerFile);
  const runManifest = readRunManifest(runner.runDir);
  problems.push(...extras.problems.map((problem) => `command run: ${problem}`));
  if (!sameScope(extras.scope, scope)) problems.push('the command run ran another scope');
  if (!sameScope(runner.scope, scope)) problems.push('the runner run ran another scope');
  const unusable = run.mutants.filter((mutant) =>
    ['invalid', 'infrastructure', 'inconclusive'].includes(mutant.oracleClass),
  );
  for (const mutant of unusable) {
    problems.push(`command run: ${mutant.globalId} classifies as ${mutant.oracleClass}`);
  }
  if (runner.flags.length > 0) {
    warnings.push(`the runner run has ${runner.flags.length} flags (gate 3 blocks on them)`);
  }

  // Versions, operators and inputs (KTD12).
  const versions = currentVersions(packageDir);
  const dryRun = parseOracleRunRecord(readFileSync(run.baselineRecord, 'utf8'));
  if (dryRun.vitestVersion !== versions.vitest) {
    problems.push(
      `the command run used Vitest ${dryRun.vitestVersion}, the checkout ${versions.vitest}`,
    );
  }
  if (runManifest.vitestVersion !== versions.vitest) {
    problems.push(
      `the runner run used Vitest ${runManifest.vitestVersion}, the checkout ${versions.vitest}`,
    );
  }
  const mutator = readStrykerMutator(extras.configFile);
  if (JSON.stringify(readStrykerMutator(runner.configFile)) !== JSON.stringify(mutator)) {
    problems.push('the runner and command runs used different Stryker mutator options');
  }
  const inputs = hashInputs(inputFiles(options.repoRoot, scope.testFiles), (repoPath) =>
    path.join(options.repoRoot, repoPath),
  );
  const mutated = new Set(scope.mutate.map((entry) => entry.split(':')[0]));
  for (const [label, preparedRoot] of [
    ['command run', path.join(run.outDir, 'prepared')],
    ['runner run', runner.preparedRoot],
  ] as const) {
    for (const mismatch of diffInputs(inputs, preparedInputs(preparedRoot, inputs), mutated)) {
      problems.push(
        `the ${label} was prepared from another ${mismatch.path} than the checkout's (${mismatch.group})`,
      );
    }
  }
  for (const mutant of run.mutants) {
    const at = mutant.globalId.indexOf('@');
    const file = mutant.globalId.slice(0, at);
    const hash = mutant.globalId.slice(at + 1, at + 17);
    const current = inputs.closure[file];
    if (current !== undefined && !current.startsWith(hash)) {
      problems.push(`${file} changed since the command run (mutant ${mutant.globalId})`);
      break;
    }
  }

  // Test inventory (KTD18) and not oracle-validated tests.
  const inventory = readTestInventory(run);
  const testIds = inventory.map((target) => target.id);
  const inventoryDiff = diffInventory(
    testIds,
    runManifest.tests.map((test) => test.id),
    normaliseTestId,
  );
  for (const id of inventoryDiff.onlyA)
    problems.push(`test ${id} is missing from the run manifest`);
  for (const id of inventoryDiff.onlyB)
    problems.push(`run-manifest test ${id} is missing from the oracle inventory`);
  for (const id of [...inventoryDiff.ambiguousA, ...inventoryDiff.ambiguousB]) {
    problems.push(`test id ${id} is ambiguous after normalisation`);
  }
  const known = new Map(testIds.map((id) => [normaliseTestId(id), id]));
  const notOracleValidated = new Set([
    ...ordinalTests(inventory),
    ...runManifest.tests
      .filter((test) => test.notOracleValidated)
      .flatMap((test) => known.get(normaliseTestId(test.id)) ?? []),
  ]);
  for (const id of options.notOracleValidated) {
    const found = known.get(normaliseTestId(id));
    if (found === undefined)
      throw new FreezeUsageError(`--not-oracle-validated ${id} is not a test of the scope`);
    notOracleValidated.add(found);
  }

  // Constructs (U5 classifier) and each rows.
  const classifier = new Classifier(options.repoRoot);
  const verdicts = scope.testFiles.map((file) => classifier.classifyFile(file));
  const beforeAllFiles = new Set(
    verdicts.filter((verdict) => verdict.hooks.beforeAll > 0).map((verdict) => verdict.file),
  );
  const eachRows = eachRowTests(inventory);
  const constructs: Record<Construct, boolean> = {
    beforeAll: beforeAllFiles.size > 0,
    each: verdicts.some((verdict) => verdict.eachCalls > 0),
  };
  const affectedTests: Record<Construct, string[]> = {
    beforeAll: inventory.filter((target) => beforeAllFiles.has(target.file)).map((t) => t.id),
    each: eachRows,
  };

  const launchRoot = path.join(options.workDir, 'launches');
  const launchOptions = {
    launchRoot,
    sandboxDir: run.sandboxDir,
    scopeFile: run.scopeFile,
    wallClockMs: options.wallClockMs,
    concurrency: options.launchConcurrency,
    retryInvalid: options.retryInvalid,
    signal: options.signal,
  };
  const progressLogger = (phase: string): LaunchRunOptions['onDone'] => {
    let lastLog = Number.NEGATIVE_INFINITY;
    const phaseStarted = performance.now();
    return (_launch, progress) => {
      const now = performance.now();
      if (progress.done !== progress.total && now - lastLog < 30_000) return;
      lastLog = now;
      const rate = progress.launched === 0 ? 0 : (now - phaseStarted) / progress.launched;
      const eta = rate * (progress.total - progress.done);
      log(
        `freeze ${name}: ${phase} ${progress.done}/${progress.total} (reused ${progress.reused}, ` +
          `invalid ${progress.invalid}); elapsed ${formatDuration(now - started)}` +
          (progress.done === progress.total ? '' : `, eta ${formatDuration(eta)}`),
      );
    };
  };

  // 3. Baseline launches.
  const baselinePlans = inventory.map((target) => ({
    key: launchKey(null, target.id),
    target,
    mutantId: null,
  }));
  log(`freeze ${name}: ${baselinePlans.length} baseline launches`);
  const baselineRun = await runLaunches(baselinePlans, {
    ...launchOptions,
    onDone: progressLogger('baseline'),
  });
  if (baselineRun.aborted)
    return { manifest: null, manifestFile: null, exitCode: EXIT_INTERRUPTED };
  const baseline: BaselineCoverage[] = [];
  let passedAlone = 0;
  for (const plan of baselinePlans) {
    const launch = baselineRun.completed.get(plan.key);
    const outcome = launch === undefined ? null : launchTestClass(launch);
    if (launch === undefined || launch.validity !== 'valid' || outcome !== 'survived') {
      problems.push(
        `baseline: ${plan.target.id} does not pass alone (${launch?.validity ?? 'missing'} ` +
          `${outcome ?? ''}: ${launch?.reason ?? ''})`,
      );
      continue;
    }
    passedAlone++;
    const coverage = launchCoverage(launch);
    if (coverage === null) problems.push(`baseline: ${launch.dir} recorded no coverage`);
    else baseline.push({ testId: plan.target.id, coverage });
  }

  // 4. Sample and strata.
  const populationMutants = run.mutants.map((mutant) => ({
    globalId: mutant.globalId,
    localId: mutant.localId,
    oracleClass: mutant.oracleClass,
    killedBy: extras.killedBy.get(mutant.globalId) ?? [],
  }));
  const populations = computePopulations(populationMutants, baseline, new Set(eachRows));
  const selection = selectSample({
    mutants: run.mutants.map((mutant) => mutant.globalId),
    seed: options.seed,
    sampleSize: options.sampleSize,
    topUpMin: options.topUpMin,
    populations,
  });
  const strata = evaluateStrata({
    populations,
    selected: selection.selected,
    topUps: selection.topUps,
    constructs,
    affectedTests,
    notOracleValidated,
  });
  for (const stratum of strata.filter((record) => record.status === 'unmet')) {
    problems.push(
      `stratum ${stratum.name}: the scope's tests contain ${stratum.construct ?? 'it'} and its ` +
        `population has ${stratum.population} mutants, but the sample has none; mark the ` +
        `${stratum.affectedTests} affected tests not oracle-validated or raise --top-up-min`,
    );
  }
  log(
    `freeze ${name}: sample ${selection.random.length} + ${selection.topUps.length} top-ups of ` +
      `${run.mutants.length} mutants; strata ${strata
        .map((record) => `${record.name} ${record.sampled}/${record.population} ${record.status}`)
        .join(', ')}`,
  );

  // 5. Per-test launches of the sampled mutants.
  const byGlobal = new Map(run.mutants.map((mutant) => [mutant.globalId, mutant]));
  const sampledPlans: PlannedLaunch[] =
    problems.length > 0
      ? []
      : selection.selected.flatMap((globalId) => {
          const mutant = byGlobal.get(globalId);
          return mutant === undefined
            ? []
            : inventory.map((target) => ({
                key: launchKey(mutant.localId, target.id),
                target,
                mutantId: mutant.localId,
              }));
        });
  if (problems.length > 0) log(`freeze ${name}: ${problems.length} problems; no mutant launched`);
  else log(`freeze ${name}: ${sampledPlans.length} mutant launches`);
  const sampledRun = await runLaunches(sampledPlans, {
    ...launchOptions,
    onDone: progressLogger('mutant launches'),
  });
  if (sampledRun.aborted) return { manifest: null, manifestFile: null, exitCode: EXIT_INTERRUPTED };

  // 6. Manifest.
  const testIndex = new Map(testIds.map((id, position) => [id, position]));
  const strataOf = (globalId: string): StratumName[] =>
    STRATA.filter((stratum) => populations.get(stratum)?.has(globalId) ?? false);
  let valid = 0;
  let invalid = 0;
  const sampled =
    sampledPlans.length === 0
      ? []
      : selection.selected.map((globalId): SampledMutant => {
          const mutant = byGlobal.get(globalId);
          const entry: SampledMutant = {
            id: globalId,
            strata: strataOf(globalId),
            covering: 0,
            outcomes: [],
            invalid: [],
          };
          for (const target of inventory) {
            const launch = sampledRun.completed.get(launchKey(mutant?.localId ?? null, target.id));
            const position = testIndex.get(target.id) ?? -1;
            if (launch === undefined) {
              entry.invalid.push([position, 'invalid', 'no launch result']);
              invalid++;
              continue;
            }
            if (launch.covering === true) entry.covering++;
            if (launch.validity === 'invalid') {
              entry.invalid.push([position, launch.outcome, launch.reason ?? '']);
              invalid++;
              continue;
            }
            valid++;
            const outcome = launchTestClass(launch);
            if (outcome !== 'survived') entry.outcomes.push([position, outcome]);
          }
          if (entry.invalid.length > 0) {
            problems.push(`${globalId}: ${entry.invalid.length} invalid observations`);
          }
          const commandKills = new Set(
            run.mutants.find((candidate) => candidate.globalId === globalId)?.assertionKilledBy ??
              [],
          );
          const aloneKills = new Set(
            entry.outcomes
              .filter(([, outcome]) => outcome === 'killed-by-test:assertion')
              .map(([position]) => testIds[position]),
          );
          const differ =
            commandKills.size !== aloneKills.size ||
            [...commandKills].some((id) => !aloneKills.has(id));
          if (differ) {
            warnings.push(
              `${globalId}: assertion kills of the tests alone (${aloneKills.size}) differ from the ` +
                `command run's (${commandKills.size})`,
            );
          }
          return entry;
        });

  const manifest: OracleManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    name,
    description: describeManifest(name, manifestPath),
    refreeze: refreezeCommand(manifestPath),
    scope,
    versions,
    operators: { mutator, names: extras.mutatorNames },
    inputs,
    sample: {
      seed: options.seed,
      method: SAMPLE_METHOD,
      size: options.sampleSize,
      topUpMin: options.topUpMin,
      random: selection.random.length,
      topUps: selection.topUps,
    },
    strata,
    baseline: { tests: inventory.length, passedAlone },
    tests: testIds,
    notOracleValidated: testIds.filter((id) => notOracleValidated.has(id)),
    mutants: run.mutants
      .map((mutant): [string, OracleClass] => [mutant.globalId, mutant.oracleClass])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    sampled,
    launches: {
      total: baselinePlans.length + sampledPlans.length,
      valid,
      invalid,
      wallClockLimitMs: options.wallClockMs,
    },
    warnings,
    problems,
  };
  const workManifest = path.join(options.workDir, WORK_MANIFEST_FILE);
  writeManifest(workManifest, manifest);
  const target = problems.length === 0 && manifestFile !== null ? manifestFile : workManifest;
  if (target !== workManifest) writeManifest(target, manifest);
  log(
    `freeze ${name}: ${problems.length === 0 ? 'clean' : `${problems.length} problems`}; ` +
      `${sampled.length} sampled mutants, ${valid} valid and ${invalid} invalid observations, ` +
      `${warnings.length} warnings; manifest ${target}; ${formatDuration(performance.now() - started)}`,
  );
  for (const problem of problems.slice(0, 20)) log(`  problem: ${problem}`);
  for (const warning of warnings.slice(0, 10)) log(`  warning: ${warning}`);
  return { manifest, manifestFile: target, exitCode: problems.length === 0 ? 0 : 1 };
}

// ── CLI ────────────────────────────────────────────────────────────────────

const positive = (value: string | undefined, name: string, fallback: number, min = 1): number => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min) {
    throw new FreezeUsageError(`--${name} must be an integer of at least ${min}, got ${value}`);
  }
  return Number(value);
};

export function parseFreezeArgs(
  argv: readonly string[],
  cwd: string,
): Omit<FreezeOptions, 'repoRoot' | 'signal' | 'log'> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      scope: { type: 'string' },
      'from-manifest': { type: 'string' },
      name: { type: 'string' },
      work: { type: 'string' },
      manifest: { type: 'string' },
      seed: { type: 'string' },
      'sample-size': { type: 'string' },
      'top-up-min': { type: 'string' },
      'launch-concurrency': { type: 'string' },
      concurrency: { type: 'string' },
      'timeout-ms': { type: 'string' },
      'wall-clock-ms': { type: 'string' },
      'command-run': { type: 'string' },
      'runner-results': { type: 'string' },
      'not-oracle-validated': { type: 'string', multiple: true },
      'retry-invalid': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if ((values.scope === undefined) === (values['from-manifest'] === undefined)) {
    throw new FreezeUsageError('give exactly one of --scope and --from-manifest');
  }
  if (values.seed === undefined || values.seed === '')
    throw new FreezeUsageError('--seed is required');
  if (values.work === undefined) throw new FreezeUsageError('--work is required');
  const resolve = (value: string | undefined): string | null =>
    value === undefined ? null : path.resolve(cwd, value);
  return {
    scopeFile: resolve(values.scope),
    fromManifest: resolve(values['from-manifest']),
    name: values.name ?? null,
    workDir: path.resolve(cwd, values.work),
    manifestFile: resolve(values.manifest),
    seed: values.seed,
    sampleSize: positive(values['sample-size'], 'sample-size', DEFAULT_SAMPLE_SIZE),
    topUpMin: positive(values['top-up-min'], 'top-up-min', DEFAULT_TOP_UP_MIN, 0),
    launchConcurrency: positive(
      values['launch-concurrency'],
      'launch-concurrency',
      DEFAULT_LAUNCH_CONCURRENCY,
    ),
    concurrency: positive(values.concurrency, 'concurrency', 4),
    timeoutMS: positive(values['timeout-ms'], 'timeout-ms', 10000),
    wallClockMs: positive(values['wall-clock-ms'], 'wall-clock-ms', DEFAULT_WALL_CLOCK_MS),
    commandRun: resolve(values['command-run']),
    runnerResults: resolve(values['runner-results']),
    notOracleValidated: values['not-oracle-validated'] ?? [],
    retryInvalid: values['retry-invalid'],
  };
}

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const controller = new AbortController();
  const interrupt = (signal: string): void => {
    console.error(`freeze: ${signal}; stopping the running launches`);
    controller.abort();
  };
  process.once('SIGINT', () => interrupt('SIGINT'));
  process.once('SIGTERM', () => interrupt('SIGTERM'));
  try {
    const options = parseFreezeArgs(process.argv.slice(2), process.cwd());
    const { exitCode } = await runFreeze({ ...options, repoRoot, signal: controller.signal });
    if (exitCode === EXIT_INTERRUPTED) console.error('freeze: interrupted; rerun to resume');
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof FreezeUsageError || error instanceof TypeError) {
      console.error(
        'usage: npm run test:mutation:oracle:freeze -- (--scope <scope.json> | --from-manifest ' +
          '<manifest.json>) --seed <seed> --work <dir> [--manifest <file>] [--name <name>] ' +
          '[--command-run <oracle-command-run.json>] [--runner-results <results.json>] ' +
          '[--sample-size <n>] [--top-up-min <n>] [--launch-concurrency <n>] [--concurrency <n>] ' +
          '[--timeout-ms <n>] [--wall-clock-ms <n>] [--not-oracle-validated <test id>]... ' +
          '[--retry-invalid]',
      );
    } else {
      console.error(error instanceof Error ? error.stack : '');
    }
    process.exitCode = controller.signal.aborted ? EXIT_INTERRUPTED : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
