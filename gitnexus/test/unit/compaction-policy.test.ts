import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import {
  graphCompactionReason,
  incrementalMutationLimit,
  incrementalMutationRows,
  isGraphCompactionState,
  MAX_INCREMENTAL_MUTATION_ROWS,
  MAX_INCREMENTAL_WRITES,
} from '../../src/core/incremental/compaction-policy.js';

const mib = 1024 * 1024;
const baseline = { version: 1, compactBytes: 200 * mib, incrementalWrites: 0 };

describe('hybrid compaction policy', () => {
  it('scales the mutation budget with graph size for large monorepos', () => {
    const graph = createKnowledgeGraph();
    expect(incrementalMutationLimit(graph)).toBe(2_000);
    for (let i = 0; i < 50_000; i++) {
      graph.addNode({
        id: `f${i}`,
        label: 'Function',
        properties: { name: `f${i}`, filePath: i < 2_100 ? 'changed.ts' : 'other.ts' },
      });
    }
    const limit = incrementalMutationLimit(graph);
    expect(limit).toBe(2_500);
    expect(incrementalMutationRows(graph, new Set(['changed.ts']))).toBe(2_100);
    expect(incrementalMutationRows(graph, new Set(['changed.ts']))).toBeLessThan(limit);
    expect(incrementalMutationRows(graph, new Set(['other.ts']))).toBe(limit);
  });
  it('keeps small edits incremental until the growth or update budget is exhausted', () => {
    expect(graphCompactionReason(baseline, 250 * mib)).toBeUndefined();
    expect(graphCompactionReason(baseline, 300 * mib)).toBeUndefined();
    expect(graphCompactionReason(baseline, 300 * mib + 1)).toContain('physical storage grew');
    expect(
      graphCompactionReason(
        { ...baseline, incrementalWrites: MAX_INCREMENTAL_WRITES - 1 },
        baseline.compactBytes,
      ),
    ).toBeUndefined();
    expect(
      graphCompactionReason(
        { ...baseline, incrementalWrites: MAX_INCREMENTAL_WRITES },
        baseline.compactBytes,
      ),
    ).toContain('incremental writes');
  });

  it('allows fixed native allocation overhead on small repositories, but still bounds growth', () => {
    const small = { ...baseline, compactBytes: 8 * mib };
    expect(graphCompactionReason(small, 24 * mib)).toBeUndefined();
    expect(graphCompactionReason(small, 24 * mib + 1)).toContain('physical storage grew');
    expect(
      graphCompactionReason({ ...small, incrementalWrites: MAX_INCREMENTAL_WRITES }, 8 * mib),
    ).toContain('incremental writes');
  });

  it.each([
    undefined,
    null,
    {},
    { ...baseline, version: 2 },
    { ...baseline, compactBytes: 0 },
    { ...baseline, compactBytes: NaN },
    { ...baseline, compactBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...baseline, incrementalWrites: -1 },
    { ...baseline, incrementalWrites: 0.5 },
    { ...baseline, incrementalWrites: '0' },
  ])('requires a fresh baseline for malformed receipts (%j)', (state) => {
    expect(isGraphCompactionState(state)).toBe(false);
    expect(graphCompactionReason(state, 200 * mib)).toContain('baseline');
  });

  it.each([undefined, 0, -1, NaN, Infinity, 1.5])(
    'cannot infer safety from an unmeasurable size (%s)',
    (bytes) => {
      expect(graphCompactionReason(baseline, bytes)).toContain('could not be measured');
    },
  );

  it('counts endpoint mutations across file boundaries without counting unrelated rows', () => {
    const graph = createKnowledgeGraph();
    for (const [id, filePath] of [
      ['a', 'changed.ts'],
      ['b', 'other.ts'],
      ['c', 'unrelated.ts'],
    ]) {
      graph.addNode({ id, label: 'Function', properties: { name: id, filePath } });
    }
    graph.addRelationship({
      id: 'ab',
      sourceId: 'a',
      targetId: 'b',
      type: 'CALLS',
      confidence: 1,
      reason: '',
      step: 0,
    });
    graph.addRelationship({
      id: 'ba',
      sourceId: 'b',
      targetId: 'a',
      type: 'CALLS',
      confidence: 1,
      reason: '',
      step: 0,
    });
    graph.addRelationship({
      id: 'bc',
      sourceId: 'b',
      targetId: 'c',
      type: 'CALLS',
      confidence: 1,
      reason: '',
      step: 0,
    });
    expect(incrementalMutationRows(graph, new Set(['changed.ts']))).toBe(3);
    expect(incrementalMutationRows(graph, new Set(['changed.ts']), 0)).toBe(0);
    expect(incrementalMutationRows(graph, new Set(['changed.ts', 'other.ts']))).toBe(5);
    expect(incrementalMutationRows(graph, new Set(['missing.ts']))).toBe(0);
  });

  it('caps the estimate for one large source file rather than counting only its file fraction', () => {
    const graph = createKnowledgeGraph();
    for (let i = 0; i < MAX_INCREMENTAL_MUTATION_ROWS + 100; i++) {
      graph.addNode({
        id: `f${i}`,
        label: 'Function',
        properties: { name: `f${i}`, filePath: 'large.ts' },
      });
    }
    expect(incrementalMutationRows(graph, new Set(['large.ts']))).toBe(
      MAX_INCREMENTAL_MUTATION_ROWS,
    );
  });
});
