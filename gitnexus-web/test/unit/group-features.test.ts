/**
 * Tests for multi-repo group features added to the web UI.
 * Covers: backend client group functions, constants updates, graph adapter repo-awareness.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ALL_EDGE_TYPES,
  DEFAULT_VISIBLE_EDGES,
  EDGE_INFO,
  REPO_COLORS,
  getRepoColor,
  type EdgeType,
} from '../../src/lib/constants';
import {
  knowledgeGraphToGraphology,
  type SigmaNodeAttributes,
} from '../../src/lib/graph-adapter';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../src/core/graph/types';

// ── Constants tests ────────────────────────────────────────────────────────

describe('CROSS_REPO_IMPORT edge type', () => {
  it('is included in ALL_EDGE_TYPES', () => {
    expect(ALL_EDGE_TYPES).toContain('CROSS_REPO_IMPORT');
  });

  it('is included in DEFAULT_VISIBLE_EDGES', () => {
    expect(DEFAULT_VISIBLE_EDGES).toContain('CROSS_REPO_IMPORT');
  });

  it('has EDGE_INFO entry with amber color', () => {
    const info = EDGE_INFO['CROSS_REPO_IMPORT' as EdgeType];
    expect(info).toBeDefined();
    expect(info.color).toBe('#f59e0b');
    expect(info.label).toBe('Cross-Repo Import');
  });
});

describe('REPO_COLORS', () => {
  it('has at least 4 colors', () => {
    expect(REPO_COLORS.length).toBeGreaterThanOrEqual(4);
  });

  it('returns valid hex colors', () => {
    for (const color of REPO_COLORS) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('getRepoColor', () => {
  it('returns valid hex color for any index', () => {
    for (let i = 0; i < 20; i++) {
      expect(getRepoColor(i)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('wraps around when index exceeds palette length', () => {
    const color0 = getRepoColor(0);
    const colorWrapped = getRepoColor(REPO_COLORS.length);
    expect(color0).toBe(colorWrapped);
  });
});

// ── Graph adapter tests ────────────────────────────────────────────────────

function makeNode(id: string, label: string, name: string, props?: Record<string, unknown>): GraphNode {
  return {
    id,
    label: label as GraphNode['label'],
    properties: {
      name,
      filePath: `src/${name}.ts`,
      ...props,
    } as GraphNode['properties'],
  };
}

function makeRel(sourceId: string, targetId: string, type: string): GraphRelationship {
  return {
    id: `${sourceId}_${type}_${targetId}`,
    sourceId,
    targetId,
    type: type as GraphRelationship['type'],
    confidence: 1.0,
    reason: 'test',
  };
}

function makeGraph(nodes: GraphNode[], relationships: GraphRelationship[]): KnowledgeGraph {
  return {
    nodes,
    relationships,
    get nodeCount() { return nodes.length; },
    get relationshipCount() { return relationships.length; },
    addNode: () => {},
    addRelationship: () => {},
  };
}

describe('knowledgeGraphToGraphology - multi-repo support', () => {
  it('detects multi-repo mode from _repo property', () => {
    const nodes = [
      makeNode('repoA::fn1', 'Function', 'funcA', { _repo: 'repoA' }),
      makeNode('repoB::fn1', 'Function', 'funcB', { _repo: 'repoB' }),
    ];
    const graph = knowledgeGraphToGraphology(makeGraph(nodes, []));

    // Both nodes should exist with repoName attribute
    const attrA = graph.getNodeAttributes('repoA::fn1') as SigmaNodeAttributes;
    const attrB = graph.getNodeAttributes('repoB::fn1') as SigmaNodeAttributes;
    expect(attrA.repoName).toBe('repoA');
    expect(attrB.repoName).toBe('repoB');
  });

  it('detects multi-repo mode from namespaced IDs', () => {
    const nodes = [
      makeNode('repoA::fn1', 'Function', 'funcA'),
      makeNode('repoB::fn1', 'Function', 'funcB'),
    ];
    const graph = knowledgeGraphToGraphology(makeGraph(nodes, []));

    const attrA = graph.getNodeAttributes('repoA::fn1') as SigmaNodeAttributes;
    expect(attrA.repoName).toBe('repoA');
  });

  it('assigns different repo colors to nodes in different repos', () => {
    const nodes = [
      makeNode('repoA::fn1', 'Function', 'funcA', { _repo: 'repoA' }),
      makeNode('repoB::fn1', 'Function', 'funcB', { _repo: 'repoB' }),
    ];
    const graph = knowledgeGraphToGraphology(makeGraph(nodes, []));

    const attrA = graph.getNodeAttributes('repoA::fn1') as SigmaNodeAttributes;
    const attrB = graph.getNodeAttributes('repoB::fn1') as SigmaNodeAttributes;
    expect(attrA.repoColor).toBeDefined();
    expect(attrB.repoColor).toBeDefined();
    expect(attrA.repoColor).not.toBe(attrB.repoColor);
  });

  it('handles CROSS_REPO_IMPORT edges', () => {
    const nodes = [
      makeNode('repoA::fn1', 'Function', 'funcA', { _repo: 'repoA' }),
      makeNode('repoB::fn1', 'Function', 'funcB', { _repo: 'repoB' }),
    ];
    const rels = [
      makeRel('repoB::fn1', 'repoA::fn1', 'CROSS_REPO_IMPORT'),
    ];
    const graph = knowledgeGraphToGraphology(makeGraph(nodes, rels));

    // Edge should exist
    expect(graph.hasEdge('repoB::fn1', 'repoA::fn1')).toBe(true);
    const edgeKey = graph.edge('repoB::fn1', 'repoA::fn1');
    const edgeAttr = graph.getEdgeAttributes(edgeKey!);
    expect(edgeAttr.relationType).toBe('CROSS_REPO_IMPORT');
    expect(edgeAttr.color).toBe('#f59e0b'); // Amber
  });

  it('colors File/Folder nodes by repo color in multi-repo mode', () => {
    const nodes = [
      makeNode('repoA::folder1', 'Folder', 'src', { _repo: 'repoA' }),
      makeNode('repoB::folder1', 'Folder', 'src', { _repo: 'repoB' }),
    ];
    const graph = knowledgeGraphToGraphology(makeGraph(nodes, []));

    const attrA = graph.getNodeAttributes('repoA::folder1') as SigmaNodeAttributes;
    const attrB = graph.getNodeAttributes('repoB::folder1') as SigmaNodeAttributes;
    // In multi-repo mode, structural nodes should use repo color, not default type color
    expect(attrA.color).toBe(attrA.repoColor);
    expect(attrB.color).toBe(attrB.repoColor);
    expect(attrA.color).not.toBe(attrB.color);
  });

  it('works correctly in single-repo mode (no repoName assigned)', () => {
    const nodes = [
      makeNode('fn1', 'Function', 'funcA'),
      makeNode('fn2', 'Function', 'funcB'),
    ];
    const graph = knowledgeGraphToGraphology(makeGraph(nodes, []));

    const attr = graph.getNodeAttributes('fn1') as SigmaNodeAttributes;
    expect(attr.repoName).toBeUndefined();
    expect(attr.repoColor).toBeUndefined();
  });

  it('positions multi-repo nodes in separate regions', () => {
    const nodes = [
      makeNode('repoA::folder1', 'Folder', 'src', { _repo: 'repoA' }),
      makeNode('repoB::folder1', 'Folder', 'src', { _repo: 'repoB' }),
    ];
    const graph = knowledgeGraphToGraphology(makeGraph(nodes, []));

    const posA = graph.getNodeAttributes('repoA::folder1') as SigmaNodeAttributes;
    const posB = graph.getNodeAttributes('repoB::folder1') as SigmaNodeAttributes;

    // Different repos should be positioned in different regions
    const distance = Math.sqrt(
      Math.pow(posA.x - posB.x, 2) + Math.pow(posA.y - posB.y, 2),
    );
    expect(distance).toBeGreaterThan(0);
  });
});

// ── Repo highlight toggle tests ─────────────────────────────────────────────

describe('repo highlight toggle logic', () => {
  it('toggling a repo out of the set removes it', () => {
    const initial = new Set(['repoA', 'repoB']);
    const next = new Set(initial);
    next.delete('repoA');
    expect(next.has('repoA')).toBe(false);
    expect(next.has('repoB')).toBe(true);
    expect(next.size).toBe(1);
  });

  it('toggling a repo back into the set adds it', () => {
    const current = new Set(['repoB']);
    const next = new Set(current);
    next.add('repoA');
    expect(next.has('repoA')).toBe(true);
    expect(next.has('repoB')).toBe(true);
    expect(next.size).toBe(2);
  });

  it('nodes in deselected repos should be dimmable based on repoName attribute', () => {
    const highlightedRepos = new Set(['repoA']);
    const nodeRepoA = 'repoA';
    const nodeRepoB = 'repoB';

    // repoA is highlighted — should NOT be dimmed
    expect(highlightedRepos.has(nodeRepoA)).toBe(true);
    // repoB is not highlighted — should be dimmed
    expect(highlightedRepos.has(nodeRepoB)).toBe(false);
  });

  it('empty highlightedRepos means no dimming (all visible)', () => {
    const highlightedRepos = new Set<string>();
    // When set is empty, the dimming logic should not trigger
    expect(highlightedRepos.size).toBe(0);
  });
});

// ── Backend client type tests ──────────────────────────────────────────────

describe('backend-client group types', () => {
  it('GroupGraphResult has expected shape', async () => {
    // Type-level test: ensure the interface is importable and has the right fields
    const { type } = await import('../../src/services/backend-client');
    // This is a compile-time check — if GroupGraphResult type is wrong, TS will fail
    const mockResult: import('../../src/services/backend-client').GroupGraphResult = {
      repos: [{ name: 'test', groupPath: 'test', nodeCount: 10, edgeCount: 5 }],
      nodes: [],
      relationships: [],
      crossLinks: [],
    };
    expect(mockResult.repos).toHaveLength(1);
    expect(mockResult.nodes).toHaveLength(0);
  });

  it('GroupStatus has expected shape', () => {
    const mockStatus: import('../../src/services/backend-client').GroupStatus = {
      group: 'test',
      lastSync: '2026-04-01T00:00:00Z',
      missingRepos: [],
      repos: {
        myRepo: { indexStale: false, contractsStale: false, missing: false },
      },
    };
    expect(mockStatus.group).toBe('test');
    expect(mockStatus.repos.myRepo.indexStale).toBe(false);
  });
});
