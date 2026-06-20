/**
 * Integration test: statement-precise inter-procedural reach (the proven subset).
 *
 * Gates the PR #2227 fix that a callee invoked DIRECTLY on the seeded line is
 * proven (`statementPreciseByDepth`), not dropped — the seed block is excluded
 * from `reachableBlocks` by the seed-minus-reachable convention, so the dispatch
 * must union the seed block's callees. End-to-end against a real LadybugDB.
 *
 * Fixture shape (function `caller`, downstream seed on line 2):
 *   - B0 (line 2, seed): calls `foo`  — `foo` is NOT called from any other block
 *   - B1 (line 4): calls `bar`        — reachable from B0 via REACHING_DEF
 *   - B2 (line 5): calls `baz`        — NOT reachable from B0 (no dependence edge)
 * So the slice = {B0, B1}; proven = {foo, bar}; `baz` (reached in the call graph
 * but not from the slice) stays unproven.
 */
import { it, expect, beforeAll, vi } from 'vitest';
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
    loadMeta: vi.fn().mockResolvedValue(null),
  };
});

const fn = (id: string, name: string, startLine: number, endLine: number): string =>
  `CREATE (:Function {id: '${id}', name: '${name}', filePath: 'src/fn.ts', startLine: ${startLine}, endLine: ${endLine}, isExported: true, content: 'x', description: 'statement-precise fixture'})`;

const blk = (idx: number, line: number, callees: string): string =>
  `CREATE (:BasicBlock {id: 'BasicBlock:src/fn.ts:1:0:${idx}', filePath: 'src/fn.ts', startLine: ${line}, endLine: ${line}, text: 't', callees: '${callees}'})`;

const calls = (callee: string): string =>
  `MATCH (c:Function {id: 'func:caller'}), (t:Function {id: '${callee}'}) CREATE (c)-[:CodeRelation {type: 'CALLS', confidence: 0.9, reason: 'local-call', step: 0}]->(t)`;

const SEED: string[] = [
  fn('func:caller', 'caller', 0, 6),
  fn('func:foo', 'foo', 10, 12),
  fn('func:bar', 'bar', 14, 16),
  fn('func:baz', 'baz', 18, 20),
  blk(0, 2, 'foo'), // seed block (line 2) — calls foo
  blk(1, 4, 'bar'), // dependent block (line 4) — calls bar
  blk(2, 5, 'baz'), // unreachable block (line 5) — calls baz
  // B0 -> B1: a downstream data dependence so B1 is reachable from the line-2 seed.
  `MATCH (a:BasicBlock {id: 'BasicBlock:src/fn.ts:1:0:0'}), (b:BasicBlock {id: 'BasicBlock:src/fn.ts:1:0:1'}) CREATE (a)-[:CodeRelation {type: 'REACHING_DEF', confidence: 1.0, reason: 'v', step: 0}]->(b)`,
  calls('func:foo'),
  calls('func:bar'),
  calls('func:baz'),
];

const READY_META: RepoMeta = {
  pdg: { maxCdgEdgesPerFunction: 0, maxReachingDefEdgesPerFunction: 0 },
} as unknown as RepoMeta;

let backend: LocalBackend;

withTestLbugDB(
  'impact-pdg-statement-precise',
  () => {
    beforeAll(() => {
      if (!backend) throw new Error('LocalBackend not initialized in afterSetup');
    });

    const provenNames = (result: {
      pdgInterprocedural?: { statementPreciseByDepth?: Record<number, Array<{ name?: string }>> };
    }): string[] =>
      Object.values(result.pdgInterprocedural?.statementPreciseByDepth ?? {})
        .flat()
        .map((item) => item.name ?? '');

    it('proves the seed-line callee and the dependent callee; excludes the unreachable callee', async () => {
      vi.mocked(loadMeta).mockResolvedValueOnce(READY_META);
      const result = await backend.callTool('impact', {
        target: 'caller',
        direction: 'downstream',
        mode: 'pdg',
        line: 2,
      });

      expect(result.error).toBeUndefined();
      expect(result.epistemic).toBe('pdg-intra-procedural');
      const proven = provenNames(result);
      // foo is called ON the seeded line (regression target); bar from the
      // dependent block — both are statement-precise proven.
      expect(proven).toContain('foo');
      expect(proven).toContain('bar');
      // baz is reached in the call graph but only from an unreachable block, so
      // it is NOT in the statement-precise slice.
      expect(proven).not.toContain('baz');
      // The full reach still lists all three (recall preserved).
      const fullNames = Object.values(result.pdgInterprocedural?.byDepth ?? {})
        .flat()
        .map((item: { name?: string }) => item.name ?? '');
      expect(fullNames).toEqual(expect.arrayContaining(['foo', 'bar', 'baz']));
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'stmt-precise-repo',
          path: '/stmt-precise/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'sp123',
          stats: { files: 1, nodes: 7, communities: 0, processes: 0 },
        },
      ]);
      backend = new LocalBackend();
      await backend.init();
    },
  },
);
