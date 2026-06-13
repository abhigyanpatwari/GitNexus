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

      it('a call with no arguments returns a clean validation error, not a crash (#2188)', async () => {
        // An MCP client may send {"name":"pdg_query"} with no `arguments` field;
        // the dispatch then hands `params: undefined` to the impl. It must
        // default to {} and surface the mode-validation error, not a TypeError.
        const result = await backend.callTool('pdg_query');
        expect(result).toHaveProperty('error');
        expect(result.error).toMatch(/mode/i);
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

// ─── Block 3: symbol-anchor line-base off-by-one (#2188 review) ──────
//
// Hand-seeded with controlled line numbers (no parser dependency): `targetFn`
// occupies 0-based symbol lines 10–14, and a neighbor function sits directly
// above it with its last block on 1-based line 10 — the line right above
// targetFn's declaration (1-based line 11). BasicBlock startLine is 1-based
// while the symbol span is 0-based, so the anchor window must be [11,15] (both
// bounds shifted +1). The pre-fix window [10,15] (lower bound left 0-based)
// over-includes the neighbor's line-10 block. This pins the lower-bound +1.

withTestLbugDB(
  'pdg-query-adjacency',
  (handle) => {
    describe('pdg_query symbol anchoring (#2188 lower-bound off-by-one)', () => {
      let backend: LocalBackend;
      beforeAll(() => {
        const ext = handle as typeof handle & { _backend?: LocalBackend };
        if (!ext._backend) throw new Error('LocalBackend not initialized in afterSetup');
        backend = ext._backend;
      });

      it('excludes a neighbor function block on the line directly above the target', async () => {
        const result = await backend.callTool('pdg_query', {
          mode: 'controls',
          target: 'targetFn',
        });
        expect(result).not.toHaveProperty('error');
        // Only targetFn's own control edge — the neighbor's line-10 edge is out
        // of the [11,15] window after the lower-bound +1 fix.
        expect(result.results).toHaveLength(1);
        expect(result.results[0].dependent.text).toMatch(/doThing/);
        expect(result.results[0].functionLine).toBe(11);
        expect(result.results.some((e: any) => /aboveDep/.test(e.dependent.text))).toBe(false);
      });
    });
  },
  {
    poolAdapter: true,
    afterSetup: async (handle) => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const nodeStmts = [
        `CREATE (fn:Function {id: 'func:targetFn', name: 'targetFn', filePath: 'src/adj.ts', startLine: 10, endLine: 14, isExported: true, content: 'function targetFn(x) {}', description: 'adjacency regression'})`,
        // targetFn's blocks (fnStartLine segment '11', 1-based startLines 12/13)
        `CREATE (b:BasicBlock {id: 'BasicBlock:src/adj.ts:11:0:0', filePath: 'src/adj.ts', startLine: 12, endLine: 12, text: 'if (x)'})`,
        `CREATE (b:BasicBlock {id: 'BasicBlock:src/adj.ts:11:0:1', filePath: 'src/adj.ts', startLine: 13, endLine: 13, text: 'doThing();'})`,
        // neighbor function's blocks (fnStartLine segment '9', 1-based startLine 10)
        `CREATE (b:BasicBlock {id: 'BasicBlock:src/adj.ts:9:0:0', filePath: 'src/adj.ts', startLine: 10, endLine: 10, text: 'if (above)'})`,
        `CREATE (b:BasicBlock {id: 'BasicBlock:src/adj.ts:9:0:1', filePath: 'src/adj.ts', startLine: 10, endLine: 10, text: 'aboveDep();'})`,
      ];
      for (const s of nodeStmts) await adapter.executePrepared(s, {});
      const cdgEdge = (src: string, dst: string) =>
        adapter.executePrepared(
          `MATCH (a:BasicBlock {id: $src}), (b:BasicBlock {id: $dst})
           CREATE (a)-[:CodeRelation {type: 'CDG', confidence: 1.0, reason: 'T', step: 0}]->(b)`,
          { src, dst },
        );
      await cdgEdge('BasicBlock:src/adj.ts:11:0:0', 'BasicBlock:src/adj.ts:11:0:1');
      await cdgEdge('BasicBlock:src/adj.ts:9:0:0', 'BasicBlock:src/adj.ts:9:0:1');

      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'adj-repo',
          path: '/adj/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'adj789',
          stats: { files: 1, nodes: 5, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
