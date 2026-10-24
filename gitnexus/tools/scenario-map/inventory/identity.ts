/**
 * Execution identities and continuity anchors of the scenario map (U3, R2, KTD3).
 *
 * {@link joinRuntime} joins the runtime records Layer 1 observes (task id, full name, location,
 * collection order) to the static call sites of cases.ts. It is pure, so Layer 1 (U4) feeds it
 * later and tests feed it in-memory records:
 *  1. Each file's records get Phase 0 ids (`assignTestIds`, tools/mutation/runner/test-ids.ts)
 *     and a row ordinal: their 0-based order among the runtime tests at the same location. The
 *     id, the location and the row are the execution identity.
 *  2. Runtime tests map to the call site on their location's line. When several call sites share
 *     the line, the column must name exactly one (else `ambiguous-location`); one call site whose
 *     line holds several runtime columns is a `join-mismatch`.
 *  3. A call site joins its runtime tests one-to-one in order when both counts match, and the
 *     runtime full name must equal a static one where the titles are plain strings. Otherwise
 *     every runtime test at the site is unsupported for strong evidence (R2): `join-mismatch`,
 *     or `join-count-unknown` when the static count is not known.
 *
 * Anchors (design §5.5, KTD3) are keyed by file, describe path, title and row fingerprint, never
 * a line; the body fingerprint follows a moved test only when it is unique on both sides
 * ({@link matchAnchors}). Identical bodies are exactly the repeats and the rows of one table, so
 * a body alone never identifies one of them.
 *
 * Library only; the scenario-map CLI (U14) calls it.
 */
import { createHash } from 'node:crypto';
import { generate } from '@babel/generator';
import { assignTestIds, type IdentifiedTest } from '../../mutation/runner/test-ids.js';
import type { CaseRecord } from '../../test-dupes/test-dupes.js';
import type {
  InventoryInstance,
  InventoryJoin,
  JoinProblem,
  RuntimeTestRecord,
  StaticCallSite,
  StaticInstance,
  StaticInventory,
  TestAnchor,
} from '../types.js';

const JOIN_PROBLEMS: readonly JoinProblem[] = [
  'join-mismatch',
  'join-count-unknown',
  'join-name-mismatch',
  'ambiguous-location',
  'no-location',
  'no-static-case',
  'unparsed',
];

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');

/** sha1 over a test callback's parameters and body, without comments or formatting. */
export function bodyFingerprint(record: CaseRecord): string {
  const params = record.fn.params.map(
    (param) => generate(param, { comments: false, compact: true }).code,
  );
  return sha1(`(${params.join(',')})=>${record.body}`);
}

/** An anchor without its twin suffix: `key` is the base key. */
function baseAnchor(
  site: StaticCallSite,
  rowFingerprint: string | null,
  row: number | null,
): TestAnchor {
  const { describePath, title } = site.record;
  const rowPart = rowFingerprint ?? `row:${row ?? ''}`;
  return {
    key: sha1(JSON.stringify([site.file, describePath, title, rowPart])),
    file: site.file,
    describePath: [...describePath],
    title,
    rowFingerprint,
    bodyFingerprint: bodyFingerprint(site.record),
  };
}

interface Joined {
  site: StaticCallSite | null;
  instance: StaticInstance | null;
  unsupported: JoinProblem[];
  unresolved: string[];
}

const failed = (problem: JoinProblem, site: StaticCallSite | null = null): Joined => ({
  site,
  instance: null,
  unsupported: [problem],
  unresolved: site?.unresolved ?? [],
});

/** One call site against its runtime tests, in collection order. */
function joinSite(site: StaticCallSite, tests: readonly IdentifiedTest[]): Joined[] {
  const { instances } = site;
  if (instances === null) return tests.map(() => failed('join-count-unknown', site));
  if (instances.length !== tests.length) return tests.map(() => failed('join-mismatch', site));
  return tests.map((test, index): Joined => {
    const instance = instances[index];
    const renamed = site.fullName !== null && test.fullName !== site.fullName;
    return {
      site,
      instance,
      unsupported: renamed ? ['join-name-mismatch'] : [],
      unresolved: instance.unresolved,
    };
  });
}

const groupBy = <T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> => {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
};

/** Joins one file's runtime tests to its call sites; returns a result per test. */
function joinFile(
  tests: readonly IdentifiedTest[],
  sites: readonly StaticCallSite[],
  unparsed: boolean,
  reached: Set<StaticCallSite>,
): Map<IdentifiedTest, Joined> {
  const results = new Map<IdentifiedTest, Joined>();
  const sitesByLine = groupBy(sites, (site) => site.location.line);
  const located = tests.filter((test) => test.location !== undefined);
  for (const test of tests) {
    if (test.location === undefined) results.set(test, failed('no-location'));
  }
  for (const [line, onLine] of groupBy(located, (test) => test.location?.line ?? 0)) {
    const candidates = sitesByLine.get(line) ?? [];
    const byColumn = groupBy(onLine, (test) => test.location?.column ?? 0);
    const set = (group: readonly IdentifiedTest[], joined: readonly Joined[]): void =>
      group.forEach((test, index) => results.set(test, joined[index]));
    if (unparsed || candidates.length === 0) {
      set(
        onLine,
        onLine.map(() => failed(unparsed ? 'unparsed' : 'no-static-case')),
      );
    } else if (candidates.length === 1) {
      const [site] = candidates;
      reached.add(site);
      set(
        onLine,
        byColumn.size === 1
          ? joinSite(site, onLine)
          : onLine.map(() => failed('join-mismatch', site)),
      );
    } else {
      for (const [column, group] of byColumn) {
        const matches = candidates.filter((site) => site.location.column === column);
        if (matches.length === 1) reached.add(matches[0]);
        set(
          group,
          matches.length === 1
            ? joinSite(matches[0], group)
            : group.map(() => failed('ambiguous-location')),
        );
      }
    }
  }
  return results;
}

/** Row ordinal of each test: its order among the file's tests at the same location. */
function rowOrdinals(tests: readonly IdentifiedTest[]): Map<IdentifiedTest, number> {
  const rows = new Map<IdentifiedTest, number>();
  const seen = new Map<string, number>();
  for (const test of tests) {
    if (test.location === undefined) continue;
    const key = `${test.location.line}:${test.location.column}`;
    const row = seen.get(key) ?? 0;
    rows.set(test, row);
    seen.set(key, row + 1);
  }
  return rows;
}

/**
 * Joins runtime records (files in any order, collection order within a file) to the static
 * inventory; pure. Throws like `assignTestIds` on a duplicated task id, or on colliding full
 * names without a location (the Vitest config must set `includeTaskLocation`).
 */
export function joinRuntime(
  statics: StaticInventory,
  runtime: readonly RuntimeTestRecord[],
): InventoryJoin {
  const sitesByFile = groupBy(statics.sites, (site) => site.file);
  const unparsed = new Set(statics.skipped);
  const reached = new Set<StaticCallSite>();
  const instances: InventoryInstance[] = [];
  const mismatched = new Set<StaticCallSite>();

  for (const [file, records] of groupBy(runtime, (record) => record.file)) {
    const tests = assignTestIds(
      file,
      records.map(({ taskId, fullName, location }) => ({ taskId, fullName, location })),
    );
    const rows = rowOrdinals(tests);
    const joined = joinFile(tests, sitesByFile.get(file) ?? [], unparsed.has(file), reached);
    for (const test of tests) {
      const result = joined.get(test) ?? failed('no-static-case');
      if (result.site !== null && result.unsupported.includes('join-mismatch')) {
        mismatched.add(result.site);
      }
      instances.push({
        id: test.id,
        file,
        taskId: test.taskId,
        fullName: test.fullName,
        location: test.location ?? null,
        row: rows.get(test) ?? null,
        notOracleValidated: test.notOracleValidated,
        site: result.site,
        instance: result.instance,
        anchor: null,
        unsupported: result.unsupported,
        unresolved: result.unresolved,
        dupeOk: result.site?.record.suppressed ?? null,
      });
    }
  }

  // Anchors: exact twins (same file, describe path, title and row values) get `~<n>` in order.
  const twins = new Map<string, number>();
  for (const instance of instances) {
    if (instance.site === null) continue;
    const anchor = baseAnchor(
      instance.site,
      instance.instance?.rowFingerprint ?? null,
      instance.row,
    );
    const seen = twins.get(anchor.key) ?? 0;
    twins.set(anchor.key, seen + 1);
    instance.anchor = seen === 0 ? anchor : { ...anchor, key: `${anchor.key}~${seen}` };
  }

  const byProblem = Object.fromEntries(JOIN_PROBLEMS.map((problem) => [problem, 0])) as Record<
    JoinProblem,
    number
  >;
  for (const instance of instances) {
    for (const problem of instance.unsupported) byProblem[problem] += 1;
  }
  const notRun = statics.sites.filter((site) => !reached.has(site));
  return {
    instances,
    notRun,
    summary: {
      runtimeTests: runtime.length,
      staticSites: statics.sites.length,
      staticInstances: statics.sites.reduce((sum, site) => sum + (site.instances?.length ?? 0), 0),
      oneToOne: instances.filter((instance) => instance.unsupported.length === 0).length,
      byProblem,
      joinMismatchSites: mismatched.size,
      notRunSites: notRun.length,
    },
  };
}

export interface AnchorMatch {
  current: string;
  /** The previous anchor key this one continues; null for a new test. */
  previous: string | null;
  via: 'key' | 'body' | null;
}

/**
 * Continuity between two runs' anchors (design §5.5): the same key continues; otherwise a test
 * whose body and row fingerprints are unique among the unmatched anchors of both runs continues
 * the one previous anchor with the same pair (a moved or renamed test); anything else is new. A
 * row whose values are unknown never moves.
 */
export function matchAnchors(
  previous: readonly TestAnchor[],
  current: readonly TestAnchor[],
): AnchorMatch[] {
  const previousKeys = new Set(previous.map((anchor) => anchor.key));
  const currentKeys = new Set(current.map((anchor) => anchor.key));
  const moveKey = (anchor: TestAnchor): string | null =>
    anchor.rowFingerprint === null
      ? null
      : `${anchor.bodyFingerprint}\u0000${anchor.rowFingerprint}`;
  const unmatchedPrevious = groupBy(
    previous.filter((anchor) => !currentKeys.has(anchor.key)),
    moveKey,
  );
  const unmatchedCurrent = groupBy(
    current.filter((anchor) => !previousKeys.has(anchor.key)),
    moveKey,
  );
  return current.map((anchor): AnchorMatch => {
    if (previousKeys.has(anchor.key))
      return { current: anchor.key, previous: anchor.key, via: 'key' };
    const key = moveKey(anchor);
    const before = key === null ? undefined : unmatchedPrevious.get(key);
    const now = key === null ? undefined : unmatchedCurrent.get(key);
    return before?.length === 1 && now?.length === 1
      ? { current: anchor.key, previous: before[0].key, via: 'body' }
      : { current: anchor.key, previous: null, via: null };
  });
}
