/**
 * Layer 1 candidate retrieval of the scenario map (U4, R3, KTD5, KTD17, design §5.2).
 *
 * Four sources make a pair of tests a candidate:
 *  - `jaccard`: exact Jaccard similarity of their V8 block sets (the work file's block indices,
 *    run-coverage.ts) of at least {@link JACCARD_THRESHOLD}, checked in integers. All pairs are
 *    found without comparing every pair: blocks are ordered rarest first (by how many tests cover
 *    them, then by index), each set is indexed by its prefix of `|x| - ceil(t * |x|) + 1` blocks,
 *    and only sets that share a prefix block and pass the size-ratio filter
 *    (`min / max >= t`) are verified. A pair at the threshold always shares a prefix block, so the
 *    filters drop no qualifying pair. Empty block sets (tests that ran no production code) never
 *    pair through this source;
 *  - `checks-context`: both tests have the same checks-and-context key (facet/checks.ts
 *    `checksContextKey`), whatever their blocks;
 *  - `body`: identical callback text, even when setup/import context and blocks differ. This
 *    source only retrieves review leads; it cannot prove equal inputs or expectations.
 *  - `fixture`: source fixtures have similar provider/CFG profiles and assertion-only keys match.
 *    This includes cross-language review leads, never proof of input equivalence.
 *
 * Each pair records its exact Jaccard (null when a set is empty), whether the block sets are
 * identical (KTD5: a pair that is not caps at weak evidence) and whether it is path-unattributable
 * (either test ran concurrently, design §5.2: such a pair is Inconclusive). Groups are the
 * connected components of the pairs; they only schedule Layer 3 and never decide a verdict. A
 * group's id is a hash of its sorted test ids, so it does not depend on input order or on other
 * groups. The stats name the largest group (most tests, then most pairs) for shard planning
 * (KTD17).
 *
 * Library only; pure. The scenario-map CLI (U14) and run-coverage.ts call {@link findCandidates}.
 */
import { ascending, byText, sha1 } from '../util.js';
import {
  compareFixtureProfiles,
  type FixtureProfile,
  type FixtureSimilarity,
} from '../facet/fixture-profile.js';

/** Jaccard >= 99 / 100 makes a candidate (R3). */
export const JACCARD_THRESHOLD = Object.freeze({ numerator: 99, denominator: 100 });

export type CandidateSource = 'jaccard' | 'checks-context' | 'body' | 'fixture';

export interface CandidateTest {
  /** Phase 0 test id. */
  id: string;
  /** Block indices (any integer ids), each once. */
  blocks: readonly number[];
  concurrent: boolean;
  /** Checks-and-context key; null when the test has none (no call site, no assertion). */
  checksContext: string | null;
  /** Same callback text, independent of surrounding setup. Retrieval only, never proof. */
  bodyKey?: string | null;
  /** Fixture retrieval also requires a known, equal assertion-only key. */
  checks?: string | null;
  fixture?: FixtureProfile | null;
}

export interface CandidatePair {
  /** The smaller test id. */
  a: string;
  b: string;
  /** In the order `jaccard`, `checks-context`, `body`, `fixture`. */
  sources: CandidateSource[];
  /** Exact Jaccard of the block sets; null when either set is empty. */
  jaccard: number | null;
  /** The block sets are equal (KTD5). */
  identicalBlocks: boolean;
  /** Either test ran concurrently: its path cannot be attributed (design §5.2). */
  pathUnattributable: boolean;
  /** Id of the pair's group. */
  group: string;
  /** Review evidence only. Exact input identity is checked separately by Layer 2. */
  fixtureSimilarity?: FixtureSimilarity;
}

export interface CandidateGroup {
  /** `g` + the first 16 hex digits of sha1 over the sorted test ids, newline-joined. */
  id: string;
  /** Sorted test ids. */
  tests: string[];
  pairs: number;
}

export interface CandidateStats {
  /** Tests given. */
  tests: number;
  pairs: number;
  /** Disjoint counts: fixture takes precedence over body, then the original three buckets. */
  bySource: {
    jaccard: number;
    checksContext: number;
    both: number;
    body: number;
    fixture?: number;
  };
  groups: number;
  /** The group with the most tests, then the most pairs, then the smallest id. */
  largestGroup: { id: string; tests: number; pairs: number } | null;
}

export interface CandidateResult {
  /** Sorted by `a`, then `b`. */
  pairs: CandidatePair[];
  /** Sorted by id. */
  groups: CandidateGroup[];
  stats: CandidateStats;
}

/** Size of the intersection of two ascending arrays. */
function intersectionSize(a: readonly number[], b: readonly number[]): number {
  let shared = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      shared += 1;
      i += 1;
      j += 1;
    } else if (a[i] < b[j]) i += 1;
    else j += 1;
  }
  return shared;
}

const sortedBlocks = (blocks: readonly number[]): number[] => [...new Set(blocks)].sort(ascending);

/** Jaccard similarity of two block sets; 1 for two empty sets. */
export function jaccard(a: readonly number[], b: readonly number[]): number {
  const x = sortedBlocks(a);
  const y = sortedBlocks(b);
  const shared = intersectionSize(x, y);
  const union = x.length + y.length - shared;
  return union === 0 ? 1 : shared / union;
}

const { numerator: T_NUM, denominator: T_DEN } = JACCARD_THRESHOLD;

/** `shared / union >= t`, in integers. */
const meetsThreshold = (shared: number, union: number): boolean => shared * T_DEN >= T_NUM * union;

/** Prefix length of a set of `size` blocks: `size - ceil(t * size) + 1`. */
const prefixLength = (size: number): number => size - Math.ceil((T_NUM * size) / T_DEN) + 1;

interface Indexed {
  test: CandidateTest;
  /** Ascending block indices. */
  blocks: number[];
}

/** Index pairs (into `items`) at Jaccard >= t, through the prefix and size filters. */
function jaccardPairs(items: readonly Indexed[]): [number, number][] {
  const frequency = new Map<number, number>();
  for (const item of items) {
    for (const block of item.blocks) frequency.set(block, (frequency.get(block) ?? 0) + 1);
  }
  const rarestFirst = (a: number, b: number): number =>
    (frequency.get(a) ?? 0) - (frequency.get(b) ?? 0) || a - b;
  const order = items
    .map((item, index) => ({ index, size: item.blocks.length }))
    .filter(({ size }) => size > 0)
    .sort((p, q) => p.size - q.size || byText(items[p.index].test.id, items[q.index].test.id));
  const postings = new Map<number, number[]>();
  const found: [number, number][] = [];
  for (const { index, size } of order) {
    const prefix = [...items[index].blocks].sort(rarestFirst).slice(0, prefixLength(size));
    const seen = new Set<number>();
    for (const block of prefix) {
      for (const other of postings.get(block) ?? []) {
        if (seen.has(other)) continue;
        seen.add(other);
        // `other` was indexed earlier, so it is no larger: the size-ratio filter.
        if (items[other].blocks.length * T_DEN < T_NUM * size) continue;
        const shared = intersectionSize(items[other].blocks, items[index].blocks);
        const union = items[other].blocks.length + size - shared;
        if (meetsThreshold(shared, union)) found.push([other, index]);
      }
    }
    for (const block of prefix) {
      const list = postings.get(block);
      if (list) list.push(index);
      else postings.set(block, [index]);
    }
  }
  return found;
}

/** Index pairs (into `items`) sharing a non-null key of the selected field. */
function checksContextPairs(
  items: readonly Indexed[],
  field: 'checksContext' | 'bodyKey' = 'checksContext',
): [number, number][] {
  const buckets = new Map<string, number[]>();
  items.forEach((item, index) => {
    const key = item.test[field];
    if (key == null) return;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index);
    else buckets.set(key, [index]);
  });
  const found: [number, number][] = [];
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) found.push([bucket[i], bucket[j]]);
    }
  }
  return found;
}

const groupId = (tests: readonly string[]): string => `g${sha1(tests.join('\n')).slice(0, 16)}`;

/** Connected components of the pairs, as sorted test-id lists keyed by each member. */
function components(pairs: readonly { a: string; b: string }[]): Map<string, string[]> {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    for (let node = id; node !== root; ) {
      const next = parent.get(node) ?? root;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  for (const { a, b } of pairs) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const members = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const list = members.get(root);
    if (list) list.push(id);
    else members.set(root, [id]);
  }
  const byMember = new Map<string, string[]>();
  for (const list of members.values()) {
    list.sort(byText);
    for (const id of list) byMember.set(id, list);
  }
  return byMember;
}

/**
 * Candidate pairs, groups and stats of a set of tests (module header). Test ids must be unique.
 * `focus` (a diff-scoped run, fingerprint plan E8) keeps only the pairs with a focused test, before
 * the groups are formed.
 */
export function findCandidates(
  tests: readonly CandidateTest[],
  focus: (id: string) => boolean = () => true,
): CandidateResult {
  const items: Indexed[] = [...tests]
    .sort((p, q) => byText(p.id, q.id))
    .map((test) => ({ test, blocks: sortedBlocks(test.blocks) }));
  for (let i = 1; i < items.length; i += 1) {
    if (items[i].test.id === items[i - 1].test.id) {
      throw new Error(`candidates: test id ${items[i].test.id} is listed twice`);
    }
  }

  const sources = new Map<string, { i: number; j: number; found: Set<CandidateSource> }>();
  const add = (pairs: readonly [number, number][], source: CandidateSource): void => {
    for (const [x, y] of pairs) {
      const [i, j] = x < y ? [x, y] : [y, x];
      const key = `${i}:${j}`;
      const entry = sources.get(key) ?? { i, j, found: new Set<CandidateSource>() };
      entry.found.add(source);
      sources.set(key, entry);
    }
  };
  add(jaccardPairs(items), 'jaccard');
  add(checksContextPairs(items), 'checks-context');
  add(checksContextPairs(items, 'bodyKey'), 'body');

  // Bucket by assertions and compare each distinct fixture profile once. Many tests share
  // beforeAll fixtures; do not re-parse/re-score them for every test pair.
  const fixtureMatches = new Map<string, FixtureSimilarity>();
  const fixtureBuckets = new Map<string, Map<string, number[]>>();
  for (let index = 0; index < items.length; index++) {
    const { checks, fixture } = items[index].test;
    if (checks == null || fixture == null || fixture.files.length === 0) continue;
    const key = JSON.stringify([
      fixture.contentKey,
      fixture.features,
      fixture.unresolved,
      fixture.languages,
    ]);
    const bucket = fixtureBuckets.get(checks) ?? new Map<string, number[]>();
    const group = bucket.get(key) ?? [];
    group.push(index);
    bucket.set(key, group);
    fixtureBuckets.set(checks, bucket);
  }
  const scores = new Map<string, FixtureSimilarity | null>();
  for (const bucket of fixtureBuckets.values()) {
    const entries = [...bucket];
    for (let x = 0; x < entries.length; x++)
      for (let y = x; y < entries.length; y++) {
        const [aKey, a] = entries[x];
        const [bKey, b] = entries[y];
        const aProfile = items[a[0]].test.fixture;
        const bProfile = items[b[0]].test.fixture;
        if (aProfile == null || bProfile == null) continue;
        const key = JSON.stringify([aKey, bKey].sort());
        if (!scores.has(key)) scores.set(key, compareFixtureProfiles(aProfile, bProfile));
        const similarity = scores.get(key);
        if (similarity == null) continue;
        for (let ai = 0; ai < a.length; ai++)
          for (let bi = x === y ? ai + 1 : 0; bi < b.length; bi++) {
            const [i, j] = [a[ai], b[bi]].sort(ascending);
            if (!focus(items[i].test.id) && !focus(items[j].test.id)) continue;
            add([[i, j]], 'fixture');
            fixtureMatches.set(`${i}:${j}`, similarity);
          }
      }
  }

  const raw = [...sources.values()]
    .sort((p, q) => p.i - q.i || p.j - q.j)
    .filter(({ i, j }) => focus(items[i].test.id) || focus(items[j].test.id))
    .map(({ i, j, found }) => {
      const [x, y] = [items[i], items[j]];
      const shared = intersectionSize(x.blocks, y.blocks);
      const union = x.blocks.length + y.blocks.length - shared;
      const empty = x.blocks.length === 0 || y.blocks.length === 0;
      return {
        a: x.test.id,
        b: y.test.id,
        sources: (['jaccard', 'checks-context', 'body', 'fixture'] as const).filter((s) =>
          found.has(s),
        ),
        ...(fixtureMatches.has(`${i}:${j}`)
          ? { fixtureSimilarity: fixtureMatches.get(`${i}:${j}`) }
          : {}),
        jaccard: empty ? null : shared / union,
        identicalBlocks: shared === x.blocks.length && shared === y.blocks.length,
        pathUnattributable: x.test.concurrent || y.test.concurrent,
      };
    });

  const membersOf = components(raw);
  const groupOf = new Map<string[], CandidateGroup>();
  const pairs: CandidatePair[] = raw.map((pair) => {
    const members = membersOf.get(pair.a) ?? [pair.a, pair.b];
    let group = groupOf.get(members);
    if (group === undefined) {
      group = { id: groupId(members), tests: members, pairs: 0 };
      groupOf.set(members, group);
    }
    group.pairs += 1;
    return { ...pair, sources: [...pair.sources], group: group.id };
  });
  const groups = [...groupOf.values()].sort((p, q) => byText(p.id, q.id));
  const largest = [...groups].sort(
    (p, q) => q.tests.length - p.tests.length || q.pairs - p.pairs || byText(p.id, q.id),
  )[0];
  const count = (wanted: readonly CandidateSource[]): number =>
    pairs.filter((pair) => pair.sources.join() === wanted.join()).length;
  return {
    pairs,
    groups,
    stats: {
      tests: tests.length,
      pairs: pairs.length,
      bySource: {
        jaccard: count(['jaccard']),
        checksContext: count(['checks-context']),
        both: count(['jaccard', 'checks-context']),
        body: pairs.filter(
          (pair) => pair.sources.includes('body') && !pair.sources.includes('fixture'),
        ).length,
        ...(fixtureMatches.size > 0 ? { fixture: fixtureMatches.size } : {}),
      },
      groups: groups.length,
      largestGroup:
        largest === undefined
          ? null
          : { id: largest.id, tests: largest.tests.length, pairs: largest.pairs },
    },
  };
}
