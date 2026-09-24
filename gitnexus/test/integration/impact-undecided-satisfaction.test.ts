/**
 * Integration test: undecided interface satisfaction reaches `impact` (#2873)
 *
 * The failure this pins is the one the issue reports, and it is invisible to a
 * graph-only probe. When the analyzer cannot DECIDE whether a type satisfies an
 * interface — a type in a required signature named a package with no
 * recoverable identity — it mints no IMPLEMENTS edge. The dispatch boundary
 * that `computeEpistemicBoundary` looks for is derived FROM that edge, so there
 * is nothing left for it to notice: `impact()` on the implementation reports
 * zero callers and calls the answer `exact`. The hedge is strongest where it is
 * least needed and silent where the answer is wrong.
 *
 * The graph below is therefore deliberately edge-free between `CtxStoreImpl`
 * and `CtxStore` — that absence IS the bug — and the only thing that can rescue
 * the query is the analyzer's own record of what it could not decide, read from
 * the index metadata.
 */
import { it, expect, beforeAll, vi } from 'vitest';
import path from 'node:path';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    // Spied, not stubbed: the read count per query is the invariant below.
    loadMeta: vi.fn(actual.loadMeta),
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
  };
});
const { listRegisteredRepos, loadMeta, saveMeta } =
  await import('../../src/storage/repo-manager.js');

const SEED = [
  // The interface, its would-be implementor, and the implementor's method.
  // NOTE: no IMPLEMENTS edge — the analyzer could not decide, so none exists.
  `CREATE (iface:Interface {id: 'Interface:store/store.go:CtxStore', name: 'CtxStore', filePath: 'store/store.go', startLine: 1, endLine: 5, isExported: true, content: '', description: ''})`,
  `CREATE (impl:Struct {id: 'Struct:memory/memory.go:CtxStoreImpl', name: 'CtxStoreImpl', filePath: 'memory/memory.go', startLine: 1, endLine: 20, content: '', description: ''})`,
  `CREATE (m:Method {id: 'Method:memory/memory.go:CtxStoreImpl.Delete', name: 'Delete', filePath: 'memory/memory.go', startLine: 8, endLine: 10, isExported: true, content: '', description: ''})`,
  `MATCH (a:Struct {id:'Struct:memory/memory.go:CtxStoreImpl'}), (b:Method {id:'Method:memory/memory.go:CtxStoreImpl.Delete'}) CREATE (a)-[:CodeRelation {type:'HAS_METHOD', confidence:1.0, reason:'method', step:0}]->(b)`,

  // A genuinely isolated leaf in the same index: it must stay `exact`, or the
  // hedge is just noise applied to everything.
  `CREATE (leaf:Function {id: 'Function:util/util.go:FormatDate', name: 'FormatDate', filePath: 'util/util.go', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
];

withTestLbugDB(
  'impact-undecided-satisfaction',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      backend = (handle as any)._backend;
    });

    it('reports a lower bound for the implementation the analyzer could not judge', async () => {
      const result: any = await backend.callTool('impact', {
        target: 'Delete',
        direction: 'upstream',
      });
      expect(result).not.toHaveProperty('error');
      // The count is still zero — this fix does not invent callers.
      expect(result.impactedCount).toBe(0);
      // …but the answer no longer claims to be complete.
      expect(result.epistemic).toBe('lower-bound');
      expect(result.causes.undecidedSatisfaction).toBe(1);
      expect(result.boundaries.join(' ')).toContain('CtxStoreImpl');
    });

    it('reports a lower bound when asked about the interface itself', async () => {
      const result: any = await backend.callTool('impact', {
        target: 'CtxStore',
        direction: 'upstream',
      });
      expect(result).not.toHaveProperty('error');
      expect(result.epistemic).toBe('lower-bound');
      expect(result.causes.undecidedSatisfaction).toBe(2);
      expect(result.boundaries.join(' ')).toContain('could not be fully determined');
    });

    // Two independent probes read this record, and the file is dominated by
    // `fileHashes` — megabytes on a real repo. They must share one read.
    it('reads the index metadata at most once per query', async () => {
      vi.mocked(loadMeta).mockClear();
      await backend.callTool('impact', { target: 'Delete', direction: 'upstream' });
      expect(vi.mocked(loadMeta).mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('leaves a symbol the analyzer decided cleanly as exact', async () => {
      const result: any = await backend.callTool('impact', {
        target: 'FormatDate',
        direction: 'upstream',
      });
      expect(result).not.toHaveProperty('error');
      expect(result.epistemic).toBe('exact');
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    afterSetup: async (h) => {
      // The record the analyzer would have written. `CtxStore` had 2 candidate
      // types it could not judge; `CtxStoreImpl` was a candidate for 1
      // interface — the two sides of the same undecided pair set.
      // `saveMeta`, not a hand-rolled write: it is the only writer production
      // uses, and it is atomic and dual-writes the legacy mirror. Writing the
      // file directly would pin a shape no real analyze can produce.
      await saveMeta(path.dirname(h.dbPath), {
        scopeExtractionReceipt: 1,
        undecidedInterfaceSatisfaction: {
          counts: { CtxStore: 2 },
          totalInterfaces: 1,
          totalCandidates: 2,
          candidateCounts: { CtxStoreImpl: 1 },
        },
      } as any);
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: '/test/repo',
          storagePath: h.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 4, nodes: 4, communities: 0, processes: 0 },
        },
      ] as any);
      const backend = new LocalBackend();
      await backend.init();
      (h as any)._backend = backend;
    },
  },
);
