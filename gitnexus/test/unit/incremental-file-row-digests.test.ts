/**
 * Per-file row digests decide whether an unchanged resolution-group member is
 * rewritten. A digest that misses a changed row leaves a stale index, so these
 * pin what a digest covers and when a recorded digest may be replaced.
 */

import { describe, expect, it } from 'vitest';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import {
  computeFileRowDigests,
  nextFileRowDigests,
} from '../../src/core/incremental/file-row-digests.js';

const node = (id: string, filePath: string | undefined, label = 'Method'): GraphNode => ({
  id,
  label: label as GraphNode['label'],
  properties: { name: id, filePath } as GraphNode['properties'],
});
const edge = (
  sourceId: string,
  targetId: string,
  type = 'CALLS',
  reason = 'test',
): GraphRelationship => ({
  id: `${type}:${sourceId}->${targetId}`,
  sourceId,
  targetId,
  type: type as GraphRelationship['type'],
  confidence: 1,
  reason,
});
function digests(nodes: readonly GraphNode[], edges: readonly GraphRelationship[]) {
  const graph = createKnowledgeGraph();
  nodes.forEach((entry) => graph.addNode(entry));
  edges.forEach((entry) => graph.addRelationship(entry));
  return computeFileRowDigests(graph);
}

const nodes = [node('a', 'A.java'), node('b', 'B.java'), node('c', 'C.java')];

describe('computeFileRowDigests', () => {
  it('does not depend on the order rows were added', () => {
    const forward = digests(nodes, [edge('a', 'b'), edge('a', 'c')]);
    const backward = digests([...nodes].reverse(), [edge('a', 'c'), edge('a', 'b')]);
    expect([...backward]).toEqual(expect.arrayContaining([...forward]));
    expect(backward.size).toBe(forward.size);
  });

  it('changes only the source file when an edge is retargeted', () => {
    const before = digests(nodes, [edge('a', 'b')]);
    const after = digests(nodes, [edge('a', 'c')]);
    expect(after.get('A.java')).not.toBe(before.get('A.java'));
    expect(after.get('B.java')).toBe(before.get('B.java'));
    expect(after.get('C.java')).toBe(before.get('C.java'));
  });

  it.each([
    ['a node label', [node('a', 'A.java', 'Class'), nodes[1], nodes[2]], [edge('a', 'b')]],
    [
      'a node property',
      [
        { ...nodes[0], properties: { ...nodes[0].properties, name: 'renamed' } },
        nodes[1],
        nodes[2],
      ],
      [edge('a', 'b')],
    ],
    ['an added edge', nodes, [edge('a', 'b'), edge('a', 'c')]],
    ['an edge reason', nodes, [edge('a', 'b', 'CALLS', 'other')]],
    ['an edge type', nodes, [edge('a', 'b', 'EXTENDS')]],
  ])('sees a change to %s', (_label, changedNodes, changedEdges) => {
    const before = digests(nodes, [edge('a', 'b')]);
    expect(digests(changedNodes, changedEdges).get('A.java')).not.toBe(before.get('A.java'));
  });

  it('counts duplicate rows, so a removed duplicate is a change', () => {
    const twice = digests([...nodes, node('a2', 'A.java')], [edge('a', 'b'), edge('a2', 'b')]);
    const once = digests([...nodes, node('a2', 'A.java')], [edge('a', 'b')]);
    expect(twice.get('A.java')).not.toBe(once.get('A.java'));
  });

  it('leaves graph-wide rows out, because every run rewrites them anyway', () => {
    const plain = digests(nodes, [edge('a', 'b')]);
    const withDerived = digests(
      [...nodes, node('community', undefined, 'Community')],
      [edge('a', 'b'), edge('a', 'community', 'MEMBER_OF'), edge('a', 'b', 'TAINT_PATH')],
    );
    expect([...withDerived]).toEqual([...plain]);
  });
});

describe('nextFileRowDigests', () => {
  const current = new Map([
    ['A.java', 'new-a'],
    ['B.java', 'new-b'],
    ['C.java', 'new-c'],
  ]);

  it('records every current file after a full write and forgets deleted files', () => {
    expect(nextFileRowDigests({ 'A.java': 'old-a', 'Gone.java': 'old' }, current, 'all')).toEqual({
      'A.java': 'new-a',
      'B.java': 'new-b',
      'C.java': 'new-c',
    });
  });

  it('moves only written files to their new digest', () => {
    expect(
      nextFileRowDigests({ 'A.java': 'old-a', 'B.java': 'old-b' }, current, new Set(['A.java'])),
    ).toEqual({ 'A.java': 'new-a', 'B.java': 'old-b' });
  });

  it('records nothing for an unwritten file with no earlier digest', () => {
    expect(nextFileRowDigests(undefined, current, new Set(['B.java']))).toEqual({
      'B.java': 'new-b',
    });
  });
});
