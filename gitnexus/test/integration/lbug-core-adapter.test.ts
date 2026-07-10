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
import type { GraphRelationship } from 'gitnexus-shared';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { skipUnlessFtsAvailable } from '../helpers/fts-availability.js';

/**
 * LadybugDB 0.16.0 has a known Windows-only regression: `Database.close()`
 * does not release the underlying file lock until the process exits, so any
 * `closeLbug()` followed by `initLbug(samePath)` in the same process raises
 * Win32 Error 33. Production paths are unaffected (single open per process).
 *
 * Tracking: kuzudb/kuzu#3872 / #3883 / #4730 (file-lock UX gaps on Windows).
 */
const itLbugReopen = process.platform === 'win32' ? it.skip : it;

// The FTS extension is optional and defaults to a `load-only` install policy
// (PR #1161 — offline-first), so on a machine where it was never pre-installed
// it cannot load. The tests below exercise the FTS *primitives* directly and
// have nothing to assert without the extension — skip them rather than fail.
// Graceful degradation when FTS is unavailable is covered at the analyze /
// query layer (see run-analyze.ts and the BM25 fallback tests).
// See test/helpers/fts-availability.ts for skipUnlessFtsAvailable's contract.

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

      it('deleteAllInjects: removes only INJECTS edges and is benign when none exist (#2200)', async () => {
        // Mirrors the deleteAllInterprocTaintPaths test above (same contract:
        // COUNT-then-DELETE, missing-table carve-out, re-throw otherwise).
        // The re-throw path is not simulated here — doing so would require
        // breaking the shared singleton connection mid-suite. Its benign-vs-
        // rethrow classification is pinned as a pure function instead:
        // `classifyDeleteAllError` (lbug-config.ts), exhaustively covered in
        // test/unit/lbug-delete-all-error.test.ts.
        const { executeQuery: coreExecuteQuery, deleteAllInjects } =
          await import('../../src/core/lbug/lbug-adapter.js');

        // Benign: no INJECTS rows yet → returns 0, does NOT throw.
        await expect(deleteAllInjects()).resolves.toEqual({ edgesDeleted: 0 });

        // Seed one INJECTS edge plus one edge of ANOTHER type between the two
        // seeded Function nodes, then delete-all and confirm exactly the
        // INJECTS row is removed while the other-typed row survives.
        const fns = (await coreExecuteQuery('MATCH (n:Function) RETURN n.id AS id')) as {
          id: string;
        }[];
        expect(fns.length).toBe(2);
        await coreExecuteQuery(
          `MATCH (a:Function {id: '${fns[0].id}'}), (b:Function {id: '${fns[1].id}'}) ` +
            `CREATE (a)-[:CodeRelation {type: 'INJECTS', confidence: 0.8, reason: 'di', step: 0}]->(b)`,
        );
        await coreExecuteQuery(
          `MATCH (a:Function {id: '${fns[0].id}'}), (b:Function {id: '${fns[1].id}'}) ` +
            `CREATE (a)-[:CodeRelation {type: 'QUERIES', confidence: 0.8, reason: 'orm', step: 0}]->(b)`,
        );
        const r2 = await deleteAllInjects();
        expect(r2.edgesDeleted).toBe(1);
        const injectsLeft = await coreExecuteQuery(
          `MATCH ()-[r:CodeRelation]->() WHERE r.type = 'INJECTS' RETURN count(r) AS cnt`,
        );
        expect(Number((injectsLeft[0] as { cnt: number }).cnt)).toBe(0);
        const queriesLeft = await coreExecuteQuery(
          `MATCH ()-[r:CodeRelation]->() WHERE r.type = 'QUERIES' RETURN count(r) AS cnt`,
        );
        expect(Number((queriesLeft[0] as { cnt: number }).cnt)).toBe(1);
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

      // ── Cypher escaping sweep (#2409, tri-review 4669518496 P2-2) ─────
      // Quoted-value round-trips through the three string-built statement
      // builders that used SQL-style `''` doubling — which LadybugDB rejects
      // as a parse error, so every quoted value silently failed wherever the
      // call site swallowed per-row errors. Declared LAST on purpose: these
      // tests APPEND rows to the shared singleton DB, and the count-based
      // assertions above (getLbugStats, the loadGraphToLbug round-trip) run
      // first in declaration order.
      describe('string-built Cypher escaping (quoted values)', () => {
        it('insertNodeToLbug: quoted filePath/name/content round-trip by exact match', async () => {
          const { insertNodeToLbug, executeQuery } =
            await import('../../src/core/lbug/lbug-adapter.js');
          const { escapeCypherString } = await import('../../src/core/lbug/cypher-escape.js');

          const filePath = "src/es'cape-probe.ts";
          const inserted = await insertNodeToLbug('File', {
            id: `File:${filePath}`,
            name: "es'cape-probe.ts",
            filePath,
            content: "const s = 'quoted';",
          });
          expect(inserted).toBe(true);

          const rows = await executeQuery(
            `MATCH (n:File) WHERE n.filePath = '${escapeCypherString(filePath)}' ` +
              `RETURN n.id AS id, n.name AS name, n.content AS content`,
          );
          expect(rows).toEqual([
            { id: `File:${filePath}`, name: "es'cape-probe.ts", content: "const s = 'quoted';" },
          ]);
        });

        it('fallbackRelationshipInserts: quoted endpoint ids create the edge; quoted reason round-trips', async () => {
          const { fallbackRelationshipInserts, insertNodeToLbug, executeQuery } =
            await import('../../src/core/lbug/lbug-adapter.js');
          const { getNodeLabel } = await import('../../src/core/lbug/rel-pair-routing.js');
          const { REL_CSV_HEADER, buildRelRow } =
            await import('../../src/core/lbug/csv-generator.js');
          const { NODE_TABLES, REL_TABLE_NAME } = await import('../../src/core/lbug/schema.js');
          const { escapeCypherString } = await import('../../src/core/lbug/cypher-escape.js');

          const quotedFile = "src/we'ird.ts";
          const fnId = `Function:${quotedFile}:fn:1`;
          const fileId = `File:${quotedFile}`;
          expect(
            await insertNodeToLbug('Function', {
              id: fnId,
              name: 'fn',
              filePath: quotedFile,
              startLine: 1,
              endLine: 3,
              isExported: true,
              content: 'function fn() {}',
            }),
          ).toBe(true);
          expect(
            await insertNodeToLbug('File', {
              id: fileId,
              name: "we'ird.ts",
              filePath: quotedFile,
              content: '',
            }),
          ).toBe(true);

          // Real buildRelRow bytes + the real rel-pair-routing getNodeLabel —
          // exactly the shapes the production COPY-failure fallback receives.
          // Direction is File→Function because that is a pair the CodeRelation
          // rel table declares (schema.ts); Function→File is NOT declared, so
          // the reverse edge would exercise schema validation, not escaping.
          // NOTE (pre-existing narrowing, distinct from the `''` escaping bug
          // and NOT fixed here): the fallback's row regex matches fields with
          // `[^"]*`, so an id containing a double quote never matches and its
          // edge is skipped — see the fallbackRelationshipInserts TSDoc.
          const rel: GraphRelationship = {
            id: 'rel-escaping-sweep-1',
            sourceId: fileId,
            targetId: fnId,
            type: 'CALLS',
            confidence: 1,
            reason: "it's quoted",
            step: 0,
          };
          await fallbackRelationshipInserts(
            [REL_CSV_HEADER, buildRelRow(rel)],
            new Set<string>(NODE_TABLES),
            getNodeLabel,
          );

          const edges = await executeQuery(
            `MATCH (a)-[r:${REL_TABLE_NAME}]->(b) ` +
              `WHERE r.reason = '${escapeCypherString("it's quoted")}' ` +
              `RETURN a.id AS fromId, b.id AS toId, r.type AS type, r.reason AS reason`,
          );
          expect(edges).toEqual([
            { fromId: fileId, toId: fnId, type: 'CALLS', reason: "it's quoted" },
          ]);
        });

        itLbugReopen(
          'batchInsertNodesToLbug: quoted values MERGE cleanly over its own connection',
          async () => {
            // batchInsertNodesToLbug opens its OWN connection on dbPath, which
            // cannot coexist with the singleton's exclusive file lock — close
            // the singleton around the call and reopen after. win32-skipped
            // for the same close→reopen native lock regression as the FTS
            // reopen probe above. Labels are File + Class (NOT Function): the
            // earlier tests in this suite put FTS indexes on Function, and a
            // write to an FTS-indexed table fails on a connection that has not
            // loaded the FTS extension (probed on 0.18.0) — an orthogonal
            // engine behavior this escaping test must not trip over. Class
            // exercises the same TABLES_WITH_EXPORTED + description branch.
            const adapter = await import('../../src/core/lbug/lbug-adapter.js');
            const { escapeCypherString } = await import('../../src/core/lbug/cypher-escape.js');

            const filePath = "src/ba'tch.ts";
            await adapter.closeLbug();
            let result: { inserted: number; failed: number };
            try {
              result = await adapter.batchInsertNodesToLbug(
                [
                  {
                    label: 'File',
                    properties: {
                      id: `File:${filePath}`,
                      name: "ba'tch.ts",
                      filePath,
                      content: "let q = 'x';",
                    },
                  },
                  {
                    label: 'Class',
                    properties: {
                      id: `Class:${filePath}:K:1`,
                      name: 'K',
                      filePath,
                      startLine: 1,
                      endLine: 2,
                      isExported: false,
                      content: '',
                      description: "batch'd",
                    },
                  },
                ],
                handle.dbPath,
              );
            } finally {
              await adapter.initLbug(handle.dbPath);
            }
            expect(result).toEqual({ inserted: 2, failed: 0 });

            const rows = await adapter.executeQuery(
              `MATCH (n:Class) WHERE n.filePath = '${escapeCypherString(filePath)}' ` +
                `RETURN n.name AS name, n.description AS description`,
            );
            expect(rows).toEqual([{ name: 'K', description: "batch'd" }]);
          },
        );

        it('backslash and raw-LF/CR values round-trip byte-identical', async () => {
          // The old escapeValue closures rewrote literal \n / \r into
          // two-character escape sequences; raw LF/CR are legal inside
          // LadybugDB single-quoted literals (live-probed on 0.18.0), so the
          // replaces are gone and content bytes must survive unchanged.
          const { insertNodeToLbug, executeQuery } =
            await import('../../src/core/lbug/lbug-adapter.js');
          const { escapeCypherString } = await import('../../src/core/lbug/cypher-escape.js');

          const id = 'File:src/bytes-probe.ts';
          const content = "line1\nC:\\temp\\it's ok\r\nline3";
          expect(
            await insertNodeToLbug('File', {
              id,
              name: 'bytes-probe.ts',
              filePath: 'src/bytes-probe.ts',
              content,
            }),
          ).toBe(true);

          const rows = await executeQuery(
            `MATCH (n:File) WHERE n.id = '${escapeCypherString(id)}' RETURN n.content AS content`,
          );
          expect(rows).toEqual([{ content }]);
        });
      });
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
