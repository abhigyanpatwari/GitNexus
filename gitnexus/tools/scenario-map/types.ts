/**
 * Shared records of the test scenario map (Phase 1, KTD1): the schema version, the run mode, the
 * one production-file predicate (KTD7) and the inventory records (U3) that Layer 1, Layer 2, the
 * verdict engine and the report read. Types, constants and small pure helpers only.
 *
 * Two path spaces, both POSIX:
 *  - repo path, relative to the repo root (`gitnexus/src/x.ts`, `gitnexus-shared/src/y.ts`):
 *    production files, path-map entries, Layer 0 records (`CaseRecord.file`) and their import keys;
 *  - package path, relative to `gitnexus/` (`test/unit/a.test.ts`): test files, Phase 0 test ids,
 *    the gate 1 envelope and runtime records.
 * {@link toPackagePath} and {@link fromPackagePath} convert between them.
 */
import path from 'node:path';
import type * as t from '@babel/types';
import { buildPathMap, PACKAGE_DIR, PATH_MAP } from '../mutation/prepare/path-map.js';
import type { CollectedTest, TestLocation } from '../mutation/runner/test-ids.js';
import type { CaseRecord } from '../test-dupes/test-dupes.js';

/** 2: the report gained the scenario fingerprint section and the mutation scope. */
export const SCENARIO_MAP_SCHEMA_VERSION = 2;

/**
 * How much mutation evidence a run gathers (docs/plans/2026-10-25-1700-feat-scenario-fingerprint-
 * plan.md F2, F3, F7): `none` (fingerprint only), `possible-duplicates` (the groups with a
 * possible duplicate, trimmed to its tests) or `all` (every group, the Phase 1 run).
 */
export type MutationScope = 'none' | 'possible-duplicates' | 'all';
export const MUTATION_SCOPES: readonly MutationScope[] = ['none', 'possible-duplicates', 'all'];

// ── Run mode and paths ─────────────────────────────────────────────────────

/**
 * `normal`: the eligible tests are the validated envelope (R1). `controls`: the eligible tests
 * are the `*.case.ts` files of one mutation fixture project, whose `src/` modules are production
 * files; the envelope is not consulted.
 */
export type RunMode =
  | { kind: 'normal' }
  | {
      kind: 'controls';
      /** Repo path of the fixture project, `gitnexus/test/fixtures/mutation-<name>`. */
      fixtureRoot: string;
    };

/** The extra path-map roots of a mode: the fixture project in `controls` mode, else none. */
export const extraRootsOf = (mode: RunMode): string[] =>
  mode.kind === 'controls' ? [mode.fixtureRoot] : [];

/** Normalises a repo or package path; absolute paths and `..` escapes throw. */
export function normalizeRelativePath(input: string): string {
  const posix = input.replace(/\\/g, '/');
  const normalized = path.posix.normalize(posix);
  const escapes = normalized === '..' || normalized.startsWith('../');
  if (path.posix.isAbsolute(posix) || /^[A-Za-z]:\//.test(posix) || escapes) {
    throw new Error(
      `scenario-map: ${JSON.stringify(input)} is not a relative path inside the root`,
    );
  }
  return normalized;
}

/** A repo path under `gitnexus/` as a package path; anything else throws. */
export function toPackagePath(repoPath: string): string {
  const normalized = normalizeRelativePath(repoPath);
  if (!normalized.startsWith(`${PACKAGE_DIR}/`)) {
    throw new Error(`scenario-map: ${JSON.stringify(repoPath)} is not under ${PACKAGE_DIR}/`);
  }
  return normalized.slice(PACKAGE_DIR.length + 1);
}

/** A package path as a repo path. */
export const fromPackagePath = (packagePath: string): string =>
  `${PACKAGE_DIR}/${normalizeRelativePath(packagePath)}`;

// ── Production files (KTD7) ────────────────────────────────────────────────

/** Test-side names that never count as production, wherever they live. */
const TEST_NAME = /\.(test|spec|case)\.[mc]?[jt]sx?$/;

/**
 * The repo-path directories that hold production files: the path map's roots (`gitnexus/src/`
 * and `gitnexus-shared/src/`, which the prepared copy relocates) and, for each extra root, its
 * `src/` subtree. Extra roots are validated by `buildPathMap`.
 */
export function productionRoots(extraRoots: readonly string[] = []): string[] {
  const extra = buildPathMap(extraRoots).filter((entry) => !PATH_MAP.includes(entry));
  return [...PATH_MAP.map((entry) => entry.repo), ...extra.map((entry) => `${entry.repo}src/`)];
}

/**
 * The one production-file predicate (KTD7), used by the Layer 1 block filter, provenance, the
 * mutate scope and the trace frame filter. Takes a repo path; a production file is a `.ts`
 * source (not `.d.ts`, the only kind the mutation driver accepts) under a production root that
 * is not named like a test (`*.test.*`, `*.spec.*`, `*.case.*`). Absolute paths throw: map
 * prepared or absolute paths to repo paths first (`tools/mutation/prepare/path-map.ts`).
 */
export function productionFilePredicate(
  extraRoots: readonly string[] = [],
): (repoPath: string) => boolean {
  const roots = productionRoots(extraRoots);
  return (repoPath: string): boolean => {
    const normalized = normalizeRelativePath(repoPath);
    if (!normalized.endsWith('.ts') || normalized.endsWith('.d.ts')) return false;
    if (TEST_NAME.test(normalized)) return false;
    return roots.some((root) => normalized.startsWith(root));
  };
}

/** {@link productionFilePredicate} for one path. */
export const isProductionFile = (repoPath: string, extraRoots: readonly string[] = []): boolean =>
  productionFilePredicate(extraRoots)(repoPath);

// ── Eligibility (R1) ───────────────────────────────────────────────────────

export interface EligibilityDelta {
  /** Accepted by the classifier now but not in the envelope: not validated by gate 1. */
  notValidated: string[];
  /** In the envelope but not accepted now, with the classifier's reasons. */
  rejected: { file: string; reasons: string[] }[];
}

export interface Eligibility {
  mode: RunMode['kind'];
  /** Package paths of the test files mutation may run (R1: the validated envelope), sorted. */
  files: string[];
  /**
   * Package paths of the test files the scenario fingerprint covers, sorted: every `*.test.ts`
   * under `test/unit` and `test/integration` (normal mode; F8), or the fixture's case files.
   * A superset of `files`.
   */
  fingerprintFiles: string[];
  /** R1 delta; null in `controls` mode, where the envelope is not consulted. */
  delta: EligibilityDelta | null;
  /** Extra path-map roots for {@link productionFilePredicate}. */
  extraRoots: string[];
}

// ── Static instances (cases.ts) ────────────────────────────────────────────

/**
 * A statically evaluated value bound by a table row or loop element. Numbers keep their
 * `String()` text (`-0` stays `-0`) so the record survives JSON. `unresolved` marks an
 * expression the evaluator could not decide (design §5.3); it blocks strong evidence.
 */
export type RowValue =
  | { kind: 'string'; value: string }
  | { kind: 'number'; text: string }
  | { kind: 'bigint'; text: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'undefined' }
  | { kind: 'regexp'; pattern: string; flags: string }
  | { kind: 'array'; items: RowValue[] }
  | { kind: 'object'; entries: RowEntry[] }
  | { kind: 'unresolved'; code: string; reason: string };

export interface RowEntry {
  key: string;
  value: RowValue;
}

/**
 * A construct that repeats a test call: an enclosing `describe.each`/`describe.for`, an
 * enclosing `for…of`, or the test's own `each`/`for` table (always last).
 */
export type DimensionKind = 'describe-each' | 'describe-for' | 'for-of' | 'each' | 'for';

export interface InstanceDimension {
  kind: DimensionKind;
  /** 0-based position of the row in its table or loop. */
  index: number;
  /** The row: the table element, the template-table row object or the loop element. */
  row: RowValue;
  /**
   * What the row binds: for tables, the callback arguments (Vitest spreads a row only when every
   * row is an array; null when that cannot be decided); for `for…of`, the loop element.
   */
  args: RowValue[] | null;
  /** The row's source node; null for template-table rows and rows copied in by a spread. */
  node: t.Node | null;
}

export interface StaticInstance {
  /** 0-based position among the call site's instances, in Vitest collection order. */
  row: number;
  /** Outermost first; empty for a plain test. */
  dimensions: InstanceDimension[];
  /** Arguments the test callback gets from its own table; `[]` without one; null when unknown. */
  args: RowValue[] | null;
  /** Why the instance's inputs are not fully static; empty when resolved. */
  unresolved: string[];
  /** sha1 over the rendered rows of every dimension, outermost first (KTD3). */
  rowFingerprint: string;
}

/** One test call as written, with its statically expanded instances. */
export interface StaticCallSite {
  /** Package path of the test file. */
  file: string;
  /** Layer 0's record of the call; `record.file` is the repo path. */
  record: CaseRecord;
  /** Where Vitest reports the call's tests (`includeTaskLocation`): V8's position of the call. */
  location: TestLocation;
  /** Vitest full name when every suite and test title is a plain string, else null. */
  fullName: string | null;
  /** The call's instances in collection order; null when their number is not static. */
  instances: StaticInstance[] | null;
  /** Why the number of instances is not static; empty when `instances` is set. */
  unresolved: string[];
}

export interface StaticInventory {
  sites: StaticCallSite[];
  /** Package paths of eligible files that did not parse. */
  skipped: string[];
  /**
   * Package paths of parsed test files whose tests the inventory may not all see: no test call,
   * or a registration-level call that registers what it does not record (a helper, an alias, a
   * suite or test whose callback is not written inline).
   */
  incomplete: string[];
}

// ── Runtime join and anchors (identity.ts) ─────────────────────────────────

/** One test as Layer 1 observed it; a file's records come in Vitest collection order. */
export interface RuntimeTestRecord extends CollectedTest {
  /** Package path of the test file. */
  file: string;
}

/**
 * Continuity anchor (design §5.5, KTD3): no line, so unrelated edits keep it. A moved test is
 * matched by its body fingerprint only when that is unique.
 */
export interface TestAnchor {
  /** sha1 over file, describe path, title and row fingerprint; `~<n>` marks the n-th twin. */
  key: string;
  /** Package path. */
  file: string;
  describePath: string[];
  title: string;
  /** null when the row's values are unknown; the key then uses the runtime row ordinal. */
  rowFingerprint: string | null;
  /** sha1 over the callback's parameters and body, without comments or formatting. */
  bodyFingerprint: string;
}

/**
 * Why an instance's static-to-runtime join is not one-to-one (R2):
 * - `join-mismatch`: the call site has a different number of static and runtime instances;
 * - `join-count-unknown`: the number of static instances is not static;
 * - `join-name-mismatch`: the runtime full name differs from the call site's static one;
 * - `ambiguous-location`: several call sites share the line and no column decides;
 * - `no-location`: the runtime record has no location;
 * - `no-static-case`: no test call of the file sits at the location;
 * - `unparsed`: the test file did not parse.
 */
export type JoinProblem =
  | 'join-mismatch'
  | 'join-count-unknown'
  | 'join-name-mismatch'
  | 'ambiguous-location'
  | 'no-location'
  | 'no-static-case'
  | 'unparsed';

export interface InventoryInstance {
  /** Phase 0 test id; with `location` and `row` the execution identity (KTD3). */
  id: string;
  /** Package path. */
  file: string;
  taskId: string;
  fullName: string;
  location: TestLocation | null;
  /** 0-based order among the runtime tests at `location`; null without a location. */
  row: number | null;
  /** True when the id needed the row ordinal (gate 3 cannot validate it). */
  notOracleValidated: boolean;
  /** The call site at the location; null when there is none or it is ambiguous. */
  site: StaticCallSite | null;
  /** The static instance joined one-to-one; null otherwise. */
  instance: StaticInstance | null;
  anchor: TestAnchor | null;
  /** Join problems; empty exactly when the join is one-to-one. Non-empty is unsupported. */
  unsupported: JoinProblem[];
  /** Unresolved static inputs of the instance or call site (design §5.3). */
  unresolved: string[];
  /** The `// dupe-ok:` reason on the call, a human keep (R15); null when absent. */
  dupeOk: string | null;
}

export interface JoinSummary {
  runtimeTests: number;
  staticSites: number;
  /** Static instances of sites whose count is static. */
  staticInstances: number;
  oneToOne: number;
  /** Runtime tests per join problem. */
  byProblem: Record<JoinProblem, number>;
  /** Call sites whose static and runtime counts differ. */
  joinMismatchSites: number;
  /** Call sites without any runtime test (skipped, filtered or not collected). */
  notRunSites: number;
}

export interface InventoryJoin {
  /** One per runtime record, files in first-seen order, collection order within a file. */
  instances: InventoryInstance[];
  /** Static call sites no runtime record maps to. */
  notRun: StaticCallSite[];
  summary: JoinSummary;
}
