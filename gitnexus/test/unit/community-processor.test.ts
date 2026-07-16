import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { GraphNode, GraphRelationship } from '../../src/core/graph/types.js';
import {
  getCommunityColor,
  COMMUNITY_COLORS,
  buildCommunityCsr,
  buildCommunityProjection,
  processCommunities,
  resolveCommunityDetectionEngine,
} from '../../src/core/ingestion/community-processor.js';

function makeNode(
  id: string,
  name: string,
  label: GraphNode['label'] = 'Function',
  filePath = `/src/${name}.ts`,
): GraphNode {
  return {
    id,
    label,
    properties: { name, filePath, startLine: 1, endLine: 10, isExported: false },
  };
}

function makeRel(
  id: string,
  sourceId: string,
  targetId: string,
  type: GraphRelationship['type'] = 'CALLS',
): GraphRelationship {
  return { id, sourceId, targetId, type, confidence: 1.0, reason: '' };
}

describe('community-processor', () => {
  describe('COMMUNITY_COLORS', () => {
    it('has 12 colors', () => {
      expect(COMMUNITY_COLORS).toHaveLength(12);
    });

    it('contains valid hex color strings', () => {
      for (const color of COMMUNITY_COLORS) {
        expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });

    it('has no duplicate colors', () => {
      const unique = new Set(COMMUNITY_COLORS);
      expect(unique.size).toBe(COMMUNITY_COLORS.length);
    });
  });

  describe('getCommunityColor', () => {
    it('returns first color for index 0', () => {
      expect(getCommunityColor(0)).toBe(COMMUNITY_COLORS[0]);
    });

    it('wraps around when index exceeds color count', () => {
      expect(getCommunityColor(12)).toBe(COMMUNITY_COLORS[0]);
      expect(getCommunityColor(13)).toBe(COMMUNITY_COLORS[1]);
    });

    it('returns different colors for different indices', () => {
      const c0 = getCommunityColor(0);
      const c1 = getCommunityColor(1);
      expect(c0).not.toBe(c1);
    });
  });

  describe('community engine selection', () => {
    it('defaults unknown engine values to graphology', () => {
      expect(resolveCommunityDetectionEngine(undefined)).toBe('graphology');
      expect(resolveCommunityDetectionEngine('')).toBe('graphology');
      expect(resolveCommunityDetectionEngine('native')).toBe('graphology');
    });

    it('accepts graphology, icebug, and auto engine values', () => {
      expect(resolveCommunityDetectionEngine('graphology')).toBe('graphology');
      expect(resolveCommunityDetectionEngine('icebug')).toBe('icebug');
      expect(resolveCommunityDetectionEngine('auto')).toBe('auto');
      expect(resolveCommunityDetectionEngine(' ICEBUG ')).toBe('icebug');
    });
  });

  describe('community projection and CSR', () => {
    it('projects only connected community symbols and deduplicates undirected edges', () => {
      const graph = createKnowledgeGraph();
      graph.addNode(makeNode('fn:a', 'a'));
      graph.addNode(makeNode('fn:b', 'b', 'Method'));
      graph.addNode(makeNode('file:a', 'file', 'File'));
      graph.addNode(makeNode('fn:isolated', 'isolated'));

      graph.addRelationship(makeRel('rel:ab', 'fn:a', 'fn:b'));
      graph.addRelationship(makeRel('rel:ba', 'fn:b', 'fn:a'));
      graph.addRelationship(makeRel('rel:file', 'fn:a', 'file:a'));

      const projection = buildCommunityProjection(graph);

      expect(projection.nodes.map((node) => node.id)).toEqual(['fn:a', 'fn:b']);
      expect(projection.edges).toEqual([[0, 1]]);
      expect(projection.symbolCount).toBe(3);
    });

    it('produces the same projection regardless of graph insertion order', () => {
      const first = createKnowledgeGraph();
      for (const id of ['fn:c', 'fn:a', 'fn:b']) {
        first.addNode(makeNode(id, id.slice(3)));
      }
      first.addRelationship(makeRel('rel:ac', 'fn:a', 'fn:c'));
      first.addRelationship(makeRel('rel:ab', 'fn:a', 'fn:b'));
      first.addRelationship(makeRel('rel:bc', 'fn:b', 'fn:c'));

      const second = createKnowledgeGraph();
      for (const id of ['fn:b', 'fn:c', 'fn:a']) {
        second.addNode(makeNode(id, id.slice(3)));
      }
      second.addRelationship(makeRel('rel:bc', 'fn:c', 'fn:b'));
      second.addRelationship(makeRel('rel:ab', 'fn:b', 'fn:a'));
      second.addRelationship(makeRel('rel:ac', 'fn:c', 'fn:a'));

      expect(buildCommunityProjection(second)).toEqual(buildCommunityProjection(first));
    });

    it('exports a deterministic undirected CSR adjacency', () => {
      const projection = {
        nodes: [
          { id: 'a', name: 'a', filePath: '/a.ts', type: 'Function' as const },
          { id: 'b', name: 'b', filePath: '/b.ts', type: 'Function' as const },
          { id: 'c', name: 'c', filePath: '/c.ts', type: 'Function' as const },
        ],
        edges: [
          [0, 2],
          [0, 1],
        ] as Array<readonly [number, number]>,
        symbolCount: 3,
        isLarge: false,
      };

      const csr = buildCommunityCsr(projection);

      expect([...csr.indptr].map(Number)).toEqual([0, 2, 3, 4]);
      expect([...csr.indices].map(Number)).toEqual([1, 2, 0, 0]);
    });
  });

  describe('processCommunities engine fallback', () => {
    it('falls back to graphology when explicit icebug engine is unavailable', async () => {
      const graph = createKnowledgeGraph();
      graph.addNode(makeNode('fn:a', 'a', 'Function', '/src/group/a.ts'));
      graph.addNode(makeNode('fn:b', 'b', 'Function', '/src/group/b.ts'));
      graph.addRelationship(makeRel('rel:ab', 'fn:a', 'fn:b'));

      const progress: string[] = [];
      const result = await processCommunities(graph, (message) => progress.push(message), {
        engine: 'icebug',
      });

      expect(result.stats.engineRequested).toBe('icebug');
      expect(result.stats.engine).toBe('graphology');
      expect(result.stats.fallbackReason).toBeTruthy();
      expect(progress.some((message) => message.includes('falling back to Graphology'))).toBe(true);
      expect(result.communities).toHaveLength(1);
      expect(result.memberships).toHaveLength(2);
    });

    it('falls back to graphology when icebug returns invalid modularity', async () => {
      vi.resetModules();
      vi.doMock('node:worker_threads', () => {
        class MockWorker extends EventEmitter {
          constructor() {
            super();
            queueMicrotask(() => {
              this.emit('message', { ok: true, partition: [0, 0], modularity: Number.NaN });
            });
          }

          terminate(): Promise<number> {
            return Promise.resolve(0);
          }
        }

        return { Worker: MockWorker };
      });

      try {
        const { processCommunities: processCommunitiesWithMockWorker } =
          await import('../../src/core/ingestion/community-processor.js');
        const graph = createKnowledgeGraph();
        graph.addNode(makeNode('fn:a', 'a', 'Function', '/src/group/a.ts'));
        graph.addNode(makeNode('fn:b', 'b', 'Function', '/src/group/b.ts'));
        graph.addRelationship(makeRel('rel:ab', 'fn:a', 'fn:b'));

        const progress: string[] = [];
        const result = await processCommunitiesWithMockWorker(
          graph,
          (message) => progress.push(message),
          { engine: 'icebug' },
        );

        expect(result.stats.engineRequested).toBe('icebug');
        expect(result.stats.engine).toBe('graphology');
        expect(result.stats.fallbackReason).toContain('modularity');
        expect(progress.some((message) => message.includes('falling back to Graphology'))).toBe(
          true,
        );
      } finally {
        vi.doUnmock('node:worker_threads');
        vi.resetModules();
      }
    });

    it('falls back before icebug worker launch for nondeterministic options', async () => {
      const graph = createKnowledgeGraph();
      graph.addNode(makeNode('fn:a', 'a', 'Function', '/src/group/a.ts'));
      graph.addNode(makeNode('fn:b', 'b', 'Function', '/src/group/b.ts'));
      graph.addRelationship(makeRel('rel:ab', 'fn:a', 'fn:b'));

      const threadResult = await processCommunities(graph, undefined, {
        engine: 'icebug',
        icebug: { threads: 2 },
      });
      expect(threadResult.stats.engine).toBe('graphology');
      expect(threadResult.stats.fallbackReason).toContain('threads=1');

      const randomizeResult = await processCommunities(graph, undefined, {
        engine: 'icebug',
        icebug: { randomize: true },
      });
      expect(randomizeResult.stats.engine).toBe('graphology');
      expect(randomizeResult.stats.fallbackReason).toContain('randomize=false');
    });
  });
});
