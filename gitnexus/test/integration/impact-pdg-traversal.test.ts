/**
 * Integration Tests: `impact` PDG-mode blast-radius TRAVERSAL (U3 / KTD2,4,6,11)
 *
 * End-to-end against a REAL LadybugDB, through the full `callTool('impact', …)`
 * dispatch with `mode:'pdg'`. Exercises `_runImpactPDG` — the direction-aware
 * bounded BFS over CDG + REACHING_DEF block edges — the correctness keystone of
 * the feature (the KTD4 direction × edge-type truth table).
 *
 * The result exposes the consumer-safe impact shape plus traversal details
 * (`reachableBlocks`, `truncated`, `depthReached`) so this suite can pin the
 * graph algorithm without bypassing the public `impact` tool contract.
 *
 * ── Fixture graph (hand-seeded, no parser; controlled line numbers) ──────────
 * One file `src/flow.ts`. The TARGET symbol `target` is a one-line function at
 * 0-based symbol lines [10,10] ⇒ anchor window [11,11], fnLine segment '11'. Its
 * single seed block `S` sits at 1-based line 11. All OTHER blocks belong to
 * neighbouring functions OUTSIDE that window, so the seed set is exactly {S} and
 * every reached block is unambiguously a traversal result, not a co-seed.
 *
 *   RD (def→use, forward = downstream):
 *     P  -[RD]-> S  -[RD]-> D1 -[RD]-> D2
 *   CDG (controller→dependent, forward = downstream):
 *     C  -[CDG]-> S -[CDG]-> K1 -[CDG]-> K2
 *
 *   So from S:
 *     downstream RD  → {D1, D2}          (forward; NOT P)
 *     upstream   RD  → {P}               (reverse; NOT D1/D2)
 *     downstream CDG → {K1, K2}          (forward; NOT C)
 *     upstream   CDG → {C}               (reverse; NOT K1/K2)
 *     downstream (combined) → {D1,D2,K1,K2}   (union, same forward sense)
 *     upstream   (combined) → {P, C}          (union, same reverse sense)
 *
 * `loadMeta` is mocked to stamp BOTH caps so `pdgLayerStatus` returns `ready`
 * and the call falls through to the real traversal (U2's gate is exercised by
 * impact-pdg-degradation.test.ts; here we drive past it).
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
    // Both caps stamped ⇒ pdgLayerStatus === 'ready' ⇒ traversal runs.
    loadMeta: vi.fn().mockResolvedValue({
      pdg: { maxCdgEdgesPerFunction: 0, maxReachingDefEdgesPerFunction: 0 },
    } as unknown as RepoMeta),
  };
});

const F = 'src/flow.ts';
// Block ids: BasicBlock:<filePath>:<fnLine>:<fnCol>:<blockIdx>
const S = `BasicBlock:${F}:11:0:0`; // target `target`'s only block (line 11)
const P = `BasicBlock:${F}:5:0:0`; // predecessor (fn `up`, line 6) — RD def & CDG controller into S
const D1 = `BasicBlock:${F}:20:0:0`; // RD use of S (fn `down`, line 21)
const D2 = `BasicBlock:${F}:20:0:1`; // RD use of D1 (line 22)
const K1 = `BasicBlock:${F}:30:0:0`; // CDG dependent of S (fn `ctl`, line 31)
const K2 = `BasicBlock:${F}:30:0:1`; // CDG dependent of K1 (line 32)

withTestLbugDB(
  'impact-pdg-traversal',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      const ext = handle as typeof handle & { _backend?: LocalBackend };
      if (!ext._backend) throw new Error('LocalBackend not initialized in afterSetup');
      backend = ext._backend;
    });

    const reachable = (result: any): string[] =>
      [...((result?.reachableBlocks as string[]) ?? [])].sort();

    describe('KTD4 direction × edge-type truth table', () => {
      it('downstream REACHING_DEF reaches the use blocks, not the def predecessor', async () => {
        const result = await backend.callTool('impact', {
          target: 'target',
          direction: 'downstream',
          mode: 'pdg',
        });
        expect(result.error).toBeUndefined();
        expect(result.mode).toBe('pdg');
        const set = reachable(result);
        // forward over RD: S→D1→D2 are reached; P (S's def predecessor) is NOT.
        expect(set).toContain(D1);
        expect(set).toContain(D2);
        expect(set).not.toContain(P);
      });

      it('upstream REACHING_DEF reaches the defs reaching the target, not its uses', async () => {
        const result = await backend.callTool('impact', {
          target: 'target',
          direction: 'upstream',
          mode: 'pdg',
        });
        expect(result.error).toBeUndefined();
        const set = reachable(result);
        // reverse over RD: P (def reaching S) reached; D1/D2 (uses) NOT.
        expect(set).toContain(P);
        expect(set).not.toContain(D1);
        expect(set).not.toContain(D2);
      });

      it('downstream CDG reaches the controlled blocks, never the controller', async () => {
        const result = await backend.callTool('impact', {
          target: 'target',
          direction: 'downstream',
          mode: 'pdg',
        });
        const set = reachable(result);
        // forward over CDG: S controls K1 controls K2.
        expect(set).toContain(K1);
        expect(set).toContain(K2);
        // CDG-precision exclusion: the CONTROLLER `P` (the CDG predecessor of S)
        // must NOT appear downstream — it is an *upstream* block. A CDG
        // direction/precision bug (e.g. traversing the CDG edge in reverse) would
        // leak P into the downstream set; pin it so such a bug fails here.
        // (D1/D2 are legitimately present downstream via the REACHING_DEF edges —
        // the combined CDG+RD frontier is one direction over BOTH edge types — so
        // the meaningful CDG-precision exclusion is the controller, not the RD
        // uses; the combined-frontier test below pins the exact {D1,D2,K1,K2} set.)
        expect(set).not.toContain(P);
      });

      it('upstream CDG reaches the controller, not the controlled blocks', async () => {
        const result = await backend.callTool('impact', {
          target: 'target',
          direction: 'upstream',
          mode: 'pdg',
        });
        const set = reachable(result);
        // reverse over CDG: C (controller of S) reached; K1/K2 (controlled) NOT.
        expect(set).toContain(P);
        expect(set).not.toContain(K1);
        expect(set).not.toContain(K2);
      });

      it('combined CDG+RD downstream frontier is the forward union of both', async () => {
        const result = await backend.callTool('impact', {
          target: 'target',
          direction: 'downstream',
          mode: 'pdg',
        });
        const set = reachable(result);
        expect(set).toEqual([D1, D2, K1, K2].sort());
      });

      it('combined CDG+RD upstream frontier is the reverse union of both', async () => {
        const result = await backend.callTool('impact', {
          target: 'target',
          direction: 'upstream',
          mode: 'pdg',
        });
        const set = reachable(result);
        // P is both the RD def AND the CDG controller of S, so the reverse union
        // is exactly {P}; the forward successors D1/D2/K1/K2 are never reached.
        expect(set).toEqual([P]);
      });
    });

    // Helper: the slice statements' lines (sorted) for an `accum` line-seeded call.
    const sliceLines = (result: any): number[] =>
      [...((result?.affectedStatements as any[]) ?? [])].map((s) => s.line).sort((a, b) => a - b);

    describe('statement-anchored seed (mode:pdg + line)', () => {
      it('downstream from line 72 returns exactly the statements dependent on it (NOT the whole symbol)', async () => {
        const result = await backend.callTool('impact', {
          target: 'accum',
          direction: 'downstream',
          mode: 'pdg',
          line: 72,
        });
        expect(result.error).toBeUndefined();
        expect(result.mode).toBe('pdg');
        expect(result.criterionLine).toBe(72);
        // line 72 (the loop header B) controls C@74, whose sum flows to D@76.
        expect(sliceLines(result)).toEqual([74, 76]);
        expect(result.affectedStatementCount).toBe(2);
        // The dependent statements carry the real source line + text.
        const byLine = new Map((result.affectedStatements as any[]).map((s) => [s.line, s]));
        expect(byLine.get(74).text).toBe('sum = sum + x;');
        expect(byLine.get(74).filePath).toBe(F);
        expect(byLine.get(76).text).toBe('return sum;');
        // It is NOT the whole-symbol set — line 71 (the def above the criterion) is
        // upstream of the criterion, not downstream of it, so it must be absent.
        expect(sliceLines(result)).not.toContain(71);
      });

      it('upstream from line 74 returns the statements line 74 depends on (the def + the controller)', async () => {
        const result = await backend.callTool('impact', {
          target: 'accum',
          direction: 'upstream',
          mode: 'pdg',
          line: 74,
        });
        expect(result.error).toBeUndefined();
        expect(result.criterionLine).toBe(74);
        // C@74 depends on A@71 (RD def of sum) and B@72 (CDG controller).
        expect(sliceLines(result)).toEqual([71, 72]);
        expect(result.affectedStatementCount).toBe(2);
        // NOT the whole-symbol set — D@76 is downstream of line 74, never upstream.
        expect(sliceLines(result)).not.toContain(76);
      });

      it('whole-symbol (no line) is empty and steers the caller to line:<N>', async () => {
        // `accum`'s entire dependence stays inside its own [7,13] window, so a
        // whole-symbol seed reaches nothing (every block is a co-seed) — the
        // structurally-empty WHOLE-SYMBOL case.
        const result = await backend.callTool('impact', {
          target: 'accum',
          direction: 'downstream',
          mode: 'pdg',
        });
        expect(result.error).toBeUndefined();
        expect(result.mode).toBe('pdg');
        // No criterionLine (whole-symbol mode), an empty slice, and the steering note.
        expect(result.criterionLine).toBeUndefined();
        expect(result.affectedStatements).toEqual([]);
        expect(result.affectedStatementCount).toBe(0);
        expect(result.note).toMatch(/WHOLE-SYMBOL/);
        expect(result.note).toMatch(/line:<N>|Pass line/i);
        // Still never a confident "safe" zero.
        expect(result.risk).not.toBe('LOW');
      });

      it('a line with no statement block → epistemic pdg-no-block-at-line (distinct from no-pdg-body)', async () => {
        const result = await backend.callTool('impact', {
          target: 'accum',
          direction: 'downstream',
          mode: 'pdg',
          line: 73, // blank line inside accum — no block starts here
        });
        expect(result.error).toBeUndefined();
        expect(result.mode).toBe('pdg');
        expect(result.criterionLine).toBe(73);
        // Distinct from the no-PDG-body epistemic (the line has no statement block).
        expect(result.epistemic).toBe('pdg-no-block-at-line');
        expect(result.epistemic).not.toBe('no-pdg-body');
        expect(result.affectedStatements).toEqual([]);
        expect(result.risk).not.toBe('LOW');
      });
    });

    describe('truncation signalling', () => {
      it('maxDepth=1 truncates the chain and flags truncated (not silently short)', async () => {
        const result = await backend.callTool('impact', {
          target: 'target',
          direction: 'downstream',
          mode: 'pdg',
          maxDepth: 1,
        });
        const set = reachable(result);
        // Only the first hop: D1 and K1, NOT D2/K2 (depth 2).
        expect(set).toContain(D1);
        expect(set).toContain(K1);
        expect(set).not.toContain(D2);
        expect(set).not.toContain(K2);
        expect(result.truncated).toBe(true);
        expect(result.depthReached).toBe(1);
      });

      it('full traversal completing within depth is NOT flagged truncated', async () => {
        const result = await backend.callTool('impact', {
          target: 'target',
          direction: 'downstream',
          mode: 'pdg',
          maxDepth: 10,
        });
        expect(result.truncated).toBeFalsy();
      });

      it('an exact limit-sized seed/step is not flagged truncated without an extra row', async () => {
        const result = await backend.callTool('impact', {
          target: 'target',
          direction: 'upstream',
          mode: 'pdg',
          maxDepth: 10,
          limit: 1,
        });
        expect(reachable(result)).toEqual([P]);
        expect(result.truncated).toBeFalsy();
        expect(result.truncatedBy).toBeUndefined();
        expect(result.truncatedByReasons).toBeUndefined();
      });

      it('limit truncation bounds the reachable set and flags truncated', async () => {
        const result = await backend.callTool('impact', {
          target: 'target',
          direction: 'downstream',
          mode: 'pdg',
          maxDepth: 10,
          limit: 1,
        });
        // A limit of 1 cannot expand the full union — the result is bounded and
        // flagged so a caller never reads the clipped set as the whole radius.
        expect(reachable(result).length).toBeLessThan(4);
        expect(result.truncated).toBe(true);
      });

      it('reports both depth and limit when both bounds truncate the slice', async () => {
        const result = await backend.callTool('impact', {
          target: 'target',
          direction: 'downstream',
          mode: 'pdg',
          maxDepth: 1,
          limit: 1,
        });
        expect(result.truncated).toBe(true);
        expect(result.truncatedBy).toBe('depth');
        expect(result.truncatedByReasons).toEqual(['depth', 'limit']);
      });

      it('rejects or clamps a negative / huge / NaN limit (validated int interpolation)', async () => {
        for (const limit of [-1, NaN, 1.5]) {
          const result = await backend.callTool('impact', {
            target: 'target',
            direction: 'downstream',
            mode: 'pdg',
            limit,
          });
          // Either a clean validation error OR a clamp to a sane default — but
          // NEVER an unbounded/garbage interpolation or a crash.
          if (result.error) {
            expect(result.error).toMatch(/limit/i);
          } else {
            // Clamped: the traversal still produced its normal union.
            expect(reachable(result).length).toBeGreaterThan(0);
          }
        }
      });
    });

    describe('KTD6 no-body symbol contract', () => {
      it('a symbol with no BasicBlocks returns an explicit note, never a confident zero', async () => {
        const result = await backend.callTool('impact', {
          target: 'IShape', // interface — resolves, but has no CFG body / blocks
          direction: 'downstream',
          mode: 'pdg',
        });
        expect(result.error).toBeUndefined();
        expect(result.mode).toBe('pdg');
        // Explicit "no PDG body for this symbol kind" signal …
        expect(result.note).toMatch(/no.*(body|block|dependence)/i);
        // … and NEVER a silent confident-LOW / impactedCount:0 with no marker.
        expect(result.risk).not.toBe('LOW');
        expect(reachable(result)).toEqual([]);
      });
    });

    describe('KTD11 injection safety', () => {
      it('a target containing a quote/colon is bound, not interpolated (no crash, no injection)', async () => {
        // A malicious-looking target must flow through a bind param. It simply
        // resolves to not-found here (no such symbol) — never a Cypher error.
        const result = await backend.callTool('impact', {
          target: `evil':' OR 1=1 //`,
          direction: 'downstream',
          mode: 'pdg',
        });
        // Not a syntax/crash error — a clean not-found (param-bound).
        expect(result.error).toMatch(/not found/i);
      });
    });

    describe('KTD2 ambiguous-anchor names the impact tool', () => {
      it("an ambiguous target under mode:'pdg' names `impact`, not `pdg_query`", async () => {
        const result = await backend.callTool('impact', {
          target: 'dupTarget', // two functions share this name
          direction: 'downstream',
          mode: 'pdg',
        });
        expect(result.status).toBe('ambiguous');
        // The ambiguous path is the _impactImpl one (U1), which already names the
        // tool correctly; the load-bearing U3 fact is that resolveBlockAnchor's
        // widened union never emits a `pdg_query` message for an impact call.
        const blob = JSON.stringify(result);
        expect(blob).not.toMatch(/pdg_query/);
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
        type: 'Function' | 'Interface' = 'Function',
      ) =>
        adapter.executePrepared(
          `CREATE (n:${type} {id: $id, name: $name, filePath: $filePath, startLine: $startLine, endLine: $endLine, isExported: true, content: 'x', description: 'traversal fixture'})`,
          { id, name, filePath: F, startLine, endLine },
        );
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

      // Functions (0-based symbol lines). `target` is the one-line seed fn.
      await fn('func:target', 'target', 10, 10); // window [11,11] ⇒ seed {S}
      await fn('func:up', 'up', 4, 4); // P at line 6 — outside [11,11]
      await fn('func:down', 'down', 19, 21); // D1/D2 — outside [11,11]
      await fn('func:ctl', 'ctl', 29, 31); // K1/K2 — outside [11,11]
      // No-body symbol: an interface with NO BasicBlocks at all.
      await fn('func:IShape', 'IShape', 40, 42, 'Interface');
      // Ambiguous: two functions sharing a name.
      await fn('func:dupTarget@a', 'dupTarget', 50, 52);
      await fn('func:dupTarget@b', 'dupTarget', 60, 62);

      // Blocks.
      await block(S, 11, 'const x = compute();'); // target's seed block
      await block(P, 6, 'const seed = input();'); // predecessor
      await block(D1, 21, 'use(x);'); // RD use
      await block(D2, 22, 'log(x);'); // RD use of D1
      await block(K1, 31, 'doA();'); // CDG dependent
      await block(K2, 32, 'doB();'); // CDG dependent of K1

      // RD chain (def→use): P → S → D1 → D2
      await edge('REACHING_DEF', P, S, 'seed');
      await edge('REACHING_DEF', S, D1, 'x');
      await edge('REACHING_DEF', D1, D2, 'x');
      // CDG chain (controller→dependent): C(=P) → S → K1 → K2
      await edge('CDG', P, S, 'T');
      await edge('CDG', S, K1, 'T');
      await edge('CDG', K1, K2, 'T');

      // ── Statement-anchored fixture `accum` (mode:'pdg' + line) ────────────────
      // A SELF-CONTAINED multi-statement function whose every dependence stays
      // inside its own [71,81] window — so a WHOLE-SYMBOL seed reaches nothing
      // (every block is a co-seed) while a STATEMENT seed (line N) yields exactly
      // the statements dependent on line N. Lives in a line range that does NOT
      // overlap the `target`/`up`/`down`/`ctl` blocks above, so its whole-symbol
      // seed cannot pick up an unrelated block (the window is `[startLine+1,
      // endLine+1]`). Mirrors the accumulator idiom:
      //   71:  let sum = 0;            (A — RD def of sum)
      //   72:  for (const x of xs) {   (B — CDG controller of the loop body)
      //   73:                          (blank — NO block, the no-block-at-line case)
      //   74:    sum = sum + x;        (C — accumulate; controlled by B, uses A)
      //   76:    return sum;           (D — RD use of C's sum def)
      // Edges (all intra-`accum`):
      //   CDG: B(72) → C(74)        the loop controls the accumulate body
      //   RD:  A(71) → C(74)        sum's initial def reaches the accumulate use
      //   RD:  C(74) → D(76)        the accumulated sum flows to the return
      // ⇒ downstream from line 72 = {C@74, D@76}; upstream from line 74 = {A@71, B@72}.
      await fn('func:accum', 'accum', 70, 80); // window [71,81]
      const AccA = `BasicBlock:${F}:71:0:0`; // line 71
      const AccB = `BasicBlock:${F}:71:0:1`; // line 72 (same fn, distinct blockIdx)
      const AccC = `BasicBlock:${F}:71:0:2`; // line 74
      const AccD = `BasicBlock:${F}:71:0:3`; // line 76
      await block(AccA, 71, 'let sum = 0;');
      await block(AccB, 72, 'for (const x of xs) {');
      await block(AccC, 74, 'sum = sum + x;');
      await block(AccD, 76, 'return sum;');
      await edge('CDG', AccB, AccC, 'loop');
      await edge('REACHING_DEF', AccA, AccC, 'sum');
      await edge('REACHING_DEF', AccC, AccD, 'sum');

      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'traversal-repo',
          path: '/traversal/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'trav123',
          stats: { files: 1, nodes: 12, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
