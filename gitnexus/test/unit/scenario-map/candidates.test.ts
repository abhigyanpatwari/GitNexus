/**
 * Locks Layer 1 candidate retrieval (U4, R3, KTD5, KTD17): exact Jaccard >= 0.99 over block sets
 * (the size-ratio and rare-block prefix filters never drop a qualifying pair), pairs sharing a
 * checks-and-context key whatever their blocks, connected components with deterministic ids, the
 * identical-blocks flag (KTD5 caps a non-identical pair at weak), the path-unattributable flag of
 * concurrent tests (design §5.2), the largest group's size for shard planning, and the focus of a
 * diff-scoped run (pairs without a focused test dropped before the groups form).
 */
import { describe, expect, it } from 'vitest';
import {
  findCandidates,
  jaccard,
  type CandidateTest,
} from '../../../tools/scenario-map/path-coverage/candidates.js';

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, i) => from + i);

const test = (
  id: string,
  blocks: readonly number[],
  extra: Partial<Omit<CandidateTest, 'id' | 'blocks'>> = {},
): CandidateTest => ({
  id,
  blocks: [...blocks].sort((a, b) => a - b),
  concurrent: false,
  checksContext: null,
  ...extra,
});

const pairsOf = (tests: readonly CandidateTest[]): [string, string][] =>
  findCandidates(tests).pairs.map((pair) => [pair.a, pair.b]);

/** mulberry32: a fixed-seed PRNG, so the corpus is the same on every run. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 12 families of 6 near-copies: each copy drops ~0.3% of its family's blocks and adds 0-3 (about 60 pairs qualify, about 120 miss narrowly). */
function nearDuplicateCorpus(seed: number): CandidateTest[] {
  const random = prng(seed);
  return range(0, 12).flatMap((base) => {
    const core = range(base * 1000, base * 1000 + 150 + base * 10);
    return range(0, 6).map((copy) => {
      const kept = core.filter(() => random() > 0.003);
      const extra = range(0, 3)
        .filter(() => random() > 0.8)
        .map((i) => 900_000 + base * 100 + copy * 10 + i);
      return test(`t${base}-${copy}`, [...kept, ...extra]);
    });
  });
}

/** Every pair at Jaccard >= 0.99 by exhaustive comparison, ids ordered, sorted. */
function bruteForcePairs(tests: readonly CandidateTest[]): [string, string][] {
  const ids = (x: CandidateTest, y: CandidateTest): [string, string] =>
    x.id < y.id ? [x.id, y.id] : [y.id, x.id];
  return tests
    .flatMap((x, i) => tests.slice(i + 1).map((y) => ({ x, y })))
    .filter(({ x, y }) => jaccard(x.blocks, y.blocks) >= 0.99)
    .map(({ x, y }) => ids(x, y))
    .sort((p, q) => (p.join('\0') < q.join('\0') ? -1 : 1));
}

describe('jaccard', () => {
  it.each([
    { name: 'identical', a: [1, 2, 3], b: [1, 2, 3], expected: 1 },
    { name: 'half overlap', a: [1, 2, 3], b: [2, 3, 4], expected: 0.5 },
    { name: 'disjoint', a: [1], b: [2], expected: 0 },
  ])('computes $name sets', ({ a, b, expected }) => {
    expect(jaccard(a, b)).toBe(expected);
  });
});

describe('findCandidates: Jaccard source', () => {
  it.each([
    { name: 'one block removed (199/200)', b: range(0, 199) },
    { name: 'one block replaced (199/201)', b: [...range(0, 199), 500] },
  ])('makes a pair that differs by 1 in 200 a candidate: $name', ({ b }) => {
    const result = findCandidates([test('a', range(0, 200)), test('b', b)]);
    expect(result.pairs).toEqual([
      expect.objectContaining({
        a: 'a',
        b: 'b',
        sources: ['jaccard'],
        identicalBlocks: false,
        pathUnattributable: false,
      }),
    ]);
    expect(result.pairs[0].jaccard).toBeGreaterThanOrEqual(0.99);
  });

  it.each([
    { name: 'three blocks removed (197/200)', b: range(0, 197) },
    { name: 'three blocks replaced (197/203)', b: [...range(0, 197), 500, 501, 502] },
  ])('does not pair sets that differ by 3 in 200: $name', ({ b }) => {
    expect(pairsOf([test('a', range(0, 200)), test('b', b)])).toEqual([]);
  });

  it('accepts a pair exactly at the threshold (99/100)', () => {
    expect(pairsOf([test('a', range(0, 100)), test('b', range(0, 99))])).toEqual([['a', 'b']]);
  });

  it('marks identical block sets and never pairs empty ones through Jaccard', () => {
    const result = findCandidates([
      test('a', [3, 4, 5]),
      test('b', [3, 4, 5]),
      test('c', []),
      test('d', []),
    ]);
    expect(result.pairs).toEqual([
      expect.objectContaining({ a: 'a', b: 'b', jaccard: 1, identicalBlocks: true }),
    ]);
  });

  it('finds exactly the brute-force pairs on a seeded near-duplicate corpus', () => {
    const corpus = nearDuplicateCorpus(20261024);
    const brute = bruteForcePairs(corpus);
    expect(brute.length).toBeGreaterThan(40);
    expect(pairsOf(corpus)).toEqual(brute);
  });
});

describe('findCandidates: checks-and-context source', () => {
  it('pairs tests with Jaccard 0.5 that share a checks-and-context key', () => {
    const result = findCandidates([
      test('a', [1, 2, 3], { checksContext: 'k1' }),
      test('b', [2, 3, 4], { checksContext: 'k1' }),
      test('c', [2, 3, 4], { checksContext: 'k2' }),
    ]);
    expect(result.pairs).toEqual([
      expect.objectContaining({ a: 'a', b: 'b', sources: ['checks-context'], jaccard: 0.5 }),
      expect.objectContaining({ a: 'b', b: 'c', sources: ['jaccard'], jaccard: 1 }),
    ]);
  });

  it('records both sources on a pair found twice', () => {
    const result = findCandidates([
      test('a', [1, 2], { checksContext: 'k' }),
      test('b', [1, 2], { checksContext: 'k' }),
    ]);
    expect(result.pairs.map((pair) => pair.sources)).toEqual([['jaccard', 'checks-context']]);
    expect(result.stats.bySource).toEqual({ jaccard: 0, checksContext: 0, both: 1 });
  });
});

describe('findCandidates: groups', () => {
  const chain = [
    test('a', range(0, 200)),
    test('b', range(1, 201)),
    test('c', range(2, 202)),
    test('lone', range(5000, 5010)),
  ];

  it('makes A-B and B-C one group of three with exactly two pairs when A-C misses', () => {
    const result = findCandidates(chain);
    expect(jaccard(chain[0].blocks, chain[2].blocks)).toBeLessThan(0.99);
    expect(pairsOf(chain)).toEqual([
      ['a', 'b'],
      ['b', 'c'],
    ]);
    expect(result.groups).toEqual([
      { id: result.pairs[0].group, tests: ['a', 'b', 'c'], pairs: 2 },
    ]);
    expect(result.pairs.map((pair) => pair.group)).toEqual([
      result.groups[0].id,
      result.groups[0].id,
    ]);
    expect(result.stats).toMatchObject({
      tests: 4,
      pairs: 2,
      groups: 1,
      largestGroup: { id: result.groups[0].id, tests: 3, pairs: 2 },
    });
  });

  it('gives the same pairs and group ids whatever the input order', () => {
    expect(findCandidates([...chain].reverse())).toEqual(findCandidates(chain));
  });

  it('picks the largest group by test count, then pair count', () => {
    const result = findCandidates([
      ...chain,
      test('x', [1], { checksContext: 'k' }),
      test('y', [2], { checksContext: 'k' }),
    ]);
    expect(result.groups.map((group) => group.tests.length).sort()).toEqual([2, 3]);
    expect(result.stats.largestGroup).toMatchObject({ tests: 3, pairs: 2 });
  });
});

describe('findCandidates: concurrent tests', () => {
  it('flags every pair of a concurrent test as path-unattributable', () => {
    const result = findCandidates([
      test('a', [1, 2], { checksContext: 'k' }),
      test('b', [1, 2], { checksContext: 'k', concurrent: true }),
      test('c', [7, 8], { checksContext: 'k' }),
    ]);
    expect(result.pairs.map((pair) => [pair.a, pair.b, pair.pathUnattributable])).toEqual([
      ['a', 'b', true],
      ['a', 'c', false],
      ['b', 'c', true],
    ]);
  });
});

describe('findCandidates: focus', () => {
  it('keeps only pairs with a focused test, and groups only those', () => {
    const result = findCandidates(
      [
        test('a', [1, 2], { checksContext: 'k' }),
        test('b', [1, 2], { checksContext: 'k' }),
        test('c', [1, 2], { checksContext: 'k' }),
        test('d', [7, 8], { checksContext: 'j' }),
        test('e', [7, 8], { checksContext: 'j' }),
      ],
      (id) => id === 'a',
    );
    expect([
      result.pairs.map((pair) => [pair.a, pair.b]),
      result.groups.map((group) => group.tests),
    ]).toEqual([
      [
        ['a', 'b'],
        ['a', 'c'],
      ],
      [['a', 'b', 'c']],
    ]);
  });
});
