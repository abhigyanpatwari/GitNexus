import { describe, expect, it } from 'vitest';
import {
  IMPORT_CYCLE_LIMIT,
  IMPORT_CYCLE_WORK_LIMIT,
  findImportCycles,
  type ImportCycleReport,
} from '../../src/core/graph/import-cycles.js';

/**
 * Unwrap a report that must be a COMPLETE enumeration. Written as an assertion
 * rather than a conditional so a degraded report fails the test instead of
 * silently yielding a representative list that looks like an answer.
 */
function cyclesOf(report: ImportCycleReport): readonly string[][] {
  expect(report.enumeration).toBe('complete');
  return (report as Extract<ImportCycleReport, { enumeration: 'complete' }>).cycles;
}

function componentCountOf(report: ImportCycleReport): number {
  expect(report.enumeration).toBe('complete');
  return (report as Extract<ImportCycleReport, { enumeration: 'complete' }>).componentCount;
}

/** Unwrap a report that must have degraded to one cycle per component. */
function representativesOf(report: ImportCycleReport): readonly string[][] {
  expect(report.enumeration).toBe('component-representatives');
  return (report as Extract<ImportCycleReport, { enumeration: 'component-representatives' }>)
    .cycles;
}

/** Every consecutive pair of a reported cycle that is NOT an edge of the graph. */
function fabricatedSteps(
  cycles: readonly string[][],
  edges: readonly { source: string; target: string }[],
): string[] {
  const present = new Set(edges.map(({ source, target }) => `${source}>${target}`));
  return cycles
    .flatMap((cycle) => cycle.slice(0, -1).map((node, index) => `${node}>${cycle[index + 1]}`))
    .filter((step) => !present.has(step));
}

/** `a -> b` for every pair in a `a b` space-separated line, for readable fixtures. */
function edgesOf(...pairs: string[]): { source: string; target: string }[] {
  return pairs.map((pair) => {
    const [source, target] = pair.split(' ');
    return { source, target };
  });
}

describe('findImportCycles', () => {
  it('reports no cycles for a DAG', () => {
    const report = findImportCycles(edgesOf('a b', 'b c', 'a c', 'c d'));
    expect(cyclesOf(report)).toEqual([]);
    expect(componentCountOf(report)).toBe(0);
  });

  it('reports a self-import as a one-node cycle', () => {
    expect(cyclesOf(findImportCycles(edgesOf('a a')))).toEqual([['a', 'a']]);
  });

  it('deduplicates repeated edges', () => {
    expect(cyclesOf(findImportCycles(edgesOf('a a', 'a a', 'a a')))).toEqual([['a', 'a']]);
  });

  it('reports a two-node cycle', () => {
    expect(cyclesOf(findImportCycles(edgesOf('a b', 'b a')))).toEqual([['a', 'b', 'a']]);
  });

  it('reports a self-import alongside the larger cycle that shares its node', () => {
    // `a`'s self-loop and the a->b->a cycle are distinct elementary cycles that
    // live in one strongly connected component. Reporting one component-
    // representative would show only one of them.
    const report = findImportCycles(edgesOf('a a', 'a b', 'b a'));
    expect(cyclesOf(report)).toEqual([
      ['a', 'a'],
      ['a', 'b', 'a'],
    ]);
    expect(componentCountOf(report)).toBe(1);
  });

  it('reports both loops of a figure-eight sharing one node', () => {
    // a->b->a and a->c->a meet only at `a`: one SCC, two elementary cycles.
    const report = findImportCycles(edgesOf('a b', 'b a', 'a c', 'c a'));
    expect(cyclesOf(report)).toEqual([
      ['a', 'b', 'a'],
      ['a', 'c', 'a'],
    ]);
    expect(componentCountOf(report)).toBe(1);
  });

  it('reports two disjoint cycles as two components', () => {
    const report = findImportCycles(edgesOf('y z', 'z y', 'b a', 'a b'));
    expect(cyclesOf(report)).toEqual([
      ['a', 'b', 'a'],
      ['y', 'z', 'y'],
    ]);
    expect(componentCountOf(report)).toBe(2);
  });

  it('reports every elementary cycle of a three-node complete digraph', () => {
    // K3 has exactly five elementary cycles: three 2-cycles and two 3-cycles
    // (the two orientations of the triangle). Counted by hand.
    const report = findImportCycles(edgesOf('a b', 'b a', 'a c', 'c a', 'b c', 'c b'));
    expect(cyclesOf(report)).toEqual([
      ['a', 'b', 'a'],
      ['a', 'b', 'c', 'a'],
      ['a', 'c', 'a'],
      ['a', 'c', 'b', 'a'],
      ['b', 'c', 'b'],
    ]);
    expect(componentCountOf(report)).toBe(1);
  });

  it('reports nested cycles that share a chain of nodes', () => {
    // One SCC on a-b-c-d: the outer 4-cycle a->b->c->d->a, the inner 3-cycle
    // a->b->c->a via the c->a chord, and the inner 2-cycle a->b->a via b->a.
    const report = findImportCycles(edgesOf('a b', 'b c', 'c d', 'd a', 'c a', 'b a'));
    expect(cyclesOf(report)).toEqual([
      ['a', 'b', 'a'],
      ['a', 'b', 'c', 'a'],
      ['a', 'b', 'c', 'd', 'a'],
    ]);
    expect(componentCountOf(report)).toBe(1);
  });

  it('reports a cycle once regardless of which node the walk could enter it from', () => {
    // Three entry points (x, y, z) all lead into the same b->c->d->b triangle.
    // Rotation normalization roots it at its least node and emits it once.
    const report = findImportCycles(
      edgesOf('x b', 'y c', 'z d', 'b c', 'c d', 'd b', 'a x', 'a y', 'a z'),
    );
    expect(cyclesOf(report)).toEqual([['b', 'c', 'd', 'b']]);
  });

  it('roots every cycle at its lexicographically smallest node', () => {
    // The only cycle is m->n->k->m. Its smallest node is `k`, so that is where
    // the reported rotation starts and closes — not `m`, the edge-list head.
    expect(cyclesOf(findImportCycles(edgesOf('m n', 'n k', 'k m')))).toEqual([
      ['k', 'm', 'n', 'k'],
    ]);
  });

  it('produces identical output for the same input twice', () => {
    const edges = edgesOf('a b', 'b c', 'c a', 'c b', 'b a', 'd e', 'e d', 'e e');
    expect(JSON.stringify(findImportCycles(edges))).toBe(JSON.stringify(findImportCycles(edges)));
  });

  it('produces identical output regardless of edge input order', () => {
    // Determinism must come from the graph, not from the order rows arrived in.
    const edges = edgesOf('a b', 'b c', 'c a', 'c b', 'b a');
    expect(JSON.stringify(findImportCycles(edges))).toBe(
      JSON.stringify(findImportCycles([...edges].reverse())),
    );
  });

  it('counts every elementary cycle of a complete digraph', () => {
    // K_n has sum over k=2..n of C(n,k) * (k-1)! elementary cycles.
    // For n = 5 that is 10*1 + 10*2 + 5*6 + 1*24 = 84.
    const nodes = ['a', 'b', 'c', 'd', 'e'];
    const edges = nodes.flatMap((source) =>
      nodes.filter((target) => target !== source).map((target) => ({ source, target })),
    );
    expect(cyclesOf(findImportCycles(edges))).toHaveLength(84);
  });

  it('never emits the same cycle under two rotations', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'];
    const edges = nodes.flatMap((source) =>
      nodes.filter((target) => target !== source).map((target) => ({ source, target })),
    );
    // Canonicalize independently of the implementation's own rule: drop the
    // repeated tail, then rotate to the smallest node. Duplicates under any
    // rotation would collapse here and shrink the set.
    const canonical = cyclesOf(findImportCycles(edges)).map((cycle) => {
      const body = cycle.slice(0, -1);
      const pivot = body.indexOf([...body].sort()[0]);
      return [...body.slice(pivot), ...body.slice(0, pivot)].join('>');
    });
    expect(new Set(canonical).size).toBe(canonical.length);
  });

  it('closes every reported cycle back onto its first node', () => {
    const cycles = cyclesOf(findImportCycles(edgesOf('a b', 'b c', 'c a', 'c b', 'a a')));
    expect(cycles.map((cycle) => cycle[0] === cycle[cycle.length - 1])).toEqual(
      cycles.map(() => true),
    );
  });

  it('reports every node of a reported cycle exactly once', () => {
    const cycles = cyclesOf(findImportCycles(edgesOf('a b', 'b c', 'c a', 'c b', 'b a')));
    expect(cycles.map((cycle) => new Set(cycle.slice(0, -1)).size)).toEqual(
      cycles.map((cycle) => cycle.length - 1),
    );
  });

  it('reports only edges that exist between consecutive nodes of a cycle', () => {
    const edges = edgesOf('a b', 'b c', 'c a', 'c b', 'b a', 'a c');
    const present = new Set(edges.map(({ source, target }) => `${source}>${target}`));
    const steps = cyclesOf(findImportCycles(edges)).flatMap((cycle) =>
      cycle.slice(0, -1).map((node, index) => `${node}>${cycle[index + 1]}`),
    );
    expect(steps.filter((step) => !present.has(step))).toEqual([]);
  });

  it('improves on one-cycle-per-component reporting for a single tangled component', () => {
    // The regression this replaces: a->b->c->d->a plus a->z->a is ONE strongly
    // connected component, and the previous implementation returned exactly one
    // BFS path for it — hiding the other four cycles. All five are elementary,
    // all five must be reported, and they are all in one component.
    const report = findImportCycles(
      edgesOf('a b', 'b c', 'c d', 'd a', 'a z', 'z a', 'b d', 'd b'),
    );
    expect(componentCountOf(report)).toBe(1);
    expect(cyclesOf(report)).toEqual([
      ['a', 'b', 'c', 'd', 'a'],
      ['a', 'b', 'd', 'a'],
      ['a', 'z', 'a'],
      ['b', 'c', 'd', 'b'],
      ['b', 'd', 'b'],
    ]);
  });

  it('does not return a shortened elementary-cycle list when the cap is reached', () => {
    // K5 has 84 cycles; a cap of 10 must not yield a 10-item list.
    const nodes = ['a', 'b', 'c', 'd', 'e'];
    const edges = nodes.flatMap((source) =>
      nodes.filter((target) => target !== source).map((target) => ({ source, target })),
    );
    expect(findImportCycles(edges, 10)).toEqual({
      enumeration: 'component-representatives',
      reason: 'cycles',
      limit: 10,
      componentCount: 1,
      cycles: [['a', 'b', 'a']],
    });
  });

  it('carries no count of elementary cycles when capped', () => {
    // The point of failing closed: there is no field a caller could mistake for
    // a complete answer.
    const report = findImportCycles(edgesOf('a b', 'b a', 'a c', 'c a'), 1);
    // The degraded report carries a list, but the type says what kind, and it
    // carries NO count of elementary cycles -- there is no field a caller could
    // read a cycle count from.
    expect(Object.keys(report).sort()).toEqual([
      'componentCount',
      'cycles',
      'enumeration',
      'limit',
      'reason',
    ]);
  });

  it('completes rather than capping when the cycle count exactly equals the cap', () => {
    // Boundary: 2 cycles under a cap of 2 is a complete answer, not an overflow.
    expect(cyclesOf(findImportCycles(edgesOf('a b', 'b a', 'a c', 'c a'), 2))).toHaveLength(2);
  });

  it('caps a graph whose cycle count exceeds the default limit', () => {
    // K9 has 109_600 elementary cycles, well past IMPORT_CYCLE_LIMIT.
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const edges = nodes.flatMap((source) =>
      nodes.filter((target) => target !== source).map((target) => ({ source, target })),
    );
    expect(findImportCycles(edges)).toEqual({
      enumeration: 'component-representatives',
      reason: 'cycles',
      limit: IMPORT_CYCLE_LIMIT,
      componentCount: 1,
      cycles: [['a', 'b', 'a']],
    });
  });

  it('fails closed on the work budget even when few cycles have been found', () => {
    // The cycle cap alone cannot bound runtime: this graph has exactly one
    // cycle, so no cycle count would ever stop it. Only the work budget does.
    const size = 400;
    const edges = Array.from({ length: size }, (_, index) => ({
      source: `r${String(index).padStart(4, '0')}`,
      target: `r${String((index + 1) % size).padStart(4, '0')}`,
    }));
    expect(findImportCycles(edges, IMPORT_CYCLE_LIMIT, 50)).toEqual({
      // The budget ran out inside the very first decomposition, so not even the
      // tangle count is known -- and it reports nothing rather than zero.
      enumeration: 'none',
      reason: 'work',
      limit: 50,
    });
  });

  it('reports which bound stopped the search', () => {
    const edges = edgesOf('a b', 'b a', 'a c', 'c a', 'b c', 'c b');
    const byCycles = findImportCycles(edges, 1, IMPORT_CYCLE_WORK_LIMIT);
    const byWork = findImportCycles(edges, IMPORT_CYCLE_LIMIT, 3);
    expect([byCycles, byWork]).toEqual([
      {
        enumeration: 'component-representatives',
        reason: 'cycles',
        limit: 1,
        componentCount: 1,
        cycles: [['a', 'b', 'a']],
      },
      { enumeration: 'none', reason: 'work', limit: 3 },
    ]);
  });

  it('leaves the default work budget untouched by a realistic import graph', () => {
    // 100k files in a chain with fan-out, plus a handful of real tangles: the
    // shape `check` actually runs on must finish, not trip the budget.
    const size = 100_000;
    const edges = Array.from({ length: size - 1 }, (_, index) => ({
      source: `src/${String(index).padStart(6, '0')}.ts`,
      target: `src/${String(index + 1).padStart(6, '0')}.ts`,
    }));
    edges.push(
      { source: 'src/000500.ts', target: 'src/000100.ts' },
      { source: 'src/030000.ts', target: 'src/029000.ts' },
    );
    expect(cyclesOf(findImportCycles(edges))).toHaveLength(2);
  });

  it('degrades to one representative per component when the cycle cap is exceeded', () => {
    // Two independent tangles, six cycles between them, a cap of 2. The list is
    // withheld, but the number a reader acts on survives.
    const report = findImportCycles(
      edgesOf('a b', 'b a', 'a c', 'c a', 'b c', 'c b', 'y z', 'z y'),
      2,
    );
    expect(report).toEqual({
      enumeration: 'component-representatives',
      reason: 'cycles',
      limit: 2,
      componentCount: 2,
      cycles: [
        ['a', 'b', 'a'],
        ['y', 'z', 'y'],
      ],
    });
  });

  it('returns exactly one representative per cyclic component when capped', () => {
    // Four independent tangles, each with several elementary cycles. Capped at
    // 1, the report must name all four -- not the one it managed to enumerate.
    const edges = edgesOf(
      'a b',
      'b a',
      'a c',
      'c a',
      'b c',
      'c b',
      'j k',
      'k j',
      'j l',
      'l j',
      'p q',
      'q r',
      'r p',
      'r q',
      'q p',
      's s',
    );
    const report = findImportCycles(edges, 1);
    expect(representativesOf(report)).toEqual([
      ['a', 'b', 'a'],
      ['j', 'k', 'j'],
      ['p', 'q', 'p'],
      ['s', 's'],
    ]);
    expect(
      (report as Extract<ImportCycleReport, { enumeration: 'component-representatives' }>)
        .componentCount,
    ).toBe(4);
  });

  it('reports representatives that are real cycles in the input graph', () => {
    // A representative is only useful if a reader can follow it. Every
    // consecutive pair must be an actual import edge, and it must close.
    const edges = edgesOf('a b', 'b c', 'c a', 'c b', 'b a', 'a d', 'd a', 'm n', 'n o', 'o m');
    const representatives = representativesOf(findImportCycles(edges, 1));
    expect(fabricatedSteps(representatives, edges)).toEqual([]);
    expect(representatives.map((cycle) => cycle[0] === cycle[cycle.length - 1])).toEqual(
      representatives.map(() => true),
    );
  });

  it('picks the shortest cycle through each component root as its representative', () => {
    // The component holds a 2-cycle and a 4-cycle through `a`. BFS must return
    // the short one -- a representative exists to be read, so length matters.
    const report = findImportCycles(edgesOf('a b', 'b c', 'c d', 'd a', 'a z', 'z a'), 1);
    expect(representativesOf(report)).toEqual([['a', 'z', 'a']]);
  });

  it('roots representatives at the component least node, like the complete list', () => {
    const report = findImportCycles(edgesOf('m n', 'n k', 'k m', 'm k'), 1);
    expect(representativesOf(report)).toEqual([['k', 'm', 'k']]);
  });

  it('produces identical degraded output for the same input twice', () => {
    const edges = edgesOf('a b', 'b c', 'c a', 'c b', 'b a', 'd e', 'e d');
    expect(JSON.stringify(findImportCycles(edges, 1))).toBe(
      JSON.stringify(findImportCycles(edges, 1)),
    );
  });

  it('handles deep import graphs without recursive traversal', () => {
    const size = 20_000;
    const edges = Array.from({ length: size - 1 }, (_, index) => ({
      source: `src/${index}.ts`,
      target: `src/${index + 1}.ts`,
    }));
    expect(cyclesOf(findImportCycles(edges))).toEqual([]);
  });

  it('handles a single deep cycle without recursive traversal', () => {
    // One 20k-node cycle: the search stack reaches full depth before closing.
    const size = 20_000;
    const edges = Array.from({ length: size }, (_, index) => ({
      source: `src/${String(index).padStart(6, '0')}.ts`,
      target: `src/${String((index + 1) % size).padStart(6, '0')}.ts`,
    }));
    expect(cyclesOf(findImportCycles(edges))).toHaveLength(1);
  });

  it('ignores edges with an empty endpoint', () => {
    expect(
      cyclesOf(findImportCycles([...edgesOf('a b', 'b a'), { source: '', target: 'a' }])),
    ).toEqual([['a', 'b', 'a']]);
  });
});
