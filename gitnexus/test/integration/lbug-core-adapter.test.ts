/**
 * P0 Integration Tests: Core LadybugDB Adapter
 *
 * Tests: loadGraphToLbug CSV round-trip, createFTSIndex, getLbugStats.
 *
 * IMPORTANT: All core adapter tests share ONE coreHandle and ONE coreInitLbug
 * call because the core adapter is a module-level singleton. Calling
 * coreInitLbug with a different path closes the previous native DB handle
 * and opens a new one — sharing a single handle avoids unnecessary churn.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

/**
 * LadybugDB 0.16.0 has a known Windows-only regression: `Database.close()`
 * does not release the underlying file lock until the process exits, so any
 * `closeLbug()` followed by `initLbug(samePath)` in the same process raises
 * Win32 Error 33. Production paths are unaffected (single open per process).
 *
 * Tracking: kuzudb/kuzu#3872 / #3883 / #4730 (file-lock UX gaps on Windows).
 */
const itLbugReopen = process.platform === 'win32' ? it.skip : it;

/**
 * The FTS extension is optional and defaults to a `load-only` install policy
 * (PR #1161 — offline-first), so on a machine where it was never pre-installed
 * it cannot load. The tests below exercise the FTS *primitives* directly and
 * have nothing to assert without the extension — skip them rather than fail.
 * Graceful degradation when FTS is unavailable is covered at the analyze /
 * query layer (see run-analyze.ts and the BM25 fallback tests).
 */
const FTS_UNAVAILABLE_NOTE =
  'FTS extension unavailable (load-only policy; not pre-installed on this machine)';

/**
 * Dynamically skip an FTS-primitive test when the extension cannot load.
 * `ctx.skip()` aborts the test, so callers should `await` this first thing.
 *
 * Honors GITNEXUS_REQUIRE_FTS=1 the same way `withTestLbugDB` does (see
 * test/helpers/test-indexed-db.ts): when CI sets it, an unavailable extension is
 * a HARD FAILURE, never a silent skip — otherwise these FTS-primitive tests
 * (this file is in LBUG_NATIVE, so it runs on the ubuntu/macOS/windows jobs that
 * all set GITNEXUS_REQUIRE_FTS=1) could vanish from a green run. Offline/local
 * runs (no env var) still skip gracefully (#2299).
 */
const skipUnlessFtsAvailable = async (ctx: { skip: (note?: string) => void }): Promise<void> => {
  const { loadFTSExtension } = await import('../../src/core/lbug/lbug-adapter.js');
  if (await loadFTSExtension()) return;
  if (process.env.GITNEXUS_REQUIRE_FTS === '1') {
    throw new Error(
      'FTS extension is required (GITNEXUS_REQUIRE_FTS=1) but could not be loaded or installed. ' +
        'FTS-dependent tests must not be silently skipped in CI — install/repair the LadybugDB ' +
        'FTS extension (see `gitnexus doctor`) or unset GITNEXUS_REQUIRE_FTS for offline/local runs.',
    );
  }
  ctx.skip(FTS_UNAVAILABLE_NOTE);
};

// ─── Core LadybugDB Adapter ─────────────────────────────────────────────

withTestLbugDB(
  'core-adapter',
  (handle) => {
    describe('core adapter', () => {
      it('loadGraphToLbug: loads a minimal graph and node counts match', async () => {
        const { executeQuery: coreExecuteQuery } =
          await import('../../src/core/lbug/lbug-adapter.js');

        // createMinimalTestGraph has 2 File, 2 Function, 1 Class, 1 Folder = 6 nodes
        const fileRows = await coreExecuteQuery('MATCH (n:File) RETURN n.id AS id');
        expect(fileRows).toHaveLength(2);

        const funcRows = await coreExecuteQuery('MATCH (n:Function) RETURN n.id AS id');
        expect(funcRows).toHaveLength(2);

        const classRows = await coreExecuteQuery('MATCH (n:Class) RETURN n.id AS id');
        expect(classRows).toHaveLength(1);

        const folderRows = await coreExecuteQuery('MATCH (n:Folder) RETURN n.id AS id');
        expect(folderRows).toHaveLength(1);
      });

      it('createFTSIndex: creates FTS index on Function table without error', async (ctx) => {
        await skipUnlessFtsAvailable(ctx);
        const { createFTSIndex } = await import('../../src/core/lbug/lbug-adapter.js');

        await expect(
          createFTSIndex('Function', 'function_fts', ['name', 'content']),
        ).resolves.toBeUndefined();
      });

      it('loadFTSExtension(conn): loads on an explicit connection and returns true', async (ctx) => {
        await skipUnlessFtsAvailable(ctx);
        const lbug = (await import('@ladybugdb/core')).default;
        const { loadFTSExtension, getDatabase } =
          await import('../../src/core/lbug/lbug-adapter.js');

        const db = getDatabase();
        expect(db).not.toBeNull();

        // Fresh Connection on the same Database — simulates the pool adapter's
        // path where loadFTSExtension is called with an explicit connection
        // rather than the module-level singleton.
        const freshConn = new lbug.Connection(db!);
        try {
          const loaded = await loadFTSExtension(freshConn);
          expect(loaded).toBe(true);

          // Idempotent on the same connection — calling again still returns true
          // (exercises the "already loaded" catch branch in the fallback path).
          const loadedAgain = await loadFTSExtension(freshConn);
          expect(loadedAgain).toBe(true);
        } finally {
          await freshConn.close().catch(() => {});
        }
      });

      it('getLbugStats: returns correct node and edge counts for seeded data', async () => {
        const { getLbugStats } = await import('../../src/core/lbug/lbug-adapter.js');

        const stats = await getLbugStats();

        // createMinimalTestGraph: 6 nodes (2 File, 2 Function, 1 Class, 1 Folder)
        expect(stats.nodes).toBe(6);

        // 4 relationships (2 CALLS, 2 CONTAINS)
        expect(stats.edges).toBe(4);
      });

      it('deleteAllInterprocTaintPaths: removes TAINT_PATH edges and is benign when none exist (#2084 review P2-5)', async () => {
        const { executeQuery: coreExecuteQuery, deleteAllInterprocTaintPaths } =
          await import('../../src/core/lbug/lbug-adapter.js');

        // Benign: no TAINT_PATH rows yet → returns 0, does NOT throw.
        await expect(deleteAllInterprocTaintPaths()).resolves.toEqual({ edgesDeleted: 0 });

        // Seed one TAINT_PATH edge between the two seeded Function nodes, then
        // delete-all and confirm it is removed (the incremental-rebuild guard).
        const fns = (await coreExecuteQuery('MATCH (n:Function) RETURN n.id AS id')) as {
          id: string;
        }[];
        expect(fns.length).toBe(2);
        await coreExecuteQuery(
          `MATCH (a:Function {id: '${fns[0].id}'}), (b:Function {id: '${fns[1].id}'}) ` +
            `CREATE (a)-[:CodeRelation {type: 'TAINT_PATH', confidence: 0.6, reason: '1', step: 0}]->(b)`,
        );
        const r = await deleteAllInterprocTaintPaths();
        expect(r.edgesDeleted).toBe(1);
        const left = await coreExecuteQuery(
          `MATCH ()-[r:CodeRelation]->() WHERE r.type = 'TAINT_PATH' RETURN count(r) AS cnt`,
        );
        expect(Number((left[0] as { cnt: number }).cnt)).toBe(0);
      });

      describe('unhappy path', () => {
        it('throws on malformed Cypher query', async () => {
          const { executeQuery } = await import('../../src/core/lbug/lbug-adapter.js');

          // Deliberately broken syntax: MATCH without a pattern clause
          await expect(executeQuery('MATCH RETURN 1')).rejects.toThrow();
        });

        it('returns empty results for query matching no nodes', async () => {
          const { executeQuery } = await import('../../src/core/lbug/lbug-adapter.js');

          // Valid Cypher, but the id will never exist in the seeded graph
          const rows = await executeQuery(
            "MATCH (n:Function) WHERE n.id = '__nonexistent_id__' RETURN n.id AS id",
          );
          expect(rows).toHaveLength(0);
        });

        it('handles query with non-existent table/node label', async () => {
          const { executeQuery } = await import('../../src/core/lbug/lbug-adapter.js');

          // LadybugDB throws when the node table does not exist in the schema
          await expect(executeQuery('MATCH (n:GhostTable) RETURN n')).rejects.toThrow();
        });
      });

      describe('error handling', () => {
        it('createFTSIndex handles already-existing index gracefully', async (ctx) => {
          await skipUnlessFtsAvailable(ctx);
          const { createFTSIndex } = await import('../../src/core/lbug/lbug-adapter.js');

          // First call creates the index (may already exist from earlier test)
          await createFTSIndex('Function', 'function_fts_dup', ['name', 'content']);

          // Second call with same params should NOT throw — createFTSIndex catches "already exists"
          await expect(
            createFTSIndex('Function', 'function_fts_dup', ['name', 'content']),
          ).resolves.toBeUndefined();
        });

        it('ensureFTSIndex is idempotent and caches across writable calls (#1224)', async (ctx) => {
          await skipUnlessFtsAvailable(ctx);
          const { ensureFTSIndex } = await import('../../src/core/lbug/lbug-adapter.js');

          // First call creates the index. Second call must short-circuit on the
          // in-process cache — guarantees the read-only guard added in #1224
          // still respects the success path.
          await expect(
            ensureFTSIndex('Function', 'function_fts_ensure', ['name', 'content']),
          ).resolves.toBeUndefined();
          await expect(
            ensureFTSIndex('Function', 'function_fts_ensure', ['name', 'content']),
          ).resolves.toBeUndefined();
        });

        it('getLbugStats returns valid counts', async () => {
          const { getLbugStats } = await import('../../src/core/lbug/lbug-adapter.js');

          // getLbugStats NEVER throws — it has silent catch blocks per table
          const stats = await getLbugStats();
          expect(typeof stats.nodes).toBe('number');
          expect(typeof stats.edges).toBe('number');
          expect(stats.nodes).toBeGreaterThanOrEqual(0);
          expect(stats.edges).toBeGreaterThanOrEqual(0);
        });

        it('executeQuery with empty string rejects', async () => {
          const { executeQuery } = await import('../../src/core/lbug/lbug-adapter.js');

          // LadybugDB throws on empty query string
          await expect(executeQuery('')).rejects.toThrow();
        });

        it('deleteNodesForFile with non-existent path returns zero deleted', async () => {
          const { deleteNodesForFile } = await import('../../src/core/lbug/lbug-adapter.js');

          // deleteNodesForFile has per-query try/catch, returns {deletedNodes: 0} for missing paths
          const result = await deleteNodesForFile('/absolutely/nonexistent/path/file.ts');
          expect(result).toEqual({ deletedNodes: 0 });
        });
      });

      itLbugReopen(
        'initLbug loads FTS so reopened HTTP-style sessions can query existing indexes',
        async (ctx) => {
          await skipUnlessFtsAvailable(ctx);
          const adapter = await import('../../src/core/lbug/lbug-adapter.js');
          const indexName = 'function_fts_init_probe';

          await adapter.createFTSIndex('Function', indexName, ['name', 'content']);
          await adapter.closeLbug();

          await adapter.initLbug(handle.dbPath);

          await expect(adapter.queryFTS('Function', indexName, 'main', 5)).resolves.toEqual(
            expect.arrayContaining([expect.objectContaining({ filePath: 'src/index.ts' })]),
          );
        },
      );
    });
  },
  {
    afterSetup: async (handle) => {
      // Load a minimal graph via CSV round-trip (core adapter is already initialized by wrapper)
      const { loadGraphToLbug } = await import('../../src/core/lbug/lbug-adapter.js');
      const { createMinimalTestGraph } = await import('../helpers/test-graph.js');

      const graph = createMinimalTestGraph();
      const storagePath = path.join(handle.tmpHandle.dbPath, 'storage');
      await fs.mkdir(storagePath, { recursive: true });

      await loadGraphToLbug(graph, '/test/repo', storagePath);
    },
  },
);
