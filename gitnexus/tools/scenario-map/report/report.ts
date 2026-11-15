/**
 * The scenario map report (U13, R12, R13, KTD13, KTD15, design §5.4, §5.5, §7, §8): one JSON
 * artifact ({@link ScenarioMapReport}) that markdown.ts renders for humans and issue-body.ts turns
 * into the tracking issue body.
 *
 * {@link buildReport} is pure: plain data in ({@link ReportInput}, assembled by the CLI from the
 * stage artifacts and the U12 verdict report), plain data out, sorted, so the same input gives a
 * byte-identical report. It carries:
 *  - `schemaVersion` (types.ts `SCENARIO_MAP_SCHEMA_VERSION`; a baseline with another version is
 *    incompatible) and the verdict-engine version;
 *  - run provenance: the design §7 cache-key inputs (KTD15: no result cache in Phase 1, but a later
 *    one has its keys) from {@link collectProvenance}, plus the universe ids, the operator set and
 *    the mutant-fingerprint fallbacks, and the run's seed;
 *  - completeness: shards planned and complete, partial, and every value-flow degraded flag;
 *  - the R1 eligibility delta and the Layer 0 findings (test-dupes `--json`) on eligible files;
 *  - the scenario fingerprint verdict of every candidate pair (verdict/fingerprint.ts: same path,
 *    input and expectation), with its continuity key, and the run's mutation scope;
 *  - every mutation pair verdict and kept pair with its evidence (U12), its continuity key, its
 *    KTD13 universe id and its evidence hash; every test's properties; the per-file gaps (empty
 *    when the mutation scope is `none`);
 *  - the design §8 spot audit: 10 fingerprint duplicates (all when fewer), ordered by sha256 of
 *    the seed and the pair's continuity key, so the same seed picks the same pairs;
 *  - "N of M eligible tests evaluated" and the scoped limits, the precision-not-measured statement
 *    first;
 *  - change status against the previous complete run (baseline.ts).
 *
 * Evidence hash (design §5.5; anchors.ts `evidenceHash`): fingerprints only, never a revision, a
 * line or a group. For a pair, per test: the canonical path (fingerprints of the mutants it covers
 * in the pair's group run), provenance, checks-and-context key, facet (fingerprint, discarded
 * values without location, unresolved inputs), kills over the common universe, runner-validation
 * status (eligible, oracle-validated, join problems, unsupported forms, unresolved inputs),
 * exclusions (excluded files, dupe-ok reason) and the weak disqualifiers that name it; the two test
 * records are sorted, so the pair's orientation does not matter. For the pair: the KTD13 universe
 * id, the row-deletion outcome, the validity status (schedule, unknown and other-class counts,
 * isolation, trace, static value flow, every Inconclusive cause, the stage relations), the verdict,
 * the deciding rule, the pair-level disqualifiers and the engine version. A test's hash covers the
 * same per-test inputs over all its group runs plus its status, reasons, subsumption and
 * statements; a gap item's the fingerprints of its survived, uncovered and inconclusive mutants.
 *
 * Library only; {@link collectProvenance} is the one function that reads the file system. The
 * scenario-map CLI (U14) assembles the input and writes the artifacts.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile } from '../../mutation/shared/fs.js';
import type { Finding, Kind } from '../../test-dupes/test-dupes.js';
import type { CoverageInventory } from '../inventory/coverage-inventory.js';
import {
  MAIN_LINEAGE,
  comparePair,
  indexObservations,
  lineageOf,
  mutantsOf,
  observedMutants as observedMutantsOf,
  type LineageObservations,
  type MergedObservation,
  type PairComparison,
  type RunKey,
} from '../mutation/observations.js';
import {
  SCENARIO_MAP_SCHEMA_VERSION,
  fromPackagePath,
  toPackagePath,
  type Eligibility,
  type EligibilityDelta,
  type MutationScope,
  type TestAnchor,
} from '../types.js';
import { byText, isRecord, sha256, sortedUnique } from '../util.js';
import type { DegradedFlag } from '../value-flow/pdg-walk.js';
import {
  FINGERPRINT_VERDICTS,
  type FingerprintPair,
  type FingerprintReport,
  type FingerprintVerdict,
} from '../verdict/fingerprint.js';
import {
  VERDICT_PRECEDENCE,
  WORDING,
  type FileGaps,
  type PairVerdict,
  type TestResult,
  type TestStatus,
  type Verdict,
  type VerdictInput,
  type VerdictReport,
  type VerdictTestInput,
} from '../verdict/verdict.js';
import {
  FINGERPRINT_FALLBACKS,
  evidenceHash,
  fallbackAnchor,
  fingerprintOf,
  parseGlobalMutantId,
  universeIdOf,
  type FingerprintFallback,
  type JsonValue,
  type MutantFingerprints,
} from './anchors.js';
import {
  compareWithBaseline,
  itemKey,
  type BaselineComparison,
  type ChangeStatus,
  type ContinuityItem,
  type ContinuitySection,
} from './baseline.js';

export const SPOT_AUDIT_SIZE = 10;

export const PRECISION_NOT_MEASURED =
  'Precision not measured: no duplicate or strong repeat candidate has been independently ' +
  'adjudicated (design §8), so each one is a lead for human scenario review, never a removal ' +
  'suggestion.';

/** The limits every report states (design §5.4, §8, R1), after {@link PRECISION_NOT_MEASURED}. */
export const LIMITS: readonly string[] = Object.freeze([
  PRECISION_NOT_MEASURED,
  'Observed stability only: two passing baselines show observed stability, not absence of ' +
    'flakiness (design §5.4).',
  `Scoped claims: "${WORDING.weak}", "${WORDING.subsumed}", "${WORDING.survived}" and ` +
    `"${WORDING.uncovered}" hold over the evaluated mutant universe only; survived mutants ` +
    'include equivalent mutants.',
  'Eligible category only: the pure-JS unit tests validated in Phase 0 (R1); every other test ' +
    'is out of scope. The report never edits, deletes or folds a test (R15).',
]);

// ── Provenance (KTD15, design §7) ──────────────────────────────────────────

/** Repo paths of the Vitest and Stryker config inputs of a run. */
export const DEFAULT_CONFIG_FILES: readonly string[] = Object.freeze([
  'gitnexus/vitest.config.ts',
  'gitnexus/tools/mutation/vitest.mutation.config.ts',
  'gitnexus/tools/mutation/driver/stryker-config.ts',
  'gitnexus-shared/package.json',
]);
export const DEFAULT_LOCKFILES: readonly string[] = Object.freeze([
  'gitnexus/package-lock.json',
  'gitnexus-shared/package-lock.json',
]);
/** The vitest5 runner's modules; their hashes are the runner version. */
const RUNNER_DIR = 'gitnexus/tools/mutation/runner';
const ABSENT = 'absent';
/** `GITNEXUS_*` names whose values never enter the report. */
const SECRET_ENV = /(^|_)(API_KEY|KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIALS?)(_|$)/;
export const REDACTED = '<redacted>';

export interface ProvenanceOptions {
  repoRoot: string;
  /** Package paths of the eligible test files. */
  testFiles: readonly string[];
  /** Repo paths of the production files of every mutate scope. */
  productionFiles: readonly string[];
  /** Repo paths of the fixture files the tests read. */
  fixtureFiles: readonly string[];
  /** The checkout's commit; null when unknown. */
  sourceRevision: string | null;
  /** Default {@link DEFAULT_CONFIG_FILES}. */
  configFiles?: readonly string[];
  /** Default {@link DEFAULT_LOCKFILES}. */
  lockfiles?: readonly string[];
  /** Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Default `process.version`. */
  node?: string;
  /** Default `<platform> <release> <arch>`. */
  os?: string;
}

/** What {@link collectProvenance} reads: path → sha256 hex, or `absent`. */
export interface CollectedProvenance {
  sourceRevision: string | null;
  files: {
    /** Package path → hash. */
    tests: Record<string, string>;
    /** Repo path → hash. */
    production: Record<string, string>;
    /** Repo path → hash. */
    fixtures: Record<string, string>;
  };
  lockfiles: Record<string, string>;
  /** The Stryker and Vitest config used for the run (repo path → hash). */
  configs: Record<string, string>;
  versions: {
    vitest: string | null;
    stryker: string | null;
    typescript: string | null;
    /** sha256 over the runner modules' hashes: the in-repo runner has no version number. */
    runner: string;
  };
  runtime: {
    node: string;
    os: string;
    /** `GITNEXUS_*` variables, sorted; secret-looking ones {@link REDACTED}. */
    env: Record<string, string>;
  };
}

export interface RunProvenance extends CollectedProvenance {
  /**
   * The Stryker `mutator` option and the operators the run's mutants show. The generated config
   * never sets `mutator` (driver/stryker-config.ts), so it is null: Stryker's default set.
   */
  operators: { mutator: null; names: string[] };
  /** KTD13 universe ids of every evaluated pair, sorted and distinct. */
  universes: string[];
  mutants: {
    total: number;
    /** Mutants named by their revision-pinned id instead of a continuity fingerprint. */
    fallbacks: Record<FingerprintFallback, number>;
  };
}

function hashFiles(repoRoot: string, repoPaths: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    sortedUnique(repoPaths).map((repoPath) => {
      const file = path.join(repoRoot, repoPath);
      return [repoPath, existsSync(file) ? sha256(readFileSync(file)) : ABSENT];
    }),
  );
}

function packageVersion(repoRoot: string, name: string): string | null {
  const file = path.join(repoRoot, 'gitnexus', 'node_modules', name, 'package.json');
  if (!existsSync(file)) return null;
  const data = readJsonFile(file);
  const version =
    typeof data === 'object' && data !== null && 'version' in data ? data.version : null;
  return typeof version === 'string' ? version : null;
}

/** Reads the KTD15 inputs of a run; the only function of this module that touches the disk. */
export function collectProvenance(options: ProvenanceOptions): CollectedProvenance {
  const { repoRoot } = options;
  const testHashes = hashFiles(repoRoot, options.testFiles.map(fromPackagePath));
  const runnerDir = path.join(repoRoot, RUNNER_DIR);
  const runnerModules = existsSync(runnerDir)
    ? readdirSync(runnerDir)
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
        .map((name) => `${RUNNER_DIR}/${name}`)
    : [];
  const env = options.env ?? process.env;
  return {
    sourceRevision: options.sourceRevision,
    files: {
      tests: Object.fromEntries(
        Object.entries(testHashes).map(([repoPath, hash]) => [toPackagePath(repoPath), hash]),
      ),
      production: hashFiles(repoRoot, options.productionFiles),
      fixtures: hashFiles(repoRoot, options.fixtureFiles),
    },
    lockfiles: hashFiles(repoRoot, options.lockfiles ?? DEFAULT_LOCKFILES),
    configs: hashFiles(repoRoot, options.configFiles ?? DEFAULT_CONFIG_FILES),
    versions: {
      vitest: packageVersion(repoRoot, 'vitest'),
      stryker: packageVersion(repoRoot, '@stryker-mutator/core'),
      typescript: packageVersion(repoRoot, 'typescript'),
      runner: sha256(JSON.stringify(Object.entries(hashFiles(repoRoot, runnerModules)))),
    },
    runtime: {
      node: options.node ?? process.version,
      os: options.os ?? `${os.platform()} ${os.release()} ${os.arch()}`,
      env: Object.fromEntries(
        Object.keys(env)
          .filter((name) => name.startsWith('GITNEXUS_') && env[name] !== undefined)
          .sort(byText)
          .map((name) => [name, SECRET_ENV.test(name) ? REDACTED : (env[name] ?? '')]),
      ),
    },
  };
}

// ── Input ──────────────────────────────────────────────────────────────────

export interface RunInfo {
  /** GitHub Actions run id (decimal), or a local label. */
  id: string;
  attempt: number;
  url: string | null;
  /** The ref the run checked out; null when unknown. */
  ref: string | null;
  /** R13: only complete default-branch runs update the tracking issue. */
  defaultBranch: boolean;
}

export interface ShardStatus {
  planned: number;
  complete: number;
  /** Shards (and the value-flow job) without a usable result, sorted by shard. */
  incomplete: { shard: string; reason: string }[];
}

export interface ReportInput {
  run: RunInfo;
  /** The seed of every sampled choice of the run (spot audit). */
  seed: string;
  provenance: CollectedProvenance;
  eligibility: Eligibility;
  /** All collected runtime cases, including tests that formed no candidate pair. */
  inventory?: CoverageInventory;
  /** How many test files Layer 1 was given (every fingerprint file for a whole-suite run). */
  layer1Files: number;
  /** How many of them wrote no record: a failed run, or a coverage slice that did not report. */
  unrecordedFiles: number;
  /** A diff-scoped run's changed test files (E8); null for the whole suite. */
  changedFiles: readonly string[] | null;
  /**
   * Layer 1 tests without a result to fingerprint: `skipped` (skip, skipIf, todo, such as the
   * `GITNEXUS_BENCH` benchmark suites) and `unfinished` (pending: their file's run ended first).
   */
  notRun: { skipped: number; unfinished: number };
  /** Phase 0 ids of every eligible test (the M of "N of M evaluated"). */
  eligibleTests: readonly string[];
  shards: ShardStatus;
  /** test-dupes `--json` output over the checkout; null when the scan did not run. */
  layer0: unknown;
  /** The inputs the verdicts were computed from (U12 `VerdictInput`). */
  evidence: VerdictInput;
  /** The fingerprint verdicts of every candidate pair (verdict/fingerprint.ts). */
  fingerprint: FingerprintReport;
  /** How much mutation evidence the run gathered; `verdicts` covers only the mutated pairs. */
  mutation: MutationScope;
  verdicts: VerdictReport;
  /** U3 anchor per test id; a missing or null anchor falls back to the execution identity. */
  anchors: ReadonlyMap<string, TestAnchor | null>;
  /** anchors.ts `fingerprintMutants` over every observed mutant. */
  fingerprints: MutantFingerprints;
  /** The previous complete run's report (parsed JSON); null when there is none. */
  baseline: unknown;
}

// ── Output ─────────────────────────────────────────────────────────────────

export interface Completeness {
  /** Every planned shard and the value-flow job produced a usable result. */
  complete: boolean;
  partial: boolean;
  shards: ShardStatus;
  /** Value-flow degraded flags (U10), sorted. */
  degraded: DegradedFlag[];
}

export interface ReportSummary {
  /** M: eligible tests. */
  eligibleTests: number;
  /** N: eligible tests evaluated by a trusted Layer 3 group run. */
  evaluatedTests: number;
  /** "N of M eligible tests evaluated". */
  evaluated: string;
  pairs: number;
  kept: number;
  byVerdict: Record<Verdict, number>;
  testsByStatus: Record<TestStatus, number>;
  subsumed: number;
  subsumptionUnknown: number;
  /** Production files with a survived or uncovered mutant. */
  gapFiles: number;
  survived: number;
  uncovered: number;
  inconclusiveMutants: number;
}

export interface Layer0Section {
  /** False when no scan output was given. */
  available: boolean;
  scanned: number | null;
  /** Findings whose file is eligible, sorted by file and line. */
  findings: Finding[];
  /** Eligible files the scan could not parse. */
  skipped: string[];
}

export interface ReportPair extends PairVerdict {
  /** Continuity key (baseline.ts `itemKey`). */
  key: string;
  /** Anchor keys of the two tests. */
  members: { a: string; b: string };
  /** KTD13: id and size of the common universe, from mutant fingerprints. */
  universe: { id: string | null; size: number };
  evidenceHash: string;
  /** Null when the baseline is incompatible. */
  change: ChangeStatus | null;
}

export interface TestProperties {
  eligible: boolean;
  notOracleValidated: boolean;
  dupeOk: string | null;
  joinProblems: string[];
  checksContext: string | null;
  facet: string | null;
  unresolved: string[];
  unsupportedForms: string[];
  provenance: { known: boolean; nativeEntries: string[]; workerSpawns: string[] } | null;
  concurrent: boolean;
  excludedFiles: string[];
}

export interface ReportTest extends TestResult {
  key: string;
  anchor: TestAnchor;
  /** Evaluated by a trusted Layer 3 group run. */
  evaluated: boolean;
  /** KTD13 id of the universe of the test's group runs. */
  universeId: string | null;
  properties: TestProperties;
  evidenceHash: string;
  change: ChangeStatus | null;
}

export interface ReportGap extends FileGaps {
  key: string;
  evidenceHash: string;
  change: ChangeStatus | null;
}

export interface SpotAuditPick {
  key: string;
  a: string;
  b: string;
}

export interface SpotAudit {
  seed: string;
  size: number;
  method: string;
  /** Fingerprint duplicates to pick from. */
  candidates: number;
  picks: SpotAuditPick[];
}

/** A fingerprint verdict with its continuity key and its members' anchor keys. */
export interface ReportFingerprintPair extends FingerprintPair {
  key: string;
  members: { a: string; b: string };
}

export interface FingerprintSection {
  engineVersion: number;
  byVerdict: Record<FingerprintVerdict, number>;
  pairs: ReportFingerprintPair[];
  kept: ReportFingerprintPair[];
}

export interface ScenarioMapReport {
  inventory: CoverageInventory | null;
  schemaVersion: number;
  engineVersion: number;
  run: RunInfo;
  seed: string;
  provenance: RunProvenance;
  completeness: Completeness;
  summary: ReportSummary;
  /** How much mutation evidence the run gathered. */
  mutation: MutationScope;
  fingerprint: FingerprintSection;
  /** {@link LIMITS}, plus a fingerprint-fallback note when one applies. */
  limits: string[];
  eligibility: {
    mode: Eligibility['mode'];
    /** The mutation-eligible test files. */
    files: string[];
    /** How many test files the fingerprint covers. */
    fingerprintFiles: number;
    /**
     * How many of them Layer 1 ran. A diff scope can select fewer; omitted tests were not compared.
     */
    layer1Files: number;
    /** How many of those wrote no record (a failed run, or a coverage slice that did not report). */
    unrecordedFiles: number;
    /** A diff-scoped run's changed test files: every pair has a test of one. Null: whole suite. */
    changedFiles: string[] | null;
    /** Layer 1 tests without a fingerprint: skipped at run time, or never finished. */
    notRun: { skipped: number; unfinished: number };
    delta: EligibilityDelta | null;
  };
  layer0: Layer0Section;
  pairs: ReportPair[];
  kept: ReportPair[];
  tests: ReportTest[];
  gaps: ReportGap[];
  spotAudit: SpotAudit;
  changes: BaselineComparison;
  continuity: ContinuitySection;
}

// ── Layer 0 ────────────────────────────────────────────────────────────────

const LAYER0_KINDS: readonly string[] = [
  'same-test',
  'assertions-pinned',
  'same-fixture-setup',
  'copied-helper',
  'orphan-bench-gate',
] satisfies Kind[];

const isKind = (value: unknown): value is Kind =>
  typeof value === 'string' && LAYER0_KINDS.includes(value);
const isLine = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;

function readLocation(value: unknown): { file: string; line: number } | null {
  return isRecord(value) && typeof value.file === 'string' && isLine(value.line)
    ? { file: value.file, line: value.line }
    : null;
}

function readFinding(value: unknown): Finding | null {
  if (!isRecord(value) || !isKind(value.kind) || typeof value.detail !== 'string') return null;
  const at = readLocation(value);
  if (at === null || !Array.isArray(value.matches)) return null;
  const matches = value.matches.map(readLocation);
  if (!matches.every((match) => match !== null)) return null;
  return { kind: value.kind, ...at, matches, detail: value.detail };
}

/** The test-dupes `--json` findings on eligible files (repo paths). */
export function layer0Section(scan: unknown, eligibleFiles: ReadonlySet<string>): Layer0Section {
  if (!isRecord(scan) || !Array.isArray(scan.findings)) {
    return { available: false, scanned: null, findings: [], skipped: [] };
  }
  const findings = scan.findings
    .map(readFinding)
    .filter((finding): finding is Finding => finding !== null && eligibleFiles.has(finding.file))
    .sort((x, y) => byText(x.file, y.file) || x.line - y.line || byText(x.kind, y.kind));
  const skipped = Array.isArray(scan.skipped)
    ? scan.skipped.filter(
        (file): file is string => typeof file === 'string' && eligibleFiles.has(file),
      )
    : [];
  return {
    available: true,
    scanned: typeof scan.scanned === 'number' ? scan.scanned : null,
    findings,
    skipped: sortedUnique(skipped),
  };
}

// ── Spot audit (design §8) ─────────────────────────────────────────────────

export const SPOT_AUDIT_METHOD = 'ascending sha256 of [seed, continuity key]';

/** Picks `size` candidates (all when fewer) in seeded order; see the module comment. */
export function spotAudit(
  candidates: readonly SpotAuditPick[],
  seed: string,
  size: number = SPOT_AUDIT_SIZE,
): SpotAudit {
  const ranked = candidates
    .map((pick) => ({ pick, rank: sha256(JSON.stringify([seed, pick.key])) }))
    .sort((x, y) => byText(x.rank, y.rank) || byText(x.pick.key, y.pick.key));
  return {
    seed,
    size,
    method: SPOT_AUDIT_METHOD,
    candidates: candidates.length,
    picks: ranked.slice(0, size).map(({ pick }) => ({ ...pick })),
  };
}

// ── Evidence records ───────────────────────────────────────────────────────

const ASSERTION_KILL = 'killed-by-test:assertion';
const exposed = (entry: MergedObservation): boolean =>
  entry.covered || entry.static || entry.sources.includes('row');

function propertiesOf(input: VerdictTestInput | undefined): TestProperties {
  if (input === undefined) {
    return {
      eligible: false,
      notOracleValidated: false,
      dupeOk: null,
      joinProblems: [],
      checksContext: null,
      facet: null,
      unresolved: ['no verdict input'],
      unsupportedForms: [],
      provenance: null,
      concurrent: false,
      excludedFiles: [],
    };
  }
  return {
    eligible: input.eligible,
    notOracleValidated: input.notOracleValidated,
    dupeOk: input.dupeOk,
    joinProblems: sortedUnique(input.joinProblems),
    checksContext: input.checksContext,
    facet: input.facet?.fingerprint ?? null,
    unresolved: sortedUnique([
      ...(input.facet?.unresolved ?? []),
      ...input.inventoryUnresolved,
      ...input.unresolvedSelectors.map((name) => `selector ${name}`),
    ]),
    unsupportedForms: sortedUnique(
      input.unsupportedForms.map((form) => `${form.form} (${form.reason})`),
    ),
    provenance:
      input.provenance === null
        ? null
        : {
            known: input.provenance.known,
            nativeEntries: sortedUnique(input.provenance.nativeEntries),
            workerSpawns: sortedUnique(
              input.provenance.workerSpawns.map((spawn) => `${spawn.api} ${spawn.target}`),
            ),
          },
    concurrent: input.concurrent,
    excludedFiles: sortedUnique(input.excludedFiles),
  };
}

/** The per-test part of an evidence record: line-free, revision-free. */
function testRecord(
  input: VerdictTestInput | undefined,
  properties: TestProperties,
  pathFingerprints: readonly string[],
  kills: readonly string[],
): { [key: string]: JsonValue } {
  return {
    path: [...pathFingerprints],
    provenance: properties.provenance,
    concurrent: properties.concurrent,
    checksContext: properties.checksContext,
    facet:
      input?.facet == null
        ? null
        : {
            fingerprint: input.facet.fingerprint,
            discarded: input.facet.discarded.map((value) => [
              value.position,
              value.kind,
              value.value,
              value.origin,
            ]),
          },
    kills: [...kills],
    validation: {
      eligible: properties.eligible,
      notOracleValidated: properties.notOracleValidated,
      joinProblems: properties.joinProblems,
      unsupportedForms: properties.unsupportedForms,
      unresolved: properties.unresolved,
    },
    exclusions: { excludedFiles: properties.excludedFiles, dupeOk: properties.dupeOk },
  };
}

// ── Build ──────────────────────────────────────────────────────────────────

const isMain = (run: RunKey): boolean => run.kind === 'main' && run.lineage === MAIN_LINEAGE;

/** A test's explicit observations in a lineage (an implied one is never on a path or a kill). */
const explicitOf = (view: LineageObservations | undefined, test: string): MergedObservation[] => [
  ...(view?.explicit.get(test)?.values() ?? []),
];

/** How often each key occurs among the values, in key order (one pass). */
function countBy<K extends string>(keys: readonly K[], values: readonly K[]): Record<K, number> {
  const counts = new Map<K, number>(keys.map((key) => [key, 0]));
  for (const value of values) {
    const count = counts.get(value);
    if (count !== undefined) counts.set(value, count + 1);
  }
  return Object.fromEntries(counts) as Record<K, number>;
}

/** A sorted list without its repeats (still sorted). */
const distinct = (sorted: readonly string[]): string[] => [...new Set(sorted)];

const TEST_STATUSES: readonly TestStatus[] = ['killing', 'weak', 'inconclusive', 'out-of-scope'];

/** Builds the report; see the module comment. */
export function buildReport(input: ReportInput): ScenarioMapReport {
  const { evidence, verdicts, fingerprints } = input;
  const engineVersion = verdicts.engineVersion;
  const fp = (id: string): string => fingerprintOf(fingerprints, id);
  const fps = (ids: Iterable<string>): string[] => [...ids].map(fp).sort(byText);
  // Every main lineage, compact model (observations.ts): implied observations are read, not stored.
  const index = indexObservations(evidence.observations, isMain);
  const inputs = new Map(evidence.tests.map((test) => [test.id, test]));
  const anchorOf = (id: string): TestAnchor => input.anchors.get(id) ?? fallbackAnchor(id);
  const universes = new Set<string>();
  // KTD13 ids by comparison universe id: pairs of one group often share a universe. A hit is
  // used only when its mutants are the same, so a truncated-hash collision recomputes.
  const fingerprinted = new Map<string, { universe: readonly string[]; id: string | null }>();
  const universeIdOfComparison = (comparison: PairComparison): string | null => {
    const known = fingerprinted.get(comparison.universeId);
    if (
      known !== undefined &&
      known.universe.length === comparison.universe.length &&
      known.universe.every((mutant, i) => mutant === comparison.universe[i])
    ) {
      return known.id;
    }
    const id = universeIdOf(comparison.universe.map(fp));
    fingerprinted.set(comparison.universeId, { universe: comparison.universe, id });
    return id;
  };

  // Pairs (findings and kept), before change status.
  const pairOf = (verdict: PairVerdict): Omit<ReportPair, 'change'> => {
    const run = { group: verdict.group, kind: 'main', lineage: MAIN_LINEAGE } as const;
    const view = lineageOf(index, run);
    const comparison = comparePair(index, run, verdict.a, verdict.b);
    const universeId = universeIdOfComparison(comparison);
    if (universeId !== null && verdict.evidence.schedule === 'evaluated') universes.add(universeId);
    const sides = (
      [
        [verdict.a, comparison.killsA],
        [verdict.b, comparison.killsB],
      ] as const
    ).map(([test, kills]): { [key: string]: JsonValue } => {
      const testInput = inputs.get(test);
      const pathIds = explicitOf(view, test)
        .filter((entry) => entry.covered || entry.static)
        .map((entry) => entry.mutant);
      return {
        ...testRecord(testInput, propertiesOf(testInput), distinct(fps(pathIds)), fps(kills)),
        disqualifiers: verdict.disqualifiers
          .filter((entry) => entry.tests.includes(test))
          .map((entry) => entry.kind),
      };
    });
    const pairLevel = verdict.disqualifiers
      .filter((entry) => entry.tests.length === 0)
      .map((entry) => entry.kind);
    const stage = verdict.evidence;
    const record: JsonValue = {
      tests: sides.sort((x, y) => byText(JSON.stringify(x), JSON.stringify(y))),
      universe: universeId,
      rowDeletion: stage.rowDeletion,
      validity: {
        schedule: stage.schedule,
        universe: stage.universe,
        unknown: stage.unknown,
        otherClasses: stage.otherClasses,
        isolation: stage.isolation,
        trace: stage.trace,
        staticValueFlow: stage.staticValueFlow,
        inconclusive: [...verdict.inconclusive],
        relations: [
          stage.path,
          stage.checksContext,
          stage.facet,
          stage.discardedValues,
          stage.killSets,
        ],
      },
      verdict: verdict.verdict,
      rule: verdict.rule,
      disqualifiers: pairLevel,
      engineVersion,
    };
    const members = { a: anchorOf(verdict.a).key, b: anchorOf(verdict.b).key };
    return {
      ...verdict,
      key: itemKey('pair', [members.a, members.b]),
      members,
      universe: { id: universeId, size: comparison.universe.length },
      evidenceHash: evidenceHash(record),
    };
  };
  const pairs = verdicts.pairs.map(pairOf);
  const kept = verdicts.kept.map(pairOf);
  const fingerprintPairOf = (pair: FingerprintPair): ReportFingerprintPair => {
    const members = { a: anchorOf(pair.a).key, b: anchorOf(pair.b).key };
    return { ...pair, key: itemKey('pair', [members.a, members.b]), members };
  };
  const fingerprint: FingerprintSection = {
    engineVersion: input.fingerprint.engineVersion,
    byVerdict: countBy(
      FINGERPRINT_VERDICTS,
      input.fingerprint.pairs.map((pair) => pair.verdict),
    ),
    pairs: input.fingerprint.pairs.map(fingerprintPairOf),
    kept: input.fingerprint.kept.map(fingerprintPairOf),
  };

  // Tests.
  const eligibleTests = new Set(input.eligibleTests);
  const tests = verdicts.tests.map((result): Omit<ReportTest, 'change'> => {
    const testInput = inputs.get(result.id);
    const properties = propertiesOf(testInput);
    const views = index.byTest.get(result.id) ?? [];
    const observed = views.flatMap((view) => explicitOf(view, result.id));
    const universe = fps(new Set(views.flatMap((view) => mutantsOf(view, result.id))));
    const pathFps = distinct(
      fps(observed.filter((entry) => entry.covered || entry.static).map((entry) => entry.mutant)),
    );
    const kills = distinct(
      fps(
        observed
          .filter((entry) => entry.valid && entry.outcome === ASSERTION_KILL && exposed(entry))
          .map((entry) => entry.mutant),
      ),
    );
    const universeId = universeIdOf(universe);
    const anchor = anchorOf(result.id);
    const record: JsonValue = {
      ...testRecord(testInput, properties, pathFps, kills),
      universe: universeId,
      status: result.status,
      reasons: [...result.reasons],
      subsumption: {
        status: result.subsumption.status,
        by: result.subsumption.by.map((id) => anchorOf(id).key).sort(byText),
      },
      statements: [...result.statements],
      engineVersion,
    };
    return {
      ...result,
      key: itemKey('test', [anchor.key]),
      anchor,
      evaluated: !result.reasons.some(
        (reason) => reason === 'not-evaluated' || reason === 'not-eligible',
      ),
      universeId,
      properties,
      evidenceHash: evidenceHash(record),
    };
  });

  // Gaps.
  const gaps = verdicts.gaps.map(
    (gap): Omit<ReportGap, 'change'> => ({
      ...gap,
      key: itemKey('gap', [], gap.file),
      evidenceHash: evidenceHash({
        file: gap.file,
        mutants: gap.mutants,
        killed: gap.killed,
        survived: fps(gap.survived),
        uncovered: fps(gap.uncovered),
        inconclusive: fps(gap.inconclusive),
        engineVersion,
      }),
    }),
  );

  // Continuity and change status.
  const anchors = new Map<string, TestAnchor>();
  for (const id of [
    ...verdicts.tests.map((t) => t.id),
    ...[...pairs, ...kept].flatMap((p) => [p.a, p.b]),
  ]) {
    const anchor = anchorOf(id);
    anchors.set(anchor.key, anchor);
  }
  const items: ContinuityItem[] = [
    ...[...pairs, ...kept].map(
      (pair): ContinuityItem => ({
        kind: 'pair',
        key: pair.key,
        members: [pair.members.a, pair.members.b].sort(byText),
        evidenceHash: pair.evidenceHash,
        label: `${pair.a} + ${pair.b}`,
      }),
    ),
    ...tests.map(
      (test): ContinuityItem => ({
        kind: 'test',
        key: test.key,
        members: [test.anchor.key],
        evidenceHash: test.evidenceHash,
        label: test.id,
      }),
    ),
    ...gaps.map(
      (gap): ContinuityItem => ({
        kind: 'gap',
        key: gap.key,
        members: [],
        evidenceHash: gap.evidenceHash,
        label: gap.file,
      }),
    ),
  ];
  const continuity: ContinuitySection = {
    anchors: [...anchors.values()].sort((x, y) => byText(x.key, y.key)),
    items,
  };
  const changes = compareWithBaseline(continuity, input.baseline);
  const statusOf = new Map(changes.changes.map((change) => [change.key, change.status]));
  const withChange = <T extends { key: string }>(item: T): T & { change: ChangeStatus | null } => ({
    ...item,
    change: statusOf.get(item.key) ?? null,
  });

  // Summary, completeness, provenance.
  const evaluatedTests = tests.filter((test) => test.evaluated && eligibleTests.has(test.id));
  const summaryVerdicts = pairs.map((pair) => pair.verdict);
  const gapFiles = gaps.filter((gap) => gap.survived.length > 0 || gap.uncovered.length > 0);
  const summary: ReportSummary = {
    eligibleTests: eligibleTests.size,
    evaluatedTests: evaluatedTests.length,
    evaluated: `${evaluatedTests.length} of ${eligibleTests.size} eligible tests evaluated`,
    pairs: pairs.length,
    kept: kept.length,
    byVerdict: countBy(VERDICT_PRECEDENCE, summaryVerdicts),
    testsByStatus: countBy(
      TEST_STATUSES,
      tests.map((test) => test.status),
    ),
    subsumed: tests.filter((test) => test.subsumption.status === 'subsumed').length,
    subsumptionUnknown: tests.filter((test) => test.subsumption.status === 'unknown').length,
    gapFiles: gapFiles.length,
    survived: gaps.reduce((sum, gap) => sum + gap.survived.length, 0),
    uncovered: gaps.reduce((sum, gap) => sum + gap.uncovered.length, 0),
    inconclusiveMutants: gaps.reduce((sum, gap) => sum + gap.inconclusive.length, 0),
  };
  const shards: ShardStatus = {
    planned: input.shards.planned,
    complete: input.shards.complete,
    incomplete: [...input.shards.incomplete].sort(
      (x, y) => byText(x.shard, y.shard) || byText(x.reason, y.reason),
    ),
  };
  const complete = shards.complete >= shards.planned && shards.incomplete.length === 0;
  const observedMutants = observedMutantsOf(evidence.observations);
  // One pass over the observed mutants: fingerprint fallbacks and mutator names.
  const fallbackKinds: FingerprintFallback[] = [];
  const mutators: string[] = [];
  for (const id of observedMutants) {
    const known = fingerprints.get(id);
    if (known === undefined) fallbackKinds.push('not-fingerprinted');
    else if (known.fallback !== null) fallbackKinds.push(known.fallback);
    const parsed = parseGlobalMutantId(id);
    if (parsed !== null) mutators.push(parsed.mutator);
  }
  const fallbacks = countBy(FINGERPRINT_FALLBACKS, fallbackKinds);
  const fallbackTotal = Object.values(fallbacks).reduce((sum, count) => sum + count, 0);
  const provenance: RunProvenance = {
    ...input.provenance,
    operators: { mutator: null, names: sortedUnique(mutators) },
    universes: sortedUnique(universes),
    mutants: { total: observedMutants.length, fallbacks },
  };
  const eligibleRepoFiles = new Set(input.eligibility.fingerprintFiles.map(fromPackagePath));
  const duplicates = fingerprint.pairs
    .filter((pair) => pair.verdict === 'duplicate')
    .map((pair): SpotAuditPick => ({ key: pair.key, a: pair.a, b: pair.b }));

  return {
    schemaVersion: SCENARIO_MAP_SCHEMA_VERSION,
    inventory: input.inventory ?? null,
    engineVersion,
    run: { ...input.run },
    seed: input.seed,
    provenance,
    completeness: {
      complete,
      partial: !complete,
      shards,
      degraded: sortedUnique(evidence.valueFlowDegraded) as DegradedFlag[],
    },
    summary,
    mutation: input.mutation,
    fingerprint,
    limits: [
      ...LIMITS,
      ...(fallbackTotal > 0
        ? [
            `Continuity: ${fallbackTotal} of ${observedMutants.length} mutants are named by their ` +
              'revision-pinned id (source changed or unreadable), so items with them may show as ' +
              'changed next week.',
          ]
        : []),
    ],
    eligibility: {
      mode: input.eligibility.mode,
      files: sortedUnique(input.eligibility.files),
      fingerprintFiles: input.eligibility.fingerprintFiles.length,
      layer1Files: input.layer1Files,
      unrecordedFiles: input.unrecordedFiles,
      changedFiles: input.changedFiles === null ? null : sortedUnique(input.changedFiles),
      notRun: { ...input.notRun },
      delta: input.eligibility.delta,
    },
    layer0: layer0Section(input.layer0, eligibleRepoFiles),
    pairs: pairs.map(withChange),
    kept: kept.map(withChange),
    tests: tests.map(withChange),
    gaps: gaps.map(withChange),
    spotAudit: spotAudit(duplicates, input.seed),
    changes,
    continuity,
  };
}
