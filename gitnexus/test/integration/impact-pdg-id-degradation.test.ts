/**
 * Integration test (U10): the sound resolved-id bridge degrades gracefully on a
 * pre-v3 / id-less index — it falls back to the existing leaf-NAME match with no
 * crash and no silently-empty proof. End-to-end against a REAL LadybugDB through
 * the full `callTool('impact', {mode:'pdg', line})` dispatch.
 *
 * Covers R3 (graceful degradation) + R7 (the 512-site truncation sentinel keeps a
 * capped block callgraph-equal regardless of ids). Two of the three degradation
 * shapes are expressible at the integration layer here:
 *
 *   Scenario 1 — empty `calleeIds` cells (the seeded BasicBlocks carry `callees`
 *     but NO `calleeIds`, so the v3 column reads back empty): `calleeIdsOfBlocks`
 *     yields an empty id set → the bridge falls back to the NAME path → the reached
 *     callee whose leaf name is in the slice is proven (callgraph-bridge), exactly
 *     the pre-feature behavior. Asserted NOT empty / NOT dropped.
 *
 *   Scenario 3 — capped-sentinel block: a slice block whose `callees` carries the
 *     `*` truncation sentinel (R7) is callee-unknown, so the bridge stays
 *     callgraph-equal — every reached callee is proven regardless of ids.
 *
 * Scenario 2 (the `calleeIds` query itself erroring — a truly column-less / older
 * binder error) cannot be expressed here: `withTestLbugDB` always materializes the
 * current v3 schema, so the column is always present and `RETURN b.calleeIds`
 * never raises a binder error. That swallow-on-error → name-fallback path is
 * covered at the UNIT layer in
 * `test/unit/calltool-dispatch-id-bridge.test.ts` (the "falls back to the name path
 * when the calleeIds query errors" case, which mocks `executeParameterized` to
 * throw on `RETURN b.calleeIds`).
 *
 * Module-scoped `let backend` and unconditional asserts, mirroring the sibling PDG
 * integration suites (no `if`-branching, no `as any`).
 */
import { it, expect, beforeAll, vi } from 'vitest';
import type { RepoMeta } from '../../src/storage/repo-manager.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos, loadMeta } from '../../src/storage/repo-manager.js';
import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
    loadMeta: vi.fn().mockResolvedValue(null),
  };
});

const FILE = 'src/deg.ts';

// A Function symbol the dispatch can resolve by name.
const fn = (id: string, name: string, startLine: number, endLine: number): string =>
  `CREATE (:Function {id: '${id}', name: '${name}', filePath: '${FILE}', startLine: ${startLine}, endLine: ${endLine}, isExported: true, content: 'x', description: 'id-degradation fixture'})`;

// A BasicBlock with `callees` (leaf names) but WITHOUT `calleeIds` — the property
// is left unset so the present-but-empty v3 column reads back empty (the pre-v3
// reality: names harvested, resolved ids never captured).
const blkNoIds = (owner: string, idx: number, line: number, callees: string): string =>
  `CREATE (:BasicBlock {id: 'BasicBlock:${FILE}:${owner}:0:${idx}', filePath: '${FILE}', startLine: ${line}, endLine: ${line}, text: 't', callees: '${callees}'})`;

const reachingDef = (owner: string, fromIdx: number, toIdx: number): string =>
  `MATCH (a:BasicBlock {id: 'BasicBlock:${FILE}:${owner}:0:${fromIdx}'}), (b:BasicBlock {id: 'BasicBlock:${FILE}:${owner}:0:${toIdx}'}) CREATE (a)-[:CodeRelation {type: 'REACHING_DEF', confidence: 1.0, reason: 'v', step: 0}]->(b)`;

const calls = (callerId: string, calleeId: string): string =>
  `MATCH (c:Function {id: '${callerId}'}), (t:Function {id: '${calleeId}'}) CREATE (c)-[:CodeRelation {type: 'CALLS', confidence: 0.9, reason: 'local-call', step: 0}]->(t)`;

// ── Scenario 1 graph: `nameCaller` ───────────────────────────────────────────
//   B0 (line 2, seed): calls foo    — only foo's call site
//   B1 (line 4): calls bar          — reachable from B0 via REACHING_DEF
//   B2 (line 5): calls baz          — NOT reachable from B0
// slice = {B0, B1}; name-proven = {foo, bar}; baz stays unproven. With empty
// calleeIds the bridge must reproduce this NAME-based verdict.
const SCENARIO_1 = [
  fn('func:nameCaller', 'nameCaller', 0, 6),
  fn('func:foo', 'foo', 10, 12),
  fn('func:bar', 'bar', 14, 16),
  fn('func:baz', 'baz', 18, 20),
  blkNoIds('nameCaller', 0, 2, 'foo'),
  blkNoIds('nameCaller', 1, 4, 'bar'),
  blkNoIds('nameCaller', 2, 5, 'baz'),
  reachingDef('nameCaller', 0, 1),
  calls('func:nameCaller', 'func:foo'),
  calls('func:nameCaller', 'func:bar'),
  calls('func:nameCaller', 'func:baz'),
];

// ── Scenario 3 graph: `cappedCaller` ─────────────────────────────────────────
//   B0 (line 2, seed): callees = '*' (the 512-site truncation sentinel, R7) — the
//   block is callee-unknown, so even though calleeIds is empty AND the leaf name
//   would not match, the bridge stays callgraph-equal: the reached callee is proven.
const SCENARIO_3 = [
  fn('func:cappedCaller', 'cappedCaller', 30, 36),
  fn('func:qux', 'qux', 40, 42),
  blkNoIds('cappedCaller', 0, 32, '*'),
  calls('func:cappedCaller', 'func:qux'),
];

const SEED: string[] = [...SCENARIO_1, ...SCENARIO_3];

const READY_META: RepoMeta = {
  pdg: { maxCdgEdgesPerFunction: 0, maxReachingDefEdgesPerFunction: 0 },
} as unknown as RepoMeta;

let backend: LocalBackend;

withTestLbugDB(
  'impact-pdg-id-degradation',
  (handle) => {
    beforeAll(() => {
      if (!backend) throw new Error('LocalBackend not initialized in afterSetup');
    });

    const provenNames = (result: {
      pdgInterprocedural?: { statementPreciseByDepth?: Record<number, Array<{ name?: string }>> };
    }): string[] =>
      Object.values(result.pdgInterprocedural?.statementPreciseByDepth ?? {})
        .flat()
        .map((item) => item.name ?? '');

    const evidenceById = (result: {
      interproceduralByDepth?: Record<number, Array<{ id?: string; pdgEvidence?: string }>>;
    }): Map<string, string> =>
      new Map(
        Object.values(result.interproceduralByDepth ?? {})
          .flat()
          .map((item) => [item.id ?? '', item.pdgEvidence ?? '']),
      );

    it('precondition: the seeded slice blocks carry empty calleeIds (pre-v3 shape)', async () => {
      // Prove the fixture really exercises the degraded path: every BasicBlock has
      // an EMPTY calleeIds cell (column present in v3, never populated) so
      // `calleeIdsOfBlocks` returns an empty id set and the bridge has no ids to
      // prove by — forcing the name fallback / sentinel paths below.
      const rows: Array<{ id?: string; calleeIds?: string | null }> = await executeParameterized(
        handle.repoId,
        `MATCH (b:BasicBlock) RETURN b.id AS id, b.calleeIds AS calleeIds`,
        {},
      );
      const calleeIdCells = rows.map((r) => String(r.calleeIds ?? ''));
      expect(calleeIdCells.length).toBeGreaterThan(0);
      expect(calleeIdCells.every((cell) => cell === '')).toBe(true);
    });

    it('Scenario 1 (R3): empty calleeIds → bridge falls back to the leaf-NAME match', async () => {
      vi.mocked(loadMeta).mockResolvedValue(READY_META);
      const result = await backend.callTool('impact', {
        target: 'nameCaller',
        direction: 'downstream',
        mode: 'pdg',
        line: 2,
      });

      // No crash, no surfaced error — the inter-procedural reach completed.
      expect(result.error).toBeUndefined();
      expect(result.epistemic).toBe('pdg-intra-procedural');

      // The NAME path proves exactly the slice callees: foo (seeded line) and bar
      // (dependent block). This is the byte-for-byte pre-feature behavior; an empty
      // id set must NOT silently drop the proof.
      const proven = provenNames(result);
      expect(proven).toContain('foo');
      expect(proven).toContain('bar');
      // baz is reached in the call graph but only from an unreachable block, so it
      // stays out of the statement-precise (name-proven) slice.
      expect(proven).not.toContain('baz');

      // The proof is NOT silently empty: there is a statement-precise verdict and a
      // non-empty proven set.
      expect(result.pdgInterprocedural.statementPreciseImpactedCount).toBeGreaterThanOrEqual(2);
      expect(proven.length).toBeGreaterThanOrEqual(2);

      // Per-callee evidence: foo + bar proven via the name bridge, baz unproven —
      // the exact verdict the name path (and only the name path, since ids are
      // empty) produces.
      const byId = evidenceById(result);
      expect(byId.get('func:foo')).toBe('callgraph-bridge');
      expect(byId.get('func:bar')).toBe('callgraph-bridge');
      expect(byId.get('func:baz')).toBe('unproven-bridge');

      // Full call-graph reach is preserved (recall intact) — degradation does not
      // shrink the underlying reach, only the proof key.
      const fullNames = Object.values(result.pdgInterprocedural?.byDepth ?? {})
        .flat()
        .map((item: { name?: string }) => item.name ?? '');
      expect(fullNames).toEqual(expect.arrayContaining(['foo', 'bar', 'baz']));
    });

    it('Scenario 3 (R7): a capped-sentinel slice block stays callgraph-equal', async () => {
      vi.mocked(loadMeta).mockResolvedValue(READY_META);
      const result = await backend.callTool('impact', {
        target: 'cappedCaller',
        direction: 'downstream',
        mode: 'pdg',
        line: 32,
      });

      expect(result.error).toBeUndefined();
      expect(result.epistemic).toBe('pdg-intra-procedural');

      // The seed block's call sites are truncated (`*` sentinel) → the callee set is
      // incomplete → the bridge keeps the reach callgraph-equal: `qux` is proven
      // even though it is neither in calleeIds (empty) nor a literal name match.
      const byId = evidenceById(result);
      expect(byId.get('func:qux')).toBe('callgraph-bridge');

      // Callgraph-equal means every reached callee is proven — precision is 1, never
      // a partial under-proof, and nothing was dropped.
      expect(result.pdgInterprocedural.statementPrecision).toBe(1);
      const proven = provenNames(result);
      expect(proven).toContain('qux');
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'id-degradation-repo',
          path: '/id-degradation/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'iddeg123',
          stats: { files: 1, nodes: 6, communities: 0, processes: 0 },
        },
      ]);
      backend = new LocalBackend();
      await backend.init();
    },
  },
);
