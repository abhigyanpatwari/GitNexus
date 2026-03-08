/**
 * P0 Integration Tests: Core KuzuDB Adapter
 *
 * Tests: loadGraphToKuzu CSV round-trip, createFTSIndex, getKuzuStats.
 *
 * IMPORTANT: All core adapter tests share ONE coreHandle and ONE coreInitKuzu
 * call because the core adapter is a module-level singleton. Calling
 * coreInitKuzu with a different path would close the previous native DB
 * handle, which segfaults in forked processes. Sharing a single handle
 * avoids this entirely.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { withTestKuzuDB } from '../helpers/test-indexed-db.js';

// ─── Core KuzuDB Adapter ─────────────────────────────────────────────

withTestKuzuDB('core-adapter', (handle) => {
  describe('core adapter', () => {
    it('loadGraphToKuzu: loads a minimal graph and node counts match', async () => {
      const { executeQuery: coreExecuteQuery } = await import('../../src/core/kuzu/kuzu-adapter.js');

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
      const { createFTSIndex } = await import('../../src/core/kuzu/kuzu-adapter.js');

      await expect(
        createFTSIndex('Function', 'function_fts', ['name', 'content']),
      ).resolves.toBeUndefined();
    });

    it('getKuzuStats: returns correct node and edge counts for seeded data', async () => {
      const { getKuzuStats } = await import('../../src/core/kuzu/kuzu-adapter.js');

      const stats = await getKuzuStats();

      // createMinimalTestGraph: 6 nodes (2 File, 2 Function, 1 Class, 1 Folder)
      expect(stats.nodes).toBe(6);

      // 4 relationships (2 CALLS, 2 CONTAINS)
      expect(stats.edges).toBe(4);
    });

    describe('unhappy path', () => {
      it('throws on malformed Cypher query', async () => {
        const { executeQuery } = await import('../../src/core/kuzu/kuzu-adapter.js');

        // Deliberately broken syntax: MATCH without a pattern clause
        await expect(executeQuery('MATCH RETURN 1')).rejects.toThrow();
      });

      it('returns empty results for query matching no nodes', async () => {
        const { executeQuery } = await import('../../src/core/kuzu/kuzu-adapter.js');

        // Valid Cypher, but the id will never exist in the seeded graph
        const rows = await executeQuery(
          "MATCH (n:Function) WHERE n.id = '__nonexistent_id__' RETURN n.id AS id",
        );
        expect(rows).toHaveLength(0);
      });

      it('handles query with non-existent table/node label', async () => {
        const { executeQuery } = await import('../../src/core/kuzu/kuzu-adapter.js');

        // KuzuDB throws when the node table does not exist in the schema
        await expect(
          executeQuery('MATCH (n:GhostTable) RETURN n'),
        ).rejects.toThrow();
      });
    });

    describe('error handling', () => {
      it('createFTSIndex handles already-existing index gracefully', async () => {
        const { createFTSIndex } = await import('../../src/core/kuzu/kuzu-adapter.js');

        // First call creates the index (may already exist from earlier test)
        await createFTSIndex('Function', 'function_fts_dup', ['name', 'content']);

        // Second call with same params should NOT throw — createFTSIndex catches "already exists"
        await expect(
          createFTSIndex('Function', 'function_fts_dup', ['name', 'content']),
        ).resolves.toBeUndefined();
      });

      it('getKuzuStats returns valid counts', async () => {
        const { getKuzuStats } = await import('../../src/core/kuzu/kuzu-adapter.js');

        // getKuzuStats NEVER throws — it has silent catch blocks per table
        const stats = await getKuzuStats();
        expect(typeof stats.nodes).toBe('number');
        expect(typeof stats.edges).toBe('number');
        expect(stats.nodes).toBeGreaterThanOrEqual(0);
        expect(stats.edges).toBeGreaterThanOrEqual(0);
      });

      it('executeQuery with empty string rejects', async () => {
        const { executeQuery } = await import('../../src/core/kuzu/kuzu-adapter.js');

        // KuzuDB throws on empty query string
        await expect(executeQuery('')).rejects.toThrow();
      });

      it('deleteNodesForFile with non-existent path returns zero deleted', async () => {
        const { deleteNodesForFile } = await import('../../src/core/kuzu/kuzu-adapter.js');

        // deleteNodesForFile has per-query try/catch, returns {deletedNodes: 0} for missing paths
        const result = await deleteNodesForFile('/absolutely/nonexistent/path/file.ts');
        expect(result).toEqual({ deletedNodes: 0 });
      });
    });
  });
}, {
  afterSetup: async (handle) => {
    // Load a minimal graph via CSV round-trip (core adapter is already initialized by wrapper)
    const { loadGraphToKuzu } = await import('../../src/core/kuzu/kuzu-adapter.js');
    const { createMinimalTestGraph } = await import('../helpers/test-graph.js');

    const graph = createMinimalTestGraph();
    const storagePath = path.join(handle.tmpHandle.dbPath, 'storage');
    await fs.mkdir(storagePath, { recursive: true });

    await loadGraphToKuzu(graph, '/test/repo', storagePath);
  },
});
