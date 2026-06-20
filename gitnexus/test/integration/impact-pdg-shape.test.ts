/**
 * Integration Tests: `impact` PDG-mode RESULT SHAPE + consumer-safety (U4 / KTD8)
 *
 * This suite guards the **standing interchangeability contract** (KTD8): a
 * `mode:'pdg'` result must be structurally substitutable for the call-graph
 * result for EVERY consumer (CLI `formatImpactResult`, group
 * `collectImpactSymbolUids`/`mergeRisk`, `impactByUid`). These are not one-time
 * checks — they protect a permanent contract. If a future change drops `target.id`,
 * un-collapses `byDepth`, or mints a non-`UNKNOWN` risk, a consumer misrenders and
 * one of these tests must go red.
 *
 * It also exercises the **net-new block→owning-symbol resolver** (the reverse of
 * `resolveBlockAnchor`, no precedent) including the two non-happy paths the
 * Feasibility review surfaced:
 *   - same-line, different-name functions → ambiguous-projection (report ALL,
 *     never silently pick one — there is no `startColumn` to disambiguate), and
 *   - a reachable block that owns no symbol (top-level / free statement) →
 *     reported under its file as `unresolved`, NEVER silently dropped (R9).
 *
 * ── Fixture graph (hand-seeded, no parser; controlled line numbers) ──────────
 * One file `src/flow.ts`.
 *   - `target`  fn at 0-based [10,10] ⇒ anchor window [11,11], seed block S@11.
 *   - `up`      fn at [4,4]   ⇒ block P@6   (RD def + CDG controller into S).
 *   - `down`    fn at [19,21] ⇒ blocks D1@21, D2@22 (RD uses, downstream of S).
 *   - `ctl`     fn at [29,31] ⇒ blocks K1@31, K2@32 (CDG dependents of S).
 *   - `dupA` AND `dupB`, BOTH at 0-based [40,42] (SAME (filePath,startLine)) —
 *     a CDG-reachable block T@41 maps to BOTH (ambiguous-projection).
 *   - `FlowThing.constructor` at 0-based [55,55] owns CT@56 (constructor projection).
 *   - a free/top-level block U@99 owned by NO symbol (downstream of K2) — the
 *     `unresolved` shadow path.
 *
 *   Downstream from S:  RD → {D1,D2,CT}; CDG → {K1,K2} → T(@41) → U(@99 top-level).
 *
 * `loadMeta` is mocked to stamp BOTH caps so `pdgLayerStatus` returns `ready`.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { RepoMeta } from '../../src/storage/repo-manager.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { collectImpactSymbolUids, mergeRisk } from '../../src/core/group/cross-impact.js';
import type { CrossRepoImpact } from '../../src/core/group/types.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
    // Both caps stamped ⇒ pdgLayerStatus === 'ready' ⇒ traversal + projection run.
    loadMeta: vi.fn().mockResolvedValue({
      pdg: { maxCdgEdgesPerFunction: 0, maxReachingDefEdgesPerFunction: 0 },
    } as unknown as RepoMeta),
  };
});

const F = 'src/flow.ts';
// Block ids: BasicBlock:<filePath>:<fnLine>:<fnCol>:<blockIdx>  (fnLine 1-based)
const S = `BasicBlock:${F}:11:0:0`; // target@[10,10]
const P = `BasicBlock:${F}:5:0:0`; // up@[4,4]
const D1 = `BasicBlock:${F}:20:0:0`; // down@[19,21]
const D2 = `BasicBlock:${F}:20:0:1`; // down@[19,21]
const K1 = `BasicBlock:${F}:30:0:0`; // ctl@[29,31]
const K2 = `BasicBlock:${F}:30:0:1`; // ctl@[29,31]
const T = `BasicBlock:${F}:41:0:0`; // dupA AND dupB BOTH @[40,42] → ambiguous
const CT = `BasicBlock:${F}:56:0:0`; // Constructor FlowThing.constructor@[55,55]
const U = `BasicBlock:${F}:99:0:0`; // top-level / no owning symbol → unresolved

withTestLbugDB(
  'impact-pdg-shape',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      const ext = handle as typeof handle & { _backend?: LocalBackend };
      if (!ext._backend) throw new Error('LocalBackend not initialized in afterSetup');
      backend = ext._backend;
    });

    // Deep enough to traverse the full CDG chain S→K1→K2→T(@dup)→U(top-level),
    // so the ambiguous-projection and unresolved shadow-path blocks are reached.
    const downstream = () =>
      backend.callTool('impact', {
        target: 'target',
        direction: 'downstream',
        mode: 'pdg',
        maxDepth: 10,
      });

    // ── The net-new block → owning-symbol resolver ────────────────────────────
    describe('block → owning-symbol projection (KTD8 net-new resolver)', () => {
      it('maps a known reachable block to its owning function (0-based offset correct)', async () => {
        const result = await downstream();
        expect(result.error).toBeUndefined();
        expect(result.mode).toBe('pdg');
        // D1/D2 (fnLine 20 ⇒ symbol startLine 19) own `down`; K1/K2 (fnLine 30 ⇒
        // startLine 29) own `ctl`. The resolver must surface BOTH owning fns.
        const items = Object.values(result.byDepth as Record<number, any[]>).flat();
        const names = new Set(items.map((i: any) => i.name));
        expect(names.has('down')).toBe(true);
        expect(names.has('ctl')).toBe(true);
        // And the resolved owning symbols carry real UIDs (not null).
        const down = items.find((i: any) => i.name === 'down');
        expect(down.id).toBe('func:down');
        expect(down.filePath).toBe(F);
      });

      it('maps a reachable constructor block to its owning Constructor symbol', async () => {
        const result = await downstream();
        const items = Object.values(result.byDepth as Record<number, any[]>).flat();
        const ctor = items.find((i: any) => i.id === 'ctor:FlowThing');
        expect(ctor).toBeDefined();
        expect(ctor.name).toBe('FlowThing.constructor');
        expect(ctor.type).toBe('Constructor');
        expect(ctor.filePath).toBe(F);
      });

      it('a reachable block owning NO symbol is reported as unresolved, never dropped (R9 shadow path)', async () => {
        const result = await downstream();
        const items = Object.values(result.byDepth as Record<number, any[]>).flat();
        // U@99 has no owning Function/Method/Constructor → an explicit unresolved entry.
        const unresolved = items.filter((i: any) => i.id === null || i.type === 'unresolved');
        expect(unresolved.length).toBeGreaterThanOrEqual(1);
        expect(unresolved[0].filePath).toBe(F);
        // It is surfaced (recall preserved), and the top-level count is exposed.
        expect(result.unresolvedBlockCount).toBeGreaterThanOrEqual(1);
        // But an unresolved block contributes NO symbol UID (no false attribution).
        expect(unresolved.every((i: any) => i.id === null)).toBe(true);
      });

      it('two functions sharing (filePath, startLine) project to BOTH, never a silent pick (Feasibility Finding 1)', async () => {
        const result = await downstream();
        const items = Object.values(result.byDepth as Record<number, any[]>).flat();
        // T@41 ⇒ startLine 40 matches BOTH func:dupA and func:dupB (they share the
        // NAME 'dupTarget' and the same start line). The resolver must report
        // BOTH (ambiguous-projection), each flagged, never one of them. Identity
        // is the UID, not the shared name.
        const dupItems = items.filter((i: any) => i.id === 'func:dupA' || i.id === 'func:dupB');
        const dupIds = new Set(dupItems.map((i: any) => i.id));
        expect(dupIds.has('func:dupA')).toBe(true);
        expect(dupIds.has('func:dupB')).toBe(true);
        expect(dupItems.every((i: any) => i.ambiguous === true)).toBe(true);
        // Both share the same projected name (the schema can't disambiguate).
        expect(dupItems.every((i: any) => i.name === 'dupTarget')).toBe(true);
        expect(result.ambiguousProjectionCount).toBeGreaterThanOrEqual(1);
        // The PDG note must call out the ambiguity, not hide it.
        expect(result.note).toMatch(/ambiguous|same-line/i);
      });
    });

    // ── KTD8 result-shape parity matrix (vs the call-graph result) ────────────
    describe('result-shape parity (KTD8 standing interchangeability contract)', () => {
      it('populates target.id / target.filePath with call-graph-compatible shape', async () => {
        const result = await downstream();
        expect(result.target).toBeDefined();
        expect(result.target.id).toBe('func:target');
        expect(result.target.name).toBe('target');
        expect(result.target.filePath).toBe(F);
        // `type` present like the callgraph target (consumers may read it).
        expect(typeof result.target.type).toBe('string');
      });

      it('populates byDepth (single collapsed bucket) and byDepthCounts in callgraph shape', async () => {
        const result = await downstream();
        // byDepth is a { [depth]: item[] } map, collapsed to exactly ONE bucket
        // — block-hops are not call-hops, so there is no multi-depth fan.
        const depths = Object.keys(result.byDepth);
        expect(depths).toEqual(['1']);
        expect(Array.isArray(result.byDepth['1'])).toBe(true);
        // Each item carries the call-graph item fields consumers iterate on.
        for (const it of result.byDepth['1']) {
          expect(it).toHaveProperty('id');
          expect(it).toHaveProperty('name');
          expect(it).toHaveProperty('filePath');
          expect(it).toHaveProperty('processes'); // shape-stable like callgraph
        }
        // byDepthCounts mirrors the bucket.
        expect(result.byDepthCounts['1']).toBe(result.byDepth['1'].length);
      });

      it('affected_processes / affected_modules are empty arrays (consumers coalesce []) ', async () => {
        const result = await downstream();
        expect(result.affected_processes).toEqual([]);
        expect(result.affected_modules).toEqual([]);
        expect(result.summary.processes_affected).toBe(0);
        expect(result.summary.modules_affected).toBe(0);
      });

      it('epistemic/note is PDG-specific, NOT the callgraph DI/dynamic-dispatch copy', async () => {
        const result = await downstream();
        // PDG marker, not the callgraph 'lower-bound'/'exact'.
        expect(result.epistemic).toBe('pdg-intra-procedural');
        // Note frames the intra-procedural caveat, never the DI/interface text.
        expect(result.note).toMatch(/intra-procedural|dependence/i);
        expect(result.note).not.toMatch(/DI container|dynamic dispatch/i);
      });

      it("risk is the existing 'UNKNOWN' sentinel, not a minted PDG label", async () => {
        const result = await downstream();
        expect(result.risk).toBe('UNKNOWN');
        // impactedCount = distinct owning SYMBOLS (down, ctl, dupA, dupB, ctor) —
        // the meaningful unit; unresolved blocks do not inflate it.
        expect(result.impactedCount).toBe(5);
        // blockCount is the raw reachable-block count, retained separately.
        expect(result.blockCount).toBeGreaterThanOrEqual(result.impactedCount);
      });
    });

    // ── Statement-mode result shape (criterionLine + slice + KTD8 parity) ─────
    describe('statement-mode result carries the slice fields AND the KTD8 parity fields', () => {
      it('a line-seeded result has criterionLine/affectedStatements/affectedStatementCount', async () => {
        const result = await backend.callTool('impact', {
          target: 'accum',
          direction: 'downstream',
          mode: 'pdg',
          line: 72,
        });
        expect(result.error).toBeUndefined();
        expect(result.mode).toBe('pdg');
        // Statement-mode-specific fields.
        expect(result.criterionLine).toBe(72);
        expect(Array.isArray(result.affectedStatements)).toBe(true);
        expect(result.affectedStatementCount).toBe(result.affectedStatements.length);
        expect(result.affectedStatementCount).toBe(2);
        for (const s of result.affectedStatements) {
          expect(s).toHaveProperty('line');
          expect(s).toHaveProperty('filePath');
          expect(s).toHaveProperty('text');
        }
        // The slice statements are the downstream-dependent ones (lines 10, 12).
        const lines = (result.affectedStatements as any[]).map((s) => s.line).sort((a, b) => a - b);
        expect(lines).toEqual([74, 76]);
      });

      it('the statement-mode result ALSO carries the KTD8 parity fields (byDepth/target/risk/empty processes-modules)', async () => {
        const result = await backend.callTool('impact', {
          target: 'accum',
          direction: 'downstream',
          mode: 'pdg',
          line: 72,
        });
        // byDepth is the single collapsed bucket (block-hops ≠ call-hops).
        expect(Object.keys(result.byDepth)).toEqual(['1']);
        expect(result.byDepthCounts['1']).toBe(result.byDepth['1'].length);
        // target carries the call-graph-compatible shape.
        expect(result.target.id).toBe('func:accum');
        expect(result.target.name).toBe('accum');
        expect(result.target.filePath).toBe(F);
        expect(typeof result.target.type).toBe('string');
        // risk is the UNKNOWN sentinel (never a confident LOW).
        expect(result.risk).toBe('UNKNOWN');
        expect(result.risk).not.toBe('LOW');
        // Empty processes/modules — consumers coalesce [].
        expect(result.affected_processes).toEqual([]);
        expect(result.affected_modules).toEqual([]);
        expect(result.summary.processes_affected).toBe(0);
        expect(result.summary.modules_affected).toBe(0);
      });
    });

    // ── Consumer safety: group cross-impact treats the PDG result correctly ───
    describe('group consumer safety (cross-impact.ts)', () => {
      it('collectImpactSymbolUids collects the PDG owning-symbol UIDs (non-zero)', async () => {
        const result = await downstream();
        const { uids, targetFilePath } = collectImpactSymbolUids(result, undefined);
        // The target plus every resolved owning symbol's UID is collected; the
        // null unresolved entry contributes nothing (no crash, no '' UID).
        expect(uids.length).toBeGreaterThan(0);
        expect(uids).toContain('func:target'); // from target.id
        expect(uids).toContain('func:down');
        expect(uids).toContain('func:ctl');
        expect(uids).toContain('ctor:FlowThing');
        expect(uids).not.toContain('null');
        expect(uids).not.toContain('');
        expect(targetFilePath).toBe(F);
      });

      it("mergeRisk does NOT render a confident LOW from a PDG 'UNKNOWN' risk (R7 false-LOW trap)", async () => {
        const result = await downstream();
        const localRisk = String(result.risk);
        expect(localRisk).toBe('UNKNOWN');
        // No cross-repo hits → mergeRisk returns localRisk verbatim: 'UNKNOWN',
        // NEVER coerced to a confident 'LOW' (the false-safe this guards).
        expect(mergeRisk(localRisk, [])).toBe('UNKNOWN');
        // With a cross-repo hit, 'UNKNOWN' bumps UP to 'MEDIUM' (never down to LOW).
        const cross = [{ contract: { confidence: 0.5 } }] as unknown as CrossRepoImpact[];
        expect(mergeRisk(localRisk, cross)).toBe('MEDIUM');
      });
    });

    // ── KTD5 ambiguous trap: pdg+ambiguous never runs interprocedural fan-out ──
    describe('KTD5 ambiguous target never invokes the interprocedural BFS', () => {
      it("mode:'pdg' on an ambiguous target returns candidates, never calls _runImpactBFS", async () => {
        // Spy on the private interprocedural BFS; ambiguous PDG has no single
        // resolved symbol, so it must not run the composed symbol-reach pass.
        // `dupTarget` collides across dupA/dupB by NAME.
        const bfsSpy = vi.spyOn(backend as any, '_runImpactBFS');
        try {
          const result = await backend.callTool('impact', {
            target: 'dupTarget',
            direction: 'downstream',
            mode: 'pdg',
          });
          expect(result.status).toBe('ambiguous');
          expect(result.mode).toBe('pdg');
          // No interprocedural symbol-reach pass ran without a resolved target.
          expect(bfsSpy).not.toHaveBeenCalled();
          // And it surfaces the candidate list (no silent zero blast radius).
          expect(Array.isArray(result.candidates)).toBe(true);
          expect(result.candidates.length).toBeGreaterThanOrEqual(2);
          // The response never names pdg_query (toolName union widened to impact).
          expect(JSON.stringify(result)).not.toMatch(/pdg_query/);
        } finally {
          bfsSpy.mockRestore();
        }
      });
    });

    // ── FIX 1 keystone: the PDG seed anchors on the ALREADY-RESOLVED symbol ───
    // The seed must NOT be re-resolved by bare `sym.name` inside `_runImpactPDG`
    // (that would re-ambiguate a file_path/uid-disambiguated name, or anchor on a
    // DIFFERENT same-name symbol → wrong-symbol blast radius). With two functions
    // named `sameName` in different files, disambiguating by file_path/target_uid
    // must produce the CORRECT local PDG blast radius before the composed
    // interprocedural `_runImpactBFS` pass runs for the resolved symbol.
    describe('seed anchors on the resolved (disambiguated) symbol, not a name re-resolution', () => {
      it('file_path disambiguation reaches the right file’s downstream owner (not the other same-name fn)', async () => {
        const bfsSpy = vi.spyOn(backend as any, '_runImpactBFS');
        try {
          const result = await backend.callTool('impact', {
            target: 'sameName',
            file_path: 'src/b.ts',
            direction: 'downstream',
            mode: 'pdg',
          });
          // Resolved cleanly (NOT the ambiguous early payload) and it is a PDG result.
          expect(result.status).not.toBe('ambiguous');
          expect(result.mode).toBe('pdg');
          expect(result.error).toBeUndefined();
          // The target is the B-file `sameName`, and the blast radius reflects B's
          // downstream owner `onlyB` — NEVER A's `onlyA` (the wrong-file anchor).
          expect(result.target.id).toBe('func:sameB');
          expect(result.target.filePath).toBe('src/b.ts');
          const names = new Set(
            Object.values(result.byDepth as Record<number, any[]>)
              .flat()
              .map((i: any) => i.name),
          );
          expect(names.has('onlyB')).toBe(true);
          expect(names.has('onlyA')).toBe(false);
          // Unified PDG now composes interprocedural symbol reach after the local
          // PDG slice anchors on the resolved symbol.
          expect(bfsSpy).toHaveBeenCalledTimes(1);
        } finally {
          bfsSpy.mockRestore();
        }
      });

      it('target_uid disambiguation anchors the seed on THAT uid (not a re-ambiguation)', async () => {
        const bfsSpy = vi.spyOn(backend as any, '_runImpactBFS');
        try {
          const result = await backend.callTool('impact', {
            target: 'sameName',
            target_uid: 'func:sameA',
            direction: 'downstream',
            mode: 'pdg',
          });
          expect(result.status).not.toBe('ambiguous');
          expect(result.mode).toBe('pdg');
          expect(result.target.id).toBe('func:sameA');
          expect(result.target.filePath).toBe('src/a.ts');
          const names = new Set(
            Object.values(result.byDepth as Record<number, any[]>)
              .flat()
              .map((i: any) => i.name),
          );
          expect(names.has('onlyA')).toBe(true);
          expect(names.has('onlyB')).toBe(false);
          expect(bfsSpy).toHaveBeenCalledTimes(1);
        } finally {
          bfsSpy.mockRestore();
        }
      });
    });

    // ── fnFileOf Windows-path coverage (split-from-right) ─────────────────────
    // The block→owning-symbol projector (`projectBlocksToSymbols`) recovers each
    // block's file path via `fnFileOf`, which must split a `BasicBlock` id FROM
    // THE RIGHT so a Windows drive-letter ':' inside the path is not mistaken for
    // a segment delimiter. Exercised behaviorally (fnFileOf is module-scope, not
    // exported) — mirrors how pdg-query.test.ts pins `fnLineOf` with a `C:/...` id.
    describe('fnFileOf recovers a Windows-style (drive-colon) path', () => {
      it('projects a downstream block whose id carries a C:/ drive path to its owning symbol', async () => {
        const result = await backend.callTool('impact', {
          target: 'winFn',
          direction: 'downstream',
          mode: 'pdg',
        });
        expect(result.error).toBeUndefined();
        expect(result.mode).toBe('pdg');
        const items = Object.values(result.byDepth as Record<number, any[]>).flat();
        // The downstream Windows block `BasicBlock:C:/src/win.ts:21:0:0` owns
        // `winUse` (0-based startLine 20). If `fnFileOf` split from the LEFT it
        // would yield `C` (the drive letter) as the path and fail to resolve the
        // owning symbol — surfacing it as unresolved instead. Correct split-from-
        // right recovers `C:/src/win.ts` and resolves `winUse`.
        const winUse = items.find((i: any) => i.name === 'winUse');
        expect(winUse).toBeDefined();
        expect(winUse.id).toBe('func:winUse');
        expect(winUse.filePath).toBe('C:/src/win.ts');
      });
    });

    // ── No-body symbol parity (KTD6 × KTD8) ───────────────────────────────────
    describe('no-body symbol still yields a parity-shaped (non-LOW) result', () => {
      it('an interface (no CFG body) returns the no-body note + well-formed empty shape', async () => {
        const result = await backend.callTool('impact', {
          target: 'IShape',
          direction: 'downstream',
          mode: 'pdg',
        });
        expect(result.error).toBeUndefined();
        expect(result.risk).not.toBe('LOW'); // never a confident "safe to refactor"
        expect(result.note).toMatch(/no.*(body|block|dependence)/i);
        // Parity fields are present & well-formed (empty), not undefined.
        expect(result.byDepth).toEqual({});
        expect(result.byDepthCounts['1']).toBe(0);
        expect(result.affected_processes).toEqual([]);
        expect(result.affected_modules).toEqual([]);
      });
    });
  },
  {
    poolAdapter: true,
    afterSetup: async (handle) => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const fn = (
        id: string,
        name: string,
        startLine: number,
        endLine: number,
        type: 'Function' | 'Interface' | 'Constructor' = 'Function',
      ) => {
        if (type === 'Constructor') {
          return adapter.executePrepared(
            `CREATE (n:Constructor {id: $id, name: $name, filePath: $filePath, startLine: $startLine, endLine: $endLine, content: 'x', description: 'shape fixture'})`,
            { id, name, filePath: F, startLine, endLine },
          );
        }
        return adapter.executePrepared(
          `CREATE (n:${type} {id: $id, name: $name, filePath: $filePath, startLine: $startLine, endLine: $endLine, isExported: true, content: 'x', description: 'shape fixture'})`,
          { id, name, filePath: F, startLine, endLine },
        );
      };
      const block = (id: string, startLine: number, text: string) =>
        adapter.executePrepared(
          `CREATE (b:BasicBlock {id: $id, filePath: $filePath, startLine: $startLine, endLine: $startLine, text: $text})`,
          { id, filePath: F, startLine, text },
        );
      const edge = (type: 'CDG' | 'REACHING_DEF', src: string, dst: string, reason: string) =>
        adapter.executePrepared(
          `MATCH (a:BasicBlock {id: $src}), (b:BasicBlock {id: $dst})
           CREATE (a)-[:CodeRelation {type: '${type}', confidence: 1.0, reason: $reason, step: 0}]->(b)`,
          { src, dst, reason },
        );

      // Functions (0-based symbol lines).
      await fn('func:target', 'target', 10, 10); // window [11,11] ⇒ seed {S}
      await fn('func:up', 'up', 4, 4); // P@6
      await fn('func:down', 'down', 19, 21); // D1@21,D2@22
      await fn('func:ctl', 'ctl', 29, 31); // K1@31,K2@32
      // Same-line collision: dupA and dupB BOTH start at 0-based line 40.
      await fn('func:dupA', 'dupTarget', 40, 42);
      await fn('func:dupB', 'dupTarget', 40, 42);
      // No-body interface (no blocks).
      await fn('func:IShape', 'IShape', 50, 52, 'Interface');
      // Constructor owner projection.
      await fn('ctor:FlowThing', 'FlowThing.constructor', 55, 55, 'Constructor');

      // Blocks.
      await block(S, 11, 'const x = compute();');
      await block(P, 6, 'const seed = input();');
      await block(D1, 21, 'use(x);');
      await block(D2, 22, 'log(x);');
      await block(K1, 31, 'doA();');
      await block(K2, 32, 'doB();');
      await block(T, 41, 'dispatch();'); // owned by BOTH dupA & dupB
      await block(CT, 56, 'this.value = x;'); // owned by Constructor
      await block(U, 99, 'top-level-side-effect();'); // owned by NO symbol

      // RD chain (def→use): P → S → D1 → D2
      await edge('REACHING_DEF', P, S, 'seed');
      await edge('REACHING_DEF', S, D1, 'x');
      await edge('REACHING_DEF', D1, D2, 'x');
      await edge('REACHING_DEF', S, CT, 'ctor');
      // CDG chain: P(controller) → S → K1 → K2 → T(@dup line) → U(top-level)
      await edge('CDG', P, S, 'T');
      await edge('CDG', S, K1, 'T');
      await edge('CDG', K1, K2, 'T');
      await edge('CDG', K2, T, 'T');
      await edge('CDG', T, U, 'T');

      // ── Statement-anchored fixture `accum` (mode:'pdg' + line) ────────────────
      // Self-contained multi-statement fn at 0-based [70,80] (window [71,81]); a
      // line range that does NOT overlap S@11 / D@21,22 / K@31,32 above, so its
      // whole-symbol seed cannot pick up an unrelated block. Every dependence
      // stays inside it, so a STATEMENT seed slices the dependent statements.
      //   71:  let sum = 0;         (A)  72: for (…) {     (B, criterion)
      //   74:  sum = sum + x;       (C)  76: return sum;   (D)
      // CDG B→C; RD A→C, C→D ⇒ downstream from line 72 = {C@74, D@76}.
      await fn('func:accum', 'accum', 70, 80);
      const AccA = `BasicBlock:${F}:71:0:0`; // line 71
      const AccB = `BasicBlock:${F}:71:0:1`; // line 72
      const AccC = `BasicBlock:${F}:71:0:2`; // line 74
      const AccD = `BasicBlock:${F}:71:0:3`; // line 76
      await block(AccA, 71, 'let sum = 0;');
      await block(AccB, 72, 'for (const x of xs) {');
      await block(AccC, 74, 'sum = sum + x;');
      await block(AccD, 76, 'return sum;');
      await edge('CDG', AccB, AccC, 'loop');
      await edge('REACHING_DEF', AccA, AccC, 'sum');
      await edge('REACHING_DEF', AccC, AccD, 'sum');

      // ── Windows drive-colon path fixture (exercises fnFileOf split-from-right) ─
      // Separate file `C:/src/win.ts`, isolated from `target`'s graph so the
      // existing impactedCount/byDepth assertions are untouched. `winFn` is its
      // own seed target; a downstream RD block (`:21:`) owns `winUse`.
      const WF = 'C:/src/win.ts';
      const winFnSeed = `BasicBlock:${WF}:11:0:0`; // winFn@0-based[10,12] ⇒ window [11,13]
      const winUseBlk = `BasicBlock:${WF}:21:0:0`; // winUse@0-based[20,20] ⇒ fnLine 21
      const winNode = (
        id: string,
        name: string,
        startLine: number,
        endLine: number,
        type: 'Function' = 'Function',
      ) =>
        adapter.executePrepared(
          `CREATE (n:${type} {id: $id, name: $name, filePath: $filePath, startLine: $startLine, endLine: $endLine, isExported: true, content: 'x', description: 'win fixture'})`,
          { id, name, filePath: WF, startLine, endLine },
        );
      const winBlock = (id: string, startLine: number, text: string) =>
        adapter.executePrepared(
          `CREATE (b:BasicBlock {id: $id, filePath: $filePath, startLine: $startLine, endLine: $startLine, text: $text})`,
          { id, filePath: WF, startLine, text },
        );
      await winNode('func:winFn', 'winFn', 10, 12);
      await winNode('func:winUse', 'winUse', 20, 20);
      await winBlock(winFnSeed, 11, 'const w = win();');
      await winBlock(winUseBlk, 21, 'useWin(w);');
      await edge('REACHING_DEF', winFnSeed, winUseBlk, 'w');

      // ── Same-name-in-different-files fixture (FIX 1 keystone: seed must anchor
      // on the file_path/uid-disambiguated symbol, NOT re-resolve by bare name) ──
      // Two functions BOTH named `sameName`, in `src/a.ts` and `src/b.ts`, each
      // with a DISTINCT downstream owner (`onlyA` vs `onlyB`). A correct seed
      // (anchored on the already-resolved symbol's file+span) reaches only the
      // chosen file's downstream block; a re-resolution by bare `sameName` would
      // either re-ambiguate or anchor on the wrong file.
      const AFILE = 'src/a.ts';
      const BFILE = 'src/b.ts';
      const sameSeedA = `BasicBlock:${AFILE}:11:0:0`; // sameName@A 0-based[10,10] ⇒ window [11,11]
      const onlyABlk = `BasicBlock:${AFILE}:21:0:0`; // onlyA@0-based[20,20] ⇒ fnLine 21
      const sameSeedB = `BasicBlock:${BFILE}:11:0:0`; // sameName@B 0-based[10,10] ⇒ window [11,11]
      const onlyBBlk = `BasicBlock:${BFILE}:21:0:0`; // onlyB@0-based[20,20] ⇒ fnLine 21
      const node2 = (
        id: string,
        name: string,
        filePath: string,
        startLine: number,
        endLine: number,
      ) =>
        adapter.executePrepared(
          `CREATE (n:Function {id: $id, name: $name, filePath: $filePath, startLine: $startLine, endLine: $endLine, isExported: true, content: 'x', description: 'samename fixture'})`,
          { id, name, filePath, startLine, endLine },
        );
      const block2 = (id: string, filePath: string, startLine: number, text: string) =>
        adapter.executePrepared(
          `CREATE (b:BasicBlock {id: $id, filePath: $filePath, startLine: $startLine, endLine: $startLine, text: $text})`,
          { id, filePath, startLine, text },
        );
      await node2('func:sameA', 'sameName', AFILE, 10, 10);
      await node2('func:onlyA', 'onlyA', AFILE, 20, 20);
      await node2('func:sameB', 'sameName', BFILE, 10, 10);
      await node2('func:onlyB', 'onlyB', BFILE, 20, 20);
      await block2(sameSeedA, AFILE, 11, 'const a = mk();');
      await block2(onlyABlk, AFILE, 21, 'useA(a);');
      await block2(sameSeedB, BFILE, 11, 'const b = mk();');
      await block2(onlyBBlk, BFILE, 21, 'useB(b);');
      await edge('REACHING_DEF', sameSeedA, onlyABlk, 'a');
      await edge('REACHING_DEF', sameSeedB, onlyBBlk, 'b');

      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'shape-repo',
          path: '/shape/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'shape123',
          stats: { files: 1, nodes: 18, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
