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

function makeRel(
  src: string,
  tgt: string,
  type: GraphRelationship['type'] = 'CALLS',
): GraphRelationship {
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

    const ids = [...g.iterNodes()].map((n) => n.id);
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
    g.forEachNode((n) => ids.push(n.id));
    expect(ids).toHaveLength(2);
  });

  it('forEachRelationship calls fn for every relationship', () => {
    const g = createKnowledgeGraph();
    g.addNode(makeNode('fn:a', 'a'));
    g.addNode(makeNode('fn:b', 'b'));
    g.addRelationship(makeRel('fn:a', 'fn:b'));

    const types: string[] = [];
    g.forEachRelationship((r) => types.push(r.type));
    expect(types).toEqual(['CALLS']);
  });

  // ─── removeRelationship ─────────────────────────────────────────────

  it('removes a relationship by id', () => {
    const g = createKnowledgeGraph();
    g.addNode(makeNode('fn:a', 'a'));
    g.addNode(makeNode('fn:b', 'b'));
    g.addRelationship(makeRel('fn:a', 'fn:b'));
    expect(g.relationshipCount).toBe(1);

    const removed = g.removeRelationship('fn:a-CALLS-fn:b');
    expect(removed).toBe(true);
    expect(g.relationshipCount).toBe(0);
  });

  it('removeRelationship returns false for unknown id', () => {
    const g = createKnowledgeGraph();
    expect(g.removeRelationship('nonexistent')).toBe(false);
  });

  it('removeRelationship returns false on second call with same id', () => {
    const g = createKnowledgeGraph();
    g.addNode(makeNode('fn:a', 'a'));
    g.addNode(makeNode('fn:b', 'b'));
    g.addRelationship(makeRel('fn:a', 'fn:b'));

    expect(g.removeRelationship('fn:a-CALLS-fn:b')).toBe(true);
    expect(g.removeRelationship('fn:a-CALLS-fn:b')).toBe(false);
  });

  it('removeRelationship does not affect nodes', () => {
    const g = createKnowledgeGraph();
    g.addNode(makeNode('fn:a', 'a'));
    g.addNode(makeNode('fn:b', 'b'));
    g.addRelationship(makeRel('fn:a', 'fn:b'));

    g.removeRelationship('fn:a-CALLS-fn:b');
    expect(g.nodeCount).toBe(2);
    expect(g.getNode('fn:a')).toBeDefined();
    expect(g.getNode('fn:b')).toBeDefined();
  });

  it('removeRelationship leaves other relationships intact', () => {
    const g = createKnowledgeGraph();
    g.addNode(makeNode('fn:a', 'a'));
    g.addNode(makeNode('fn:b', 'b'));
    g.addNode(makeNode('fn:c', 'c'));
    g.addRelationship(makeRel('fn:a', 'fn:b'));
    g.addRelationship(makeRel('fn:b', 'fn:c'));
    expect(g.relationshipCount).toBe(2);

    g.removeRelationship('fn:a-CALLS-fn:b');
    expect(g.relationshipCount).toBe(1);
    const remaining = [...g.iterRelationships()];
    expect(remaining[0].sourceId).toBe('fn:b');
    expect(remaining[0].targetId).toBe('fn:c');
  });

  // ─── iterRelationshipsByType ───────────────────────────────────────

  describe('iterRelationshipsByType', () => {
    it('yields only the requested type', () => {
      const g = createKnowledgeGraph();
      g.addRelationship(makeRel('fn:a', 'fn:b', 'CALLS'));
      g.addRelationship(makeRel('fn:b', 'fn:c', 'CALLS'));
      g.addRelationship(makeRel('cls:X', 'cls:Y', 'EXTENDS'));
      g.addRelationship(makeRel('cls:Y', 'cls:Z', 'EXTENDS'));

      const calls = [...g.iterRelationshipsByType('CALLS')];
      const extends_ = [...g.iterRelationshipsByType('EXTENDS')];
      expect(calls).toHaveLength(2);
      expect(extends_).toHaveLength(2);
      // Identity assertions guard against a bucket-key swap bug that
      // would return the wrong edges with the right count.
      expect(calls.every((r) => r.type === 'CALLS')).toBe(true);
      expect(extends_.every((r) => r.type === 'EXTENDS')).toBe(true);
      expect(new Set(calls.map((r) => r.sourceId))).toEqual(new Set(['fn:a', 'fn:b']));
    });

    it('retains an empty bucket after last edge removed and reuses it on re-add', () => {
      const g = createKnowledgeGraph();
      g.addRelationship(makeRel('cls:X', 'cls:Y', 'EXTENDS'));
      expect([...g.iterRelationshipsByType('EXTENDS')]).toHaveLength(1);
      g.removeRelationship('cls:X-EXTENDS-cls:Y');
      expect([...g.iterRelationshipsByType('EXTENDS')]).toHaveLength(0);
      // Re-add the same type — bucket must still be live.
      g.addRelationship(makeRel('cls:A', 'cls:B', 'EXTENDS'));
      const again = [...g.iterRelationshipsByType('EXTENDS')];
      expect(again).toHaveLength(1);
      expect(again[0].sourceId).toBe('cls:A');
    });

    it('returns a fresh empty iterator when the type has no edges', () => {
      const g = createKnowledgeGraph();
      g.addRelationship(makeRel('fn:a', 'fn:b', 'CALLS'));
      // Two consecutive calls must each be exhaustible — guards against
      // returning a single shared exhausted iterator.
      expect([...g.iterRelationshipsByType('IMPLEMENTS')]).toHaveLength(0);
      expect([...g.iterRelationshipsByType('IMPLEMENTS')]).toHaveLength(0);
    });

    it('reflects removeRelationship on both indexes', () => {
      const g = createKnowledgeGraph();
      g.addRelationship(makeRel('cls:X', 'cls:Y', 'EXTENDS'));
      g.addRelationship(makeRel('cls:Y', 'cls:Z', 'EXTENDS'));
      expect([...g.iterRelationshipsByType('EXTENDS')]).toHaveLength(2);

      g.removeRelationship('cls:X-EXTENDS-cls:Y');
      expect([...g.iterRelationshipsByType('EXTENDS')]).toHaveLength(1);
      expect(g.relationshipCount).toBe(1);
    });

    it('reflects removeNode on both indexes', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode('cls:X', 'X', 'src/x.ts'));
      g.addNode(makeNode('cls:Y', 'Y', 'src/y.ts'));
      g.addRelationship(makeRel('cls:X', 'cls:Y', 'EXTENDS'));
      g.addRelationship(makeRel('cls:X', 'cls:Y', 'IMPLEMENTS'));
      expect([...g.iterRelationshipsByType('EXTENDS')]).toHaveLength(1);
      expect([...g.iterRelationshipsByType('IMPLEMENTS')]).toHaveLength(1);

      g.removeNode('cls:Y');
      expect([...g.iterRelationshipsByType('EXTENDS')]).toHaveLength(0);
      expect([...g.iterRelationshipsByType('IMPLEMENTS')]).toHaveLength(0);
      expect([...g.iterRelationships()]).toHaveLength(0);
    });

    it('dedupes by id across both indexes', () => {
      const g = createKnowledgeGraph();
      const rel = makeRel('cls:X', 'cls:Y', 'EXTENDS');
      g.addRelationship(rel);
      g.addRelationship(rel); // dedup by id
      expect([...g.iterRelationshipsByType('EXTENDS')]).toHaveLength(1);
      expect(g.relationshipCount).toBe(1);
    });
  });

  // ─── Reverse-adjacency + file indexes ─────────────────────────────
  // Pin the behavior of the nodeIdsByFile + edgeIdsByNode indexes
  // that back removeNode / removeNodesByFile. These replace the prior
  // O(N) full-map scans with O(edges-touching-node) and
  // O(file-nodes × avg-edges-per-node) respectively.

  describe('removeNode reverse-adjacency', () => {
    it('removes only edges touching the removed node', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode('fn:a', 'a', 'src/a.ts'));
      g.addNode(makeNode('fn:b', 'b', 'src/a.ts'));
      g.addNode(makeNode('fn:c', 'c', 'src/c.ts'));
      g.addRelationship(makeRel('fn:a', 'fn:b'));
      g.addRelationship(makeRel('fn:b', 'fn:c'));
      g.addRelationship(makeRel('fn:a', 'fn:c'));

      g.removeNode('fn:b');

      // Two edges touched fn:b (a→b and b→c); only a→c survives.
      expect(g.relationshipCount).toBe(1);
      const survivors = [...g.iterRelationships()];
      expect(survivors[0].sourceId).toBe('fn:a');
      expect(survivors[0].targetId).toBe('fn:c');
    });

    it('handles self-edges without double-counting or crashing', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode('fn:a', 'a', 'src/a.ts'));
      g.addRelationship(makeRel('fn:a', 'fn:a'));
      expect(g.relationshipCount).toBe(1);

      g.removeNode('fn:a');
      expect(g.relationshipCount).toBe(0);
      expect(g.nodeCount).toBe(0);
    });

    it('removes orphan node with no edges cleanly', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode('fn:a', 'a', 'src/a.ts'));
      expect(g.removeNode('fn:a')).toBe(true);
      expect(g.nodeCount).toBe(0);
    });
  });

  describe('removeNodesByFile via file index', () => {
    it('removes only nodes matching the file path', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode('fn:a', 'a', 'src/a.ts'));
      g.addNode(makeNode('fn:b', 'b', 'src/a.ts'));
      g.addNode(makeNode('fn:c', 'c', 'src/other.ts'));

      const removed = g.removeNodesByFile('src/a.ts');
      expect(removed).toBe(2);
      expect(g.nodeCount).toBe(1);
      expect(g.getNode('fn:c')).toBeDefined();
    });

    it('returns 0 when no node matches the file path', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode('fn:a', 'a', 'src/a.ts'));
      expect(g.removeNodesByFile('src/missing.ts')).toBe(0);
      expect(g.nodeCount).toBe(1);
    });

    it('also removes edges whose endpoints lived on the removed file', () => {
      const g = createKnowledgeGraph();
      g.addNode(makeNode('fn:a', 'a', 'src/a.ts'));
      g.addNode(makeNode('fn:b', 'b', 'src/b.ts'));
      g.addRelationship(makeRel('fn:a', 'fn:b'));
      expect(g.relationshipCount).toBe(1);

      g.removeNodesByFile('src/a.ts');
      // Removing fn:a also removed the a→b edge; fn:b survives.
      expect(g.nodeCount).toBe(1);
      expect(g.relationshipCount).toBe(0);
    });

    it('does not index nodes without a filePath property', () => {
      const g = createKnowledgeGraph();
      // Cluster/Community nodes and similar have no filePath.
      const node: Parameters<typeof g.addNode>[0] = {
        id: 'cluster:x',
        label: 'Community',
        properties: { name: 'x' },
      };
      g.addNode(node);
      g.addNode(makeNode('fn:a', 'a', 'src/a.ts'));

      expect(g.removeNodesByFile('src/a.ts')).toBe(1);
      expect(g.nodeCount).toBe(1);
      expect(g.getNode('cluster:x')).toBeDefined();
    });
  });
});
