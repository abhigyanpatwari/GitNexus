/**
 * Integration Test: U4 — FULL-STACK inter-procedural PDG chain.
 *
 * The sibling suites each cover half of the producer→consumer contract but
 * neither chains all four stages with the cross-function hop:
 *   - impact-pdg-e2e.test.ts runs the REAL emitter but its persist helper drops
 *     `BasicBlock.calleeIds`, so the U1 inter-procedural descent is never
 *     exercised against real-emitted ids (an emitter line-encoding change to the
 *     calleeIds join would not be caught there).
 *   - impact-pdg-interproc.test.ts exercises the U1 descent but on a HAND-SEEDED
 *     graph (synthetic block ids + hand-written calleeIds), so an emitter change
 *     to the basicBlockId template / calleeIdsOfBlock join would not be caught.
 *
 * This test closes the gap: it runs the REAL pipeline (`runPipelineFromRepo`
 * with `pdg:true`) on the pdg-repo fixture — exercising the real emitter's
 * `basicBlockId` template AND the `calleeIdsOfBlock` resolved-id join — persists
 * the REAL emitted BasicBlock ids + `calleeIds` to a real lbug DB, calls
 * `backend.callTool('impact', { mode:'pdg' })` against that DB, and asserts the
 * projected `affectedStatements` (a) derive from real-emitted block ids and
 * (b) — since U1 landed — CROSS into the called function.
 *
 * ── The real cross-function shape (taint-cases.ts) ───────────────────────────
 *   - `throughCall` (1-based lines 53–57) has a block at startLine 54 whose span
 *     includes the `const built = decorate(raw);` call on line 55; the REAL emitter
 *     populates that block's `calleeIds` with the resolved id `Function:taint-cases.ts:decorate`.
 *   - `decorate` (Function node 0-based [58,60] ⇒ block window [59,61]) carries a
 *     downstream REACHING_DEF dependent statement at line 60 (`return 'sh -c '
 *     + s;`, def→use of the param `s`).
 * Seeding `impact(mode:'pdg', target:'throughCall', line:54)` downstream must
 * therefore surface line 60 — a statement in a DIFFERENT function reachable ONLY
 * via the resolved-callee descent (`interproceduralHops >= 1`).
 *
 * `loadMeta` is mocked to stamp BOTH PDG caps so `pdgLayerStatus` is `ready`.
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
  // hasCallSummary enables the FU-C return-value ascent in the consumer (without
  // it the ascent is suppressed and only the descent path is exercised).
  pdg: { maxCdgEdgesPerFunction: 0, maxReachingDefEdgesPerFunction: 0, hasCallSummary: true },
} as unknown as RepoMeta;

/**
 * Run the REAL `--pdg` pipeline on the fixture and persist its emitted Function
 * + BasicBlock nodes and REACHING_DEF/CDG edges into the active lbug DB.
 *
 * Unlike impact-pdg-e2e's `persistFixtureGraph`, this persists `calleeIds` (and
 * `callees`) on every BasicBlock — the resolved-callee column the U1 descent
 * keys on — so the cross-function hop runs against REAL emitter output.
 */
async function persistFixtureGraphWithCallees(): Promise<{
  reachingDefEdges: number;
  cdgEdges: number;
  calleeIdBearingBlocks: number;
  callSummaryEdges: number;
}> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-impact-pdg-fullchain-'));
  try {
    fs.cpSync(FIXTURE, repoDir, { recursive: true });
    const pipelineResult = await runPipelineFromRepo(repoDir, () => {}, { pdg: true });
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    let calleeIdBearingBlocks = 0;
    const nodes: Array<{ label: 'BasicBlock' | 'Function'; props: Record<string, unknown> }> = [];
    pipelineResult.graph.forEachNode((n) => {
      if (n.label === 'BasicBlock') {
        const calleeIds = typeof n.properties.calleeIds === 'string' ? n.properties.calleeIds : '';
        if (calleeIds.length > 0) calleeIdBearingBlocks++;
        nodes.push({
          label: 'BasicBlock',
          props: {
            id: n.id,
            filePath: n.properties.filePath ?? '',
            startLine: n.properties.startLine ?? 0,
            endLine: n.properties.endLine ?? 0,
            text: n.properties.text ?? '',
            callees: typeof n.properties.callees === 'string' ? n.properties.callees : '',
            calleeIds,
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
        node.props as Record<string, unknown>,
      );
    }

    let reachingDefEdges = 0;
    let cdgEdges = 0;
    let callSummaryEdges = 0;
    for (const rel of pipelineResult.graph.iterRelationships()) {
      // CALL_SUMMARY is a self-loop on the callee's Function/Method node (NOT a
      // BasicBlock edge), so persist it separately — the U-C4 return-value ascent
      // reads it to re-seed the caller's continuation from the call block.
      if (rel.type === 'CALL_SUMMARY') {
        await adapter.executePrepared(
          `MATCH (a:Function {id: $src})
           CREATE (a)-[:CodeRelation {type: 'CALL_SUMMARY', confidence: $confidence, reason: $reason, step: 0}]->(a)`,
          { src: rel.sourceId, confidence: rel.confidence ?? 1.0, reason: rel.reason ?? '' },
        );
        callSummaryEdges++;
        continue;
      }
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
      if (rel.type === 'REACHING_DEF') reachingDefEdges++;
      if (rel.type === 'CDG') cdgEdges++;
    }

    return { reachingDefEdges, cdgEdges, calleeIdBearingBlocks, callSummaryEdges };
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

interface FullChainExt {
  _backend?: LocalBackend;
  _counts?: { reachingDefEdges: number; cdgEdges: number; calleeIdBearingBlocks: number };
}

withTestLbugDB(
  'impact-pdg-fullchain-e2e',
  (handle) => {
    let backend: LocalBackend;
    let counts: NonNullable<FullChainExt['_counts']>;

    beforeAll(() => {
      const ext = handle as IndexedDBHandle & FullChainExt;
      if (!ext._backend || !ext._counts) throw new Error('PDG full-chain e2e setup did not finish');
      backend = ext._backend;
      counts = ext._counts;
    });

    it('chains real emitter -> DB -> impact(mode:pdg) and crosses into the called function (U1)', async () => {
      // The real emitter populated the resolved-callee column the U1 descent
      // keys on, and the data-dependence layer landed.
      expect(counts.calleeIdBearingBlocks).toBeGreaterThan(0);
      expect(counts.reachingDefEdges).toBeGreaterThan(0);
      expect(counts.cdgEdges).toBeGreaterThan(0);

      const result = await backend.callTool('impact', {
        target: 'throughCall',
        direction: 'downstream',
        mode: 'pdg',
        line: 54,
        maxDepth: 10,
        limit: 50,
      });

      expect(result.error).toBeUndefined();
      expect(result.mode).toBe('pdg');
      expect(result.target.name).toBe('throughCall');
      expect(result.target.filePath).toBe('taint-cases.ts');
      expect(result.criterionLine).toBe(54);

      // The persisted block carries the REAL emitted resolved-callee id — this is
      // the producer side of the contract the descent consumes. (Read after the
      // impact call so the MCP pool adapter for this DB is already open.)
      const calleeRows = await executeParameterized(
        handle.dbPath,
        `MATCH (b:BasicBlock)
         WHERE b.filePath = 'taint-cases.ts' AND b.startLine = 54
         RETURN b.id AS id, b.calleeIds AS calleeIds`,
        {},
      );
      const calleeCells = (calleeRows as Array<Record<string, unknown>>).map((r) =>
        String(r['calleeIds'] ?? ''),
      );
      expect(calleeCells.join(' ')).toContain('Function:taint-cases.ts:decorate');
      expect(
        (calleeRows as Array<Record<string, unknown>>).map((r) => String(r['id'] ?? '')),
      ).toEqual(expect.arrayContaining(['BasicBlock:taint-cases.ts:53:7:2']));

      // The slice crossed exactly one resolved-callee function hop (throughCall
      // -> decorate) — the U1 marker. The hop count is documented in the note
      // (the dispatcher folds it into the soundness note rather than a field).
      expect(result.note).toMatch(/crosses 1 inter-procedural hop/i);
      expect(result.note).toMatch(/resolved call sites/i);

      // The called function `decorate` is surfaced in byDepth — the cross-
      // function reach the resolved calleeIds descent unlocked.
      const reachedNames = new Set(
        Object.values(result.byDepth as Record<number, Array<{ name: string }>>)
          .flat()
          .map((i) => i.name),
      );
      expect(reachedNames.has('decorate')).toBe(true);

      // decorate's downstream-dependent statement (line 60, `return 'sh -c ' +
      // s;`) lives in a DIFFERENT function — reachable ONLY via the resolved
      // calleeIds descent, and the projected line derives from the REAL emitted
      // BasicBlock id (anchor `BasicBlock:taint-cases.ts:59:0:2`).
      const statements = result.affectedStatements as Array<{ line: number; text: string }>;
      const lines = statements.map((statement) => statement.line).sort((a, b) => a - b);
      expect(lines).toContain(60);
      expect(statements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ line: 60, text: "return 'sh -c ' + s;" }),
        ]),
      );
      // FU-C wiring (hasCallSummary:true + a REAL persisted CALL_SUMMARY edge):
      // line 56 `exec(built);` consumes `built`, decorate's RETURN value. The
      // consumer ran calleesWithReturnFlow against the real CALL_SUMMARY edge and
      // surfaced the call-result continuation — the meta -> callSummaryAvailable
      // -> CALL_SUMMARY-read path that was previously only mock-covered.
      expect(lines).toContain(56);
      expect(statements).toEqual(
        expect.arrayContaining([expect.objectContaining({ line: 56, text: 'exec(built);' })]),
      );
      // The seed statement's own line (54) is excluded (seed-minus-reachable).
      expect(lines).not.toContain(54);
      expect(result.affectedStatementCount).toBe(result.affectedStatements.length);
    });
  },
  {
    poolAdapter: true,
    timeout: 180_000,
    afterSetup: async (handle) => {
      metaByStoragePath.set(handle.tmpHandle.dbPath, READY_PDG_META);
      const counts = await persistFixtureGraphWithCallees();
      if (
        counts.reachingDefEdges === 0 ||
        counts.calleeIdBearingBlocks === 0 ||
        counts.callSummaryEdges === 0
      ) {
        throw new Error(
          'fixture produced no calleeId-bearing blocks, dependence edges, or CALL_SUMMARY edges',
        );
      }
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'impact-pdg-fullchain-e2e',
          path: '/impact/pdg/fullchain/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'impact-pdg-fullchain-e2e',
          stats: { files: 4, nodes: 4, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      const ext = handle as IndexedDBHandle & FullChainExt;
      ext._backend = backend;
      ext._counts = counts;
    },
  },
);
