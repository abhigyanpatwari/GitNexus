import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, it, expect, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { GraphNode, GraphRelationship } from '../../src/core/graph/types.js';
import {
  getCommunityColor,
  COMMUNITY_COLORS,
  buildCommunityCsr,
  buildCommunityProjection,
  buildIcebugWorkerSource,
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

    it('announces the experimental engine on request, before any fallback', async () => {
      const graph = createKnowledgeGraph();
      graph.addNode(makeNode('fn:a', 'a', 'Function', '/src/group/a.ts'));
      graph.addNode(makeNode('fn:b', 'b', 'Function', '/src/group/b.ts'));
      graph.addRelationship(makeRel('rel:ab', 'fn:a', 'fn:b'));

      const experimental: string[] = [];
      await processCommunities(graph, (message) => experimental.push(message), { engine: 'auto' });
      const notice = experimental.findIndex((message) => message.startsWith('Experimental auto'));
      const fallback = experimental.findIndex((message) =>
        message.includes('falling back to Graphology'),
      );

      expect(experimental[notice]).toContain('will not match the Graphology default');
      expect(notice).toBeLessThan(fallback);

      const defaultEngine: string[] = [];
      await processCommunities(graph, (message) => defaultEngine.push(message));

      expect(defaultEngine.some((message) => message.startsWith('Experimental'))).toBe(false);
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

  describe('icebug worker source', () => {
    // Executes the real worker source against a stub shaped like
    // @ladybugmem/icebug, so the package name, class names, constructor
    // argument order and getPartition() shape are all pinned. The native
    // package itself cannot run in CI (its prebuilds need system Arrow 24,
    // libomp and glibc >= 2.38).
    const STUB = `
'use strict';
const fs = require('node:fs');
const calls = [];
const log = () => fs.writeFileSync(process.env.ICEBUG_STUB_LOG, JSON.stringify(calls));

class GraphR {
  constructor(n, directed, outIndices, outIndptr) {
    calls.push(['GraphR', n, directed, Array.from(outIndices, Number), Array.from(outIndptr, Number)]);
  }
}

class Leiden {
  constructor(graph, iterations, randomize, gamma) {
    calls.push(['Leiden', graph instanceof GraphR, iterations, randomize, gamma]);
  }
  run() {
    calls.push(['run']);
    log();
  }
  getPartition() {
    return { membership: Float64Array.from([7, 7, 3]), count: 2 };
  }
  modularity() {
    return 0.25;
  }
}

module.exports = {
  GraphR,
  Leiden,
  setNumberOfThreads: (n) => calls.push(['setNumberOfThreads', n]),
  setSeed: (seed, useThreadId) => calls.push(['setSeed', seed, useThreadId]),
};
`;

    const runWorkerAgainstStub = async (stubSource: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'icebug-stub-'));
      const stubPath = join(dir, 'stub.cjs');
      const logPath = join(dir, 'calls.json');
      writeFileSync(stubPath, stubSource);

      const worker = new Worker(buildIcebugWorkerSource(stubPath), {
        eval: true,
        env: { ...process.env, ICEBUG_STUB_LOG: logPath },
        workerData: {
          nodeCount: 3,
          indices: BigUint64Array.from([1n, 0n, 2n, 1n]),
          indptr: BigUint64Array.from([0n, 1n, 3n, 4n]),
          threads: 1,
          seed: 49374,
          iterations: 4,
          gamma: 1.0,
          randomize: false,
        },
      });

      try {
        const message = await new Promise<Record<string, unknown>>((resolve, reject) => {
          worker.once('message', resolve);
          worker.once('error', reject);
        });
        // Absent when the worker bailed before run() — an empty call log.
        const calls: unknown[] = existsSync(logPath)
          ? JSON.parse(readFileSync(logPath, 'utf8'))
          : [];
        return { message, calls };
      } finally {
        await worker.terminate();
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it('drives GraphR + Leiden in the order the published API expects', async () => {
      const { message, calls } = await runWorkerAgainstStub(STUB);

      expect(calls).toEqual([
        ['setNumberOfThreads', 1],
        ['setSeed', 49374, false],
        ['GraphR', 3, false, [1, 0, 2, 1], [0, 1, 3, 4]],
        // (graph, iterations, randomize, gamma) — randomize precedes gamma.
        ['Leiden', true, 4, false, 1.0],
        ['run'],
      ]);
      expect(message).toMatchObject({ ok: true, modularity: 0.25 });
      expect(Array.from(message.partition as Float64Array)).toEqual([7, 7, 3]);
    });

    it('refuses a build without the deterministic thread and seed controls', async () => {
      const { message } = await runWorkerAgainstStub(
        STUB.replace("setNumberOfThreads: (n) => calls.push(['setNumberOfThreads', n]),", ''),
      );

      expect(message).toMatchObject({ ok: false });
      expect(message.error).toContain('deterministic thread/seed controls');
    });
  });

  describe('vendored Leiden partitioning', () => {
    // Golden values for the seeded graph below, captured from the vendored
    // implementation. They pin the partition, not just its shape.
    const GOLDEN_COMMUNITY_COUNT = 99;
    const GOLDEN_NODES_PROCESSED = 1199;
    const GOLDEN_MODULARITY = 0.7032803125;

    // Guards the mergeNodesSubset scratch-buffer change in vendor/leiden/utils.cjs
    // (#2337): the pre-merge snapshot must still hold each subset node's
    // externalEdgeWeightPerCommunity from *before* the merge loop. Getting the
    // snapshot wrong shifts the partition, which these golden values catch.
    // Seeded planted partition with cross-community noise. Unlike clean cliques,
    // the noisy edges make the outcome sensitive to the merge-phase bookkeeping
    // that `microDegrees` feeds, so a wrong snapshot shifts the golden values.
    const buildPlantedGraph = (nodeCount: number, edgeCount: number, groupCount: number) => {
      let state = 0x1234_5678;
      const random = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
      };

      const graph = createKnowledgeGraph();
      const groups: number[][] = Array.from({ length: groupCount }, () => []);

      for (let node = 0; node < nodeCount; node++) {
        const group = Math.floor(random() * groupCount);
        groups[group].push(node);
        graph.addNode(makeNode(`fn:${node}`, `f${node}`, 'Function', `/src/g${group}/f${node}.ts`));
      }

      const seen = new Set<string>();
      let added = 0;
      let guard = edgeCount * 50;

      while (added < edgeCount && guard-- > 0) {
        const group = groups[Math.floor(random() * groupCount)];
        const intraCommunity = random() < 0.85 && group.length >= 2;
        const source = intraCommunity
          ? group[Math.floor(random() * group.length)]
          : Math.floor(random() * nodeCount);
        const target = intraCommunity
          ? group[Math.floor(random() * group.length)]
          : Math.floor(random() * nodeCount);
        const low = Math.min(source, target);
        const high = Math.max(source, target);
        const key = `${low}:${high}`;

        if (low === high || seen.has(key)) continue;

        seen.add(key);
        graph.addRelationship(makeRel(`rel:${key}`, `fn:${low}`, `fn:${high}`));
        added++;
      }

      return graph;
    };

    it('recovers the planted partition with the expected golden quality', async () => {
      const result = await processCommunities(buildPlantedGraph(1200, 4000, 60));

      expect(result.stats).toMatchObject({
        engine: 'graphology',
        totalCommunities: GOLDEN_COMMUNITY_COUNT,
        nodesProcessed: GOLDEN_NODES_PROCESSED,
      });
      expect(result.stats.modularity).toBeCloseTo(GOLDEN_MODULARITY, 6);
    });

    it('produces an identical partition across repeated runs', async () => {
      const graph = buildPlantedGraph(600, 2000, 30);
      const first = await processCommunities(graph);
      const second = await processCommunities(graph);

      expect(second.memberships).toEqual(first.memberships);
      expect(second.stats.modularity).toBe(first.stats.modularity);
    });
  });
});
