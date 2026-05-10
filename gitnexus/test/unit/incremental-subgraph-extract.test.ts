import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { extractChangedSubgraph } from '../../src/core/incremental/subgraph-extract.js';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';

const fileNode = (
  id: string,
  filePath: string,
  label: GraphNode['label'] = 'Function',
): GraphNode => ({
  id,
  label,
  properties: { name: id, filePath },
});

const wideNode = (id: string, label: GraphNode['label']): GraphNode => ({
  id,
  label,
  properties: { name: id },
});

const rel = (
  id: string,
  type: GraphRelationship['type'],
  src: string,
  dst: string,
): GraphRelationship => ({
  id,
  type,
  sourceId: src,
  targetId: dst,
  confidence: 1,
  reason: 't',
});

describe('extractChangedSubgraph', () => {
  it('keeps file nodes whose filePath is in the writable set', () => {
    const g = createKnowledgeGraph();
    g.addNode(fileNode('Function:a.ts:foo', 'a.ts'));
    g.addNode(fileNode('Function:b.ts:bar', 'b.ts'));
    g.addNode(fileNode('Function:c.ts:baz', 'c.ts'));

    const sub = extractChangedSubgraph(g, new Set(['a.ts', 'c.ts']));
    expect(sub.nodeCount).toBe(2);
    expect(sub.getNode('Function:a.ts:foo')).toBeDefined();
    expect(sub.getNode('Function:c.ts:baz')).toBeDefined();
    expect(sub.getNode('Function:b.ts:bar')).toBeUndefined();
  });

  it('always keeps Community and Process nodes (regenerated graph-wide)', () => {
    const g = createKnowledgeGraph();
    g.addNode(fileNode('Function:a.ts:foo', 'a.ts'));
    g.addNode(wideNode('comm_1', 'Community'));
    g.addNode(wideNode('proc_1', 'Process'));

    // Empty writable set: only graph-wide nodes survive
    const sub = extractChangedSubgraph(g, new Set());
    expect(sub.getNode('Function:a.ts:foo')).toBeUndefined();
    expect(sub.getNode('comm_1')).toBeDefined();
    expect(sub.getNode('proc_1')).toBeDefined();
  });

  it('keeps edges where at least one endpoint is in the writable subgraph', () => {
    const g = createKnowledgeGraph();
    g.addNode(fileNode('Function:a.ts:foo', 'a.ts'));
    g.addNode(fileNode('Function:b.ts:bar', 'b.ts'));
    g.addNode(fileNode('Function:c.ts:baz', 'c.ts'));
    g.addRelationship(rel('r-ab', 'CALLS', 'Function:a.ts:foo', 'Function:b.ts:bar'));
    g.addRelationship(rel('r-bc', 'CALLS', 'Function:b.ts:bar', 'Function:c.ts:baz'));
    g.addRelationship(rel('r-ac', 'CALLS', 'Function:a.ts:foo', 'Function:c.ts:baz'));

    const sub = extractChangedSubgraph(g, new Set(['a.ts']));
    // r-ab: src in a.ts (writable) → kept
    // r-ac: src in a.ts (writable) → kept
    // r-bc: src in b.ts, dst in c.ts (both unchanged) → dropped
    const rels = [...sub.iterRelationships()].map((r) => r.id).sort();
    expect(rels).toEqual(['r-ab', 'r-ac']);
  });

  it('keeps MEMBER_OF edges (Community endpoints are graph-wide)', () => {
    const g = createKnowledgeGraph();
    g.addNode(fileNode('Function:a.ts:foo', 'a.ts'));
    g.addNode(fileNode('Function:b.ts:bar', 'b.ts'));
    g.addNode(wideNode('comm_1', 'Community'));
    // Both functions are members of the same community
    g.addRelationship(rel('r-a-comm', 'MEMBER_OF', 'Function:a.ts:foo', 'comm_1'));
    g.addRelationship(rel('r-b-comm', 'MEMBER_OF', 'Function:b.ts:bar', 'comm_1'));

    const sub = extractChangedSubgraph(g, new Set(['a.ts']));
    // r-a-comm: src in a.ts (writable) — kept
    // r-b-comm: src in b.ts (NOT writable) but dst is graph-wide (Community is in writable subgraph) — kept
    const rels = [...sub.iterRelationships()].map((r) => r.id).sort();
    expect(rels).toEqual(['r-a-comm', 'r-b-comm']);
  });

  it('produces an empty subgraph when no nodes match', () => {
    const g = createKnowledgeGraph();
    g.addNode(fileNode('Function:a.ts:foo', 'a.ts'));
    g.addRelationship(rel('r1', 'CALLS', 'Function:a.ts:foo', 'Function:a.ts:foo'));

    const sub = extractChangedSubgraph(g, new Set(['nonexistent.ts']));
    expect(sub.nodeCount).toBe(0);
    expect(sub.relationshipCount).toBe(0);
  });
});
