/**
 * Unit tests for cohesion formula consistency.
 *
 * Verifies that calculateCohesion (module-private) uses the internal edge ratio
 * formula: internalEdges / totalEdges, NOT graph density (internalEdges / maxPossibleEdges).
 *
 * Since calculateCohesion is not exported, all tests exercise it indirectly through
 * processCommunities — the public export. Graphs are built so that Leiden's community
 * assignment is deterministic (disconnected cliques with strong internal connectivity).
 */
import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { GraphNode, GraphRelationship } from '../../src/core/graph/types.js';
import { processCommunities } from '../../src/core/ingestion/community-processor.js';

// ============================================================================
// FIXTURE HELPERS
// ============================================================================

/** Create a GraphNode with commonly-needed properties */
function makeNode(
  id: string,
  name: string,
  label: GraphNode['label'],
  filePath: string,
): GraphNode {
  return {
    id,
    label,
    properties: { name, filePath, startLine: 1, endLine: 10, isExported: false },
  };
}

/** Create a CALLS relationship between two nodes */
function makeRel(id: string, sourceId: string, targetId: string): GraphRelationship {
  return { id, sourceId, targetId, type: 'CALLS', confidence: 1.0, reason: '' };
}

/** Add a fully-connected clique of Function nodes to the graph */
function addClique(
  graph: ReturnType<typeof createKnowledgeGraph>,
  prefix: string,
  folder: string,
  size: number,
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < size; i++) {
    const id = `fn:${prefix}${i}`;
    ids.push(id);
    graph.addNode(makeNode(id, `${prefix}Fn${i}`, 'Function', `/src/${folder}/f${i}.ts`));
  }
  // Fully connect all pairs
  let relIdx = 0;
  for (let i = 0; i < size; i++) {
    for (let j = i + 1; j < size; j++) {
      graph.addRelationship(makeRel(`rel:${prefix}_${relIdx++}`, ids[i], ids[j]));
    }
  }
  return ids;
}

// ============================================================================
// TESTS
// ============================================================================

describe('calculateCohesion — internal edge ratio', () => {
  /**
   * Build a 4-node fully connected clique with 2 external boundary edges.
   * For the clique community:
   *   - 4 nodes, 6 internal edges (undirected)
   *   - 2 external edges (one from node0, one from node1 to outside nodes)
   *   - Each undirected edge is traversed twice in forEachNeighbor
   *   - Internal traversals: 6 edges * 2 = 12  (each internal edge counted from both endpoints)
   *     BUT only edges where BOTH endpoints are in the clique count. node0 has 3 internal + 1 external neighbor,
   *     node1 has 3 internal + 1 external neighbor, node2 has 3 internal, node3 has 3 internal.
   *   - Total neighbor traversals from clique members: (3+1) + (3+1) + 3 + 3 = 14
   *   - Internal traversals: 3 + 3 + 3 + 3 = 12
   *   - Edge ratio: 12 / 14 = 0.857...
   *   - Graph density would be: 6 / (4*3/2) = 6/6 = 1.0
   *   - This discriminates: if cohesion < 1.0, it's edge ratio; if 1.0, it could be density.
   */
  it('produces internal edge ratio, not graph density, for a tight cluster with external edges', async () => {
    const graph = createKnowledgeGraph();

    // Clique of 4 nodes
    const clique = addClique(graph, 'c', 'cluster', 4);

    // Two external nodes, each connected to one clique member
    graph.addNode(makeNode('fn:ext0', 'extFn0', 'Function', '/src/other/ext0.ts'));
    graph.addNode(makeNode('fn:ext1', 'extFn1', 'Function', '/src/other/ext1.ts'));
    // Connect ext nodes to each other so they form their own community (size >= 2)
    graph.addRelationship(makeRel('rel:ext_link', 'fn:ext0', 'fn:ext1'));
    // Boundary edges from clique to external
    graph.addRelationship(makeRel('rel:boundary0', clique[0], 'fn:ext0'));
    graph.addRelationship(makeRel('rel:boundary1', clique[1], 'fn:ext1'));

    const result = await processCommunities(graph);

    // Find the community containing the clique nodes
    const cliqueMemberSet = new Set(clique);
    const membershipMap = new Map<string, string>();
    for (const m of result.memberships) {
      membershipMap.set(m.nodeId, m.communityId);
    }

    // Determine which community the clique nodes belong to
    const cliqueCommunityId = membershipMap.get(clique[0]);
    expect(cliqueCommunityId).toBeDefined();

    // All clique nodes should be in the same community
    for (const nodeId of clique) {
      expect(membershipMap.get(nodeId)).toBe(cliqueCommunityId);
    }

    // Find the community node
    const cliqueCommunity = result.communities.find((c) => c.id === cliqueCommunityId);
    expect(cliqueCommunity).toBeDefined();

    // Key assertion: cohesion should be < 1.0 (edge ratio with boundary edges)
    // Graph density would be 1.0 since 4 nodes are fully connected internally.
    // Edge ratio: 12 internal traversals / 14 total traversals = ~0.857
    expect(cliqueCommunity!.cohesion).toBeLessThan(1.0);
    expect(cliqueCommunity!.cohesion).toBeCloseTo(12 / 14, 2);
  });

  /**
   * A fully isolated clique with no external edges.
   * Both formulas agree: cohesion should be 1.0 because all edges are internal.
   */
  it('cohesion is 1.0 when community has no external edges', async () => {
    const graph = createKnowledgeGraph();

    // Single isolated clique of 4 — no boundary edges at all
    addClique(graph, 'iso', 'isolated', 4);

    const result = await processCommunities(graph);

    // Should produce exactly one community (singletons are filtered)
    expect(result.communities.length).toBeGreaterThanOrEqual(1);

    // The community containing our clique should have cohesion 1.0
    const community = result.communities.find((c) => c.symbolCount >= 4);
    // If Leiden puts them all in one community (expected for a fully connected graph)
    if (community) {
      expect(community.cohesion).toBe(1.0);
    }
  });

  /**
   * Two variants of the same base clique: one with few external edges,
   * one with many. The variant with more external edges should have lower cohesion.
   */
  it('cohesion decreases as external edge proportion increases', async () => {
    // --- Variant A: clique with 1 external edge ---
    const graphA = createKnowledgeGraph();
    const cliqueA = addClique(graphA, 'a', 'groupA', 4);
    // One external node pair (to form a valid community)
    graphA.addNode(makeNode('fn:extA0', 'extA0', 'Function', '/src/extA/e0.ts'));
    graphA.addNode(makeNode('fn:extA1', 'extA1', 'Function', '/src/extA/e1.ts'));
    graphA.addRelationship(makeRel('rel:extA_link', 'fn:extA0', 'fn:extA1'));
    // 1 boundary edge
    graphA.addRelationship(makeRel('rel:bndA0', cliqueA[0], 'fn:extA0'));

    const resultA = await processCommunities(graphA);
    const commIdA = resultA.memberships.find((m) => m.nodeId === cliqueA[0])?.communityId;
    const communityA = resultA.communities.find((c) => c.id === commIdA);

    // --- Variant B: clique with 4 external edges ---
    const graphB = createKnowledgeGraph();
    const cliqueB = addClique(graphB, 'b', 'groupB', 4);
    // Four external nodes (two pairs)
    for (let i = 0; i < 4; i++) {
      graphB.addNode(makeNode(`fn:extB${i}`, `extB${i}`, 'Function', `/src/extB/e${i}.ts`));
    }
    graphB.addRelationship(makeRel('rel:extB_link0', 'fn:extB0', 'fn:extB1'));
    graphB.addRelationship(makeRel('rel:extB_link1', 'fn:extB2', 'fn:extB3'));
    // 4 boundary edges (one per clique node)
    for (let i = 0; i < 4; i++) {
      graphB.addRelationship(makeRel(`rel:bndB${i}`, cliqueB[i], `fn:extB${i}`));
    }

    const resultB = await processCommunities(graphB);
    const commIdB = resultB.memberships.find((m) => m.nodeId === cliqueB[0])?.communityId;
    const communityB = resultB.communities.find((c) => c.id === commIdB);

    expect(communityA).toBeDefined();
    expect(communityB).toBeDefined();

    // More external edges => lower cohesion
    expect(communityB!.cohesion).toBeLessThan(communityA!.cohesion);
  });

  /**
   * Edge case: a community with a single node should return cohesion 1.0.
   * The code returns early for memberIds.length <= 1.
   * Leiden skips singletons (communities with < 2 members), so we test this
   * by building a graph where one node has no edges — it won't appear in a
   * community at all. Instead, test with 2 connected nodes and verify the
   * community gets cohesion 1.0 (2 nodes, 1 internal edge, 0 external = 1.0).
   */
  it('two-node community with no external edges returns 1.0', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode(makeNode('fn:pair0', 'pairFn0', 'Function', '/src/pair/f0.ts'));
    graph.addNode(makeNode('fn:pair1', 'pairFn1', 'Function', '/src/pair/f1.ts'));
    graph.addRelationship(makeRel('rel:pair', 'fn:pair0', 'fn:pair1'));

    const result = await processCommunities(graph);

    // Should have exactly 1 community with 2 members
    expect(result.communities).toHaveLength(1);
    expect(result.communities[0].symbolCount).toBe(2);
    expect(result.communities[0].cohesion).toBe(1.0);
  });

  /**
   * Sanity check: an empty graph should yield no communities.
   */
  it('empty graph returns empty communities', async () => {
    const graph = createKnowledgeGraph();
    const result = await processCommunities(graph);

    expect(result.communities).toEqual([]);
    expect(result.memberships).toEqual([]);
    expect(result.stats.totalCommunities).toBe(0);
    expect(result.stats.nodesProcessed).toBe(0);
  });

  /**
   * Verify that the web and backend formulas produce equivalent results
   * by checking the backend value against a hand-calculated edge-ratio result.
   *
   * Topology: 3-node triangle (clique) + 1 external node connected to one vertex.
   *   - Triangle: 3 internal edges
   *   - 1 boundary edge from vertex 0 to external node
   *   - Traversals from triangle members:
   *     vertex0: 2 internal neighbors + 1 external = 3 traversals
   *     vertex1: 2 internal neighbors = 2 traversals
   *     vertex2: 2 internal neighbors = 2 traversals
   *   - Total traversals: 7, internal traversals: 6
   *   - Edge ratio: 6/7 ≈ 0.857
   *
   * The external node is a singleton so Leiden won't produce a community for it.
   * But we need at least 2 external nodes connected to each other for Leiden
   * to form a second community. Let's add a second external node.
   *   - vertex0 connects to ext0, ext0 connects to ext1
   *   - Triangle traversals:
   *     vertex0: 2 internal + 1 external = 3
   *     vertex1: 2 internal = 2
   *     vertex2: 2 internal = 2
   *   - Total: 7, internal: 6, ratio: 6/7 ≈ 0.857
   */
  it('web and backend formulas produce equivalent edge-ratio results', async () => {
    const graph = createKnowledgeGraph();

    // Triangle clique
    const tri = ['fn:t0', 'fn:t1', 'fn:t2'];
    graph.addNode(makeNode('fn:t0', 'triFn0', 'Function', '/src/tri/f0.ts'));
    graph.addNode(makeNode('fn:t1', 'triFn1', 'Function', '/src/tri/f1.ts'));
    graph.addNode(makeNode('fn:t2', 'triFn2', 'Function', '/src/tri/f2.ts'));
    graph.addRelationship(makeRel('rel:t01', 'fn:t0', 'fn:t1'));
    graph.addRelationship(makeRel('rel:t02', 'fn:t0', 'fn:t2'));
    graph.addRelationship(makeRel('rel:t12', 'fn:t1', 'fn:t2'));

    // External pair
    graph.addNode(makeNode('fn:ext0', 'extFn0', 'Function', '/src/ext/e0.ts'));
    graph.addNode(makeNode('fn:ext1', 'extFn1', 'Function', '/src/ext/e1.ts'));
    graph.addRelationship(makeRel('rel:ext', 'fn:ext0', 'fn:ext1'));

    // Boundary edge: triangle vertex0 -> ext0
    graph.addRelationship(makeRel('rel:bnd', 'fn:t0', 'fn:ext0'));

    const result = await processCommunities(graph);

    // Find triangle community
    const triCommId = result.memberships.find((m) => m.nodeId === 'fn:t0')?.communityId;
    expect(triCommId).toBeDefined();

    const triComm = result.communities.find((c) => c.id === triCommId);
    expect(triComm).toBeDefined();

    // Hand-calculated edge ratio: 6 internal traversals / 7 total = 0.8571...
    const expectedEdgeRatio = 6 / 7;
    expect(triComm!.cohesion).toBeCloseTo(expectedEdgeRatio, 2);

    // Verify it's NOT graph density (which would be 3 / (3*2/2) = 1.0)
    expect(triComm!.cohesion).not.toBeCloseTo(1.0, 2);
  });
});
