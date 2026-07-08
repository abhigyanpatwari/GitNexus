/**
 * Integration Test: U1 — bounded INTER-PROCEDURAL PDG forward slice.
 *
 * The intra-procedural slice (CDG + REACHING_DEF) stays inside one function.
 * U1 descends through resolved call sites (`BasicBlock.calleeIds`) so the
 * statement slice crosses function boundaries — HRB context-insensitive forward
 * closure (Joern's shipped approach), DOWNSTREAM only, bounded by a function-hop
 * depth budget + a shared `visited` set.
 *
 * ── Fixture graph (hand-seeded, no parser; controlled line numbers) ──────────
 * Two files mirror the resolved-callee binding the descent keys on.
 *   - `fnA` at 0-based [4,8]  (window [5,9]); seed block SA@6 carries
 *     `calleeIds = 'func:fnB'` (fnA calls fnB on the seeded line 6).
 *   - `fnB` at 0-based [14,18] (window [15,19]); seed block SB@16, with a
 *     downstream REACHING_DEF dependent BD@18 ('return r;') inside fnB.
 *   - `fnC` at 0-based [24,28]; SB@16 carries `calleeIds = 'func:fnC'`, so the
 *     descent reaches a SECOND hop (fnB calls fnC). fnC has dependent CD@27.
 * Seeding `impact(mode:'pdg', line:6, target:'fnA')` downstream must surface
 * fnB's dependent statement (line 18) AND fnC's (line 27) in affectedStatements
 * — neither is reachable by the intra slice (they live in other functions).
 *
 * A control fixture `fnNoCall` carries NO `calleeIds` (the pre-namespace-v4
 * degrade path): its slice must stay intra-only (no cross-function leak).
 *
 * `loadMeta` is mocked to stamp BOTH caps so `pdgLayerStatus` returns `ready`.
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
    // Both caps stamped ⇒ pdgLayerStatus === 'ready' ⇒ traversal + descent run.
    loadMeta: vi.fn().mockResolvedValue({
      pdg: { maxCdgEdgesPerFunction: 0, maxReachingDefEdgesPerFunction: 0 },
    } as unknown as RepoMeta),
  };
});

const F = 'src/interproc.ts';

withTestLbugDB(
  'impact-pdg-interproc',
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

    describe('cross-function forward closure (U1)', () => {
      it('reaches a dependent statement in a CALLED function (fnA -> fnB) in affectedStatements', async () => {
        const result = await slice();
        expect(result.error).toBeUndefined();
        expect(result.mode).toBe('pdg');
        expect(result.target.id).toBe('func:fnA');
        expect(result.criterionLine).toBe(6);
        const lines = (result.affectedStatements as Array<{ line: number }>)
          .map((s) => s.line)
          .sort((a, b) => a - b);
        // fnB's downstream-dependent statement (line 18) is cross-function — only
        // the inter-procedural descent surfaces it.
        expect(lines).toContain(18);
      });

      it('descends a SECOND hop (fnB -> fnC) within the depth budget', async () => {
        const result = await slice();
        const lines = (result.affectedStatements as Array<{ line: number }>)
          .map((s) => s.line)
          .sort((a, b) => a - b);
        // fnC is reached only via fnB's call site (two function hops from fnA).
        expect(lines).toContain(27);
      });

      it('projects the called functions to owning symbols in byDepth (single collapsed bucket)', async () => {
        const result = await slice();
        // byDepth stays the single collapsed bucket (block-hops are not call-hops);
        // the cross-function reach DEEPENS the statement slice, not the bucket count.
        expect(Object.keys(result.byDepth)).toEqual(['1']);
        const names = new Set(
          Object.values(result.byDepth as Record<number, Array<{ name: string }>>)
            .flat()
            .map((i) => i.name),
        );
        expect(names.has('fnB')).toBe(true);
        expect(names.has('fnC')).toBe(true);
      });

      it('documents the 4 soundness caveats in the note when the slice crosses a hop', async () => {
        const result = await slice();
        expect(result.note).toMatch(/return-value ascent/i);
        expect(result.note).toMatch(/context-insensitive/i);
        expect(result.note).toMatch(/alias model/i);
        expect(result.note).toMatch(/resolver/i);
      });

      it('risk stays UNKNOWN (never a confident LOW) and the result is consumer-shaped', async () => {
        const result = await slice();
        expect(result.risk).toBe('UNKNOWN');
        expect(result.risk).not.toBe('LOW');
        expect(result.affected_processes).toEqual([]);
        expect(result.affected_modules).toEqual([]);
      });
    });

    describe('pre-namespace-v4 degrade path (no calleeIds)', () => {
      it('a seed whose blocks carry no calleeIds stays intra-only (no cross-function leak)', async () => {
        const result = await backend.callTool('impact', {
          target: 'fnNoCall',
          direction: 'downstream',
          mode: 'pdg',
          line: 36,
          maxDepth: 10,
        });
        expect(result.error).toBeUndefined();
        expect(result.mode).toBe('pdg');
        const lines = (result.affectedStatements as Array<{ line: number }>)
          .map((s) => s.line)
          .sort((a, b) => a - b);
        // The intra dependent (line 38) is present; no foreign-function line leaks.
        expect(lines).toContain(38);
        expect(lines).not.toContain(18);
        expect(lines).not.toContain(27);
      });
    });
  },
  {
    poolAdapter: true,
    afterSetup: async (handle) => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const fn = (id: string, name: string, startLine: number, endLine: number) =>
        adapter.executePrepared(
          `CREATE (n:Function {id: $id, name: $name, filePath: $filePath, startLine: $startLine, endLine: $endLine, isExported: true, content: 'x', description: 'interproc fixture'})`,
          { id, name, filePath: F, startLine, endLine },
        );
      // A BasicBlock that carries the resolved-callee binding the descent keys on.
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
      // fnB @0-based[14,18] ⇒ window [15,19]; SB@16 calls fnC; BD@18 RD-dependent.
      const SB = `BasicBlock:${F}:15:0:0`;
      const BD = `BasicBlock:${F}:15:0:1`;
      // fnC @0-based[24,28] ⇒ window [25,29]; SC@26; CD@27 RD-dependent.
      const SC = `BasicBlock:${F}:25:0:0`;
      const CD = `BasicBlock:${F}:25:0:1`;
      // fnNoCall @0-based[34,38] ⇒ window [35,39]; NS@36 (no calleeIds); ND@38.
      const NS = `BasicBlock:${F}:35:0:0`;
      const ND = `BasicBlock:${F}:35:0:1`;

      await fn('func:fnA', 'fnA', 4, 8);
      await fn('func:fnB', 'fnB', 14, 18);
      await fn('func:fnC', 'fnC', 24, 28);
      await fn('func:fnNoCall', 'fnNoCall', 34, 38);

      await block(SA, 6, 'const a = fnB(x);', 'func:fnB');
      await block(SB, 16, 'const r = fnC(y);', 'func:fnC');
      await block(BD, 18, 'return r;', '');
      await block(SC, 26, 'const c = work(z);', '');
      await block(CD, 27, 'return c;', '');
      await block(NS, 36, 'const n = local(p);', ''); // no calleeIds → intra-only
      await block(ND, 38, 'return n;', '');

      // Intra-fnB dependence: SB → BD (line 18 depends on line 16).
      await edge('REACHING_DEF', SB, BD, 'r');
      // Intra-fnC dependence: SC → CD (line 27 depends on line 26).
      await edge('REACHING_DEF', SC, CD, 'c');
      // Intra-fnNoCall dependence: NS → ND (line 38 depends on line 36).
      await edge('REACHING_DEF', NS, ND, 'n');

      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'interproc-repo',
          path: '/interproc/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'interproc123',
          stats: { files: 1, nodes: 11, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as typeof handle & { _backend?: LocalBackend })._backend = backend;
    },
  },
);
