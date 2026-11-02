/**
 * Gate 4 (U8; KTD17, KTD19): planted positive controls and a two-profile determinism check over
 * vitest5 runner runs (U10 `results.json`) of the KTD11 scopes.
 *
 * Controls. A control is one of a run's own Stryker mutants, named by its global id (U2); no source
 * is edited. `test/fixtures/mutation-controls/planted.json` records per scope the driver scope,
 * and per control its expected killers (the tests that kill it with an assertion, KTD17) and a
 * sample of expected non-killers of two kinds: `ran` tests run with the mutant active and pass
 * (covering non-killers; every test of a static mutant runs), `notRun` tests do not reach it (the
 * runner's per-test coverage does not select them). In every run, every expected killer must kill
 * the control with an assertion, no other test may kill it in any class (Stryker's `killedBy` or
 * the assertion kill set), and every `ran` non-killer must run with the mutant active and pass. A
 * control whose global id the run lacks while the run mutated another version of its file, or a
 * planted test whose id the run lacks, means the checkout changed: "re-select required" (exit 3),
 * and nothing else is checked for that control. A control the run lacks although its file's
 * content hash is unchanged was not generated (a broken blanking step, KTD7, or another mutator
 * set) and fails.
 *
 * Required tags (KTD19). At least one control sits in relocated `gitnexus-shared` code
 * (`relocated-shared`: its file is under `gitnexus-shared/`, which the prepare step relocates into
 * the package, KTD8) and one inside an `as const` table (`as-const`: its span lies inside the
 * operand of an `as const` assertion of the original file, code only the prepare step's blanking
 * makes mutable, KTD7). A mis-pointed alias or a broken blanking step then fails a control instead
 * of every shared mutant quietly surviving. Tags are recomputed from the checkout's source at every
 * check and must equal the recorded ones.
 *
 * Determinism. Every scope runs once per profile of the planted file: A at Stryker concurrency 1
 * with unlimited runner reuse (`maxTestRunnerReuse: 0`), B at concurrency 3 with
 * `maxTestRunnerReuse: 1` (a fresh runner process per mutant). The first profile is compared with
 * every other: the same global mutant ids and test ids (skipped flag included), and per mutant the
 * same outcome class (KTD17), Stryker status, `killedBy` set and assertion kill set. Each
 * difference names the mutant and, for kill sets, the test.
 *
 * Runs. Each (scope, profile) pair is one scope-driver run (U10, vitest5 variant). A run must have
 * run the planted scope, at its profile's concurrency and runner reuse, from a prepared copy whose
 * input files (oracle/freeze.ts KTD12 groups: the scope's import closure, the Vitest configs and the
 * prepare tool) and mutated files hash like the checkout's; otherwise it is stale (exit 2). Its
 * integrity flags, span-map failures and a failed Stryker run are problems (exit 1). Runs go in
 * parallel while the Stryker concurrency of the running ones stays within `--max-workers`
 * (default 3): the three concurrency-1 runs of profile A together, profile B's runs one at a time.
 *
 * Selection (`--select`) regenerates the controls from the runs of every selected profile; with
 * `--scope` only those scopes are re-selected. A candidate is a mutant that, in every run, is
 * Killed with outcome `killed-by-test:assertion`, whose every killer kills with an assertion
 * (`killedBy` equals the assertion kill set), with the same 1 to `maxKillers` killers in every run,
 * one attempt, no flags and a sidecar record. Candidates rank by: a covering non-killer exists,
 * then fewer killers, then freeze.ts `sampleRank(seed, global id)`. Per scope: first, for each
 * required tag that no control has yet, the best candidate with the tag; then the best candidates
 * with a mutator and killers no control has yet; then the best remaining, up to `perScope`. Listed
 * non-killers are the `maxNonKillers` lowest-ranked tests of each kind (`sampleRank(seed + "\n" +
 * id, test)`), sorted. The selection goes to `<work>/planted.json`, and to `--planted` only when
 * every selected scope's runs were usable and every required tag is carried; the check then runs
 * on the same runs (a missing required tag fails it).
 *
 * Planted file ({@link PlantedControls}, schemaVersion 1, JSON):
 *   kind, description, reselect      what the file is, the re-select command
 *   profiles[]                       {name, concurrency, maxTestRunnerReuse}
 *   timeoutMS                        Stryker `timeoutMS` of every run
 *   selection                        {seed, perScope, maxKillers, maxNonKillers, selectedFrom[]}
 *   scopes[]                         {name, scope {testFiles, mutate} (driver scope), mutants and
 *                                    tests (inventory sizes at selection), controls[] {id, tags[],
 *                                    static, expectedKillers[], expectedNonKillers {ran[], notRun[]}}}
 *
 * Work dir (absolute, outside the checkout): `scopes/<scope>.json` driver scope files,
 * `runs/<scope>/<profile>/` scope-driver runs, `planted.json` (select), and the report.
 * Report ({@link ControlsReport}, `--report`, default `<work>/controls-report.json`): result,
 * exitCode, requirements {required, carried, missing}, scopes[] {name, runs[] {profile, results,
 * wallClockMs, mutants, tests, stale[], problems[]}, controls {checked, failures[]}, determinism
 * [{profiles, mutants, tests, differences[]}]}, selection problems, summary lines.
 *
 * Usage (from gitnexus/):
 *   npm run test:mutation:controls -- --work <dir> [--planted <file>] [--profile <name>]...
 *     [--scope <name>]... [--compare-only] [--timeout-ms <n>] [--max-workers <n>] [--report <file>]
 *     [--select [--define <name>=<driver scope.json>]... [--seed <seed>] [--per-scope <n>]]
 * `--compare-only` reads the runs already in `<work>`; `--profile`/`--scope` restrict the runs (CI
 * can run the profiles in separate jobs, then compare with `--compare-only`). `--define` adds or
 * replaces a scope (select only); `--seed` and `--per-scope` default to the planted file's.
 * Exit codes: 0 pass; 1 control failures, determinism differences, run or selection problems;
 * 2 usage or setup error, or a stale run; 3 re-select required (only stale controls); 130
 * interrupted (SIGINT or SIGTERM: no further run starts, the scope driver forwards the signal to
 * the running Stryker processes, nothing is selected or checked).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from '@babel/parser';
import {
  RESULTS_SCHEMA_VERSION,
  type NormalisedMutant,
  type RunResults,
} from '../driver/normalise-results.js';
import { runScope } from '../driver/run-scope.js';
import { formatMutateEntry, parseDriverScope } from '../driver/stryker-config.js';
import {
  diffInputs,
  hashInputs,
  inputFiles,
  preparedInputs,
  sampleRank,
  type InputHashes,
} from '../oracle/freeze.js';
import { contentHash, type ReportLocation } from '../prepare/mutant-identity.js';
import { PACKAGE_DIR } from '../prepare/path-map.js';
import { indexSource, locationToOffsets, type Offsets } from '../prepare/span-map-check.js';
import type { OutcomeClass } from '../runner/classify-outcome.js';
import type { SidecarRecord } from '../runner/sidecar.js';
import { errorMessage, isMainModule } from '../shared/cli.js';
import { isInside, readJsonFile } from '../shared/fs.js';

export const PLANTED_SCHEMA_VERSION = 1;
export const PLANTED_KIND = 'gitnexus-mutation-controls';
export const REPORT_KIND = 'gitnexus-mutation-gate4-report';
/** Package-relative default of `--planted`. */
export const PLANTED_FILE = 'test/fixtures/mutation-controls/planted.json';
export const WORK_MARKER = '.gitnexus-mutation-controls';

export const EXIT_PASS = 0;
export const EXIT_FAILURES = 1;
export const EXIT_USAGE = 2;
export const EXIT_RESELECT = 3;
export const EXIT_INTERRUPTED = 130;

export const CONTROL_TAGS = ['relocated-shared', 'as-const'] as const;
export type ControlTag = (typeof CONTROL_TAGS)[number];
/** KTD19: every planted file carries a control with each of these tags; selection order. */
export const REQUIRED_TAGS: readonly ControlTag[] = ['as-const', 'relocated-shared'];
const SHARED_PREFIX = 'gitnexus-shared/';

export interface Profile {
  name: string;
  concurrency: number;
  maxTestRunnerReuse: number;
}

export const DEFAULT_PROFILES: readonly Profile[] = [
  { name: 'A', concurrency: 1, maxTestRunnerReuse: 0 },
  { name: 'B', concurrency: 3, maxTestRunnerReuse: 1 },
];
export const DEFAULT_TIMEOUT_MS = 10000;
export const DEFAULT_PER_SCOPE = 3;
export const DEFAULT_MAX_KILLERS = 3;
export const DEFAULT_MAX_NON_KILLERS = 3;
/** Default `--max-workers`: profile B's concurrency, so its runs go one at a time. */
export const DEFAULT_MAX_WORKERS = 3;

export const RESELECT_COMMAND =
  'npm run test:mutation:controls -- --select --work <dir outside the checkout>';
const DESCRIPTION =
  'Gate 4 positive controls (U8, KTD19): Stryker mutants of the scopes, named by global id. In ' +
  'every determinism profile each must be killed with an assertion by exactly its expected ' +
  'killers, and every listed covering non-killer must run with it and pass. Regenerate with ' +
  '`reselect` when a control or test goes missing (tools/mutation/controls/run-controls.ts).';

export interface ExpectedNonKillers {
  /** Ran with the mutant active and passed (covering non-killers). */
  ran: string[];
  /** Not reached: the runner's coverage did not select them. */
  notRun: string[];
}

export interface PlantedControl {
  /** Global mutant id (U2). */
  id: string;
  tags: ControlTag[];
  static: boolean | null;
  expectedKillers: string[];
  expectedNonKillers: ExpectedNonKillers;
}

export interface DriverScopeSpec {
  testFiles: string[];
  mutate: string[];
}

export interface PlantedScope {
  name: string;
  scope: DriverScopeSpec;
  /** Mutants and non-skipped tests of the runs the controls were selected from. */
  mutants: number;
  tests: number;
  controls: PlantedControl[];
}

export interface SelectionRecord {
  seed: string;
  perScope: number;
  maxKillers: number;
  maxNonKillers: number;
  /** Profiles whose runs the controls were selected from. */
  selectedFrom: string[];
}

export interface PlantedControls {
  schemaVersion: typeof PLANTED_SCHEMA_VERSION;
  kind: typeof PLANTED_KIND;
  description: string;
  reselect: string;
  profiles: Profile[];
  timeoutMS: number;
  selection: SelectionRecord;
  scopes: PlantedScope[];
}

// ── run views ──────────────────────────────────────────────────────────────

export interface RanTest {
  id: string;
  outcome: OutcomeClass;
}

/** What gate 4 reads of one mutant of a vitest5 run. */
export interface RunMutantView {
  globalId: string;
  /** Repo-relative original file. */
  file: string;
  location: ReportLocation;
  mutatorName: string;
  static: boolean | null;
  /** Stryker's raw status. */
  status: string;
  outcome: OutcomeClass | null;
  killedBy: string[];
  assertionKilledBy: string[];
  /** The tests the latest sidecar record ran, with their classes; null without a record. */
  ran: RanTest[] | null;
  attempts: number;
  flags: string[];
}

export interface RunView {
  profile: string;
  tests: { id: string; skipped: boolean }[];
  mutants: RunMutantView[];
}

export type TagsOf = (mutant: Pick<RunMutantView, 'file' | 'location'>) => ControlTag[];

const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  JSON.stringify(sortedUnique(a)) === JSON.stringify(sortedUnique(b));

/** The run view of a normalised mutant; `readRan` reads a sidecar record's test rows. */
export function mutantView(
  mutant: NormalisedMutant,
  readRan: (sidecarFile: string) => RanTest[],
): RunMutantView {
  return {
    globalId: mutant.globalId,
    file: mutant.file,
    location: mutant.location,
    mutatorName: mutant.mutatorName,
    static: mutant.static,
    status: mutant.status,
    outcome: mutant.outcome,
    killedBy: mutant.killedBy,
    assertionKilledBy: mutant.assertionKilledBy,
    ran: mutant.sidecar === null ? null : readRan(mutant.sidecar.file),
    attempts: mutant.attempts.length,
    flags: mutant.flags,
  };
}

// ── tags (KTD19) ───────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const spanOf = (value: unknown): Offsets | null =>
  isRecord(value) && typeof value.start === 'number' && typeof value.end === 'number'
    ? { start: value.start, end: value.end }
    : null;

function isAsConst(node: Record<string, unknown>): boolean {
  if (node.type !== 'TSAsExpression') return false;
  const annotation = node.typeAnnotation;
  if (!isRecord(annotation) || annotation.type !== 'TSTypeReference') return false;
  const name = annotation.typeName;
  return isRecord(name) && name.type === 'Identifier' && name.name === 'const';
}

const SKIPPED_KEYS = new Set(['loc', 'leadingComments', 'trailingComments', 'innerComments']);

/** 0-based, end-exclusive offsets of the operand of every `as const` assertion, in order. */
export function asConstRanges(source: string): Offsets[] {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'decorators-legacy'] });
  const ranges: Offsets[] = [];
  const stack: unknown[] = [ast.program];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (!isRecord(node)) continue;
    const span = isAsConst(node) ? spanOf(node.expression) : null;
    if (span !== null) ranges.push(span);
    for (const [key, value] of Object.entries(node)) {
      if (!SKIPPED_KEYS.has(key) && isRecord(value)) stack.push(value);
    }
  }
  return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * The KTD19 tags of a mutant, in {@link CONTROL_TAGS} order; `source` is its original file and
 * `ranges` that file's {@link asConstRanges}.
 */
export function mutantTags(
  mutant: Pick<RunMutantView, 'file' | 'location'>,
  source: string,
  ranges: readonly Offsets[] = asConstRanges(source),
): ControlTag[] {
  const offsets = locationToOffsets(indexSource(source, mutant.file), mutant.location);
  const inTable = ranges.some((range) => range.start <= offsets.start && offsets.end <= range.end);
  return CONTROL_TAGS.filter((tag) =>
    tag === 'relocated-shared' ? mutant.file.startsWith(SHARED_PREFIX) : inTable,
  );
}

// ── controls check ─────────────────────────────────────────────────────────

export type ControlFailureKind =
  | 'stale-mutant'
  | 'stale-test'
  | 'mutant-missing'
  | 'killer-missed'
  | 'unexpected-killer'
  | 'non-killer-not-run'
  | 'tags';

const STALE_KINDS: ReadonlySet<ControlFailureKind> = new Set(['stale-mutant', 'stale-test']);

export interface ControlFailure {
  scope: string;
  profile: string;
  /** Global mutant id of the control. */
  control: string;
  kind: ControlFailureKind;
  test: string | null;
  detail: string;
}

/** Checks every control of a planted scope against one run; pure. */
export function checkControls(scope: PlantedScope, run: RunView, tagsOf: TagsOf): ControlFailure[] {
  const mutants = new Map(run.mutants.map((mutant) => [mutant.globalId, mutant]));
  const inventory = new Set(run.tests.filter((test) => !test.skipped).map((test) => test.id));
  return scope.controls.flatMap((control): ControlFailure[] => {
    const fail = (
      kind: ControlFailureKind,
      test: string | null,
      detail: string,
    ): ControlFailure => ({
      scope: scope.name,
      profile: run.profile,
      control: control.id,
      kind,
      test,
      detail,
    });
    const mutant = mutants.get(control.id);
    if (mutant === undefined) {
      // `<file>@<content hash>:` prefixes every mutant of the same source text (U2).
      const source = control.id.slice(0, control.id.indexOf(':', control.id.indexOf('@')) + 1);
      return run.mutants.some((entry) => entry.globalId.startsWith(source))
        ? [
            fail(
              'mutant-missing',
              null,
              'the source is unchanged but the run has no such mutant (prepare step or mutator ' +
                'set changed; re-select only if that is intended)',
            ),
          ]
        : [fail('stale-mutant', null, 'the run mutated another version of its file; re-select')];
    }
    const { ran: ranNonKillers, notRun } = control.expectedNonKillers;
    const unknown = sortedUnique([...control.expectedKillers, ...ranNonKillers, ...notRun]).filter(
      (id) => !inventory.has(id),
    );
    if (unknown.length > 0) {
      return unknown.map((id) =>
        fail('stale-test', id, 'the run has no such test, or skipped it; re-select'),
      );
    }

    const failures: ControlFailure[] = [];
    const tags = tagsOf(mutant);
    if (!sameSet(tags, control.tags)) {
      failures.push(
        fail(
          'tags',
          null,
          `recorded [${control.tags.join(', ')}], source has [${tags.join(', ')}]`,
        ),
      );
    }
    const assertion = new Set(mutant.assertionKilledBy);
    const killers = new Set(mutant.killedBy);
    const ran = new Map((mutant.ran ?? []).map((test) => [test.id, test.outcome]));
    for (const id of control.expectedKillers) {
      if (assertion.has(id)) continue;
      failures.push(
        fail(
          'killer-missed',
          id,
          killers.has(id)
            ? `killed it without an assertion (${ran.get(id) ?? 'no test row'})`
            : `did not kill it (Stryker ${mutant.status}, class ${mutant.outcome ?? 'none'})`,
        ),
      );
    }
    const expected = new Set(control.expectedKillers);
    const listed = new Set([...ranNonKillers, ...notRun]);
    for (const id of sortedUnique([...mutant.killedBy, ...mutant.assertionKilledBy])) {
      if (expected.has(id)) continue;
      failures.push(
        fail(
          'unexpected-killer',
          id,
          `${assertion.has(id) ? 'killed it with an assertion' : `killed it (${ran.get(id) ?? 'no test row'})`}` +
            `; ${listed.has(id) ? 'listed as an expected non-killer' : 'not an expected killer'}`,
        ),
      );
    }
    for (const id of ranNonKillers) {
      if (killers.has(id) || assertion.has(id)) continue;
      const outcome = ran.get(id);
      if (outcome === 'survived') continue;
      failures.push(
        fail(
          'non-killer-not-run',
          id,
          outcome === undefined
            ? 'did not run with the mutant active'
            : `ran with class ${outcome}`,
        ),
      );
    }
    return failures;
  });
}

/** The required tags no control of the planted file carries, in {@link REQUIRED_TAGS} order. */
export function checkRequirements(planted: PlantedControls): ControlTag[] {
  const carried = new Set(
    planted.scopes.flatMap((scope) => scope.controls.flatMap((control) => control.tags)),
  );
  return REQUIRED_TAGS.filter((tag) => !carried.has(tag));
}

// ── determinism ────────────────────────────────────────────────────────────

export type DeterminismKind =
  | 'mutant-inventory'
  | 'test-inventory'
  | 'outcome'
  | 'status'
  | 'killed-by'
  | 'assertion-killed-by';

export interface DeterminismDifference {
  kind: DeterminismKind;
  mutant: string | null;
  test: string | null;
  detail: string;
}

/** Differences between two runs of one scope in two profiles; pure. */
export function compareDeterminism(a: RunView, b: RunView): DeterminismDifference[] {
  const diffs: DeterminismDifference[] = [];
  const onlyIn = (name: string): string => `only in profile ${name}`;

  const testsA = new Map(a.tests.map((test) => [test.id, test.skipped]));
  const testsB = new Map(b.tests.map((test) => [test.id, test.skipped]));
  for (const id of sortedUnique([...testsA.keys(), ...testsB.keys()])) {
    const skippedA = testsA.get(id);
    const skippedB = testsB.get(id);
    if (skippedA === skippedB) continue;
    const detail =
      skippedA === undefined
        ? onlyIn(b.profile)
        : skippedB === undefined
          ? onlyIn(a.profile)
          : `skipped only in profile ${skippedA ? a.profile : b.profile}`;
    diffs.push({ kind: 'test-inventory', mutant: null, test: id, detail });
  }

  const mutantsB = new Map(b.mutants.map((mutant) => [mutant.globalId, mutant]));
  const idsA = new Set(a.mutants.map((mutant) => mutant.globalId));
  for (const id of sortedUnique([...idsA, ...mutantsB.keys()])) {
    if (idsA.has(id) && mutantsB.has(id)) continue;
    const detail = onlyIn(idsA.has(id) ? a.profile : b.profile);
    diffs.push({ kind: 'mutant-inventory', mutant: id, test: null, detail });
  }

  const sorted = [...a.mutants].sort((x, y) => byCodeUnits(x.globalId, y.globalId));
  for (const mutantA of sorted) {
    const mutantB = mutantsB.get(mutantA.globalId);
    if (mutantB === undefined) continue;
    const id = mutantA.globalId;
    const versus = (x: string, y: string): string => `${a.profile}: ${x}, ${b.profile}: ${y}`;
    const outcomeA = mutantA.outcome ?? 'none';
    const outcomeB = mutantB.outcome ?? 'none';
    if (outcomeA !== outcomeB) {
      diffs.push({ kind: 'outcome', mutant: id, test: null, detail: versus(outcomeA, outcomeB) });
    }
    if (mutantA.status !== mutantB.status) {
      const detail = versus(mutantA.status, mutantB.status);
      diffs.push({ kind: 'status', mutant: id, test: null, detail });
    }
    const sets: [DeterminismKind, string[], string[]][] = [
      ['killed-by', mutantA.killedBy, mutantB.killedBy],
      ['assertion-killed-by', mutantA.assertionKilledBy, mutantB.assertionKilledBy],
    ];
    for (const [kind, inA, inB] of sets) {
      const setA = new Set(inA);
      const setB = new Set(inB);
      for (const test of sortedUnique([...inA, ...inB])) {
        if (setA.has(test) && setB.has(test)) continue;
        const detail = `kills only in profile ${setA.has(test) ? a.profile : b.profile}`;
        diffs.push({ kind, mutant: id, test, detail });
      }
    }
  }
  return diffs;
}

// ── selection ──────────────────────────────────────────────────────────────

export interface SelectOptions {
  seed: string;
  perScope: number;
  maxKillers: number;
  maxNonKillers: number;
}

export interface ScopeSelection {
  /** Mutants that qualified as controls. */
  candidates: number;
  /** Sorted by global id. */
  controls: PlantedControl[];
}

interface Candidate {
  mutant: RunMutantView;
  killers: string[];
  ranPassed: string[];
  notRun: string[];
  tags: ControlTag[];
  rank: string;
}

const qualifies = (mutant: RunMutantView | undefined, maxKillers: number): boolean =>
  mutant !== undefined &&
  mutant.status === 'Killed' &&
  mutant.outcome === 'killed-by-test:assertion' &&
  mutant.attempts === 1 &&
  mutant.flags.length === 0 &&
  mutant.ran !== null &&
  sameSet(mutant.killedBy, mutant.assertionKilledBy) &&
  mutant.assertionKilledBy.length >= 1 &&
  new Set(mutant.assertionKilledBy).size <= maxKillers;

/** Picks a scope's controls from its runs (one per profile); pure and order-independent. */
export function selectScopeControls(
  runs: readonly RunView[],
  options: SelectOptions,
  tagsOf: TagsOf,
): ScopeSelection {
  if (runs.length === 0) throw new Error('selection needs at least one run');
  const maps = runs.map((run) => new Map(run.mutants.map((mutant) => [mutant.globalId, mutant])));
  const inventories = runs.map(
    (run) => new Set(run.tests.filter((test) => !test.skipped).map((test) => test.id)),
  );
  const inventory = [...inventories[0]].filter((id) => inventories.every((set) => set.has(id)));

  const candidates: Candidate[] = [];
  for (const id of sortedUnique(runs[0].mutants.map((mutant) => mutant.globalId))) {
    const views = maps.map((map) => map.get(id));
    if (!views.every((view) => qualifies(view, options.maxKillers))) continue;
    const present = views.filter((view): view is RunMutantView => view !== undefined);
    const killers = sortedUnique(present[0].assertionKilledBy);
    if (!present.every((view) => sameSet(view.assertionKilledBy, killers))) continue;
    if (!killers.every((test) => inventory.includes(test))) continue;
    const ranRows = present.map((view) => view.ran ?? []);
    const passed = ranRows.map(
      (rows) => new Set(rows.filter((row) => row.outcome === 'survived').map((row) => row.id)),
    );
    const reached = new Set(ranRows.flatMap((rows) => rows.map((row) => row.id)));
    candidates.push({
      mutant: present[0],
      killers,
      ranPassed: inventory.filter((test) => passed.every((set) => set.has(test))),
      notRun: inventory.filter((test) => !reached.has(test) && !killers.includes(test)),
      tags: tagsOf(present[0]),
      rank: sampleRank(options.seed, id),
    });
  }
  const quality = (c: Candidate): [number, number, string] => [
    c.ranPassed.length > 0 ? 0 : 1,
    c.killers.length,
    c.rank,
  ];
  candidates.sort((x, y) => {
    const [qx, qy] = [quality(x), quality(y)];
    return qx[0] - qy[0] || qx[1] - qy[1] || byCodeUnits(qx[2], qy[2]);
  });

  const selected: Candidate[] = [];
  for (const tag of REQUIRED_TAGS) {
    if (selected.some((entry) => entry.tags.includes(tag))) continue;
    const pick = candidates.find((entry) => entry.tags.includes(tag) && !selected.includes(entry));
    if (pick !== undefined) selected.push(pick);
  }
  for (const entry of candidates) {
    if (selected.length >= options.perScope) break;
    if (selected.includes(entry)) continue;
    const mutators = new Set(selected.map((chosen) => chosen.mutant.mutatorName));
    const killers = new Set(selected.flatMap((chosen) => chosen.killers));
    const fresh = !mutators.has(entry.mutant.mutatorName);
    if (fresh && entry.killers.every((test) => !killers.has(test))) selected.push(entry);
  }
  for (const entry of candidates) {
    if (selected.length >= options.perScope) break;
    if (!selected.includes(entry)) selected.push(entry);
  }

  const sample = (id: string, tests: readonly string[]): string[] =>
    [...tests]
      .sort((x, y) =>
        byCodeUnits(
          sampleRank(`${options.seed}\n${id}`, x),
          sampleRank(`${options.seed}\n${id}`, y),
        ),
      )
      .slice(0, options.maxNonKillers)
      .sort(byCodeUnits);
  return {
    candidates: candidates.length,
    controls: selected
      .map(
        (entry): PlantedControl => ({
          id: entry.mutant.globalId,
          tags: entry.tags,
          static: entry.mutant.static,
          expectedKillers: entry.killers,
          expectedNonKillers: {
            ran: sample(entry.mutant.globalId, entry.ranPassed),
            notRun: sample(entry.mutant.globalId, entry.notRun),
          },
        }),
      )
      .sort((x, y) => byCodeUnits(x.id, y.id)),
  };
}

// ── planted file ───────────────────────────────────────────────────────────

export class ControlsUsageError extends Error {
  override name = 'ControlsUsageError';
}

export class ControlsInterruptedError extends Error {
  override name = 'ControlsInterruptedError';
}

const invalid = (at: string, what: string): never => {
  throw new ControlsUsageError(`planted file: ${at} ${what}`);
};

function field(data: unknown, key: string, at: string): unknown {
  if (!isRecord(data) || Array.isArray(data) || !(key in data)) {
    return invalid(`${at}.${key}`, 'is missing');
  }
  return data[key];
}

function stringField(data: unknown, key: string, at: string): string {
  const value = field(data, key, at);
  return typeof value === 'string' ? value : invalid(`${at}.${key}`, 'must be a string');
}

function integerField(data: unknown, key: string, at: string, min: number): number {
  const value = field(data, key, at);
  return typeof value === 'number' && Number.isInteger(value) && value >= min
    ? value
    : invalid(`${at}.${key}`, `must be an integer >= ${min}`);
}

function stringsField(data: unknown, key: string, at: string): string[] {
  const value = field(data, key, at);
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value.map(String)
    : invalid(`${at}.${key}`, 'must be an array of strings');
}

function arrayField(data: unknown, key: string, at: string): unknown[] {
  const value = field(data, key, at);
  return Array.isArray(value) ? value : invalid(`${at}.${key}`, 'must be an array');
}

function toTag(value: string, at: string): ControlTag {
  const tag = CONTROL_TAGS.find((entry) => entry === value);
  return tag ?? invalid(at, `has an unknown tag ${JSON.stringify(value)}`);
}

function parseControl(data: unknown, at: string): PlantedControl {
  const staticValue = field(data, 'static', at);
  if (staticValue !== null && typeof staticValue !== 'boolean') {
    invalid(`${at}.static`, 'must be a boolean or null');
  }
  const nonKillers = field(data, 'expectedNonKillers', at);
  return {
    id: stringField(data, 'id', at),
    tags: stringsField(data, 'tags', at).map((tag) => toTag(tag, `${at}.tags`)),
    static: typeof staticValue === 'boolean' ? staticValue : null,
    expectedKillers: stringsField(data, 'expectedKillers', at),
    expectedNonKillers: {
      ran: stringsField(nonKillers, 'ran', `${at}.expectedNonKillers`),
      notRun: stringsField(nonKillers, 'notRun', `${at}.expectedNonKillers`),
    },
  };
}

function parseScope(data: unknown, at: string): PlantedScope {
  const scope = field(data, 'scope', at);
  return {
    name: stringField(data, 'name', at),
    scope: {
      testFiles: stringsField(scope, 'testFiles', `${at}.scope`),
      mutate: stringsField(scope, 'mutate', `${at}.scope`),
    },
    mutants: integerField(data, 'mutants', at, 0),
    tests: integerField(data, 'tests', at, 0),
    controls: arrayField(data, 'controls', at).map((entry, index) =>
      parseControl(entry, `${at}.controls[${index}]`),
    ),
  };
}

/** Parses and validates a planted file. */
export function parsePlanted(text: string): PlantedControls {
  const data: unknown = JSON.parse(text);
  const at = 'planted';
  if (field(data, 'schemaVersion', at) !== PLANTED_SCHEMA_VERSION) {
    invalid(`${at}.schemaVersion`, `must be ${PLANTED_SCHEMA_VERSION}`);
  }
  if (field(data, 'kind', at) !== PLANTED_KIND) invalid(`${at}.kind`, `must be ${PLANTED_KIND}`);
  const selection = field(data, 'selection', at);
  const planted: PlantedControls = {
    schemaVersion: PLANTED_SCHEMA_VERSION,
    kind: PLANTED_KIND,
    description: stringField(data, 'description', at),
    reselect: stringField(data, 'reselect', at),
    profiles: arrayField(data, 'profiles', at).map((entry, index) => ({
      name: stringField(entry, 'name', `${at}.profiles[${index}]`),
      concurrency: integerField(entry, 'concurrency', `${at}.profiles[${index}]`, 1),
      maxTestRunnerReuse: integerField(entry, 'maxTestRunnerReuse', `${at}.profiles[${index}]`, 0),
    })),
    timeoutMS: integerField(data, 'timeoutMS', at, 1),
    selection: {
      seed: stringField(selection, 'seed', `${at}.selection`),
      perScope: integerField(selection, 'perScope', `${at}.selection`, 1),
      maxKillers: integerField(selection, 'maxKillers', `${at}.selection`, 1),
      maxNonKillers: integerField(selection, 'maxNonKillers', `${at}.selection`, 0),
      selectedFrom: stringsField(selection, 'selectedFrom', `${at}.selection`),
    },
    scopes: arrayField(data, 'scopes', at).map((entry, index) =>
      parseScope(entry, `${at}.scopes[${index}]`),
    ),
  };
  const duplicate = (names: string[]): string | undefined =>
    names.find((name, index) => names.indexOf(name) !== index);
  const profile = duplicate(planted.profiles.map((entry) => entry.name));
  if (profile !== undefined) invalid(`${at}.profiles`, `name ${profile} twice`);
  const scope = duplicate(planted.scopes.map((entry) => entry.name));
  if (scope !== undefined) invalid(`${at}.scopes`, `name ${scope} twice`);
  return planted;
}

export const formatPlanted = (planted: PlantedControls): string =>
  `${JSON.stringify(planted, null, 2)}\n`;

// ── gate result ────────────────────────────────────────────────────────────

export interface GateInput {
  staleRuns: number;
  /** Run problems, failed runs, selection problems and missing required tags. */
  problems: number;
  failures: readonly ControlFailure[];
  differences: number;
}

/** Stale runs first, then failures of any kind, then stale controls (re-select); pure. */
export function gateExitCode(input: GateInput): number {
  if (input.staleRuns > 0) return EXIT_USAGE;
  const failed = input.failures.some((failure) => !STALE_KINDS.has(failure.kind));
  if (input.problems > 0 || input.differences > 0 || failed) return EXIT_FAILURES;
  return input.failures.length > 0 ? EXIT_RESELECT : EXIT_PASS;
}

const RESULT_BY_EXIT: Record<number, string> = {
  [EXIT_PASS]: 'pass',
  [EXIT_FAILURES]: 'failures',
  [EXIT_USAGE]: 'stale-run',
  [EXIT_RESELECT]: 'reselect-required',
};

// ── runs (impure) ──────────────────────────────────────────────────────────

export interface RunRecord {
  profile: string;
  results: string;
  wallClockMs: number | null;
  mutants: number;
  tests: number;
  stale: string[];
  problems: string[];
}

export interface DeterminismRecord {
  profiles: [string, string];
  mutants: number;
  tests: number;
  differences: DeterminismDifference[];
}

export interface ScopeRecord {
  name: string;
  runs: RunRecord[];
  controls: { checked: number; failures: ControlFailure[] };
  determinism: DeterminismRecord[];
}

export interface ControlsReport {
  schemaVersion: 1;
  kind: typeof REPORT_KIND;
  result: string;
  exitCode: number;
  planted: string;
  requirements: {
    required: ControlTag[];
    carried: Record<string, string[]>;
    missing: ControlTag[];
  };
  scopes: ScopeRecord[];
  selectionProblems: string[];
  summary: string[];
}

function readRanTests(file: string): RanTest[] {
  const record = readJsonFile(file) as SidecarRecord;
  return record.result.tests.map((test) => ({ id: test.id, outcome: test.outcome }));
}

const isRunResults = (value: unknown): value is RunResults =>
  isRecord(value) &&
  value.schemaVersion === RESULTS_SCHEMA_VERSION &&
  Array.isArray(value.mutants) &&
  Array.isArray(value.tests) &&
  Array.isArray(value.flags);

function readResults(file: string): RunResults {
  const data = readJsonFile(file);
  if (!isRunResults(data)) {
    throw new ControlsUsageError(
      `${file} is not a results.json of schema ${RESULTS_SCHEMA_VERSION}`,
    );
  }
  return data;
}

/** Why a run cannot stand for the planted scope, profile and the checkout; empty when it can. */
function runStaleness(
  results: RunResults,
  scope: PlantedScope,
  profile: Profile,
  repoRoot: string,
  inputs: InputHashes,
): string[] {
  const reasons: string[] = [];
  if (results.variant !== 'vitest5') reasons.push(`the run used the ${results.variant} variant`);
  if (
    !sameSet(results.scope.testFiles, scope.scope.testFiles) ||
    !sameSet(results.scope.mutate, scope.scope.mutate)
  ) {
    reasons.push('the run ran another scope than the planted file');
  }
  const config = readJsonFile(results.paths.configFile);
  const concurrency = isRecord(config) ? config.concurrency : undefined;
  const reuse = isRecord(config) ? config.maxTestRunnerReuse : undefined;
  if (concurrency !== profile.concurrency || reuse !== profile.maxTestRunnerReuse) {
    reasons.push(
      `the run used concurrency ${String(concurrency)} and maxTestRunnerReuse ${String(reuse)}; ` +
        `profile ${profile.name} needs ${profile.concurrency} and ${profile.maxTestRunnerReuse}`,
    );
  }
  const mutated = new Set(scope.scope.mutate.map((entry) => entry.split(':')[0]));
  for (const mismatch of diffInputs(
    inputs,
    preparedInputs(results.paths.preparedRoot, inputs),
    mutated,
  )) {
    reasons.push(`the run was prepared from another ${mismatch.path} (${mismatch.group})`);
  }
  const hashes = new Map<string, string>();
  for (const mutant of results.mutants) {
    const at = mutant.globalId.indexOf('@');
    const hash = mutant.globalId.slice(at + 1, at + 17);
    const file = path.join(repoRoot, mutant.file);
    if (!hashes.has(mutant.file)) {
      hashes.set(mutant.file, existsSync(file) ? contentHash(readFileSync(file, 'utf8')) : '');
    }
    if (!(hashes.get(mutant.file) ?? '').startsWith(hash)) {
      reasons.push(`the run mutated another version of ${mutant.file} than the checkout's`);
      break;
    }
  }
  return reasons;
}

function runProblems(results: RunResults): string[] {
  return [
    ...(results.stryker.exitCode === 0 ? [] : [`Stryker exited with ${results.stryker.exitCode}`]),
    ...(results.spanMap.failures.length === 0
      ? []
      : [`${results.spanMap.failures.length} span-map failures`]),
    ...results.flags.map(
      (flag) =>
        `flag ${flag.kind}${flag.localId === null ? '' : ` ${flag.localId}`}: ${flag.detail}`,
    ),
  ];
}

function prepareWork(repoRoot: string, work: string, compareOnly: boolean): void {
  if (!path.isAbsolute(work)) throw new ControlsUsageError(`--work ${work} must be absolute`);
  if (isInside(repoRoot, work) || isInside(work, repoRoot)) {
    throw new ControlsUsageError(`--work ${work} must lie outside the checkout ${repoRoot}`);
  }
  const marked = existsSync(path.join(work, WORK_MARKER));
  if (compareOnly) {
    if (!marked) throw new ControlsUsageError(`--compare-only: ${work} holds no gate 4 runs`);
    return;
  }
  if (existsSync(work) && readdirSync(work).length > 0 && !marked) {
    throw new ControlsUsageError(`${work} is not empty and was not created by this tool`);
  }
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, WORK_MARKER), '');
}

/**
 * Runs `run` over `items` in order, starting an item whenever the costs of the running items plus
 * its own stay within `budget`; an item costlier than the budget runs alone. `run` must not reject.
 */
export async function runBounded<T extends { cost: number }>(
  items: readonly T[],
  budget: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  const pending = [...items];
  const running = new Set<Promise<void>>();
  let used = 0;
  while (pending.length > 0) {
    const index = pending.findIndex((item) => running.size === 0 || used + item.cost <= budget);
    if (index === -1) {
      await Promise.race(running);
      continue;
    }
    const [item] = pending.splice(index, 1);
    used += item.cost;
    const task: Promise<void> = run(item).finally(() => {
      used -= item.cost;
      running.delete(task);
    });
    running.add(task);
  }
  await Promise.all(running);
}

export interface SelectRequest {
  defines: { name: string; scopeFile: string }[];
  seed: string | undefined;
  perScope: number | undefined;
}

export interface ControlsOptions {
  repoRoot: string;
  work: string;
  plantedFile: string;
  reportFile: string;
  profiles: readonly string[];
  scopes: readonly string[];
  compareOnly: boolean;
  timeoutMS: number | undefined;
  /** Budget of Stryker workers for runs in parallel ({@link runBounded}). */
  maxWorkers: number;
  /** Aborted on SIGINT/SIGTERM: no further run starts and runControls throws. */
  signal: AbortSignal | undefined;
  select: SelectRequest | null;
  log: (line: string) => void;
}

const pick = <T extends { name: string }>(
  items: readonly T[],
  names: readonly string[],
  what: string,
): T[] => {
  const unknown = names.filter((name) => !items.some((item) => item.name === name));
  if (unknown.length > 0)
    throw new ControlsUsageError(`unknown ${what} ${JSON.stringify(unknown[0])}`);
  return names.length === 0 ? [...items] : items.filter((item) => names.includes(item.name));
};

/** The planted file a selection starts from: the current one, with `--define` scopes applied. */
function selectionBase(options: ControlsOptions, request: SelectRequest): PlantedControls {
  const current = existsSync(options.plantedFile)
    ? parsePlanted(readFileSync(options.plantedFile, 'utf8'))
    : null;
  const seed = request.seed ?? current?.selection.seed;
  if (seed === undefined) throw new ControlsUsageError('--select needs --seed (no planted file)');
  const scopes = [...(current?.scopes ?? [])];
  for (const { name, scopeFile } of request.defines) {
    const driver = parseDriverScope(readFileSync(scopeFile, 'utf8'));
    const spec: PlantedScope = {
      name,
      scope: {
        testFiles: driver.testFiles,
        mutate: driver.mutate.map(formatMutateEntry),
      },
      mutants: 0,
      tests: 0,
      controls: [],
    };
    const index = scopes.findIndex((entry) => entry.name === name);
    if (index === -1) scopes.push(spec);
    else scopes[index] = spec;
  }
  if (scopes.length === 0)
    throw new ControlsUsageError('--select needs --define (no planted file)');
  return {
    schemaVersion: PLANTED_SCHEMA_VERSION,
    kind: PLANTED_KIND,
    description: DESCRIPTION,
    reselect: RESELECT_COMMAND,
    profiles: current?.profiles ?? DEFAULT_PROFILES.map((profile) => ({ ...profile })),
    timeoutMS: options.timeoutMS ?? current?.timeoutMS ?? DEFAULT_TIMEOUT_MS,
    selection: {
      seed,
      perScope: request.perScope ?? current?.selection.perScope ?? DEFAULT_PER_SCOPE,
      maxKillers: current?.selection.maxKillers ?? DEFAULT_MAX_KILLERS,
      maxNonKillers: current?.selection.maxNonKillers ?? DEFAULT_MAX_NON_KILLERS,
      selectedFrom: current?.selection.selectedFrom ?? [],
    },
    scopes,
  };
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** Runs (or reads) the gate 4 runs, selects when asked, and checks; writes the report. */
export async function runControls(options: ControlsOptions): Promise<ControlsReport> {
  const { repoRoot, work, log } = options;
  prepareWork(repoRoot, work, options.compareOnly);
  let planted =
    options.select === null
      ? parsePlanted(readFileSync(options.plantedFile, 'utf8'))
      : selectionBase(options, options.select);
  const timeoutMS = options.timeoutMS ?? planted.timeoutMS;
  const profiles = pick(planted.profiles, options.profiles, 'profile');
  const scopes = pick(planted.scopes, options.scopes, 'scope');

  const sources = new Map<string, { text: string; ranges: Offsets[] }>();
  const tagsOf: TagsOf = (mutant) => {
    let source = sources.get(mutant.file);
    if (source === undefined) {
      const text = readFileSync(path.join(repoRoot, mutant.file), 'utf8');
      source = { text, ranges: asConstRanges(text) };
      sources.set(mutant.file, source);
    }
    return mutantTags(mutant, source.text, source.ranges);
  };

  interface Pair {
    scope: PlantedScope;
    profile: Profile;
    scopeFile: string;
    outDir: string;
    inputs: InputHashes;
    cost: number;
    runError: string | null;
  }
  const pairs: Pair[] = [];
  for (const scope of scopes) {
    const scopeFile = path.join(work, 'scopes', `${scope.name}.json`);
    mkdirSync(path.dirname(scopeFile), { recursive: true });
    writeFileSync(scopeFile, `${JSON.stringify(scope.scope, null, 2)}\n`);
    const inputs = hashInputs(inputFiles(repoRoot, scope.scope.testFiles), (repoPath) =>
      path.join(repoRoot, repoPath),
    );
    for (const profile of profiles) {
      const outDir = path.join(work, 'runs', scope.name, profile.name);
      const cost = profile.concurrency;
      pairs.push({ scope, profile, scopeFile, outDir, inputs, cost, runError: null });
    }
  }
  if (!options.compareOnly) {
    await runBounded(pairs, options.maxWorkers, async (pair) => {
      const { scope, profile, outDir } = pair;
      if (options.signal?.aborted === true) return;
      const started = performance.now();
      log(
        `gate 4: ${scope.name} / ${profile.name}: running (concurrency ${profile.concurrency}, ` +
          `maxTestRunnerReuse ${profile.maxTestRunnerReuse}); log ${path.join(outDir, 'stryker.log')}`,
      );
      try {
        await runScope({
          repoRoot,
          scopeFile: pair.scopeFile,
          outDir,
          variant: 'vitest5',
          concurrency: profile.concurrency,
          maxTestRunnerReuse: profile.maxTestRunnerReuse,
          timeoutMS,
          command: undefined,
        });
      } catch (error) {
        pair.runError = errorMessage(error);
      }
      log(
        `gate 4: ${scope.name} / ${profile.name}: done in ${seconds(performance.now() - started)}`,
      );
    });
    if (options.signal?.aborted === true) throw new ControlsInterruptedError('gate 4 interrupted');
  }

  const records = new Map<string, RunRecord[]>();
  const views = new Map<string, RunView[]>();
  for (const { scope, profile, outDir, inputs, runError } of pairs) {
    const resultsFile = path.join(outDir, 'results.json');
    const record: RunRecord = {
      profile: profile.name,
      results: resultsFile,
      wallClockMs: null,
      mutants: 0,
      tests: 0,
      stale: [],
      problems: runError === null ? [] : [`run failed: ${runError}`],
    };
    if (existsSync(resultsFile)) {
      const results = readResults(resultsFile);
      record.wallClockMs = results.stryker.wallClockMs;
      record.mutants = results.mutants.length;
      record.tests = results.tests.filter((test) => !test.skipped).length;
      record.stale = runStaleness(results, scope, profile, repoRoot, inputs);
      record.problems.push(...runProblems(results));
      if (record.stale.length === 0) {
        const view: RunView = {
          profile: profile.name,
          tests: results.tests.map((test) => ({ id: test.id, skipped: test.skipped })),
          mutants: results.mutants.map((mutant) => mutantView(mutant, readRanTests)),
        };
        views.set(scope.name, [...(views.get(scope.name) ?? []), view]);
      }
    } else if (record.problems.length === 0) {
      record.problems.push(`no results at ${resultsFile}`);
    }
    records.set(scope.name, [...(records.get(scope.name) ?? []), record]);
    log(
      `gate 4: ${scope.name} / ${profile.name}: ${record.mutants} mutants, ${record.tests} tests` +
        `${record.wallClockMs === null ? '' : `, Stryker ${seconds(record.wallClockMs)}`}` +
        `${record.stale.length + record.problems.length === 0 ? '' : `; ${record.stale.length} stale, ${record.problems.length} problems`}`,
    );
  }

  const selectionProblems: string[] = [];
  if (options.select !== null) {
    const selectOptions: SelectOptions = {
      seed: planted.selection.seed,
      perScope: planted.selection.perScope,
      maxKillers: planted.selection.maxKillers,
      maxNonKillers: planted.selection.maxNonKillers,
    };
    const selected = new Map<string, PlantedScope>();
    for (const scope of scopes) {
      const runs = views.get(scope.name) ?? [];
      const unusable = (records.get(scope.name) ?? []).some(
        (record) => record.stale.length > 0 || record.problems.length > 0,
      );
      if (unusable || runs.length !== profiles.length) {
        selectionProblems.push(`${scope.name}: not every run is usable; nothing selected`);
        continue;
      }
      const selection = selectScopeControls(runs, selectOptions, tagsOf);
      if (selection.controls.length === 0) selectionProblems.push(`${scope.name}: no candidate`);
      selected.set(scope.name, {
        ...scope,
        mutants: runs[0].mutants.length,
        tests: runs[0].tests.filter((test) => !test.skipped).length,
        controls: selection.controls,
      });
      log(
        `gate 4: ${scope.name}: ${selection.candidates} candidates, ` +
          `${selection.controls.length} controls selected`,
      );
    }
    planted = {
      ...planted,
      timeoutMS,
      selection: { ...planted.selection, selectedFrom: profiles.map((profile) => profile.name) },
      scopes: planted.scopes.map((scope) => selected.get(scope.name) ?? scope),
    };
    writeFileSync(path.join(work, 'planted.json'), formatPlanted(planted));
    if (selectionProblems.length === 0 && checkRequirements(planted).length === 0) {
      mkdirSync(path.dirname(options.plantedFile), { recursive: true });
      writeFileSync(options.plantedFile, formatPlanted(planted));
      log(`gate 4: planted controls written to ${options.plantedFile}`);
    }
  }

  const plantedScopes = new Map(planted.scopes.map((scope) => [scope.name, scope]));
  const scopeRecords: ScopeRecord[] = scopes.map((entry) => {
    const scope = plantedScopes.get(entry.name) ?? entry;
    const runs = views.get(scope.name) ?? [];
    const failures = runs.flatMap((run) => checkControls(scope, run, tagsOf));
    const determinism = runs.slice(1).map(
      (other): DeterminismRecord => ({
        profiles: [runs[0].profile, other.profile],
        mutants: new Set([...runs[0].mutants, ...other.mutants].map((m) => m.globalId)).size,
        tests: new Set([...runs[0].tests, ...other.tests].map((t) => t.id)).size,
        differences: compareDeterminism(runs[0], other),
      }),
    );
    return {
      name: scope.name,
      runs: records.get(scope.name) ?? [],
      controls: { checked: scope.controls.length * runs.length, failures },
      determinism,
    };
  });

  const missing = checkRequirements(planted);
  const carried: Record<string, string[]> = Object.fromEntries(
    REQUIRED_TAGS.map((tag) => [
      tag,
      planted.scopes.flatMap((scope) =>
        scope.controls.filter((control) => control.tags.includes(tag)).map((control) => control.id),
      ),
    ]),
  );
  const allRuns = scopeRecords.flatMap((scope) => scope.runs);
  const failures = scopeRecords.flatMap((scope) => scope.controls.failures);
  const differences = scopeRecords.flatMap((scope) =>
    scope.determinism.flatMap((entry) => entry.differences),
  );
  const exitCode = gateExitCode({
    staleRuns: allRuns.filter((run) => run.stale.length > 0).length,
    problems:
      allRuns.reduce((sum, run) => sum + run.problems.length, 0) +
      selectionProblems.length +
      missing.length,
    failures,
    differences: differences.length,
  });
  const report: ControlsReport = {
    schemaVersion: 1,
    kind: REPORT_KIND,
    result: RESULT_BY_EXIT[exitCode] ?? 'failures',
    exitCode,
    planted: options.plantedFile,
    requirements: { required: [...REQUIRED_TAGS], carried, missing },
    scopes: scopeRecords,
    selectionProblems,
    summary: [],
  };
  report.summary = summarise(report);
  mkdirSync(path.dirname(options.reportFile), { recursive: true });
  writeFileSync(options.reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const LISTED = 20;

/** The printed lines of a report. */
export function summarise(report: ControlsReport): string[] {
  const lines: string[] = [];
  for (const scope of report.scopes) {
    const controls = scope.controls;
    lines.push(
      `gate 4: ${scope.name}: controls ${controls.checked} checks (controls x runs), ` +
        `${controls.failures.length} failures`,
    );
    for (const run of scope.runs) {
      for (const reason of run.stale) lines.push(`  ${run.profile}: stale run: ${reason}`);
      for (const problem of run.problems.slice(0, LISTED)) {
        lines.push(`  ${run.profile}: run problem: ${problem}`);
      }
    }
    for (const failure of controls.failures.slice(0, LISTED)) {
      lines.push(
        `  ${failure.profile}: ${failure.kind} ${failure.control}` +
          `${failure.test === null ? '' : ` test ${failure.test}`}: ${failure.detail}`,
      );
    }
    for (const entry of scope.determinism) {
      lines.push(
        `gate 4: ${scope.name}: determinism ${entry.profiles.join(' vs ')}: ${entry.mutants} ` +
          `mutants, ${entry.tests} tests compared, ${entry.differences.length} differences`,
      );
      for (const diff of entry.differences.slice(0, LISTED)) {
        lines.push(
          `  ${diff.kind}${diff.mutant === null ? '' : ` ${diff.mutant}`}` +
            `${diff.test === null ? '' : ` test ${diff.test}`}: ${diff.detail}`,
        );
      }
    }
    if (scope.determinism.length === 0) {
      lines.push(`gate 4: ${scope.name}: determinism not compared (fewer than two usable runs)`);
    }
  }
  for (const problem of report.selectionProblems) lines.push(`gate 4: selection: ${problem}`);
  const carried = report.requirements.required.map(
    (tag) => `${tag} (${report.requirements.carried[tag]?.length ?? 0} controls)`,
  );
  lines.push(`gate 4: required tags: ${carried.join(', ')}`);
  for (const tag of report.requirements.missing) {
    lines.push(`gate 4: no control carries the required tag ${tag} (KTD19); re-select`);
  }
  lines.push(`gate 4: ${report.result} (exit ${report.exitCode})`);
  return lines;
}

// ── CLI ────────────────────────────────────────────────────────────────────

const USAGE =
  'usage: npm run test:mutation:controls -- --work <dir> [--planted <file>] ' +
  '[--profile <name>]... [--scope <name>]... [--compare-only] [--timeout-ms <n>] ' +
  '[--max-workers <n>] [--report <file>] [--select [--define <name>=<driver scope.json>]... [--seed <seed>] ' +
  '[--per-scope <n>]]';

const parseInteger = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new ControlsUsageError(`--${name} must be a positive integer, got ${value}`);
  }
  return Number(value);
};

/** Parses the CLI arguments; relative paths resolve against `cwd`. */
export function parseControlsArgs(
  argv: readonly string[],
  cwd: string,
  repoRoot: string,
  log: (line: string) => void,
): ControlsOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      work: { type: 'string' },
      planted: { type: 'string' },
      report: { type: 'string' },
      profile: { type: 'string', multiple: true, default: [] },
      scope: { type: 'string', multiple: true, default: [] },
      'compare-only': { type: 'boolean', default: false },
      'timeout-ms': { type: 'string' },
      'max-workers': { type: 'string' },
      select: { type: 'boolean', default: false },
      define: { type: 'string', multiple: true, default: [] },
      seed: { type: 'string' },
      'per-scope': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.work === undefined) throw new ControlsUsageError('--work is required');
  const selectOnly = values.define.length > 0 || values.seed !== undefined;
  if (!values.select && (selectOnly || values['per-scope'] !== undefined)) {
    throw new ControlsUsageError('--define, --seed and --per-scope need --select');
  }
  const work = path.resolve(cwd, values.work);
  return {
    repoRoot,
    work,
    plantedFile: path.resolve(
      cwd,
      values.planted ?? path.join(repoRoot, PACKAGE_DIR, PLANTED_FILE),
    ),
    reportFile: path.resolve(cwd, values.report ?? path.join(work, 'controls-report.json')),
    profiles: values.profile,
    scopes: values.scope,
    compareOnly: values['compare-only'],
    timeoutMS: parseInteger(values['timeout-ms'], 'timeout-ms'),
    maxWorkers: parseInteger(values['max-workers'], 'max-workers') ?? DEFAULT_MAX_WORKERS,
    select: values.select
      ? {
          defines: values.define.map((entry) => {
            const at = entry.indexOf('=');
            if (at <= 0) throw new ControlsUsageError(`--define ${entry}: expected <name>=<file>`);
            return { name: entry.slice(0, at), scopeFile: path.resolve(cwd, entry.slice(at + 1)) };
          }),
          seed: values.seed,
          perScope: parseInteger(values['per-scope'], 'per-scope'),
        }
      : null,
    log,
    signal: undefined,
  };
}

async function main(): Promise<void> {
  const packageDir = fileURLToPath(new URL('../../../', import.meta.url));
  const repoRoot = path.dirname(path.resolve(packageDir));
  const started = performance.now();
  try {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    const parsed = parseControlsArgs(process.argv.slice(2), process.cwd(), repoRoot, (line) =>
      console.log(line),
    );
    const options = { ...parsed, signal: controller.signal };
    const report = await runControls(options);
    for (const line of report.summary) console.log(line);
    console.log(
      `gate 4: total ${seconds(performance.now() - started)}; report ${options.reportFile}`,
    );
    process.exitCode = report.exitCode;
  } catch (error) {
    console.error(errorMessage(error));
    if (error instanceof ControlsUsageError || error instanceof TypeError) console.error(USAGE);
    process.exitCode = error instanceof ControlsInterruptedError ? EXIT_INTERRUPTED : EXIT_USAGE;
  }
}

if (isMainModule(import.meta.url)) {
  void main();
}
