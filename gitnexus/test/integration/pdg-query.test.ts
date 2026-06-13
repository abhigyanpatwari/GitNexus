/**
 * Integration Tests: MCP `pdg_query` tool (#2086 M6)
 *
 * End-to-end against a REAL LadybugDB: the pdg-repo fixture is indexed by the
 * real pipeline with `--pdg` (workers — requires `node scripts/build.js`), the
 * resulting BasicBlock nodes + CDG/REACHING_DEF edges and the fixture's
 * Function symbols are persisted into the test DB, and `pdg_query` is exercised
 * through the full `callTool` dispatch:
 *
 * - controls mode: "under what condition does X run?" (CDG), incl. the
 *   guard-clause subset (early-return block, #559 subsumption / R1)
 * - flows mode: "where does variable Y flow?" (REACHING_DEF def→use) / R2
 * - symbol + file anchoring; required-target / invalid-mode / bad-limit errors
 * - a repo WITHOUT the pdg layer → the "no PDG layer" note, not an error
 *
 * Seeding via the real emit output (not hand-written rows) pins the format
 * compatibility between the M5/M2 write path and the M6 read path — the
 * BasicBlock id template + the 'T'/'F' / variable `reason` semantics.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos, loadMeta } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
    // No meta.json for the seeded test DB — pdg_query's meta probe degrades to
    // the row-existence probe (the seeded-DB reality, like taint-explain).
    loadMeta: vi.fn().mockResolvedValue(null),
  };
});

const FIXTURE = path.join(__dirname, 'cfg', 'fixtures', 'pdg-repo');

// ─── Block 1: a --pdg index with real CDG + REACHING_DEF edges ───────

withTestLbugDB(
  'pdg-query',
  (handle) => {
    describe('pdg_query against a --pdg index', () => {
      let backend: LocalBackend;
      beforeAll(() => {
        const ext = handle as typeof handle & { _backend?: LocalBackend };
        if (!ext._backend) throw new Error('LocalBackend not initialized in afterSetup');
        backend = ext._backend;
      });

      it('controls mode answers "what controls X" and flags the guard clause (R1)', async () => {
        const result = await backend.callTool('pdg_query', { mode: 'controls', target: 'guarded' });
        expect(result).not.toHaveProperty('error');
        expect(result.mode).toBe('controls');
        expect(result.anchor.symbol).toBe('guarded');
        expect(result.results.length).toBeGreaterThan(0);
        // every edge has a 'T'/'F' branch label
        for (const e of result.results) expect(['T', 'F']).toContain(e.label);
        // the early `return -1` is control-dependent on the guard predicate →
        // flagged guard:true (the #559 guard-clause subsumption)
        const guardEdge = result.results.find((e: any) => e.guard === true);
        expect(guardEdge, 'a guard-clause edge into an early-exit block').toBeDefined();
        expect(guardEdge.dependent.text).toMatch(/return/);
      });

      it('flows mode answers "where does variable Y flow" (R2)', async () => {
        const result = await backend.callTool('pdg_query', {
          mode: 'flows',
          target: 'loopFlow',
          variable: 'sum',
        });
        expect(result).not.toHaveProperty('error');
        expect(result.mode).toBe('flows');
        expect(result.results.length).toBeGreaterThan(0);
        for (const e of result.results) expect(e.variable).toBe('sum');
      });

      it('flows mode without a variable filter returns all def→use edges for the anchor', async () => {
        const result = await backend.callTool('pdg_query', { mode: 'flows', target: 'loopFlow' });
        expect(result).not.toHaveProperty('error');
        expect(result.results.length).toBeGreaterThan(0);
        expect(result.results.some((e: any) => e.variable === 'sum')).toBe(true);
      });

      it('controls mode anchors by file path too', async () => {
        const result = await backend.callTool('pdg_query', {
          mode: 'controls',
          target: 'guards.ts',
        });
        expect(result).not.toHaveProperty('error');
        expect(result.results.length).toBeGreaterThan(0);
      });

      it('rejects a missing target (PDG queries are always anchored)', async () => {
        const result = await backend.callTool('pdg_query', { mode: 'controls' });
        expect(result).toHaveProperty('error');
        expect(result.error).toMatch(/target/i);
      });

      it('rejects an invalid mode', async () => {
        const result = await backend.callTool('pdg_query', { mode: 'slice', target: 'guarded' });
        expect(result).toHaveProperty('error');
        expect(result.error).toMatch(/mode/i);
      });

      it('rejects an out-of-bounds limit', async () => {
        for (const limit of [0, -1, 1.5, 10_000, NaN]) {
          const result = await backend.callTool('pdg_query', {
            mode: 'controls',
            target: 'guarded',
            limit,
          });
          expect(result).toHaveProperty('error');
          expect(result.error).toMatch(/limit/i);
        }
      });

      it('an unknown symbol target mirrors context() not-found semantics', async () => {
        const result = await backend.callTool('pdg_query', {
          mode: 'controls',
          target: 'nonexistentPdgFn999',
        });
        expect(result).toHaveProperty('error');
        expect(result.error).toMatch(/not found/i);
      });
    });
  },
  {
    poolAdapter: true,
    afterSetup: async (handle) => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-pdgq-'));
      try {
        fs.cpSync(FIXTURE, repoDir, { recursive: true });
        const pipelineResult = await runPipelineFromRepo(repoDir, () => {}, { pdg: true });

        const adapter = await import('../../src/core/lbug/lbug-adapter.js');
        const nodes: Array<{ label: string; props: Record<string, unknown> }> = [];
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
        }
        if (pdgEdges === 0) {
          throw new Error('fixture produced no CDG/REACHING_DEF edges — pdg emit regressed?');
        }
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }

      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'pdg-repo',
          path: '/pdg/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 4, nodes: 4, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);

// ─── Block 2: a repo indexed WITHOUT --pdg ───────────────────────────

withTestLbugDB(
  'pdg-query-nopdg',
  (handle) => {
    describe('pdg_query without a PDG layer', () => {
      let backend: LocalBackend;
      beforeAll(() => {
        const ext = handle as typeof handle & { _backend?: LocalBackend };
        if (!ext._backend) throw new Error('LocalBackend not initialized in afterSetup');
        backend = ext._backend;
      });

      it('controls returns the no-PDG-layer note (row-existence probe, meta unreadable)', async () => {
        const result = await backend.callTool('pdg_query', { mode: 'controls', target: 'plainFn' });
        expect(result).not.toHaveProperty('error');
        expect(result.results).toEqual([]);
        expect(result.note).toMatch(/no PDG layer/i);
        expect(result.note).toContain('--pdg');
      });

      it('flows returns the no-PDG-layer note too', async () => {
        const result = await backend.callTool('pdg_query', { mode: 'flows', target: 'plain.ts' });
        expect(result).not.toHaveProperty('error');
        expect(result.results).toEqual([]);
        expect(result.note).toMatch(/no PDG layer/i);
      });

      it('a readable meta without a pdg stamp short-circuits to the note', async () => {
        vi.mocked(loadMeta).mockResolvedValueOnce({} as any);
        const result = await backend.callTool('pdg_query', { mode: 'controls', target: 'plainFn' });
        expect(result.results).toEqual([]);
        expect(result.note).toMatch(/no PDG layer/i);
      });
    });
  },
  {
    seed: [
      `CREATE (fn:Function {id: 'func:plainFn', name: 'plainFn', filePath: 'src/plain.ts', startLine: 1, endLine: 5, isExported: true, content: 'function plainFn() {}', description: 'no pdg layer here'})`,
    ],
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'plain-repo',
          path: '/plain/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'def456',
          stats: { files: 1, nodes: 1, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
