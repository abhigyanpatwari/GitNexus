/**
 * P0 Integration Tests: Local Backend — callTool dispatch
 *
 * Tests the full LocalBackend.callTool() dispatch with a real LadybugDB
 * instance, verifying cypher, context, impact, and query tools work
 * end-to-end against seeded graph data with FTS indexes.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { LOCAL_BACKEND_SEED_DATA, LOCAL_BACKEND_FTS_INDEXES } from '../fixtures/local-backend-seed.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

// ─── Block 2: callTool dispatch tests ────────────────────────────────

withTestLbugDB('local-backend-calltool', (handle) => {

  describe('callTool dispatch with real DB', () => {
    let backend: LocalBackend;

    beforeAll(async () => {
      // backend is created in afterSetup and attached to the handle
      const ext = handle as typeof handle & { _backend?: LocalBackend };
      if (!ext._backend) {
        throw new Error('LocalBackend not initialized — afterSetup did not attach _backend to handle');
      }
      backend = ext._backend;
    });

    it('cypher tool returns function names', async () => {
      const result = await backend.callTool('cypher', {
        query: 'MATCH (n:Function) RETURN n.name AS name ORDER BY n.name',
      });
      // cypher tool wraps results as markdown
      expect(result).toHaveProperty('markdown');
      expect(result).toHaveProperty('row_count');
      expect(result.row_count).toBeGreaterThanOrEqual(3);
      expect(result.markdown).toContain('login');
      expect(result.markdown).toContain('validate');
      expect(result.markdown).toContain('hash');
    });

    it('cypher tool blocks write queries', async () => {
      const result = await backend.callTool('cypher', {
        query: "CREATE (n:Function {id: 'x', name: 'x', filePath: '', startLine: 0, endLine: 0, isExported: false, content: '', description: ''})",
      });
      expect(result).toHaveProperty('error');
      expect(result.error).toMatch(/write operations/i);
    });

    it('context tool returns symbol info with callers and callees', async () => {
      const result = await backend.callTool('context', { name: 'login' });
      expect(result).not.toHaveProperty('error');
      expect(result.status).toBe('found');
      // Should have the symbol identity
      expect(result.symbol).toBeDefined();
      expect(result.symbol.name).toBe('login');
      expect(result.symbol.filePath).toBe('src/auth.ts');
      // login calls validate and hash — should appear in outgoing.calls
      expect(result.outgoing).toBeDefined();
      expect(result.outgoing.calls).toBeDefined();
      expect(result.outgoing.calls.length).toBeGreaterThanOrEqual(2);
      const calleeNames = result.outgoing.calls.map((c: any) => c.name);
      expect(calleeNames).toContain('validate');
      expect(calleeNames).toContain('hash');
    });

    it('impact tool returns upstream dependents', async () => {
      const result = await backend.callTool('impact', {
        target: 'validate',
        direction: 'upstream',
      });
      expect(result).not.toHaveProperty('error');
      // validate is called by login, so login should appear at depth 1
      expect(result.impactedCount).toBeGreaterThanOrEqual(1);
      expect(result.byDepth).toBeDefined();
      const directDeps = result.byDepth[1] || result.byDepth['1'] || [];
      expect(directDeps.length).toBeGreaterThanOrEqual(1);
      const depNames = directDeps.map((d: any) => d.name);
      expect(depNames).toContain('login');
    });

    it('query tool returns results for keyword search', async () => {
      const result = await backend.callTool('query', { query: 'login' });
      expect(result).not.toHaveProperty('error');
      // Should have some combination of processes, process_symbols, or definitions
      expect(result).toHaveProperty('processes');
      expect(result).toHaveProperty('definitions');
      // The search should find something (FTS or graph-based)
      const totalResults =
        (result.processes?.length || 0) +
        (result.process_symbols?.length || 0) +
        (result.definitions?.length || 0);
      expect(totalResults).toBeGreaterThanOrEqual(1);
    });

    it('unknown tool throws', async () => {
      await expect(
        backend.callTool('nonexistent_tool', {}),
      ).rejects.toThrow(/unknown tool/i);
    });
  });

  describe('tool parameter edge cases', () => {
    let backend: LocalBackend;

    beforeAll(async () => {
      const ext = handle as typeof handle & { _backend?: LocalBackend };
      if (!ext._backend) {
        throw new Error('LocalBackend not initialized — afterSetup did not attach _backend to handle');
      }
      backend = ext._backend;
    });

    it('context tool returns error for nonexistent symbol', async () => {
      const result = await backend.callTool('context', { name: 'nonexistent_xyz_symbol_999' });
      expect(result).toHaveProperty('error');
      expect(result.error).toMatch(/not found/i);
    });

    it('query tool returns error for empty query', async () => {
      const result = await backend.callTool('query', { query: '' });
      expect(result).toHaveProperty('error');
      expect(result.error).toMatch(/required/i);
    });

    it('query tool returns error for missing query param', async () => {
      const result = await backend.callTool('query', {});
      expect(result).toHaveProperty('error');
    });

    it('cypher tool returns error for invalid Cypher syntax', async () => {
      const result = await backend.callTool('cypher', { query: 'THIS IS NOT VALID CYPHER AT ALL' });
      expect(result).toHaveProperty('error');
    });

    it('context tool returns error when no name or uid provided', async () => {
      const result = await backend.callTool('context', {});
      expect(result).toHaveProperty('error');
      expect(result.error).toMatch(/required/i);
    });
  });

}, {
  seed: LOCAL_BACKEND_SEED_DATA,
  ftsIndexes: LOCAL_BACKEND_FTS_INDEXES,
  poolAdapter: true,
  afterSetup: async (handle) => {
    // Configure listRegisteredRepos mock with handle values
    vi.mocked(listRegisteredRepos).mockResolvedValue([
      {
        name: 'test-repo',
        path: '/test/repo',
        storagePath: handle.tmpHandle.dbPath,
        indexedAt: new Date().toISOString(),
        lastCommit: 'abc123',
        stats: { files: 2, nodes: 3, communities: 1, processes: 1 },
      },
    ]);

    const backend = new LocalBackend();
    await backend.init();
    // Stash backend on handle so tests can access it
    (handle as any)._backend = backend;
  },
});
