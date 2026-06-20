/**
 * Integration Tests: real emitter -> persisted PDG rows -> impact(mode:'pdg').
 *
 * Seeded PDG traversal tests lock the graph algorithm. This suite locks the
 * producer/consumer contract that seeded rows cannot cover: the real analysis
 * pipeline must emit BasicBlock ids, source-line metadata, and REACHING_DEF/CDG
 * rows in the exact shape consumed by LocalBackend's statement-anchored PDG
 * impact traversal and affectedStatements projection.
 */
import { it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { RepoMeta } from '../../src/storage/repo-manager.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { withTestLbugDB, type IndexedDBHandle } from '../helpers/test-indexed-db.js';

const metaByStoragePath = vi.hoisted(() => new Map<string, RepoMeta | null>());

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
    loadMeta: vi.fn().mockImplementation(async (storagePath: string) => {
      return metaByStoragePath.get(storagePath) ?? null;
    }),
  };
});

const FIXTURE = path.join(__dirname, 'cfg', 'fixtures', 'pdg-repo');
const READY_PDG_META = {
  pdg: { maxCdgEdgesPerFunction: 0, maxReachingDefEdgesPerFunction: 0 },
} as unknown as RepoMeta;

async function persistFixtureGraph(
  pdg: boolean,
): Promise<{ pdgEdges: number; reachingDefEdges: number; cdgEdges: number }> {
  const repoDir = fs.mkdtempSync(
    path.join(os.tmpdir(), pdg ? 'gn-impact-pdg-' : 'gn-impact-nopdg-'),
  );
  try {
    fs.cpSync(FIXTURE, repoDir, { recursive: true });
    const pipelineResult = await runPipelineFromRepo(repoDir, () => {}, pdg ? { pdg: true } : {});
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    const nodes: Array<{ label: 'BasicBlock' | 'Function'; props: Record<string, unknown> }> = [];
    pipelineResult.graph.forEachNode((n) => {
      if (n.label === 'BasicBlock') {
        nodes.push({
          label: 'BasicBlock',
          props: {
            id: n.id,
            filePath: n.properties.filePath ?? '',
            startLine: n.properties.startLine ?? 0,
            endLine: n.properties.endLine ?? 0,
            text: n.properties.text ?? '',
          },
        });
      } else if (n.label === 'Function') {
        nodes.push({
          label: 'Function',
          props: {
            id: n.id,
            name: n.properties.name ?? '',
            filePath: n.properties.filePath ?? '',
            startLine: n.properties.startLine ?? 0,
            endLine: n.properties.endLine ?? 0,
          },
        });
      }
    });

    for (const node of nodes) {
      const assignments = Object.keys(node.props)
        .map((k) => `${k}: $${k}`)
        .join(', ');
      await adapter.executePrepared(
        `CREATE (n:${node.label} {${assignments}})`,
        node.props as Record<string, any>,
      );
    }

    let pdgEdges = 0;
    let reachingDefEdges = 0;
    let cdgEdges = 0;
    for (const rel of pipelineResult.graph.iterRelationships()) {
      if (rel.type !== 'CDG' && rel.type !== 'REACHING_DEF') continue;
      await adapter.executePrepared(
        `MATCH (a:BasicBlock {id: $src}), (b:BasicBlock {id: $dst})
         CREATE (a)-[:CodeRelation {type: '${rel.type}', confidence: $confidence, reason: $reason, step: 0}]->(b)`,
        {
          src: rel.sourceId,
          dst: rel.targetId,
          confidence: rel.confidence ?? 1.0,
          reason: rel.reason ?? '',
        },
      );
      pdgEdges++;
      if (rel.type === 'REACHING_DEF') reachingDefEdges++;
      if (rel.type === 'CDG') cdgEdges++;
    }

    return { pdgEdges, reachingDefEdges, cdgEdges };
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

function registerSingleRepo(handle: IndexedDBHandle, name: string, repoPath: string): void {
  vi.mocked(listRegisteredRepos).mockResolvedValue([
    {
      name,
      path: repoPath,
      storagePath: handle.tmpHandle.dbPath,
      indexedAt: new Date().toISOString(),
      lastCommit: 'impact-pdg-e2e',
      stats: { files: 4, nodes: 4, communities: 0, processes: 0 },
    },
  ]);
}

withTestLbugDB(
  'impact-pdg-e2e',
  (handle) => {
    let backend: LocalBackend;
    let counts: { pdgEdges: number; reachingDefEdges: number; cdgEdges: number };

    beforeAll(() => {
      const ext = handle as typeof handle & {
        _backend?: LocalBackend;
        _counts?: { pdgEdges: number; reachingDefEdges: number; cdgEdges: number };
      };
      if (!ext._backend || !ext._counts) throw new Error('PDG e2e setup did not finish');
      backend = ext._backend;
      counts = ext._counts;
    });

    it('uses real emitted REACHING_DEF and CDG rows to return statement-level PDG impact', async () => {
      expect(counts.pdgEdges).toBeGreaterThan(0);
      expect(counts.reachingDefEdges).toBeGreaterThan(0);
      expect(counts.cdgEdges).toBeGreaterThan(0);

      const result = await backend.callTool('impact', {
        target: 'loopFlow',
        direction: 'downstream',
        mode: 'pdg',
        line: 19,
        maxDepth: 10,
        limit: 50,
      });

      expect(result.error).toBeUndefined();
      expect(result.mode).toBe('pdg');
      expect(result.target.name).toBe('loopFlow');
      expect(result.target.filePath).toBe('guards.ts');
      expect(result.criterionLine).toBe(19);

      const persistedRd = await executeParameterized(
        handle.dbPath,
        `MATCH (:BasicBlock)-[r:CodeRelation]->(:BasicBlock)
         WHERE r.type = 'REACHING_DEF'
         RETURN r.type AS type
         LIMIT 1`,
        {},
      );
      expect(persistedRd.length).toBeGreaterThan(0);
      const persistedCdg = await executeParameterized(
        handle.dbPath,
        `MATCH (:BasicBlock)-[r:CodeRelation]->(:BasicBlock)
         WHERE r.type = 'CDG'
         RETURN r.type AS type
         LIMIT 1`,
        {},
      );
      expect(persistedCdg.length).toBeGreaterThan(0);
      expect(Array.isArray(result.affectedStatements)).toBe(true);

      const lines = (result.affectedStatements as any[])
        .map((statement) => statement.line)
        .sort((a, b) => a - b);
      expect(lines).toEqual(expect.arrayContaining([21, 23]));
      expect(lines).not.toContain(19);
      expect(result.affectedStatementCount).toBe(result.affectedStatements.length);

      const controlResult = await backend.callTool('impact', {
        target: 'guarded',
        direction: 'downstream',
        mode: 'pdg',
        line: 9,
        maxDepth: 10,
        limit: 50,
      });
      expect(controlResult.error).toBeUndefined();
      expect(controlResult.mode).toBe('pdg');
      const controlLines = (controlResult.affectedStatements as any[])
        .map((statement) => statement.line)
        .sort((a, b) => a - b);
      expect(controlLines).toContain(10);
      expect(controlLines).not.toContain(9);
    });
  },
  {
    poolAdapter: true,
    timeout: 180_000,
    afterSetup: async (handle) => {
      metaByStoragePath.set(handle.tmpHandle.dbPath, READY_PDG_META);
      const counts = await persistFixtureGraph(true);
      if (counts.pdgEdges === 0 || counts.reachingDefEdges === 0 || counts.cdgEdges === 0) {
        throw new Error('fixture produced no persisted PDG dependence edges');
      }
      registerSingleRepo(handle, 'impact-pdg-e2e', '/impact/pdg/repo');
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
      (handle as any)._counts = counts;
    },
  },
);

withTestLbugDB(
  'impact-pdg-e2e-nopdg',
  (handle) => {
    let backend: LocalBackend;

    beforeAll(() => {
      const ext = handle as typeof handle & { _backend?: LocalBackend };
      if (!ext._backend) throw new Error('no-PDG e2e setup did not finish');
      backend = ext._backend;
    });

    it('returns the no-layer envelope for the same fixture indexed without PDG', async () => {
      const result = await backend.callTool('impact', {
        target: 'loopFlow',
        direction: 'downstream',
        mode: 'pdg',
        line: 19,
      });

      expect(result.error).toBeUndefined();
      expect(result.mode).toBe('pdg');
      expect(result.pdgLayer).toBe('no-layer');
      expect(result.note).toContain('--pdg');
      expect(result.target).toEqual({
        id: expect.any(String),
        name: 'loopFlow',
        type: 'Function',
        filePath: 'guards.ts',
      });
      expect(result.impactedCount).toBe(0);
      expect(result.risk).toBe('UNKNOWN');
      expect(result.byDepthCounts).toEqual({ 1: 0 });
    });
  },
  {
    poolAdapter: true,
    timeout: 180_000,
    afterSetup: async (handle) => {
      metaByStoragePath.set(handle.tmpHandle.dbPath, {} as RepoMeta);
      await persistFixtureGraph(false);
      registerSingleRepo(handle, 'impact-pdg-e2e-nopdg', '/impact/no-pdg/repo');
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
