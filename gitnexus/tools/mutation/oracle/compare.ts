/**
 * Gate 3 (U7; KTD11, KTD12, KTD13, KTD17, KTD18): compares vitest5 runner runs (U10 `results.json`)
 * with the oracle's frozen manifests (freeze.ts).
 *
 * Per scope, in this order:
 *   1. Freshness (KTD12): the input hashes of the checkout, the Stryker and Vitest versions, the
 *      Node major version and the runner run's Stryker `mutator` option must equal the manifest's.
 *      Any mismatch is "re-freeze required" (exit 3); nothing else is compared. The runner run must
 *      also have run the manifest's scope, on the manifest's Vitest version, from a prepared copy
 *      whose input files hash like the manifest's; otherwise the runner run is stale (exit 2).
 *   2. Runner run: its flags and span-map failures are differences.
 *   3. Inventory (KTD18): the oracle's test inventory (the manifest's tests) must equal the runner's
 *      run manifest, and the global mutant ids of both runs must be identical sets. Any difference
 *      blocks the scope before outcomes are compared.
 *   4. Classes: every mutant's runner class must equal its oracle class.
 *   5. Per-test outcomes: for every sampled mutant and every oracle-validated test, the runner's
 *      per-test class (from the mutant's latest sidecar record) must equal the frozen one.
 * Then every stratum is counted across the compared manifests (freeze.ts `combineStrata`); an
 * unmet stratum is a difference.
 *
 * Normalisations (KTD13), exactly four; everything else must agree, whatever its known cause:
 *   timeout     every timeout row of KTD17 (Vitest's test or hook timeout, the hit limit, Stryker's
 *               timer, the oracle's wall clock) is the one class `timeout`
 *   no-coverage NoCoverage and survived are one class; the raw Stryker status stays in the report,
 *               and a test the runner did not run because it does not cover the mutant is a
 *               survived observation of that test
 *   titles      title escaping in test ids (freeze.ts `normaliseTestId`)
 *   paths       path separators in test ids
 *
 * The runner's per-test class of a test: its row in the sidecar record when it ran; else the class
 * of an outside-test row that attributes to it (a failed `beforeAll`); else collection when its
 * file failed to collect; else survived (not run). A mutant the runner timed out with Stryker's
 * timer has no record: its per-test observations are listed as unsupported (the runner claims no
 * per-test outcome; step 4 compares its class). Any other mutant without a record is a difference.
 *
 * Report (`--out`, {@link Gate3Report}, schemaVersion 1):
 *   result                 pass | differences | refreeze-required | stale-runner-run
 *   exitCode, normalisations[]
 *   scopes[]               {@link ScopeReport}: name, manifest, results, result, freshness
 *                          {fresh, mismatches[], refreeze}, staleness[], runnerRun {flags[],
 *                          spanMapFailures}, inventory {blocked, tests, mutants} (counts and the ids
 *                          only one side has), classes {compared, agree, normalised[],
 *                          differences[]}, perTest {sampledMutants, compared, agree, notRunAsSurvived,
 *                          notOracleValidated, unsupported[], differences[]}; classes and perTest
 *                          are null when an earlier step blocked
 *   strata[]               freeze.ts `CombinedStratum` per stratum
 *   summary[]              the printed lines
 * Class rows keep the runner's raw Stryker status and outcome source.
 *
 * Usage (from gitnexus/):
 *   npm run test:mutation:oracle -- --scope <manifest.json>,<results.json> [--scope ...]
 *     [--out <report.json>]
 * Exit codes: 0 pass; 1 differences; 2 usage or setup error, a manifest with problems, or a stale
 * runner run; 3 re-freeze required (the manifest's `refreeze` command says how).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PACKAGE_DIR } from '../prepare/path-map.js';
import {
  FreezeUsageError,
  combineStrata,
  currentVersions,
  diffInputs,
  diffInventory,
  hashInputs,
  inputFiles,
  inventoryDiffers,
  normaliseTestId,
  preparedInputs,
  readManifest,
  readRunManifest,
  readRunnerResults,
  readStrykerMutator,
  toOracleClass,
  type CombinedStratum,
  type InputHashes,
  type InventoryDiff,
  type JsonValue,
  type OracleManifest,
  type RunnerMutantView,
  type RunnerRunView,
  type ToolVersions,
} from './freeze.js';
import type { OracleClass } from './oracle-classify.js';
import { isObject } from './util.js';

export const REPORT_SCHEMA_VERSION = 1;
export const EXIT_PASS = 0;
export const EXIT_DIFFERENCES = 1;
export const EXIT_USAGE = 2;
export const EXIT_REFREEZE = 3;

export const NORMALISATIONS = [
  'timeout: every KTD17 timeout row is the one class timeout',
  'no-coverage: NoCoverage and survived are one class (raw status kept); a test the runner did ' +
    'not run is a survived observation',
  'titles: title escaping in test ids',
  'paths: path separators in test ids',
] as const;

// ── freshness (KTD12) ──────────────────────────────────────────────────────

export interface FreshnessMismatch {
  kind: 'input' | 'version' | 'operators';
  subject: string;
  frozen: string;
  current: string;
}

export interface Freshness {
  fresh: boolean;
  mismatches: FreshnessMismatch[];
  refreeze: string;
}

export interface CurrentState {
  inputs: InputHashes;
  versions: ToolVersions;
  /** The runner run's Stryker `mutator` option. */
  mutator: JsonValue;
}

/** Whether a manifest still describes the checkout and toolchain; pure. */
export function checkFreshness(manifest: OracleManifest, current: CurrentState): Freshness {
  const mismatches: FreshnessMismatch[] = diffInputs(manifest.inputs, current.inputs).map(
    (entry) => ({
      kind: 'input',
      subject: `${entry.group}: ${entry.path}`,
      frozen: entry.expected,
      current: entry.actual,
    }),
  );
  const versions: [string, string, string][] = [
    ['stryker', manifest.versions.stryker, current.versions.stryker],
    ['vitest', manifest.versions.vitest, current.versions.vitest],
    ['node major', String(manifest.versions.nodeMajor), String(current.versions.nodeMajor)],
  ];
  for (const [subject, frozen, now] of versions) {
    if (frozen !== now) mismatches.push({ kind: 'version', subject, frozen, current: now });
  }
  const frozenMutator = JSON.stringify(manifest.operators.mutator);
  const currentMutator = JSON.stringify(current.mutator);
  if (frozenMutator !== currentMutator) {
    mismatches.push({
      kind: 'operators',
      subject: 'Stryker mutator option',
      frozen: frozenMutator,
      current: currentMutator,
    });
  }
  return { fresh: mismatches.length === 0, mismatches, refreeze: manifest.refreeze };
}

// ── runner evidence ────────────────────────────────────────────────────────

export interface SidecarView {
  tests: { id: string; outcome: OracleClass }[];
  outsideTest: {
    file: string;
    suiteTaskId: string | null;
    outcome: OracleClass;
    attributedTo: string[];
  }[];
}

/** Reads the parts of a runner sidecar record (KTD6) gate 3 needs; own parser, no runner code. */
export function readSidecarView(file: string): SidecarView {
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const result = isObject(data) ? data.result : undefined;
  if (!isObject(result) || !Array.isArray(result.tests) || !Array.isArray(result.outsideTest)) {
    throw new FreezeUsageError(`${file} is not a sidecar record`);
  }
  const text = (value: unknown, at: string): string => {
    if (typeof value !== 'string') throw new FreezeUsageError(`${file}: ${at} must be a string`);
    return value;
  };
  return {
    tests: result.tests.map((row: unknown, index) => {
      const at = `result.tests[${index}]`;
      if (!isObject(row)) throw new FreezeUsageError(`${file}: ${at} must be an object`);
      return { id: text(row.id, `${at}.id`), outcome: toOracleClass(row.outcome, at) };
    }),
    outsideTest: result.outsideTest.map((row: unknown, index) => {
      const at = `result.outsideTest[${index}]`;
      if (!isObject(row) || !Array.isArray(row.attributedTo)) {
        throw new FreezeUsageError(`${file}: ${at} must be an outside-test row`);
      }
      return {
        file: text(row.file, `${at}.file`),
        suiteTaskId: typeof row.suiteTaskId === 'string' ? row.suiteTaskId : null,
        outcome: toOracleClass(row.outcome, at),
        attributedTo: row.attributedTo.map((id, i) => text(id, `${at}.attributedTo[${i}]`)),
      };
    }),
  };
}

/** What the runner says about a mutant's tests. */
export type RunnerPerTest =
  | { kind: 'record'; sidecar: SidecarView }
  | { kind: 'no-coverage' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'missing'; reason: string };

/** The runner's per-test evidence for one mutant (see the module comment). */
export function runnerPerTest(
  mutant: RunnerMutantView,
  readSidecar: (file: string) => SidecarView = readSidecarView,
): RunnerPerTest {
  if (mutant.sidecarFile !== null)
    return { kind: 'record', sidecar: readSidecar(mutant.sidecarFile) };
  if (mutant.status === 'NoCoverage') return { kind: 'no-coverage' };
  if (mutant.outcomeSource === 'stryker-timeout') {
    return { kind: 'unsupported', reason: "Stryker's timer killed the run; no record" };
  }
  return { kind: 'missing', reason: `the runner left no record (status ${mutant.status})` };
}

export interface RunnerTestClass {
  outcome: OracleClass;
  /** How the class was found: row, attributed, collection, not-run. */
  source: 'row' | 'attributed' | 'collection' | 'not-run';
}

/**
 * Indexes a sidecar record once and returns the runner's class of one test (normalised id) in it:
 * its row, else the first outside-test row attributed to it, else the first collection failure
 * of its file, else survived (not run); each lookup takes the first match in record order. Pure.
 */
function sidecarTestClasses(sidecar: SidecarView): (testId: string) => RunnerTestClass {
  const rows = new Map<string, OracleClass>();
  const attributed = new Map<string, OracleClass>();
  const collections = new Map<string, OracleClass>();
  const first = (index: Map<string, OracleClass>, key: string, outcome: OracleClass): void => {
    if (!index.has(key)) index.set(key, outcome);
  };
  for (const entry of sidecar.tests) first(rows, normaliseTestId(entry.id), entry.outcome);
  for (const entry of sidecar.outsideTest) {
    for (const id of entry.attributedTo) first(attributed, normaliseTestId(id), entry.outcome);
    if (entry.outcome === 'killed-outside-test:collection') {
      first(collections, entry.file.replaceAll('\\', '/'), entry.outcome);
    }
  }
  return (testId) => {
    const key = normaliseTestId(testId);
    const row = rows.get(key);
    if (row !== undefined) return { outcome: row, source: 'row' };
    const outside = attributed.get(key);
    if (outside !== undefined) return { outcome: outside, source: 'attributed' };
    const collection = collections.get(key.slice(0, key.indexOf('#')));
    if (collection !== undefined) return { outcome: collection, source: 'collection' };
    return { outcome: 'survived', source: 'not-run' };
  };
}

/** The runner's class of one test (normalised id) in a sidecar record; pure. */
export function runnerTestClass(sidecar: SidecarView, testId: string): RunnerTestClass {
  return sidecarTestClasses(sidecar)(testId);
}

// ── comparison ─────────────────────────────────────────────────────────────

export interface ClassRow {
  globalId: string;
  oracle: OracleClass;
  runner: OracleClass | null;
  /** The runner's raw Stryker status. */
  runnerStatus: string;
  runnerSource: string;
  /** The KTD13 rule that made the row agree; null for an identical or differing row. */
  rule: 'no-coverage' | 'timeout' | null;
}

export interface PerTestRow {
  globalId: string;
  testId: string;
  oracle: OracleClass;
  runner: OracleClass;
  runnerSource: RunnerTestClass['source'] | 'missing';
}

export interface InventoryReport extends InventoryDiff {
  oracle: number;
  runner: number;
}

export interface ScopeReport {
  name: string;
  manifest: string;
  results: string;
  result: 'pass' | 'differences' | 'refreeze-required' | 'stale-runner-run';
  freshness: Freshness;
  staleness: string[];
  runnerRun: { flags: string[]; spanMapFailures: number };
  inventory: { blocked: boolean; tests: InventoryReport; mutants: InventoryReport } | null;
  classes: {
    compared: number;
    agree: number;
    normalised: ClassRow[];
    differences: ClassRow[];
  } | null;
  perTest: {
    sampledMutants: number;
    compared: number;
    agree: number;
    notRunAsSurvived: number;
    notOracleValidated: number;
    unsupported: { globalId: string; reason: string; observations: number }[];
    differences: PerTestRow[];
  } | null;
}

export interface ScopeInput {
  manifest: OracleManifest;
  manifestFile: string;
  freshness: Freshness;
  /** Why the runner run does not belong to this manifest; empty when it does. */
  staleness: string[];
  runner: RunnerRunView;
  /** Test ids of the runner's run manifest. */
  runnerTests: readonly string[];
  /** The runner's per-test evidence of a mutant, by global id. */
  perTest: (mutant: RunnerMutantView) => RunnerPerTest;
}

const inventoryReport = (
  oracle: readonly string[],
  runner: readonly string[],
  normalise?: (id: string) => string,
): InventoryReport => ({
  oracle: oracle.length,
  runner: runner.length,
  ...diffInventory(oracle, runner, normalise),
});

/** Compares one runner run with one manifest (steps 1-5 of the module comment); pure. */
export function compareScope(input: ScopeInput): ScopeReport {
  const { manifest, runner } = input;
  const base = {
    name: manifest.name,
    manifest: input.manifestFile,
    results: runner.file,
    freshness: input.freshness,
    staleness: input.staleness,
    runnerRun: { flags: runner.flags, spanMapFailures: runner.spanMapFailures },
  };
  if (!input.freshness.fresh) {
    return { ...base, result: 'refreeze-required', inventory: null, classes: null, perTest: null };
  }
  if (input.staleness.length > 0) {
    return { ...base, result: 'stale-runner-run', inventory: null, classes: null, perTest: null };
  }
  const runnerRunDiffers = runner.flags.length > 0 || runner.spanMapFailures > 0;
  const oracleMutants = manifest.mutants.map(([globalId]) => globalId);
  const inventory = {
    tests: inventoryReport(manifest.tests, input.runnerTests, normaliseTestId),
    mutants: inventoryReport(
      oracleMutants,
      runner.mutants.map((mutant) => mutant.globalId),
    ),
    blocked: false,
  };
  inventory.blocked = inventoryDiffers(inventory.tests) || inventoryDiffers(inventory.mutants);
  if (inventory.blocked) {
    return { ...base, result: 'differences', inventory, classes: null, perTest: null };
  }

  const runnerById = new Map(runner.mutants.map((mutant) => [mutant.globalId, mutant]));
  const normalised: ClassRow[] = [];
  const classDifferences: ClassRow[] = [];
  for (const [globalId, oracle] of manifest.mutants) {
    const mutant = runnerById.get(globalId);
    if (mutant === undefined) continue;
    const row: ClassRow = {
      globalId,
      oracle,
      runner: mutant.outcome,
      runnerStatus: mutant.status,
      runnerSource: mutant.outcomeSource,
      rule: null,
    };
    if (mutant.outcome !== oracle) classDifferences.push(row);
    else if (mutant.status === 'NoCoverage') normalised.push({ ...row, rule: 'no-coverage' });
    else if (oracle === 'timeout') normalised.push({ ...row, rule: 'timeout' });
  }

  const notOracleValidated = new Set(manifest.notOracleValidated);
  const perTest: NonNullable<ScopeReport['perTest']> = {
    sampledMutants: manifest.sampled.length,
    compared: 0,
    agree: 0,
    notRunAsSurvived: 0,
    notOracleValidated: 0,
    unsupported: [],
    differences: [],
  };
  for (const sampled of manifest.sampled) {
    const mutant = runnerById.get(sampled.id);
    if (mutant === undefined) continue;
    const frozen = new Map(sampled.outcomes);
    const invalid = new Set(sampled.invalid.map(([position]) => position));
    const evidence = input.perTest(mutant);
    const validated = manifest.tests.flatMap((testId, position) =>
      notOracleValidated.has(testId) || invalid.has(position) ? [] : [{ testId, position }],
    );
    perTest.notOracleValidated += manifest.tests.filter((id) => notOracleValidated.has(id)).length;
    if (evidence.kind === 'unsupported') {
      perTest.unsupported.push({
        globalId: sampled.id,
        reason: evidence.reason,
        observations: validated.length,
      });
      continue;
    }
    const recordClass = evidence.kind === 'record' ? sidecarTestClasses(evidence.sidecar) : null;
    for (const { testId, position } of validated) {
      const oracle = frozen.get(position) ?? 'survived';
      const found: RunnerTestClass | null =
        recordClass !== null
          ? recordClass(testId)
          : evidence.kind === 'no-coverage'
            ? { outcome: 'survived', source: 'not-run' }
            : null;
      perTest.compared++;
      if (found !== null && found.outcome === oracle) {
        perTest.agree++;
        if (found.source === 'not-run') perTest.notRunAsSurvived++;
        continue;
      }
      perTest.differences.push({
        globalId: sampled.id,
        testId,
        oracle,
        runner: found?.outcome ?? 'invalid',
        runnerSource: found?.source ?? 'missing',
      });
    }
  }

  const differs = runnerRunDiffers || classDifferences.length > 0 || perTest.differences.length > 0;
  return {
    ...base,
    result: differs ? 'differences' : 'pass',
    inventory,
    classes: {
      compared: manifest.mutants.length,
      agree: manifest.mutants.length - classDifferences.length,
      normalised,
      differences: classDifferences,
    },
    perTest,
  };
}

export interface Gate3Report {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  kind: 'gitnexus-mutation-gate3-report';
  result: 'pass' | 'differences' | 'refreeze-required' | 'stale-runner-run';
  exitCode: number;
  normalisations: readonly string[];
  scopes: ScopeReport[];
  strata: CombinedStratum[];
  summary: string[];
}

/** The gate's exit code: re-freeze first, then a stale runner run, then differences; pure. */
export function gateExitCode(
  scopes: readonly ScopeReport[],
  strata: readonly CombinedStratum[],
): number {
  if (scopes.some((scope) => scope.result === 'refreeze-required')) return EXIT_REFREEZE;
  if (scopes.some((scope) => scope.result === 'stale-runner-run')) return EXIT_USAGE;
  const differs =
    scopes.some((scope) => scope.result === 'differences') ||
    strata.some((stratum) => stratum.status === 'unmet');
  return differs ? EXIT_DIFFERENCES : EXIT_PASS;
}

const RESULT_BY_EXIT: Record<number, Gate3Report['result']> = {
  [EXIT_PASS]: 'pass',
  [EXIT_DIFFERENCES]: 'differences',
  [EXIT_USAGE]: 'stale-runner-run',
  [EXIT_REFREEZE]: 'refreeze-required',
};

export function summarise(
  scopes: readonly ScopeReport[],
  strata: readonly CombinedStratum[],
): string[] {
  const lines: string[] = [];
  for (const scope of scopes) {
    lines.push(`gate 3 ${scope.name}: ${scope.result}`);
    if (!scope.freshness.fresh) {
      lines.push(`  re-freeze required: ${scope.freshness.mismatches.length} mismatches`);
      for (const mismatch of scope.freshness.mismatches.slice(0, 10)) {
        lines.push(
          `    ${mismatch.kind} ${mismatch.subject}: ${mismatch.frozen} -> ${mismatch.current}`,
        );
      }
      lines.push(`  ${scope.freshness.refreeze}`);
      continue;
    }
    for (const reason of scope.staleness.slice(0, 10)) lines.push(`  stale runner run: ${reason}`);
    if (scope.runnerRun.flags.length > 0 || scope.runnerRun.spanMapFailures > 0) {
      lines.push(
        `  runner run: ${scope.runnerRun.flags.length} flags, ` +
          `${scope.runnerRun.spanMapFailures} span-map failures`,
      );
    }
    const { inventory } = scope;
    if (inventory !== null) {
      const describe = (label: string, entry: InventoryReport): string =>
        `  ${label}: oracle ${entry.oracle}, runner ${entry.runner}; only oracle ` +
        `${entry.onlyA.length}, only runner ${entry.onlyB.length}, ambiguous ` +
        `${entry.ambiguousA.length + entry.ambiguousB.length}`;
      lines.push(describe('tests', inventory.tests), describe('mutants', inventory.mutants));
      for (const id of [...inventory.tests.onlyA, ...inventory.mutants.onlyA].slice(0, 5)) {
        lines.push(`    only oracle: ${id}`);
      }
      for (const id of [...inventory.tests.onlyB, ...inventory.mutants.onlyB].slice(0, 5)) {
        lines.push(`    only runner: ${id}`);
      }
      if (inventory.blocked) lines.push('  inventory differs: outcomes not compared');
    }
    if (scope.classes !== null) {
      const rules = (rule: ClassRow['rule']): number =>
        scope.classes?.normalised.filter((row) => row.rule === rule).length ?? 0;
      lines.push(
        `  classes: ${scope.classes.agree}/${scope.classes.compared} agree (NoCoverage as survived ` +
          `${rules('no-coverage')}, timeout ${rules('timeout')}); ` +
          `${scope.classes.differences.length} differences`,
      );
      for (const row of scope.classes.differences.slice(0, 10)) {
        lines.push(
          `    ${row.globalId}: oracle ${row.oracle}, runner ${row.runner ?? 'none'} (${row.runnerStatus})`,
        );
      }
    }
    if (scope.perTest !== null) {
      lines.push(
        `  per-test: ${scope.perTest.agree}/${scope.perTest.compared} agree over ` +
          `${scope.perTest.sampledMutants} sampled mutants (not run as survived ` +
          `${scope.perTest.notRunAsSurvived}); not oracle-validated ${scope.perTest.notOracleValidated}; ` +
          `unsupported ${scope.perTest.unsupported.length} mutants; ` +
          `${scope.perTest.differences.length} differences`,
      );
      for (const row of scope.perTest.differences.slice(0, 10)) {
        lines.push(
          `    ${row.globalId} / ${row.testId}: oracle ${row.oracle}, runner ${row.runner} (${row.runnerSource})`,
        );
      }
    }
  }
  lines.push(
    `strata across ${scopes.length} scopes: ${strata
      .map(
        (stratum) => `${stratum.name} ${stratum.sampled}/${stratum.population} ${stratum.status}`,
      )
      .join(', ')}`,
  );
  return lines;
}

// ── I/O ────────────────────────────────────────────────────────────────────

export interface ComparePair {
  manifest: string;
  results: string;
}

/** The runner run's inputs and versions that must match the manifest; empty when they do. */
function runnerStaleness(
  manifest: OracleManifest,
  runner: RunnerRunView,
  runnerVitest: string,
): string[] {
  const reasons: string[] = [];
  const sorted = (values: readonly string[]): string => JSON.stringify([...values].sort());
  if (
    sorted(runner.scope.testFiles) !== sorted(manifest.scope.testFiles) ||
    sorted(runner.scope.mutate) !== sorted(manifest.scope.mutate)
  ) {
    reasons.push('the runner run ran another scope than the manifest');
  }
  if (runnerVitest !== manifest.versions.vitest) {
    reasons.push(
      `the runner run used Vitest ${runnerVitest}, the manifest ${manifest.versions.vitest}`,
    );
  }
  const mutated = new Set(manifest.scope.mutate.map((entry) => entry.split(':')[0]));
  const prepared = preparedInputs(runner.preparedRoot, manifest.inputs);
  for (const mismatch of diffInputs(manifest.inputs, prepared, mutated)) {
    reasons.push(`the runner run was prepared from another ${mismatch.path} (${mismatch.group})`);
  }
  return reasons;
}

/** Runs gate 3 over manifest and results pairs (see the module comment). */
export function runGate3(repoRoot: string, pairs: readonly ComparePair[]): Gate3Report {
  const packageDir = path.join(repoRoot, PACKAGE_DIR);
  const versions = currentVersions(packageDir);
  const scopes: ScopeReport[] = [];
  const manifests: OracleManifest[] = [];
  for (const pair of pairs) {
    const manifest = readManifest(pair.manifest);
    if (manifest.problems.length > 0) {
      throw new FreezeUsageError(
        `${pair.manifest} records ${manifest.problems.length} freeze problems; re-freeze it`,
      );
    }
    manifests.push(manifest);
    const runner = readRunnerResults(pair.results);
    const runManifest = readRunManifest(runner.runDir);
    const freshness = checkFreshness(manifest, {
      inputs: hashInputs(inputFiles(repoRoot, manifest.scope.testFiles), (repoPath) =>
        path.join(repoRoot, repoPath),
      ),
      versions,
      mutator: existsSync(runner.configFile) ? readStrykerMutator(runner.configFile) : null,
    });
    scopes.push(
      compareScope({
        manifest,
        manifestFile: pair.manifest,
        freshness,
        staleness: freshness.fresh
          ? runnerStaleness(manifest, runner, runManifest.vitestVersion)
          : [],
        runner,
        runnerTests: runManifest.tests.map((test) => test.id),
        perTest: (mutant) => runnerPerTest(mutant),
      }),
    );
  }
  const strata = combineStrata(
    manifests.map((manifest) => ({ name: manifest.name, strata: manifest.strata })),
  );
  const exitCode = gateExitCode(scopes, strata);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: 'gitnexus-mutation-gate3-report',
    result: RESULT_BY_EXIT[exitCode] ?? 'differences',
    exitCode,
    normalisations: NORMALISATIONS,
    scopes,
    strata,
    summary: summarise(scopes, strata),
  };
}

export function parseCompareArgs(
  argv: readonly string[],
  cwd: string,
): { pairs: ComparePair[]; out: string | null } {
  const { values } = parseArgs({
    args: [...argv],
    options: { scope: { type: 'string', multiple: true }, out: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  if (values.scope === undefined || values.scope.length === 0) {
    throw new FreezeUsageError('--scope <manifest.json>,<results.json> is required');
  }
  return {
    pairs: values.scope.map((entry) => {
      const [manifest, results, ...rest] = entry.split(',');
      if (!manifest || !results || rest.length > 0) {
        throw new FreezeUsageError(`--scope ${entry}: expected <manifest.json>,<results.json>`);
      }
      return { manifest: path.resolve(cwd, manifest), results: path.resolve(cwd, results) };
    }),
    out: values.out === undefined ? null : path.resolve(cwd, values.out),
  };
}

function main(): void {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  try {
    const { pairs, out } = parseCompareArgs(process.argv.slice(2), process.cwd());
    const report = runGate3(repoRoot, pairs);
    if (out !== null) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(report.summary.join('\n'));
    console.log(
      `gate 3: ${report.result} (exit ${report.exitCode})${out === null ? '' : `; report ${out}`}`,
    );
    process.exitCode = report.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof FreezeUsageError || error instanceof TypeError) {
      console.error(
        'usage: npm run test:mutation:oracle -- --scope <manifest.json>,<results.json> ' +
          '[--scope ...] [--out <report.json>]',
      );
    } else {
      console.error(error instanceof Error ? error.stack : '');
    }
    process.exitCode = EXIT_USAGE;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
