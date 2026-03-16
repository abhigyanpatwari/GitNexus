/**
 * P0 Unit Tests: Knowledge Graph
 *
 * Tests: createKnowledgeGraph() — addNode, getNode, removeNode,
 * iterNodes, addRelationship, removeNodesByFile, counts.
 */
import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { GraphNode, GraphRelationship } from '../../src/core/graph/types.js';

function makeNode(id: string, name: string, filePath: string = 'src/test.ts'): GraphNode {
  return {
    id,
    label: 'Function',
    properties: { name, filePath, startLine: 1, endLine: 10 },
  };
}

function makeRel(src: string, tgt: string, type: GraphRelationship['type'] = 'CALLS'): GraphRelationship {
  return {
    id: `${src}-${type}-${tgt}`,
    sourceId: src,
    targetId: tgt,
    type,
    confidence: 1.0,
    reason: '',
  };
}

describe('createKnowledgeGraph', () => {
  // ─── addNode / getNode ─────────────────────────────────────────────

  it('adds and retrieves a node', () => {
    const g = createKnowledgeGraph();
    const node = makeNode('fn:foo', 'foo');
    g.addNode(node);
    expect(g.getNode('fn:foo')).toBe(node);
  });

  it('returns undefined for unknown node', () => {
    const g = createKnowledgeGraph();
    expect(g.getNode('nonexistent')).toBeUndefined();
  });

  it('duplicate addNode is a no-op', () => {
    const g = createKnowledgeGraph();
    const node1 = makeNode('fn:foo', 'foo');
    const node2 = makeNode('fn:foo', 'bar'); // same ID, different name
    g.addNode(node1);
    g.addNode(node2);
    expect(g.nodeCount).toBe(1);
    expect(g.getNode('fn:foo')!.properties.name).toBe('foo'); // first one wins
  });

  // ─── removeNode ─────────────────────────────────────────────────────

  it('removes a node and its relationships', () => {
    const g = createKnowledgeGraph();
    g.addNode(makeNode('fn:a', 'a'));
    g.addNode(makeNode('fn:b', 'b'));
    g.addRelationship(makeRel('fn:a', 'fn:b'));
    expect(g.relationshipCount).toBe(1);

    const removed = g.removeNode('fn:a');
    expect(removed).toBe(true);
    expect(g.getNode('fn:a')).toBeUndefined();
    expect(g.nodeCount).toBe(1);
    expect(g.relationshipCount).toBe(0); // relationship involving fn:a removed
  });

  it('removeNode returns false for unknown node', () => {
    const g = createKnowledgeGraph();
    expect(g.removeNode('nope')).toBe(false);
  });

  // ─── removeNodesByFile ──────────────────────────────────────────────

  it('removes all nodes belonging to a file', () => {
    const g = createKnowledgeGraph();
    g.addNode(makeNode('fn:a', 'a', 'src/foo.ts'));
    g.addNode(makeNode('fn:b', 'b', 'src/foo.ts'));
    g.addNode(makeNode('fn:c', 'c', 'src/bar.ts'));

    const removed = g.removeNodesByFile('src/foo.ts');
    expect(removed).toBe(2);
    expect(g.nodeCount).toBe(1);
    expect(g.getNode('fn:c')).toBeDefined();
  });

  // ─── iterNodes / iterRelationships ─────────────────────────────────

  it('iterNodes yields all nodes', () => {
    const g = createKnowledgeGraph();
    g.addNode(makeNode('fn:a', 'a'));
    g.addNode(makeNode('fn:b', 'b'));

    const ids = [...g.iterNodes()].map(n => n.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain('fn:a');
    expect(ids).toContain('fn:b');
  });

  it('iterRelationships yields all relationships', () => {
    const g = createKnowledgeGraph();
    g.addNode(makeNode('fn:a', 'a'));
    g.addNode(makeNode('fn:b', 'b'));
    g.addRelationship(makeRel('fn:a', 'fn:b'));

    const rels = [...g.iterRelationships()];
    expect(rels).toHaveLength(1);
    expect(rels[0].sourceId).toBe('fn:a');
  });

  // ─── nodeCount / relationshipCount ─────────────────────────────────

  it('nodeCount reflects current node count', () => {
    const g = createKnowledgeGraph();
    expect(g.nodeCount).toBe(0);
    g.addNode(makeNode('fn:a', 'a'));
    expect(g.nodeCount).toBe(1);
    g.addNode(makeNode('fn:b', 'b'));
    expect(g.nodeCount).toBe(2);
  });

  it('relationshipCount reflects current relationship count', () => {
    const g = createKnowledgeGraph();
    g.addNode(makeNode('fn:a', 'a'));
    g.addNode(makeNode('fn:b', 'b'));
    expect(g.relationshipCount).toBe(0);
    g.addRelationship(makeRel('fn:a', 'fn:b'));
    expect(g.relationshipCount).toBe(1);
  });

  // ─── addRelationship ───────────────────────────────────────────────

  it('duplicate addRelationship is a no-op', () => {
    const g = createKnowledgeGraph();
    g.addNode(makeNode('fn:a', 'a'));
    g.addNode(makeNode('fn:b', 'b'));
    g.addRelationship(makeRel('fn:a', 'fn:b'));
    g.addRelationship(makeRel('fn:a', 'fn:b')); // same ID
    expect(g.relationshipCount).toBe(1);
  });

  // ─── nodes / relationships arrays ──────────────────────────────────

  it('.nodes returns an array copy', () => {
    const g = createKnowledgeGraph();
    g.addNode(makeNode('fn:a', 'a'));
    const arr1 = g.nodes;
    const arr2 = g.nodes;
    expect(arr1).not.toBe(arr2); // different array instances
    expect(arr1).toHaveLength(1);
  });

  it('.relationships returns an array copy', () => {
    const g = createKnowledgeGraph();
    g.addNode(makeNode('fn:a', 'a'));
    g.addNode(makeNode('fn:b', 'b'));
    g.addRelationship(makeRel('fn:a', 'fn:b'));
    const arr1 = g.relationships;
    const arr2 = g.relationships;
    expect(arr1).not.toBe(arr2);
    expect(arr1).toHaveLength(1);
  });

  // ─── forEachNode / forEachRelationship ──────────────────────────────

  it('forEachNode calls fn for every node', () => {
    const g = createKnowledgeGraph();
    g.addNode(makeNode('fn:a', 'a'));
    g.addNode(makeNode('fn:b', 'b'));

    const ids: string[] = [];
    g.forEachNode(n => ids.push(n.id));
    expect(ids).toHaveLength(2);
  });

  it('forEachRelationship calls fn for every relationship', () => {
    const g = createKnowledgeGraph();
    g.addNode(makeNode('fn:a', 'a'));
    g.addNode(makeNode('fn:b', 'b'));
    g.addRelationship(makeRel('fn:a', 'fn:b'));

    const types: string[] = [];
    g.forEachRelationship(r => types.push(r.type));
    expect(types).toEqual(['CALLS']);
  });
});
