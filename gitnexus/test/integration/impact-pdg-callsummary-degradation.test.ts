/**
 * Integration Test (golden): the NEWEST old-index degradation class —
 * a v3 / pre-FU-C `--pdg` index that LACKS the CALL_SUMMARY layer.
 *
 * The PDG contract is "loud degrade, never silent success." Three old-index
 * classes are documented by the new code:
 *   1. no CALL_SITE anchors / no calleeIds  → impact-pdg-interproc.test.ts
 *      ("pre-namespace-v4 degrade path": a seed whose blocks carry no calleeIds
 *      stays intra-only, no cross-function leak).
 *   2. no usable PDG layer (CDG/RD absent or partial) → impact-pdg-degradation
 *      and impact-pdg-id-degradation (the four-state pdgLayerStatus contract).
 *   3. CALL_SUMMARY ABSENT (this file). The least-tested case: an index whose
 *      CDG + REACHING_DEF layers ARE stamped (so the intra slice runs AND the
 *      inter-procedural descent crosses call boundaries) but whose meta has no
 *      `hasCallSummary` stamp. The return-value ASCENT silently does nothing —
 *      so the user MUST be told (a re-index remediation note), never a silent
 *      "complete" result.
 *
 * This golden asserts the EXACT degraded envelope (not just non-crash):
 *   - the result is still mode:'pdg' with pdgResultVersion:2 (the contract
 *     discriminator);
 *   - the intra slice is PRESENT (CALL_SUMMARY is NOT a required sub-layer — the
 *     index is `ready`, pdgLayer is undefined, risk is UNKNOWN, epistemic is the
 *     real-traversal marker);
 *   - the note carries the "re-index for CALL_SUMMARY" remediation text — the
 *     ascent did nothing but the user is TOLD.
 *
 * Fixture mirrors impact-pdg-interproc.test.ts (fnA calls fnB via calleeIds, a
 * downstream RD dependent inside fnB) so the slice genuinely crosses one
 * inter-procedural hop — which is the precondition for the CALL_SUMMARY
 * remediation note to fire.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { RepoMeta } from '../../src/storage/repo-manager.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
    // v3 / pre-FU-C index: BOTH caps stamped (⇒ pdgLayerStatus === 'ready', the
    // intra slice + inter-procedural descent run) but NO `hasCallSummary` stamp
    // (⇒ callSummaryAvailable === false ⇒ return-value ascent is suppressed and
    // the remediation note fires).
    loadMeta: vi.fn().mockResolvedValue({
      pdg: { maxCdgEdgesPerFunction: 0, maxReachingDefEdgesPerFunction: 0 },
    } as unknown as RepoMeta),
  };
});

const F = 'src/callsummary.ts';

withTestLbugDB(
  'impact-pdg-callsummary-degradation',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      const ext = handle as typeof handle & { _backend?: LocalBackend };
      if (!ext._backend) throw new Error('LocalBackend not initialized in afterSetup');
      backend = ext._backend;
    });

    const slice = () =>
      backend.callTool('impact', {
        target: 'fnA',
        direction: 'downstream',
        mode: 'pdg',
        line: 6,
        maxDepth: 10,
      });

    describe('CALL_SUMMARY-absent (v3 / pre-FU-C index): the ascent is silent but the user is TOLD', () => {
      it('returns the EXACT degraded envelope — mode:pdg, pdgResultVersion:2, intra slice present, risk UNKNOWN', async () => {
        const result = await slice();
        // Golden envelope: the index is `ready` (CALL_SUMMARY is NOT a required
        // sub-layer), so this is a real traversal result — NOT a pdgLayer
        // degradation early-return. The intra slice ran and risk stays UNKNOWN.
        expect(result).toMatchObject({
          mode: 'pdg',
          pdgResultVersion: 2,
          risk: 'UNKNOWN',
          epistemic: 'pdg-intra-procedural',
          target: { id: 'func:fnA', name: 'fnA' },
          criterionLine: 6,
        });
        // CALL_SUMMARY absence does NOT degrade the layer: no pdgLayer marker,
        // no probe error, no hard error — the call reached the traversal.
        expect(result.pdgLayer).toBeUndefined();
        expect(result.error).toBeUndefined();
        // The intra slice is PRESENT (the index served the statement slice).
        expect(result.affectedStatementCount).toBeGreaterThanOrEqual(1);
      });

      it('the note carries the "re-index for CALL_SUMMARY" remediation (ascent did nothing, user is TOLD)', async () => {
        const result = await slice();
        // The slice crossed one inter-procedural hop, so the FU-C degradation
        // note fires: a caller statement depending on a callee's RETURN value is
        // NOT in the slice on a pre-FU-C index — re-index to enable it.
        expect(result.note).toMatch(/re-index for CALL_SUMMARY/i);
        expect(result.note).toMatch(/CALL_SUMMARY/);
        expect(result.note).toMatch(/analyze --pdg/);
        // It must NOT read as a confident "complete / no further reach" result.
        expect(result.note).not.toMatch(/not yet implemented/i);
      });
    });
  },
  {
    poolAdapter: true,
    afterSetup: async (handle) => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const fn = (id: string, name: string, startLine: number, endLine: number) =>
        adapter.executePrepared(
          `CREATE (n:Function {id: $id, name: $name, filePath: $filePath, startLine: $startLine, endLine: $endLine, isExported: true, content: 'x', description: 'callsummary fixture'})`,
          { id, name, filePath: F, startLine, endLine },
        );
      // A BasicBlock carrying the resolved-callee binding the descent keys on.
      const block = (id: string, startLine: number, text: string, calleeIds: string) =>
        adapter.executePrepared(
          `CREATE (b:BasicBlock {id: $id, filePath: $filePath, startLine: $startLine, endLine: $startLine, text: $text, callees: '', calleeIds: $calleeIds})`,
          { id, filePath: F, startLine, text, calleeIds },
        );
      const edge = (type: 'CDG' | 'REACHING_DEF', src: string, dst: string, reason: string) =>
        adapter.executePrepared(
          `MATCH (a:BasicBlock {id: $src}), (b:BasicBlock {id: $dst})
           CREATE (a)-[:CodeRelation {type: '${type}', confidence: 1.0, reason: $reason, step: 0}]->(b)`,
          { src, dst, reason },
        );

      // Block ids: BasicBlock:<filePath>:<fnLine>:<fnCol>:<blockIdx>  (fnLine 1-based)
      // fnA @0-based[4,8] ⇒ window [5,9]; seed block SA@6 calls fnB.
      const SA = `BasicBlock:${F}:5:0:0`;
      // fnB @0-based[14,18] ⇒ window [15,19]; SB@16; BD@18 RD-dependent.
      const SB = `BasicBlock:${F}:15:0:0`;
      const BD = `BasicBlock:${F}:15:0:1`;

      await fn('func:fnA', 'fnA', 4, 8);
      await fn('func:fnB', 'fnB', 14, 18);

      await block(SA, 6, 'const a = fnB(x);', 'func:fnB');
      await block(SB, 16, 'const r = compute(y);', '');
      await block(BD, 18, 'return r;', '');

      // Intra-fnB dependence: SB → BD (line 18 depends on line 16).
      await edge('REACHING_DEF', SB, BD, 'r');

      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'callsummary-repo',
          path: '/callsummary/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'callsummary123',
          stats: { files: 1, nodes: 5, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as typeof handle & { _backend?: LocalBackend })._backend = backend;
    },
  },
);
