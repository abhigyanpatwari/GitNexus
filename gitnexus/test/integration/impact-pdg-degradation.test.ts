/**
 * Integration Tests: `impact` PDG-mode layer degradation contract (U2 / KTD7)
 *
 * End-to-end against a REAL LadybugDB, through the full `callTool('impact', …)`
 * dispatch. Exercises the four-state PDG-layer presence/degradation check
 * (`pdgLayerStatus`) wired into `_impactImpl`'s PDG branch — the check that
 * fires after symbol resolution but before traversal so a missing or partial
 * `--pdg` layer returns a distinct target-aware guidance note instead of a
 * confusing empty blast radius.
 *
 * The four states (KTD7) are driven by what the (mocked) `loadMeta` returns —
 * matching the seeded-DB reality that there is no on-disk `meta.json`:
 *   - no-layer          : meta readable, no `pdg` stamp        → run analyze --pdg
 *   - sub-layer-missing : exactly one cap stamped (CDG xor RD) → names the missing one
 *   - ready             : both caps stamped                    → falls through to traversal
 *   - unknown           : meta unreadable (null)               → inconclusive, via 1 LIMIT 1 probe
 *
 * The `ready` case asserts the layer check lets the call THROUGH to the real
 * traversal, while degraded states return before `_runImpactPDG`.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { RepoMeta } from '../../src/storage/repo-manager.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos, loadMeta } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
    // Default: meta unreadable (the seeded-DB reality — no on-disk meta.json).
    // Individual tests override per state via mockResolvedValueOnce.
    loadMeta: vi.fn().mockResolvedValue(null),
  };
});

// Minimal seed: one Function symbol (so a `ready` index could resolve it) plus
// a single BasicBlock + CDG edge so the `unknown` state's LIMIT 1 probe finds a
// row (it must STILL stay inconclusive — a present edge cannot disprove an
// edge-free layer / #2188).
const SEED = [
  `CREATE (fn:Function {id: 'func:hot', name: 'hot', filePath: 'src/hot.ts', startLine: 1, endLine: 5, isExported: true, content: 'function hot() {}', description: 'degradation fixture'})`,
  `CREATE (b0:BasicBlock {id: 'BasicBlock:src/hot.ts:1:0:0', filePath: 'src/hot.ts', startLine: 2, endLine: 2, text: 'if (x)'})`,
  `CREATE (b1:BasicBlock {id: 'BasicBlock:src/hot.ts:1:0:1', filePath: 'src/hot.ts', startLine: 3, endLine: 3, text: 'doThing();'})`,
];
const SEED_EDGE = `MATCH (a:BasicBlock {id: 'BasicBlock:src/hot.ts:1:0:0'}), (b:BasicBlock {id: 'BasicBlock:src/hot.ts:1:0:1'})
  CREATE (a)-[:CodeRelation {type: 'CDG', confidence: 1.0, reason: 'T', step: 0}]->(b)`;

const META = (pdg?: RepoMeta['pdg']): RepoMeta => ({ pdg }) as unknown as RepoMeta;

function expectEmptyPdgParity(result: any): void {
  expect(result.mode).toBe('pdg');
  expect(result.direction).toBe('downstream');
  expect(result.impactedCount).toBe(0);
  expect(result.risk).toBe('UNKNOWN');
  expect(result.byDepth).toEqual({});
  expect(result.byDepthCounts).toEqual({ 1: 0 });
  expect(result.summary).toEqual({ direct: 0, processes_affected: 0, modules_affected: 0 });
  expect(result.affected_processes).toEqual([]);
  expect(result.affected_modules).toEqual([]);
}

withTestLbugDB(
  'impact-pdg-degradation',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      const ext = handle as typeof handle & { _backend?: LocalBackend };
      if (!ext._backend) throw new Error('LocalBackend not initialized in afterSetup');
      backend = ext._backend;
    });

    // Reset the loadMeta mock to the default (unreadable) before each test so a
    // mockResolvedValueOnce set in one test never leaks into the next.
    beforeEach(() => {
      vi.mocked(loadMeta).mockReset();
      vi.mocked(loadMeta).mockResolvedValue(null);
    });

    describe('no-layer (meta readable, no pdg stamp)', () => {
      it('returns the definitive target-aware "run analyze --pdg" note', async () => {
        // Readable meta with no `pdg` key ⇒ the layer was never recorded.
        vi.mocked(loadMeta).mockResolvedValueOnce(META(undefined));
        const result = await backend.callTool('impact', {
          target: 'hot',
          direction: 'downstream',
          mode: 'pdg',
        });

        expect(result.mode).toBe('pdg');
        expect(result.pdgLayer).toBe('no-layer');
        expect(result.target).toEqual({
          id: 'func:hot',
          name: 'hot',
          type: 'Function',
          filePath: 'src/hot.ts',
        });
        expect(result.note).toMatch(/no PDG layer/i);
        expect(result.note).toContain('--pdg');
        // Not a status-unknown note, not a confident LOW.
        expect(result.error).toBeUndefined();
        expect(result.note).not.toMatch(/status unknown/i);
        expect(result.note).not.toMatch(/not yet implemented/i);
        expectEmptyPdgParity(result);
      });
    });

    describe('sub-layer-missing (exactly one cap stamped)', () => {
      it('CDG present, RD absent → names REACHING_DEF as missing', async () => {
        vi.mocked(loadMeta).mockResolvedValueOnce(META({ maxCdgEdgesPerFunction: 0 } as any));
        const result = await backend.callTool('impact', {
          target: 'hot',
          direction: 'downstream',
          mode: 'pdg',
        });
        expect(result.pdgLayer).toBe('sub-layer-missing');
        expect(result.target.filePath).toBe('src/hot.ts');
        expect(result.target.type).toBe('Function');
        expect(result.missingSubLayer).toBe('REACHING_DEF');
        expect(result.note).toMatch(/REACHING_DEF/);
        // Partial layer must NOT be reported as complete (no LOW).
        expect(result.note).not.toMatch(/not yet implemented/i);
        expectEmptyPdgParity(result);
      });

      it('RD present, CDG absent → names CDG as missing', async () => {
        vi.mocked(loadMeta).mockResolvedValueOnce(
          META({ maxReachingDefEdgesPerFunction: 0 } as any),
        );
        const result = await backend.callTool('impact', {
          target: 'hot',
          direction: 'downstream',
          mode: 'pdg',
        });
        expect(result.pdgLayer).toBe('sub-layer-missing');
        expect(result.missingSubLayer).toBe('CDG');
        expect(result.note).toMatch(/\bCDG\b/);
        expect(result.note).not.toMatch(/not yet implemented/i);
        expectEmptyPdgParity(result);
      });
    });

    describe('ready (both caps stamped)', () => {
      it('falls THROUGH the layer check to the real traversal (U3 _runImpactPDG)', async () => {
        vi.mocked(loadMeta).mockResolvedValueOnce(
          META({ maxCdgEdgesPerFunction: 0, maxReachingDefEdgesPerFunction: 0 } as any),
        );
        const result = await backend.callTool('impact', {
          target: 'hot',
          direction: 'downstream',
          mode: 'pdg',
        });
        // The layer is complete, so the check did NOT short-circuit: there is no
        // degradation note / pdgLayer marker — the call reached the traversal.
        expect(result.pdgLayer).toBeUndefined();
        // `hot` has a
        // PDG body (blocks B0→B1) but the only dependent (B1) is itself a seed
        // block of the symbol, so the intra-procedural downstream reachable set
        // is empty — and that is signalled as a real traversal result with the
        // distinct "has a body but no dependence" note, NOT the no-body /
        // degradation path. The load-bearing U2 fact —
        // `ready` does NOT return a degradation note — still holds.
        expect(result.mode).toBe('pdg');
        expect(result.error).toBeUndefined();
        expect(result.note).not.toMatch(/not yet implemented/i);
        expect(Array.isArray(result.reachableBlocks)).toBe(true);
        // Distinct from KTD6 "no PDG body": this symbol HAS a body.
        expect(result.epistemic).not.toBe('no-pdg-body');
      });

      it('a line-seeded slice over callee-less blocks degrades gracefully (real-DB calleesOfBlocks)', async () => {
        // The seeded BasicBlocks carry no `callees` data (created without the
        // property — the pre-v2 / no-calls reality). A downstream line seed at
        // B0 reaches B1 via the CDG edge, so calleesOfBlocks runs over real
        // seed+reachable blocks; with no callee data it must yield an empty set
        // and degrade to callgraph-equal — no throw, no partial precision.
        vi.mocked(loadMeta).mockResolvedValueOnce(
          META({ maxCdgEdgesPerFunction: 0, maxReachingDefEdgesPerFunction: 0 } as any),
        );
        const result = await backend.callTool('impact', {
          target: 'hot',
          direction: 'downstream',
          mode: 'pdg',
          line: 2,
        });
        // The slice resolved (B1 is downstream-dependent on the line-2 seed) and
        // the call completed without surfacing a callees-query failure.
        expect(result.error).toBeUndefined();
        expect(result.epistemic).toBe('pdg-intra-procedural');
        expect(result.affectedStatementCount).toBeGreaterThanOrEqual(1);
        // No CALLS edge in the fixture and no callee data on the blocks, so the
        // statement-precise inter-procedural reach is empty — precision is null
        // (no reach), never a partial value, and nothing threw.
        expect(result.pdgInterprocedural.statementPrecision).toBeNull();
      });
    });

    describe('unknown (meta unreadable)', () => {
      it('returns the inconclusive "status unknown" note via a bounded probe, even with edges present', async () => {
        // loadMeta defaults to null (unreadable) via beforeEach. The seeded DB
        // DOES carry a CDG edge, but the note must stay inconclusive — a present
        // edge cannot prove the layer is complete, and a missing one is
        // indistinguishable from an edge-free index (#2188).
        const result = await backend.callTool('impact', {
          target: 'hot',
          direction: 'downstream',
          mode: 'pdg',
        });
        expect(result.pdgLayer).toBe('unknown');
        expect(result.target.filePath).toBe('src/hot.ts');
        expect(result.target.type).toBe('Function');
        expect(result.note).toMatch(/status unknown/i);
        expect(result.note).toContain('--pdg');
        // Inconclusive ≠ definitive no-layer wording.
        expect(result.note).not.toMatch(/no PDG layer/i);
        expect(result.note).not.toMatch(/not yet implemented/i);
        expectEmptyPdgParity(result);
      });
    });

    describe('callgraph mode is unaffected by the PDG-layer probe', () => {
      it('mode:callgraph never consults the PDG layer (no degradation note)', async () => {
        // Even with meta unreadable, a callgraph impact resolves the symbol and
        // returns a real (here: empty-graph) blast radius, never a PDG note.
        const result = await backend.callTool('impact', {
          target: 'hot',
          direction: 'downstream',
          mode: 'callgraph',
        });
        expect(result.pdgLayer).toBeUndefined();
        // The callgraph path never sets a PDG degradation note. (It may carry
        // its own callgraph-flavored notes, but never the PDG-layer wording.)
        const note = typeof result.note === 'string' ? result.note : '';
        expect(note).not.toMatch(/status unknown/i);
        expect(note).not.toMatch(/no PDG layer/i);
      });
    });
  },
  {
    seed: [...SEED, SEED_EDGE],
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'degradation-repo',
          path: '/degradation/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'deg123',
          stats: { files: 1, nodes: 3, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
