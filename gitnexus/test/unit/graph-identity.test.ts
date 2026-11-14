import { describe, expect, it } from 'vitest';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { graphIdentity } from '../helpers/graph-identity.js';

const node = (id: string, properties: Record<string, unknown>): GraphNode =>
  ({ id, label: 'Class', properties }) as GraphNode;
const rel = (id: string, extra: Partial<GraphRelationship> = {}): GraphRelationship => ({
  id,
  sourceId: 'a',
  targetId: 'b',
  type: 'CALLS',
  confidence: 1,
  reason: 'r',
  ...extra,
});
const graph = (nodes: GraphNode[], relationships: GraphRelationship[]) => ({
  iterNodes: () => nodes,
  iterRelationships: () => relationships,
});

describe('graphIdentity', () => {
  const nodes = [node('a', { name: 'A', filePath: 'a.ts' }), node('b', { name: 'B' })];
  const rels = [rel('1'), rel('2', { targetId: 'a' })];
  const base = graphIdentity(graph(nodes, rels));

  it('ignores the order nodes and relationships are stored in', () => {
    expect(graphIdentity(graph([...nodes].reverse(), [...rels].reverse()))).toEqual(base);
  });

  it('ignores the order of property keys', () => {
    const reordered = [node('a', { filePath: 'a.ts', name: 'A' }), nodes[1]!];
    expect(graphIdentity(graph(reordered, rels))).toEqual(base);
  });

  it.each([
    { change: 'an endpoint', relationships: [rel('1', { targetId: 'c' }), rels[1]!] },
    { change: 'an edge type', relationships: [rel('1', { type: 'IMPORTS' }), rels[1]!] },
    { change: 'a confidence', relationships: [rel('1', { confidence: 0.5 }), rels[1]!] },
    { change: 'a reason', relationships: [rel('1', { reason: 'other' }), rels[1]!] },
    { change: 'a missing edge', relationships: [rels[0]!] },
    { change: 'a duplicated edge', relationships: [...rels, rels[0]!] },
  ])('tells graphs apart by $change', ({ relationships }) => {
    expect(graphIdentity(graph(nodes, relationships))).not.toEqual(base);
  });

  it('tells graphs apart by a node property', () => {
    const changed = [node('a', { name: 'A', filePath: 'other.ts' }), nodes[1]!];
    expect(graphIdentity(graph(changed, rels))).not.toEqual(base);
  });

  it('keeps the order of array-valued properties, which is content', () => {
    const first = graphIdentity(graph([node('a', { params: ['x', 'y'] })], []));
    const second = graphIdentity(graph([node('a', { params: ['y', 'x'] })], []));
    expect(second).not.toEqual(first);
  });
});
