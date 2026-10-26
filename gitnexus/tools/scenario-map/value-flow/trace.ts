/**
 * Value-flow trace run of the scenario map (U11, R9, KTD11 "Trace", design §5.3a step 4): a
 * cheap dynamic backstop for differing data that reaches opaque built-ins, including derived
 * values (`(x * 10).toFixed(1)`) and flows the static check (U10) missed. It runs for every
 * facet-equal candidate pair, not only value-differing ones.
 *
 * Run ({@link runTrace}). One throwaway copy, `<work>/trace/prepared`, prepared like a shard's
 * copy (tools/mutation/prepare, nothing blanked) and verified against the run manifest (run-group.ts
 * `verifyPreparedCopy`; a mismatch runs nothing). The tests of every pair that the manifest lists
 * run twice through vitest-run.ts `runVitest`, each a fresh Vitest instance with the same
 * selection: a baseline, then the traced run with trace.setup.ts added (`setupFiles`) and its
 * context provided: the raw-record directory `<work>/trace/raw`, the prepared root, the extra
 * path-map roots and the wrap list (builtins.ts `wrapListOf`: the documented base list plus U10's
 * opaque-sink callees). trace-records.ts documents what is recorded. {@link tracesOf} joins the
 * raw records to the tests by file and Vitest task id.
 *
 * Run validity ({@link traceRunIssues}, pure). The runs as a whole must be fit to decide anything:
 * the baseline and the traced run each end `survived` (no failing or timed-out test, no retry, no
 * unhandled error, no outside-test row, no selection problem), every wrap-list entry was wrapped
 * in every worker, no recorder error was swallowed outside a test and every raw record reads.
 * Which wraps a pair depends on cannot be known (an unwrapped api records nothing), so any such
 * issue fails every pair closed: `trace-run-invalid`, never `clean`. The issues are listed in the
 * result (`issues`).
 *
 * Comparison ({@link compareTracePair}, pure). Per pair, inconclusive first:
 *  - `trace-run-invalid`: the run has an issue (above);
 *  - `trace-missing`: a test did not run in either run, or ran traced without a record;
 *  - `trace-changed-outcome`: its outcome class under tracing differs from the baseline;
 *  - `trace-unattributable`: it ran concurrently, so the current test does not attribute calls;
 *  - `trace-overflow`: its trace is incomplete (a value over budget or a proxy, too many distinct
 *    calls, a recorder error);
 *  - `trace-not-run`: the run did not happen (manifest mismatch, a test not in the manifest, a
 *    run error).
 * Otherwise the calls are compared per `(site, api)`:
 *  - a site only one test reaches: `asymmetric-sites`;
 *  - different call totals at a shared site, or the same values used a different number of
 *    times: `asymmetric-counts`;
 *  - different receivers (`this`) at a shared site: `receiver-differs`;
 *  - different argument lists, or the same receivers and arguments paired differently:
 *    `args-differ`.
 * Any of those is a `veto` (the pair goes to Review, R9); none is `clean`. Lifting a veto needs an
 * equivalence rule per built-in (design §5.3a); the list starts empty.
 *
 * Library only; the scenario-map CLI (U14) selects the facet-equal candidate pairs, passes U10's
 * opaque sinks and persists the result. The runner and the copy are injected
 * ({@link TraceRunDeps}), so unit tests never spawn Vitest.
 */
import { mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PACKAGE_DIR, buildPathMap } from '../../mutation/prepare/path-map.js';
import {
  prepare,
  type PrepareOptions,
  type PrepareReport,
} from '../../mutation/prepare/prepare.js';
import type { OutcomeClass } from '../../mutation/runner/classify-outcome.js';
import { parseTestId } from '../../mutation/runner/test-ids.js';
import { errorMessage } from '../../mutation/shared/cli.js';
import { overlaps, readJsonFile } from '../../mutation/shared/fs.js';
import { verifyPreparedCopy, type ScenarioRunManifest } from '../mutation/run-group.js';
import {
  runVitest,
  vitestSelectionOf,
  type VitestRunOptions,
  type VitestRunResult,
} from '../mutation/vitest-run.js';
import { extraRootsOf } from '../types.js';
import { byText, isRecord, sortedUnique, toPosixSeparators } from '../util.js';
import {
  copyBuildOutput,
  runVitestPartitioned,
  sequentialMatcherFor,
} from '../path-coverage/partitions.js';
import { wrapListOf } from './builtins.js';
import {
  RAW_TRACE_PREFIX,
  RAW_TRACE_SCHEMA_VERSION,
  TRACE_KEY,
  type RawTraceCall,
  type RawTraceRecord,
  type TraceContext,
  type TraceOverflow,
} from './trace-records.js';

/** The trace hook, relative to the (prepared) package dir. */
export const TRACE_SETUP_FILE = 'tools/scenario-map/value-flow/trace.setup.ts';
/** Differing sites kept per pair. */
export const MAX_DIFFERENCES = 10;

export type TraceVetoReason =
  | 'receiver-differs'
  | 'args-differ'
  | 'asymmetric-sites'
  | 'asymmetric-counts';
export type TraceInconclusiveReason =
  | 'trace-changed-outcome'
  | 'trace-missing'
  | 'trace-unattributable'
  | 'trace-overflow'
  | 'trace-not-run'
  | 'trace-run-invalid';
export type TraceReason = TraceVetoReason | TraceInconclusiveReason;
export type TraceStatus = 'clean' | 'veto' | 'inconclusive';

/** One test's side of the comparison. */
export interface TestTrace {
  /** Phase 0 id. */
  id: string;
  /** Outcome class in the baseline run; null when it did not run. */
  baseline: OutcomeClass | null;
  /** Outcome class in the traced run; null when it did not run. */
  traced: OutcomeClass | null;
  /** The trace hook's record lists the test. */
  recorded: boolean;
  concurrent: boolean;
  overflow: TraceOverflow[];
  calls: RawTraceCall[];
}

/** One test's calls at a site: the total and the distinct receivers and argument lists. */
export interface SiteSide {
  count: number;
  receivers: string[];
  args: string[];
}

export interface SiteDifference {
  site: string;
  api: string;
  reasons: TraceVetoReason[];
  /** null when the test never reaches the site. */
  a: SiteSide | null;
  b: SiteSide | null;
}

export interface PairTrace {
  /** Phase 0 ids. */
  a: string;
  b: string;
  status: TraceStatus;
  /** Sorted, distinct; veto reasons stay listed when the pair is inconclusive. */
  reasons: TraceReason[];
  /** `(site, api)` keys both tests reach. */
  sharedSites: number;
  /** The first {@link MAX_DIFFERENCES} differing sites, by site and api. */
  differences: SiteDifference[];
}

const INCONCLUSIVE: ReadonlySet<TraceReason> = new Set<TraceReason>([
  'trace-changed-outcome',
  'trace-missing',
  'trace-unattributable',
  'trace-overflow',
  'trace-not-run',
  'trace-run-invalid',
]);

// ── Comparison ─────────────────────────────────────────────────────────────

/** Why one test's trace cannot decide anything (module header). */
function inconclusiveReasons(test: TestTrace): TraceInconclusiveReason[] {
  const reasons: TraceInconclusiveReason[] = [];
  if (test.baseline === null || test.traced === null || !test.recorded) {
    reasons.push('trace-missing');
  } else if (test.baseline !== test.traced) {
    reasons.push('trace-changed-outcome');
  }
  if (test.concurrent) reasons.push('trace-unattributable');
  if (test.overflow.length > 0) reasons.push('trace-overflow');
  return reasons;
}

const siteKey = (call: RawTraceCall): string => `${call.site}\u0001${call.api}`;

function groupBySite(calls: readonly RawTraceCall[]): Map<string, RawTraceCall[]> {
  const sites = new Map<string, RawTraceCall[]>();
  for (const call of calls) {
    const key = siteKey(call);
    sites.set(key, [...(sites.get(key) ?? []), call]);
  }
  return sites;
}

const tally = (
  calls: readonly RawTraceCall[],
  pick: (call: RawTraceCall) => string,
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(pick(call), (counts.get(pick(call)) ?? 0) + call.count);
  return counts;
};

const sameTally = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean =>
  a.size === b.size && [...a].every(([key, count]) => b.get(key) === count);

const sameKeys = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean =>
  a.size === b.size && [...a.keys()].every((key) => b.has(key));

const total = (calls: readonly RawTraceCall[]): number =>
  calls.reduce((sum, call) => sum + call.count, 0);

const sideOf = (calls: readonly RawTraceCall[]): SiteSide => ({
  count: total(calls),
  receivers: sortedUnique(calls.map((call) => call.receiver)),
  args: sortedUnique(calls.map((call) => call.args)),
});

const receiverOf = (call: RawTraceCall): string => call.receiver;
const argsOf = (call: RawTraceCall): string => call.args;
const tupleOf = (call: RawTraceCall): string => `${call.receiver}\u0001${call.args}`;

/** The veto reasons of one shared site (module header); empty when the calls are equal. */
export function siteReasons(
  a: readonly RawTraceCall[],
  b: readonly RawTraceCall[],
): TraceVetoReason[] {
  const reasons = new Set<TraceVetoReason>();
  if (total(a) !== total(b)) reasons.add('asymmetric-counts');
  const [receiversA, receiversB] = [tally(a, receiverOf), tally(b, receiverOf)];
  const [argsA, argsB] = [tally(a, argsOf), tally(b, argsOf)];
  if (!sameKeys(receiversA, receiversB)) reasons.add('receiver-differs');
  if (!sameKeys(argsA, argsB)) reasons.add('args-differ');
  if (reasons.size === 0 && !sameTally(tally(a, tupleOf), tally(b, tupleOf))) {
    const marginalsEqual = sameTally(receiversA, receiversB) && sameTally(argsA, argsB);
    reasons.add(marginalsEqual ? 'args-differ' : 'asymmetric-counts');
  }
  return sortedUnique(reasons);
}

/**
 * Compares two tests' traces (module header); `runIssues` are the run's ({@link traceRunIssues}):
 * with any, the pair is `trace-run-invalid`.
 */
export function compareTracePair(
  a: TestTrace,
  b: TestTrace,
  runIssues: readonly string[] = [],
): PairTrace {
  const inconclusive: TraceInconclusiveReason[] = [
    ...(runIssues.length > 0 ? ['trace-run-invalid' as const] : []),
    ...inconclusiveReasons(a),
    ...inconclusiveReasons(b),
  ];
  const [sitesA, sitesB] = [groupBySite(a.calls), groupBySite(b.calls)];
  const keys = sortedUnique([...sitesA.keys(), ...sitesB.keys()]);
  const differences: SiteDifference[] = [];
  let sharedSites = 0;
  for (const key of keys) {
    const [callsA, callsB] = [sitesA.get(key), sitesB.get(key)];
    const [first] = callsA ?? callsB ?? [];
    if (callsA !== undefined && callsB !== undefined) sharedSites += 1;
    const reasons: TraceVetoReason[] =
      callsA === undefined || callsB === undefined
        ? ['asymmetric-sites']
        : siteReasons(callsA, callsB);
    if (reasons.length === 0 || first === undefined) continue;
    differences.push({
      site: first.site,
      api: first.api,
      reasons,
      a: callsA === undefined ? null : sideOf(callsA),
      b: callsB === undefined ? null : sideOf(callsB),
    });
  }
  const reasons = sortedUnique<TraceReason>([
    ...inconclusive,
    ...differences.flatMap((difference) => difference.reasons),
  ]);
  const status: TraceStatus = reasons.some((reason) => INCONCLUSIVE.has(reason))
    ? 'inconclusive'
    : differences.length > 0
      ? 'veto'
      : 'clean';
  return {
    a: a.id,
    b: b.id,
    status,
    reasons,
    sharedSites,
    differences: differences.slice(0, MAX_DIFFERENCES),
  };
}

const notRunPair = (pair: TracePair): PairTrace => ({
  a: pair.a,
  b: pair.b,
  status: 'inconclusive',
  reasons: ['trace-not-run'],
  sharedSites: 0,
  differences: [],
});

// ── Records ────────────────────────────────────────────────────────────────

const isRawTraceRecord = (value: unknown): value is RawTraceRecord =>
  isRecord(value) &&
  value.schemaVersion === RAW_TRACE_SCHEMA_VERSION &&
  typeof value.file === 'string' &&
  Array.isArray(value.tests) &&
  Array.isArray(value.wrapped) &&
  Array.isArray(value.unavailable) &&
  Array.isArray(value.errors);

/** The raw records in a directory; a file that is not one is listed in `invalid`. */
export function readRawTraces(dir: string): { records: RawTraceRecord[]; invalid: string[] } {
  const records: RawTraceRecord[] = [];
  const invalid: string[] = [];
  const names = readdirSync(dir)
    .filter((name) => name.startsWith(RAW_TRACE_PREFIX) && name.endsWith('.json'))
    .sort(byText);
  for (const name of names) {
    let data: unknown;
    try {
      data = readJsonFile(path.join(dir, name));
    } catch {
      data = null;
    }
    if (isRawTraceRecord(data)) records.push(data);
    else invalid.push(name);
  }
  return { records, invalid };
}

export interface TracesInput {
  /** Phase 0 ids, in output order. */
  ids: readonly string[];
  baseline: VitestRunResult;
  traced: VitestRunResult;
  records: readonly RawTraceRecord[];
  /** Absolute package directory the workers saw (the records' file paths are under it). */
  packageDir: string;
}

/** Joins the runs and the raw records into one {@link TestTrace} per id (module header). */
export function tracesOf(input: TracesInput): TestTrace[] {
  const packageDir = toPosixSeparators(input.packageDir).replace(/\/+$/, '');
  const byFile = new Map<string, Map<string, RawTraceRecord['tests'][number]>>();
  for (const record of input.records) {
    const file = path.posix.relative(packageDir, toPosixSeparators(record.file));
    const tests = byFile.get(file) ?? new Map<string, RawTraceRecord['tests'][number]>();
    for (const test of record.tests) tests.set(test.taskId, test);
    byFile.set(file, tests);
  }
  const baselineOf = new Map(input.baseline.tests.map((test) => [test.id, test.outcome]));
  const tracedOf = new Map(input.traced.tests.map((test) => [test.id, test]));
  return input.ids.map((id): TestTrace => {
    const traced = tracedOf.get(id);
    const raw =
      traced?.taskId === null || traced === undefined
        ? undefined
        : byFile.get(parseTestId(id).file)?.get(traced.taskId);
    return {
      id,
      baseline: baselineOf.get(id) ?? null,
      traced: traced?.outcome ?? null,
      recorded: raw !== undefined,
      concurrent: raw?.concurrent ?? false,
      overflow: raw === undefined ? [] : [...raw.overflow],
      calls: raw === undefined ? [] : raw.calls.map((call) => ({ ...call })),
    };
  });
}

// ── Run ────────────────────────────────────────────────────────────────────

export interface TracePair {
  /** Phase 0 ids. */
  a: string;
  b: string;
}

export interface TraceRunDeps {
  runVitest: (options: VitestRunOptions) => Promise<VitestRunResult>;
  prepare: (options: PrepareOptions) => PrepareReport;
  /** Milliseconds on a monotonic clock. */
  now: () => number;
}

export const defaultTraceRunDeps: TraceRunDeps = {
  runVitest,
  prepare,
  now: () => performance.now(),
};

export interface TraceRunOptions {
  /** Absolute repo checkout. */
  repoRoot: string;
  /** Absolute work directory, outside the checkout. */
  workDir: string;
  /** The run manifest the copy is verified against. */
  manifest: ScenarioRunManifest;
  /** The facet-equal candidate pairs. */
  pairs: readonly TracePair[];
  /** U10's opaque-sink callees (pdg-walk.ts `opaqueSinks[].callee`), added to the wrap list. */
  opaqueCallees?: readonly string[];
  /** Upper bound of each Vitest run's worker processes (the CLI's `--concurrency`). */
  maxWorkers?: number;
}

export interface TraceRunSummary {
  wallClockMs: number;
  outcome: OutcomeClass;
  /** Selection problems and unhandled errors. */
  problems: string[];
}

export interface TraceRunResult {
  /** `not-run`: nothing was traced (`detail` says why); every pair is `trace-not-run`. */
  status: 'ran' | 'not-run';
  detail: string | null;
  /**
   * Why the runs cannot decide any pair ({@link traceRunIssues}); with any, every pair is
   * `trace-run-invalid`. Empty when the trace did not run.
   */
  issues: string[];
  wrap: {
    /** Apis added for U10's opaque sinks. */
    added: string[];
    /** Opaque-sink callees that are not wrapped, with the reason. */
    skipped: { callee: string; reason: string }[];
    /** Entries some worker could not wrap, each once. */
    unavailable: { api: string; reason: string }[];
    /** Recorder errors and unreadable raw records, each once. */
    errors: string[];
  };
  baseline: TraceRunSummary | null;
  traced: TraceRunSummary | null;
  /** Traced over baseline wall-clock time; null unless both ran. */
  overhead: number | null;
  tests: TestTrace[];
  /** In input order. */
  pairs: PairTrace[];
  wallClockMs: number;
}

export interface TraceLayout {
  preparedRoot: string;
  baselineDir: string;
  tracedDir: string;
  rawDir: string;
}

/** Where a trace run keeps its copy, its two runs' scratch and the raw records. */
export const traceLayout = (workDir: string): TraceLayout => ({
  preparedRoot: path.join(workDir, 'trace', 'prepared'),
  baselineDir: path.join(workDir, 'trace', 'baseline'),
  tracedDir: path.join(workDir, 'trace', 'traced'),
  rawDir: path.join(workDir, 'trace', 'raw'),
});

export interface TraceRunIssuesInput {
  baseline: VitestRunResult;
  traced: VitestRunResult;
  wrap: Pick<TraceRunResult['wrap'], 'unavailable' | 'errors'>;
}

/** Why the runs as a whole cannot decide any pair (module header); empty when they can. */
export function traceRunIssues(input: TraceRunIssuesInput): string[] {
  const runIssues = (name: string, run: VitestRunResult): string[] => [
    ...(run.status === 'survived' && run.outcome === 'survived'
      ? []
      : [
          `${name} run ${run.status}/${run.outcome}${run.reason === null ? '' : `: ${run.reason}`}`,
        ]),
    ...run.outsideTest.map((row) => `${name} run: ${row.outcome} outside a test in ${row.file}`),
    ...run.problems.map((problem) => `${name} run: ${problem}`),
    ...run.unhandledErrors.map((error) => `${name} run: unhandled error: ${error}`),
  ];
  return [
    ...runIssues('baseline', input.baseline),
    ...runIssues('traced', input.traced),
    ...input.wrap.unavailable.map((entry) => `not wrapped: ${entry.api} (${entry.reason})`),
    ...input.wrap.errors.map((error) => `trace error: ${error}`),
  ];
}

const summaryOf = (run: VitestRunResult): TraceRunSummary => ({
  wallClockMs: run.wallClockMs,
  outcome: run.outcome,
  problems: [...run.problems, ...run.unhandledErrors.map((error) => `unhandled error: ${error}`)],
});

/** Runs the pairs' tests with and without the trace hook and compares them (module header). */
export async function runTrace(
  options: TraceRunOptions,
  deps: TraceRunDeps = defaultTraceRunDeps,
): Promise<TraceRunResult> {
  const { repoRoot, workDir, manifest, pairs } = options;
  if (overlaps(repoRoot, workDir)) {
    throw new Error(`trace: the work directory ${workDir} must lie outside ${repoRoot}`);
  }
  const started = deps.now();
  const wrap = wrapListOf(options.opaqueCallees);
  const base: Omit<TraceRunResult, 'status' | 'detail' | 'pairs' | 'wallClockMs'> = {
    issues: [],
    wrap: { added: wrap.added, skipped: wrap.skipped, unavailable: [], errors: [] },
    baseline: null,
    traced: null,
    overhead: null,
    tests: [],
  };
  const notRun = (detail: string): TraceRunResult => ({
    ...base,
    status: 'not-run',
    detail,
    pairs: pairs.map(notRunPair),
    wallClockMs: Math.round(deps.now() - started),
  });
  if (pairs.length === 0) return notRun('no pairs');
  const listed = new Set(manifest.tests.map((test) => test.id));
  const ids = sortedUnique(pairs.flatMap((pair) => [pair.a, pair.b])).filter((id) =>
    listed.has(id),
  );
  if (ids.length === 0) return notRun('no pair test is in the run manifest');

  const layout = traceLayout(workDir);
  const extraRoots = extraRootsOf(manifest.mode);
  deps.prepare({
    repoRoot,
    outDir: layout.preparedRoot,
    mutate: [],
    pathMap: buildPathMap(extraRoots),
  });
  const check = verifyPreparedCopy(manifest, layout.preparedRoot);
  if (!check.ok) return notRun(`manifest mismatch: ${check.mismatches.join('; ')}`);
  const preparedRoot = toPosixSeparators(realpathSync(layout.preparedRoot));
  const packageDir = path.posix.join(preparedRoot, PACKAGE_DIR);
  copyBuildOutput(manifest.mode.kind, path.join(repoRoot, PACKAGE_DIR), packageDir);
  const vitest = vitestSelectionOf(manifest.mode);
  const context: TraceContext = {
    outDir: layout.rawDir,
    preparedRoot,
    extraRoots,
    wrap: wrap.entries,
  };
  let baseline: VitestRunResult;
  let traced: VitestRunResult;
  try {
    // The base config's sequential files run in a partition of their own, one worker (E3).
    const isSequential = sequentialMatcherFor(manifest.mode.kind);
    baseline = await runVitestPartitioned(
      deps.runVitest,
      {
        packageDir,
        testIds: ids,
        vitest,
        workDir: layout.baselineDir,
        maxWorkers: options.maxWorkers,
      },
      isSequential,
    );
    rmSync(layout.rawDir, { recursive: true, force: true });
    mkdirSync(layout.rawDir, { recursive: true });
    traced = await runVitestPartitioned(
      deps.runVitest,
      {
        packageDir,
        testIds: ids,
        vitest,
        workDir: layout.tracedDir,
        setupFiles: [TRACE_SETUP_FILE],
        provide: (project) => project.provide(TRACE_KEY, context),
        maxWorkers: options.maxWorkers,
      },
      isSequential,
    );
  } catch (error) {
    return notRun(`run error: ${errorMessage(error)}`);
  }

  const { records, invalid } = readRawTraces(layout.rawDir);
  const tests = tracesOf({ ids, baseline, traced, records, packageDir });
  const byId = new Map(tests.map((test) => [test.id, test]));
  const unavailable = new Map<string, { api: string; reason: string }>();
  for (const item of records.flatMap((record) => record.unavailable)) {
    unavailable.set(`${item.api}\u0001${item.reason}`, { api: item.api, reason: item.reason });
  }
  const errors = sortedUnique([
    ...records.flatMap((record) => record.errors),
    ...invalid.map((name) => `unreadable raw record ${name}`),
  ]);
  const wrapResult = { ...base.wrap, unavailable: [...unavailable.values()], errors };
  const issues = traceRunIssues({ baseline, traced, wrap: wrapResult });
  return {
    ...base,
    status: 'ran',
    detail: null,
    issues,
    wrap: wrapResult,
    baseline: summaryOf(baseline),
    traced: summaryOf(traced),
    overhead:
      baseline.wallClockMs > 0
        ? Math.round((traced.wallClockMs / baseline.wallClockMs) * 100) / 100
        : null,
    tests,
    pairs: pairs.map((pair) => {
      const [a, b] = [byId.get(pair.a), byId.get(pair.b)];
      return a === undefined || b === undefined ? notRunPair(pair) : compareTracePair(a, b, issues);
    }),
    wallClockMs: Math.round(deps.now() - started),
  };
}
