/**
 * Oracle cost benchmark (U12): what gate 3's oracle (U7) costs, measured on a small sample and
 * projected to the full KTD11 sample on a 4 vCPU runner against the 6-hour job limit.
 *
 * Inputs, per scope: an oracle command run (U13, `oracle-command-run.json`, with its kept
 * sandbox) and optionally a vitest5 run of the same scope (U10, `results.json`), which knows which
 * mutants are static and which tests cover each timed-out mutant.
 *
 * Measured per scope:
 *   - single-test launch cost (launch-single.ts) on a deterministic sample: evenly spaced
 *     assertion-killed mutants launched with one killer and non-killers, evenly spaced survivors,
 *     and unmutated baseline launches; wall clock (spawn to exit), CPU (the child and its Vitest
 *     worker) and Vitest's own run time, as mean, median and p90 (nearest rank);
 *   - each launch's class against the command run's (a small preview of gate 3);
 *   - the static mutants after blanking (vitest5 run), the population, the tests, the timed-out
 *     mutants and the command-runner pass (the command run's Stryker wall clock).
 *
 * Projection ({@link projectOracleCost}, pure): per scope the sample is `min(sampleSize + topUps,
 * population)` mutants and every sampled mutant is launched with every test of the scope.
 * Launches of timed-out mutants with a covering test are assumed to run into the wall-clock limit
 * (`ceil(sampled * timeoutMutants * hangingTestsPerTimeoutMutant / population)` launches, an upper
 * bound). With one launch per vCPU, a launch occupies its slot for `max(wall, cpu)`; a hanging
 * launch for the whole limit. The command-runner pass is scaled from its measured concurrency to
 * at most `vcpus` workers. A fixed overhead covers checkout, install and prepare. The CPU-bound
 * floor is the same sum with launch CPU only (it needs more concurrent launches than vCPUs).
 * The break-even launch time is the largest per-launch slot time that still fits the job limit.
 *
 * Report `<out>/oracle-cost.json` (schemaVersion 1): machine (load average before and after,
 * cpus, node), options, scopes[] (inputs, strata observations, launch timings, agreement),
 * launches[], timings (all launches), projectionInput, projection. `<out>/oracle-cost.txt` is
 * the short text summary, also printed.
 *
 * Usage (from gitnexus/):
 *   npm run test:mutation:bench -- --scope <oracle-command-run.json>[,<vitest5 results.json>]...
 *     --out <dir> [--mutants <n> (3)] [--tests-per-mutant <n> (2)] [--baselines <n> (2)]
 *     [--concurrency <n> (1)] [--wall-clock-ms <n> (180000)] [--sample-size <n> (100)]
 *     [--top-ups <n> (20)] [--vcpus <n> (4)] [--fixed-overhead-ms <n> (900000)]
 *     [--job-limit-ms <n> (21600000)]
 * Exit codes: 0 report written and every launch valid and in agreement; 1 report written with
 * invalid or disagreeing launches; 2 usage or setup error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEFAULT_WALL_CLOCK_MS,
  LaunchUsageError,
  launchSingle,
  readCommandRun,
  readTestInventory,
  type CommandRunMutant,
  type CommandRunView,
  type LaunchResult,
  type LaunchTarget,
} from '../oracle/launch-single.js';
import type { OracleClass } from '../oracle/oracle-classify.js';

export const BENCH_SCHEMA_VERSION = 1;
export const REPORT_FILE = 'oracle-cost.json';
export const SUMMARY_FILE = 'oracle-cost.txt';
const HOUR_MS = 3_600_000;

// ── projection ─────────────────────────────────────────────────────────────

export interface CostModel {
  vcpus: number;
  /** Mean wall clock of one launch. */
  launchWallMs: number;
  /** Mean CPU time of one launch (the child and its Vitest worker). */
  launchCpuMs: number;
  wallClockLimitMs: number;
  jobLimitMs: number;
  /** Checkout, install, prepare and reporting. */
  fixedOverheadMs: number;
}

export interface ScopeCostInput {
  name: string;
  /** Mutants of the scope. */
  population: number;
  /** Tests of the scope (the baseline's executed tests). */
  tests: number;
  sampleSize: number;
  /** Strata top-up mutants on top of the sample. */
  topUps: number;
  /** Mutants of the population the command run classified as timeout. */
  timeoutMutants: number;
  /** Tests that may hang per timed-out mutant (its covering tests; an upper bound). */
  hangingTestsPerTimeoutMutant: number;
  commandRunnerMs: number;
  commandRunnerConcurrency: number;
  /** Per-scope launch costs; the model's apply when absent. */
  launchWallMs?: number;
  launchCpuMs?: number;
}

export interface CostProjectionInput {
  model: CostModel;
  scopes: ScopeCostInput[];
}

export interface ScopeProjection {
  name: string;
  sampledMutants: number;
  launches: number;
  hangingLaunches: number;
  /** All launches one after another. */
  launchSerialMs: number;
  /** Launches on `vcpus` concurrent slots. */
  launchMs: number;
  commandMs: number;
  totalMs: number;
}

export interface CostProjection {
  scopes: ScopeProjection[];
  launches: number;
  launchMs: number;
  commandMs: number;
  fixedOverheadMs: number;
  totalMs: number;
  /** The same sum with launch CPU only; reachable only with more launches than vCPUs. */
  cpuBoundFloorMs: number;
  jobLimitMs: number;
  headroomMs: number;
  fits: boolean;
  /** The largest per-launch slot time (`max(wall, cpu)`) that still fits the job limit. */
  breakEvenLaunchMs: number;
}

/** Projects the full oracle sample's wall clock; pure and deterministic. */
export function projectOracleCost(input: CostProjectionInput): CostProjection {
  const { model } = input;
  let floorMs = model.fixedOverheadMs;
  let fixedMs = model.fixedOverheadMs;
  let normalLaunches = 0;
  const scopes = input.scopes.map((scope): ScopeProjection => {
    const wall = scope.launchWallMs ?? model.launchWallMs;
    const cpu = scope.launchCpuMs ?? model.launchCpuMs;
    const sampledMutants = Math.min(scope.sampleSize + scope.topUps, scope.population);
    const launches = sampledMutants * scope.tests;
    const hangingLaunches =
      scope.population === 0
        ? 0
        : Math.min(
            launches,
            Math.ceil(
              (sampledMutants * scope.timeoutMutants * scope.hangingTestsPerTimeoutMutant) /
                scope.population,
            ),
          );
    const normal = launches - hangingLaunches;
    const hangMs = (hangingLaunches * model.wallClockLimitMs) / model.vcpus;
    const launchMs = (normal * Math.max(wall, cpu)) / model.vcpus + hangMs;
    const commandMs =
      (scope.commandRunnerMs * scope.commandRunnerConcurrency) /
      Math.min(scope.commandRunnerConcurrency, model.vcpus);
    floorMs += (normal * cpu) / model.vcpus + hangMs + commandMs;
    fixedMs += hangMs + commandMs;
    normalLaunches += normal;
    return {
      name: scope.name,
      sampledMutants,
      launches,
      hangingLaunches,
      launchSerialMs: Math.round(normal * wall + hangingLaunches * model.wallClockLimitMs),
      launchMs: Math.round(launchMs),
      commandMs: Math.round(commandMs),
      totalMs: Math.round(launchMs + commandMs),
    };
  });
  const sum = (pick: (scope: ScopeProjection) => number): number =>
    scopes.reduce((total, scope) => total + pick(scope), 0);
  const totalMs = sum((scope) => scope.totalMs) + model.fixedOverheadMs;
  return {
    scopes,
    launches: sum((scope) => scope.launches),
    launchMs: sum((scope) => scope.launchMs),
    commandMs: sum((scope) => scope.commandMs),
    fixedOverheadMs: model.fixedOverheadMs,
    totalMs,
    cpuBoundFloorMs: Math.round(floorMs),
    jobLimitMs: model.jobLimitMs,
    headroomMs: model.jobLimitMs - totalMs,
    fits: totalMs <= model.jobLimitMs,
    breakEvenLaunchMs:
      normalLaunches === 0
        ? 0
        : Math.round(((model.jobLimitMs - fixedMs) * model.vcpus) / normalLaunches),
  };
}

export interface TimingSummary {
  count: number;
  meanMs: number;
  /** Nearest-rank percentiles: the value at rank `ceil(p * count)` of the sorted list. */
  medianMs: number;
  p90Ms: number;
  minMs: number;
  maxMs: number;
}

/** Mean, nearest-rank median and p90, min and max; pure. */
export function summarizeTimings(values: readonly number[]): TimingSummary {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
  return {
    count: sorted.length,
    meanMs:
      sorted.length === 0 ? 0 : sorted.reduce((total, value) => total + value, 0) / sorted.length,
    medianMs: rank(0.5),
    p90Ms: rank(0.9),
    minMs: sorted[0] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
  };
}

// ── sample selection ───────────────────────────────────────────────────────

/** `count` entries of `items`, evenly spaced, in order; pure. */
export function evenlySpaced<T>(items: readonly T[], count: number): T[] {
  const n = Math.min(count, items.length);
  return Array.from({ length: n }, (_, i) => items[Math.floor(((i + 0.5) * items.length) / n)]);
}

export interface PlannedLaunch {
  target: LaunchTarget;
  mutantId: string | null;
  /** The class the command run implies for this test: a killer's assertion kill, else survived. */
  expected: OracleClass;
  role: 'killer' | 'non-killer' | 'survivor' | 'baseline';
}

export interface SampleOptions {
  mutants: number;
  testsPerMutant: number;
  baselines: number;
}

const byLocalId = (a: CommandRunMutant, b: CommandRunMutant): number =>
  Number(a.localId) - Number(b.localId);

/** The deterministic launch sample of one scope (see the module comment). */
export function planLaunches(
  mutants: readonly CommandRunMutant[],
  inventory: readonly LaunchTarget[],
  options: SampleOptions,
): PlannedLaunch[] {
  const byId = new Map(inventory.map((target) => [target.id, target]));
  const killed = evenlySpaced(
    mutants
      .filter(
        (mutant) =>
          mutant.oracleClass === 'killed-by-test:assertion' &&
          mutant.assertionKilledBy.some((id) => byId.has(id)),
      )
      .sort(byLocalId),
    options.mutants,
  );
  const survived = evenlySpaced(
    mutants.filter((mutant) => mutant.oracleClass === 'survived').sort(byLocalId),
    options.mutants,
  );
  const planned: PlannedLaunch[] = [];
  killed.forEach((mutant) => {
    const killer = byId.get(mutant.assertionKilledBy.find((id) => byId.has(id)) ?? '');
    if (killer !== undefined) {
      planned.push({
        target: killer,
        mutantId: mutant.localId,
        expected: 'killed-by-test:assertion',
        role: 'killer',
      });
    }
    const others = inventory.filter((target) => !mutant.killedBy.includes(target.id));
    for (const target of evenlySpaced(others, options.testsPerMutant - 1)) {
      planned.push({ target, mutantId: mutant.localId, expected: 'survived', role: 'non-killer' });
    }
  });
  survived.forEach((mutant, index) => {
    const rotated = [...inventory.slice(index), ...inventory.slice(0, index)];
    for (const target of evenlySpaced(rotated, options.testsPerMutant)) {
      planned.push({ target, mutantId: mutant.localId, expected: 'survived', role: 'survivor' });
    }
  });
  for (const target of evenlySpaced(inventory, options.baselines)) {
    planned.push({ target, mutantId: null, expected: 'survived', role: 'baseline' });
  }
  return planned;
}

// ── inputs ─────────────────────────────────────────────────────────────────

interface Vitest5View {
  staticMutants: number;
  /** Covering-test counts of the mutants the vitest5 run timed out, by global id. */
  timeoutCoverage: Map<string, number>;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readVitest5Results(file: string): Vitest5View {
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isObject(data) || data.variant !== 'vitest5' || !Array.isArray(data.mutants)) {
    throw new LaunchUsageError(`${file} is not the results.json of a vitest5 run`);
  }
  let staticMutants = 0;
  const timeoutCoverage = new Map<string, number>();
  for (const mutant of data.mutants) {
    if (!isObject(mutant)) continue;
    if (mutant.static === true) staticMutants++;
    if (mutant.outcome === 'timeout' && typeof mutant.globalId === 'string') {
      timeoutCoverage.set(
        mutant.globalId,
        Array.isArray(mutant.coveredBy) ? mutant.coveredBy.length : 0,
      );
    }
  }
  return { staticMutants, timeoutCoverage };
}

interface CommandRunExtras {
  name: string;
  mutate: string[];
  testFiles: string[];
  strykerWallClockMs: number;
  concurrency: number;
  meanWrapperWallClockMs: number | null;
}

function readCommandRunExtras(run: CommandRunView): CommandRunExtras {
  const data: unknown = JSON.parse(readFileSync(run.file, 'utf8'));
  const scope = isObject(data) && isObject(data.scope) ? data.scope : {};
  const stryker = isObject(data) && isObject(data.stryker) ? data.stryker : {};
  const summary = isObject(data) && isObject(data.summary) ? data.summary : {};
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
  const configFile = path.join(run.outDir, 'stryker.config.json');
  const config: unknown = existsSync(configFile)
    ? JSON.parse(readFileSync(configFile, 'utf8'))
    : null;
  const concurrency = isObject(config) ? config.concurrency : undefined;
  const mutate = strings(scope.mutate);
  return {
    name: mutate[0] ?? path.basename(run.outDir),
    mutate,
    testFiles: strings(scope.testFiles),
    strykerWallClockMs: typeof stryker.wallClockMs === 'number' ? stryker.wallClockMs : 0,
    concurrency: typeof concurrency === 'number' ? concurrency : 1,
    meanWrapperWallClockMs:
      typeof summary.meanWrapperWallClockMs === 'number' ? summary.meanWrapperWallClockMs : null,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────

export interface BenchOptions {
  scopes: { oracleRun: string; vitest5Results: string | null }[];
  outDir: string;
  sample: SampleOptions;
  concurrency: number;
  wallClockMs: number;
  sampleSize: number;
  topUps: number;
  vcpus: number;
  fixedOverheadMs: number;
  jobLimitMs: number;
}

const positive = (value: string | undefined, name: string, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new LaunchUsageError(`--${name} must be a positive integer, got ${value}`);
  }
  return Number(value);
};

export function parseBenchArgs(argv: readonly string[], cwd: string): BenchOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      scope: { type: 'string', multiple: true },
      out: { type: 'string' },
      mutants: { type: 'string' },
      'tests-per-mutant': { type: 'string' },
      baselines: { type: 'string' },
      concurrency: { type: 'string' },
      'wall-clock-ms': { type: 'string' },
      'sample-size': { type: 'string' },
      'top-ups': { type: 'string' },
      vcpus: { type: 'string' },
      'fixed-overhead-ms': { type: 'string' },
      'job-limit-ms': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.scope === undefined || values.scope.length === 0) {
    throw new LaunchUsageError('--scope <oracle-command-run.json>[,<results.json>] is required');
  }
  if (values.out === undefined) throw new LaunchUsageError('--out is required');
  const topUps = values['top-ups'];
  if (topUps !== undefined && !/^\d+$/.test(topUps)) {
    throw new LaunchUsageError(`--top-ups must be a non-negative integer, got ${topUps}`);
  }
  return {
    scopes: values.scope.map((entry) => {
      const [oracleRun, vitest5Results, ...rest] = entry.split(',');
      if (oracleRun === undefined || oracleRun === '' || rest.length > 0) {
        throw new LaunchUsageError(
          `--scope ${entry}: expected <oracle-command-run.json>[,<results.json>]`,
        );
      }
      return {
        oracleRun: path.resolve(cwd, oracleRun),
        vitest5Results:
          vitest5Results === undefined || vitest5Results === ''
            ? null
            : path.resolve(cwd, vitest5Results),
      };
    }),
    outDir: path.resolve(cwd, values.out),
    sample: {
      mutants: positive(values.mutants, 'mutants', 3),
      testsPerMutant: positive(values['tests-per-mutant'], 'tests-per-mutant', 2),
      baselines: positive(values.baselines, 'baselines', 2),
    },
    concurrency: positive(values.concurrency, 'concurrency', 1),
    wallClockMs: positive(values['wall-clock-ms'], 'wall-clock-ms', DEFAULT_WALL_CLOCK_MS),
    sampleSize: positive(values['sample-size'], 'sample-size', 100),
    topUps: topUps === undefined ? 20 : Number(topUps),
    vcpus: positive(values.vcpus, 'vcpus', 4),
    fixedOverheadMs: positive(values['fixed-overhead-ms'], 'fixed-overhead-ms', 900_000),
    jobLimitMs: positive(values['job-limit-ms'], 'job-limit-ms', 6 * HOUR_MS),
  };
}

async function inPool<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

const formatHours = (ms: number): string => `${(ms / HOUR_MS).toFixed(2)} h`;
const formatSeconds = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;

interface LaunchRow {
  scope: string;
  role: PlannedLaunch['role'];
  testId: string;
  mutantId: string | null;
  expected: OracleClass;
  outcome: OracleClass;
  validity: 'valid' | 'invalid';
  agrees: boolean;
  covering: boolean | null;
  hits: LaunchResult['observation']['hits'];
  executed: number;
  reason: string | null;
  wallClockMs: number;
  cpuMs: number | null;
  vitestWallClockMs: number | null;
  launchDir: string;
}

export async function runBench(options: BenchOptions): Promise<{ text: string; exitCode: number }> {
  mkdirSync(options.outDir, { recursive: true });
  const loadBefore = os.loadavg();
  const started = performance.now();
  const scopeReports = [];
  const rows: LaunchRow[] = [];
  const costInputs: ScopeCostInput[] = [];

  for (const [scopeIndex, scope] of options.scopes.entries()) {
    const run = readCommandRun(scope.oracleRun);
    const extras = readCommandRunExtras(run);
    const vitest5 = scope.vitest5Results === null ? null : readVitest5Results(scope.vitest5Results);
    const inventory = readTestInventory(run);
    const planned = planLaunches(run.mutants, inventory, options.sample);
    const scopeDir = path.join(options.outDir, 'launches', `scope-${scopeIndex + 1}`);
    const results = await inPool(planned, options.concurrency, (launch, index) =>
      launchSingle({
        sandboxDir: run.sandboxDir,
        scopeFile: run.scopeFile,
        target: launch.target,
        mutantId: launch.mutantId,
        wallClockMs: options.wallClockMs,
        launchDir: path.join(scopeDir, `launch-${String(index + 1).padStart(3, '0')}`),
      }),
    );
    const scopeRows = results.map((result, index): LaunchRow => {
      const launch = planned[index];
      const { observation } = result;
      return {
        scope: extras.name,
        role: launch.role,
        testId: launch.target.id,
        mutantId: launch.mutantId,
        expected: launch.expected,
        outcome: observation.outcome,
        validity: observation.validity,
        agrees: observation.validity === 'valid' && observation.outcome === launch.expected,
        covering: observation.covering,
        hits: observation.hits,
        executed: observation.executed.length,
        reason: observation.reason,
        wallClockMs: result.wallClockMs,
        cpuMs: result.cpuMs,
        vitestWallClockMs: result.vitestWallClockMs,
        launchDir: result.launchDir,
      };
    });
    rows.push(...scopeRows);

    const valid = scopeRows.filter((row) => row.validity === 'valid' && row.outcome !== 'timeout');
    const wall = summarizeTimings(valid.map((row) => row.wallClockMs));
    const cpu = summarizeTimings(valid.flatMap((row) => row.cpuMs ?? []));
    const timeoutIds = new Set(
      run.mutants.filter((mutant) => mutant.oracleClass === 'timeout').map((m) => m.globalId),
    );
    const timeoutCoverage = [...timeoutIds].flatMap((id) => vitest5?.timeoutCoverage.get(id) ?? []);
    const hangingTests =
      timeoutIds.size === 0
        ? 0
        : timeoutCoverage.length === 0
          ? inventory.length
          : Math.ceil(timeoutCoverage.reduce((a, b) => a + b, 0) / timeoutCoverage.length);
    const locationKey = (target: LaunchTarget): string =>
      `${target.file}:${target.location?.line ?? '?'}:${target.location?.column ?? '?'}`;
    const perLocation = new Map<string, number>();
    const perNameAndLocation = new Map<string, number>();
    for (const target of inventory) {
      perLocation.set(locationKey(target), (perLocation.get(locationKey(target)) ?? 0) + 1);
      const key = `${locationKey(target)}#${target.fullName}`;
      perNameAndLocation.set(key, (perNameAndLocation.get(key) ?? 0) + 1);
    }
    costInputs.push({
      name: extras.name,
      population: run.mutants.length,
      tests: inventory.length,
      sampleSize: options.sampleSize,
      topUps: options.topUps,
      timeoutMutants: timeoutIds.size,
      hangingTestsPerTimeoutMutant: hangingTests,
      commandRunnerMs: extras.strykerWallClockMs,
      commandRunnerConcurrency: extras.concurrency,
      launchWallMs: Math.round(wall.meanMs),
      launchCpuMs: Math.round(cpu.meanMs),
    });
    scopeReports.push({
      name: extras.name,
      mutate: extras.mutate,
      testFiles: extras.testFiles,
      oracleRun: run.file,
      vitest5Results: scope.vitest5Results,
      sandboxDir: run.sandboxDir,
      population: run.mutants.length,
      tests: inventory.length,
      staticMutants: vitest5?.staticMutants ?? null,
      timeoutMutants: timeoutIds.size,
      hangingTestsPerTimeoutMutant: hangingTests,
      commandRunner: {
        wallClockMs: extras.strykerWallClockMs,
        concurrency: extras.concurrency,
        meanWrapperWallClockMs: extras.meanWrapperWallClockMs,
      },
      strata: {
        eachRows: inventory.filter((target) => (perLocation.get(locationKey(target)) ?? 0) > 1)
          .length,
        rowsNeedingOrdinal: inventory.filter(
          (target) =>
            (perNameAndLocation.get(`${locationKey(target)}#${target.fullName}`) ?? 0) > 1,
        ).length,
        sampledLaunchesWithLoadHits: scopeRows.filter(
          (row) => (row.hits?.loadAndCollection ?? 0) > 0,
        ).length,
        sampledLaunchesWithHookHits: scopeRows.filter((row) => (row.hits?.hook ?? 0) > 0).length,
        sampledLaunchesWithTestHits: scopeRows.filter((row) => (row.hits?.test ?? 0) > 0).length,
      },
      launches: {
        count: scopeRows.length,
        valid: scopeRows.filter((row) => row.validity === 'valid').length,
        agree: scopeRows.filter((row) => row.agrees).length,
        wall,
        cpu,
        vitest: summarizeTimings(valid.flatMap((row) => row.vitestWallClockMs ?? [])),
      },
    });
  }

  const loadAfter = os.loadavg();
  const measured = rows.filter((row) => row.validity === 'valid' && row.outcome !== 'timeout');
  const timings = {
    wall: summarizeTimings(measured.map((row) => row.wallClockMs)),
    cpu: summarizeTimings(measured.flatMap((row) => row.cpuMs ?? [])),
    vitest: summarizeTimings(measured.flatMap((row) => row.vitestWallClockMs ?? [])),
  };
  const projectionInput: CostProjectionInput = {
    model: {
      vcpus: options.vcpus,
      launchWallMs: Math.round(timings.wall.meanMs),
      launchCpuMs: Math.round(timings.cpu.meanMs),
      wallClockLimitMs: options.wallClockMs,
      jobLimitMs: options.jobLimitMs,
      fixedOverheadMs: options.fixedOverheadMs,
    },
    scopes: costInputs,
  };
  const projection = projectOracleCost(projectionInput);
  const report = {
    schemaVersion: BENCH_SCHEMA_VERSION,
    kind: 'oracle-cost-bench',
    machine: {
      cpus: os.cpus().length,
      node: process.version,
      loadAverageBefore: loadBefore,
      loadAverageAfter: loadAfter,
    },
    options: { ...options, scopes: options.scopes },
    benchWallClockMs: Math.round(performance.now() - started),
    scopes: scopeReports,
    launches: rows,
    timings,
    projectionInput,
    projection,
  };
  writeFileSync(path.join(options.outDir, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);

  const lines = [
    `oracle cost bench: ${rows.length} launches at concurrency ${options.concurrency}; load ` +
      `${loadBefore.map((v) => v.toFixed(2)).join(' ')} -> ${loadAfter.map((v) => v.toFixed(2)).join(' ')} ` +
      `on ${os.cpus().length} cpus`,
    `  per launch (valid, non-timeout): wall mean ${formatSeconds(timings.wall.meanMs)}, median ` +
      `${formatSeconds(timings.wall.medianMs)}, p90 ${formatSeconds(timings.wall.p90Ms)}; cpu mean ` +
      `${formatSeconds(timings.cpu.meanMs)}, median ${formatSeconds(timings.cpu.medianMs)}, p90 ` +
      `${formatSeconds(timings.cpu.p90Ms)}`,
    ...scopeReports.map(
      (scope, index) =>
        `  ${scope.name}: ${scope.population} mutants (${scope.staticMutants ?? '?'} static, ` +
        `${scope.timeoutMutants} timeout), ${scope.tests} tests; command pass ` +
        `${formatSeconds(scope.commandRunner.wallClockMs)} at concurrency ${scope.commandRunner.concurrency}; ` +
        `launches ${scope.launches.valid}/${scope.launches.count} valid, ${scope.launches.agree} agree; ` +
        `wall mean ${formatSeconds(scope.launches.wall.meanMs)}; projected ` +
        `${projection.scopes[index]?.launches ?? 0} launches, ${formatHours(projection.scopes[index]?.totalMs ?? 0)}`,
    ),
    `  projected full sample on ${options.vcpus} vCPU: ${formatHours(projection.totalMs)} ` +
      `(launches ${formatHours(projection.launchMs)}, command passes ${formatHours(projection.commandMs)}, ` +
      `overhead ${formatHours(projection.fixedOverheadMs)}); CPU-bound floor ` +
      `${formatHours(projection.cpuBoundFloorMs)}; job limit ${formatHours(projection.jobLimitMs)}: ` +
      (projection.fits ? 'fits' : 'DOES NOT FIT') +
      `; break-even launch ${formatSeconds(projection.breakEvenLaunchMs)}`,
    `  report: ${path.join(options.outDir, REPORT_FILE)}`,
  ];
  const text = lines.join('\n');
  writeFileSync(path.join(options.outDir, SUMMARY_FILE), `${text}\n`);
  const clean = rows.every((row) => row.validity === 'valid' && row.agrees);
  return { text, exitCode: clean ? 0 : 1 };
}

async function main(): Promise<void> {
  try {
    const options = parseBenchArgs(process.argv.slice(2), process.cwd());
    const { text, exitCode } = await runBench(options);
    console.log(text);
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof LaunchUsageError || error instanceof TypeError) {
      console.error(
        'usage: npm run test:mutation:bench -- --scope <oracle-command-run.json>[,<results.json>]... ' +
          '--out <dir> [--mutants <n>] [--tests-per-mutant <n>] [--baselines <n>] [--concurrency <n>] ' +
          '[--wall-clock-ms <n>] [--sample-size <n>] [--top-ups <n>] [--vcpus <n>] ' +
          '[--fixed-overhead-ms <n>] [--job-limit-ms <n>]',
      );
    }
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
