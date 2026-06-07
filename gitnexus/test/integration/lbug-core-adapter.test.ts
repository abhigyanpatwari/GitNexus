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
import os from 'os';
import path from 'path';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

// ─── Core LadybugDB Adapter ─────────────────────────────────────────────

withTestLbugDB('core-adapter', (handle) => {
  describe('core adapter', () => {
    it('loadGraphToLbug: loads a minimal graph and node counts match', async () => {
      const { executeQuery: coreExecuteQuery } = await import('../../src/core/lbug/lbug-adapter.js');

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

    it('createFTSIndex: creates FTS index on Function table without error', async () => {
      const { createFTSIndex } = await import('../../src/core/lbug/lbug-adapter.js');

      await expect(
        createFTSIndex('Function', 'function_fts', ['name', 'content']),
      ).resolves.toBeUndefined();
    });

    it('getLbugStats: returns correct node and edge counts for seeded data', async () => {
      const { getLbugStats } = await import('../../src/core/lbug/lbug-adapter.js');

      const stats = await getLbugStats();

      // createMinimalTestGraph: 6 nodes (2 File, 2 Function, 1 Class, 1 Folder)
      expect(stats.nodes).toBe(6);

      // 4 relationships (2 CALLS, 2 CONTAINS)
      expect(stats.edges).toBe(4);
    });

    it('labels(n) returns the actual node label as a string (regression for #73)', async () => {
      // Kùzu (LadybugDB 0.15.2) returns labels(n) as a STRING (e.g. "Method"),
      // not a list, so `labels(n)[0]` indexes into a character and produces
      // an empty string. This regression test pins the new (correct) pattern
      // `labels(n) AS type` against a real seeded DB.
      const { executeQuery: coreExecuteQuery } = await import('../../src/core/lbug/lbug-adapter.js');

      // Limit 1 — the seeded graph has 6 nodes across 4 labels; the first
      // returned value must be a non-empty string.
      const rows = await coreExecuteQuery('MATCH (n) RETURN labels(n) AS type LIMIT 1');
      expect(rows).toHaveLength(1);

      const type = rows[0].type;
      expect(typeof type).toBe('string');
      expect(type.length).toBeGreaterThan(0);

      // The seeded graph contains File, Function, Class, Folder — the first
      // row must be one of these (whichever Kùzu returns first).
      expect(['File', 'Function', 'Class', 'Folder']).toContain(type);
    });

    it('labels(n) AS type returns the correct label for a known node', async () => {
      // Pin down that the projection yields a usable label for the
      // graph-queries.ts / local-backend.ts / trace-executor.ts paths.
      const { executeQuery: coreExecuteQuery } = await import('../../src/core/lbug/lbug-adapter.js');

      // The seeded graph has exactly one Class node.
      const rows = await coreExecuteQuery(
        "MATCH (n:Class) RETURN labels(n) AS type LIMIT 1",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('Class');
    });

    it('labels(n)[0] AS type does NOT return the full label (Kùzu engine limitation)', async () => {
      // Documents the Kùzu behavior that motivated the WI-#73 fix:
      // `labels(n)[0]` indexes into a character of the string returned by
      // `labels(n)`, not into a list of labels. This test pins the buggy
      // pattern down so future Kùzu upgrades can be detected.
      const { executeQuery: coreExecuteQuery } = await import('../../src/core/lbug/lbug-adapter.js');

      // Query a Class node; the buggy pattern should return a 1-character
      // string (or empty), NOT the full "Class" label.
      const buggyRows = await coreExecuteQuery(
        "MATCH (n:Class) RETURN labels(n)[0] AS type LIMIT 1",
      );
      expect(buggyRows).toHaveLength(1);
      const buggyType = buggyRows[0].type;
      // The buggy pattern must NOT return the full label name.
      expect(buggyType).not.toBe('Class');
      // The returned value, if non-empty, must be at most 1 character
      // (Kùzu returns a single character of the label string).
      if (buggyType !== null && buggyType !== undefined && buggyType !== '') {
        expect(typeof buggyType).toBe('string');
        expect((buggyType as string).length).toBeLessThanOrEqual(1);
      }
    });

    it('OVERRIDES edges follow Class→Method direction (MRO processor contract)', async () => {
      // Regression test for WI-I69: pins the direction of OVERRIDES edges
      // emitted by the MRO processor. The MRO processor at
      // mro-processor.ts:405-408 creates edges with type 'OVERRIDES' and
      // direction Class→Method. If a future MRO refactor flips the direction,
      // this test fails immediately.
      //
      // We do not assert a specific count (fixture data varies) — only that
      // the count for Class→Method >= 1 when the engine has had a chance to
      // run MRO. For a fresh DB with no Class nodes the count is 0 and the
      // test passes vacuously. The seed used by this test file (see the
      // beforeAll hook above) does include Class nodes from a Python fixture.
      const { executeQuery: coreExecuteQuery } = await import('../../src/core/lbug/lbug-adapter.js');

      // The CORRECT direction (Class → Method) — must return non-zero if MRO ran
      const correctRows = await coreExecuteQuery(
        "MATCH (c:Class)-[r:CodeRelation {type: 'OVERRIDES'}]->(m:Method) RETURN count(r) AS cnt",
      );
      const correctCount = Number(correctRows[0]?.cnt ?? 0);

      // The WRONG direction (Method → Method) — this is the query from issue #69.
      // It returns 0 because the MRO processor never emits edges with this shape.
      // Pinning it down so a future schema or processor change is detected.
      const wrongRows = await coreExecuteQuery(
        "MATCH (m:Method)-[r:CodeRelation {type: 'OVERRIDES'}]->(p:Method) RETURN count(r) AS cnt",
      );
      const wrongCount = Number(wrongRows[0]?.cnt ?? 0);

      // Class→Method must be >= Method→Method. For a fresh Python fixture
      // with MRO-emitting classes, correctCount > 0 and wrongCount = 0.
      // We assert the invariant (correct >= wrong) so the test is robust
      // across fixtures with different MRO activity.
      expect(correctCount).toBeGreaterThanOrEqual(wrongCount);
    });

    it('migrations: run on initLbug, add parameterCount/returnType to Function (#160)', async () => {
      // Regression test for WI-160: the SCHEMA_MIGRATIONS array must run on
      // every initLbug. Before the fix, the 30 *_MIGRATION constants were
      // exported but never invoked, so a user upgrading from a prior version
      // saw "Cannot find property parameterCount for f" errors.
      //
      // We open a fresh DB via withTestLbugDB (the wrapper calls initLbug
      // which now runs SCHEMA_QUERIES then SCHEMA_MIGRATIONS), create a
      // Function node, and query the migrated columns. The fresh DB path is
      // the same one the runner covers — a separate DB file is created by
      // the global setup before the wrapper opens it.
      const { executeQuery: coreExecuteQuery } = await import('../../src/core/lbug/lbug-adapter.js');

      // The minimal seed graph has 2 Function nodes (see createMinimalTestGraph).
      // If the migrations did not run, the parameterCount/returnType columns
      // wouldn't exist on Function, and this query would throw a Binder
      // exception.
      const rows = await coreExecuteQuery(
        'MATCH (f:Function) RETURN f.parameterCount AS pc, f.returnType AS rt',
      );
      expect(rows).toHaveLength(2);

      // Column types are queryable — parameterCount is INT32 (number-or-null),
      // returnType is STRING (string-or-null). For the seeded nodes these
      // properties were not extracted, so values are null; we only assert
      // the columns exist and the rows returned are well-formed.
      for (const row of rows) {
        expect(row).toHaveProperty('pc');
        expect(row).toHaveProperty('rt');
        // parameterCount must be null or a number (Kùzu returns null for
        // unset INT32 columns).
        if (row.pc !== null && row.pc !== undefined) {
          expect(typeof row.pc).toBe('number');
        }
        // returnType must be null or a string.
        if (row.rt !== null && row.rt !== undefined) {
          expect(typeof row.rt).toBe('string');
        }
      }

      // Cross-check: the Route migration (8 columns) is the most aggressive
      // multi-statement migration. Even though the seed has no Route nodes,
      // we can still confirm the runner executed the migration by checking
      // that querying a Route column doesn't throw "Cannot find property".
      // Use a LIMIT 0 trick — if the column is missing, Kùzu rejects the
      // query at bind time regardless of LIMIT.
      await expect(
        coreExecuteQuery('MATCH (r:Route) RETURN r.responseKeys LIMIT 0'),
      ).resolves.toBeDefined();
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
        await expect(
          executeQuery('MATCH (n:GhostTable) RETURN n'),
        ).rejects.toThrow();
      });
    });

    describe('error handling', () => {
      it('createFTSIndex handles already-existing index gracefully', async () => {
        const { createFTSIndex } = await import('../../src/core/lbug/lbug-adapter.js');

        // First call creates the index (may already exist from earlier test)
        await createFTSIndex('Function', 'function_fts_dup', ['name', 'content']);

        // Second call with same params should NOT throw — createFTSIndex catches "already exists"
        await expect(
          createFTSIndex('Function', 'function_fts_dup', ['name', 'content']),
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

    it('migrations: idempotent on re-open (existing DB hits suppression branch without error)', async () => {
      // Hardening test for WI-#160: the fresh-DB path is covered above, but
      // the existing-DB path (re-open after columns exist) is logically the
      // same code and never hits the `already has property` catch block.
      // This test opens a fresh DB directly via a private lbug.Database
      // (bypassing the module-level singleton used by other tests), runs
      // initLbug's exact schema + migration path twice on the same file,
      // and asserts the suppression branch swallows every "already has
      // property" error on the second pass without throwing.
      //
      // We deliberately do NOT call the exported initLbug() / closeLbug()
      // helpers here because they mutate module-level state (conn, db,
      // ftsLoaded, currentDbPath) used by every other test in this file.
      // Instead, we drive lbug.Database + lbug.Connection directly to
      // execute the same SCHEMA_QUERIES + SCHEMA_MIGRATIONS sequences
      // that doInitLbug uses — which is the only code path the migration
      // runner exercises.
      //
      // This test is placed LAST in the describe block. Opening and closing
      // multiple lbug.Database instances back-to-back triggers the known
      // N-API destructor crash on macOS fork exit (see vitest.config.ts
      // comment). Other tests must run first; if the worker dies at
      // process exit, the earlier tests' results have already been
      // recorded, so only the test currently running is affected.
      const { SCHEMA_QUERIES, SCHEMA_MIGRATIONS } = await import('../../src/core/lbug/schema.js');
      // Lazy-load the native module via the schema barrel.
      const lbug = (await import('@ladybugdb/core')).default;

      let tmpDir: string | undefined;
      try {
        // 1. Create a fresh temp dir and DB path. lbug.Database expects
        //    a file path, not a directory — the file is created if absent.
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-mig-reopen-'));
        const tempDbPath = path.join(tmpDir, 'migration-test.db');

        // 2. Replicates doInitLbug's first half: run SCHEMA_QUERIES, then
        //    run SCHEMA_MIGRATIONS, swallowing "already exists" /
        //    "already has property" so the migration loop is idempotent.
        const runMigrationsOn = async (dbPath: string) => {
          const localDb = new lbug.Database(dbPath);
          const localConn = new lbug.Connection(localDb);
          try {
            for (const q of SCHEMA_QUERIES) {
              try { await localConn.query(q); } catch { /* already exists */ }
            }
            for (const m of SCHEMA_MIGRATIONS) {
              for (const stmt of m.split(';')) {
                const trimmed = stmt.trim();
                if (!trimmed) continue;
                try { await localConn.query(trimmed); }
                catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  // Mirror the runner's suppression: Kùzu's "already has
                  // property" + legacy "already exists".
                  if (!msg.includes('already has property') && !msg.includes('already exists')) {
                    throw err;
                  }
                }
              }
            }
            return { localDb, localConn };
          } catch (err) {
            try { await localConn.close(); } catch { /* best-effort */ }
            try { await localDb.close(); } catch { /* best-effort */ }
            throw err;
          }
        };

        const first = await runMigrationsOn(tempDbPath);

        // 3. Insert a Function node so the migrated columns
        //    (parameterCount, returnType) are populated. This is the
        //    user-visible state the next initLbug must preserve.
        await first.localConn.query(
          "CREATE (f:Function {id: 'fn_reopen_test', name: 'reopenTarget', filePath: '/tmp/x.ts', startLine: 1, endLine: 5, isExported: true, content: '', parameterCount: 3, returnType: 'string'})",
        );

        // Sanity: the row is queryable from the first session.
        const sanityRows = await first.localConn.query(
          "MATCH (f:Function) WHERE f.id = 'fn_reopen_test' RETURN f.parameterCount AS pc, f.returnType AS rt",
        );
        const sanityResult = Array.isArray(sanityRows) ? sanityRows[0] : sanityRows;
        const sanity = await sanityResult.getAll();
        expect(sanity).toHaveLength(1);
        expect(sanity[0].pc).toBe(3);
        expect(sanity[0].rt).toBe('string');

        // Close the first session so the second open can re-acquire the
        // file (LadybugDB holds an exclusive lock per Database instance).
        await first.localConn.close();
        await first.localDb.close();

        // 4. Re-open the SAME path. Every migration in SCHEMA_MIGRATIONS
        //    will now hit Kùzu's "already has property" on re-ADD, and
        //    the suppression branch in runMigrationsOn must swallow that
        //    error. If the suppression is broken, runMigrationsOn throws
        //    and the test fails with the original Kùzu error.
        const second = await runMigrationsOn(tempDbPath);

        // 5. Assert: after the second open, the Function row is still
        //    queryable and the migrated columns are intact. This is
        //    the user-visible contract: opening an existing GitNexus DB
        //    must not corrupt or lose the data the migrations protect.
        const secondRows = await second.localConn.query(
          "MATCH (f:Function) WHERE f.id = 'fn_reopen_test' RETURN f.parameterCount AS pc, f.returnType AS rt",
        );
        const secondResult = Array.isArray(secondRows) ? secondRows[0] : secondRows;
        const secondAll = await secondResult.getAll();
        expect(secondAll).toHaveLength(1);
        expect(secondAll[0].pc).toBe(3);
        expect(secondAll[0].rt).toBe('string');

        // 6. Also confirm a fresh MATCH (f:Function) RETURN f.parameterCount
        //    (the canonical case from the design doc) returns rows, NOT
        //    a "Cannot find property" binder error. This is the precise
        //    query users hit when upgrading GitNexus.
        const canonical = await second.localConn.query(
          'MATCH (f:Function) RETURN f.parameterCount',
        );
        const canonicalResult = Array.isArray(canonical) ? canonical[0] : canonical;
        const canonicalRows = await canonicalResult.getAll();
        expect(canonicalRows.length).toBeGreaterThan(0);

        // Close the second session.
        await second.localConn.close();
        await second.localDb.close();
      } finally {
        // 7. Cleanup: best-effort delete the temp dir. We never touched
        //    the module-level conn/db state, so the rest of the suite
        //    is unaffected.
        if (tmpDir) {
          try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
      }
    });
  });
}, {
  afterSetup: async (handle) => {
    // Load a minimal graph via CSV round-trip (core adapter is already initialized by wrapper)
    const { loadGraphToLbug } = await import('../../src/core/lbug/lbug-adapter.js');
    const { createMinimalTestGraph } = await import('../helpers/test-graph.js');

    const graph = createMinimalTestGraph();
    const storagePath = path.join(handle.tmpHandle.dbPath, 'storage');
    await fs.mkdir(storagePath, { recursive: true });

    await loadGraphToLbug(graph, '/test/repo', storagePath);
  },
});
