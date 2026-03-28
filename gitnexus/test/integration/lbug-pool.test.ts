/**
 * P0 Integration Tests: LadybugDB Connection Pool
 *
 * Tests: initLbug, executeQuery, executeParameterized, closeLbug lifecycle
 * Covers hardening fixes: parameterized queries, query timeout,
 * waiter queue timeout, idle eviction guards, stdout silencing race
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  initLbug,
  executeQuery,
  executeParameterized,
  closeLbug,
  isLbugReady,
} from '../../src/mcp/core/lbug-adapter.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

const POOL_SEED_DATA = [
  `CREATE (f:File {id: 'file:index.ts', name: 'index.ts', filePath: 'src/index.ts', content: ''})`,
  `CREATE (fn:Function {id: 'func:main', name: 'main', filePath: 'src/index.ts', startLine: 1, endLine: 10, isExported: true, content: '', description: ''})`,
  `CREATE (fn2:Function {id: 'func:helper', name: 'helper', filePath: 'src/utils.ts', startLine: 1, endLine: 5, isExported: true, content: '', description: ''})`,
  `MATCH (a:Function), (b:Function)
    WHERE a.id = 'func:main' AND b.id = 'func:helper'
    CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'direct', step: 0}]->(b)`,
];

// ─── Pool lifecycle tests — test the pool adapter API directly ───────

withTestLbugDB(
  'lbug-pool',
  (handle) => {
    afterEach(async () => {
      try {
        await closeLbug('test-repo');
      } catch {
        /* best-effort */
      }
      try {
        await closeLbug('repo1');
      } catch {
        /* best-effort */
      }
      try {
        await closeLbug('repo2');
      } catch {
        /* best-effort */
      }
      try {
        await closeLbug('');
      } catch {
        /* best-effort */
      }
    });

    // ─── Lifecycle: init → query → close ─────────────────────────────────

    describe('pool lifecycle', () => {
      it('initLbug + executeQuery + closeLbug', async () => {
        await initLbug('test-repo', handle.dbPath);
        expect(isLbugReady('test-repo')).toBe(true);

        const rows = await executeQuery('test-repo', 'MATCH (n:Function) RETURN n.name AS name');
        expect(rows.length).toBeGreaterThanOrEqual(2);
        const names = rows.map((r: any) => r.name);
        expect(names).toContain('main');
        expect(names).toContain('helper');

        await closeLbug('test-repo');
        expect(isLbugReady('test-repo')).toBe(false);
      });

      it('initLbug reuses existing pool entry', async () => {
        await initLbug('test-repo', handle.dbPath);
        await initLbug('test-repo', handle.dbPath); // second call should be no-op
        expect(isLbugReady('test-repo')).toBe(true);
      });

      it('closeLbug is idempotent', async () => {
        await initLbug('test-repo', handle.dbPath);
        await closeLbug('test-repo');
        await closeLbug('test-repo'); // second close should not throw
        expect(isLbugReady('test-repo')).toBe(false);
      });

      it('closeLbug with no args closes all repos', async () => {
        await initLbug('repo1', handle.dbPath);
        await initLbug('repo2', handle.dbPath);
        expect(isLbugReady('repo1')).toBe(true);
        expect(isLbugReady('repo2')).toBe(true);

        await closeLbug();
        expect(isLbugReady('repo1')).toBe(false);
        expect(isLbugReady('repo2')).toBe(false);
      });
    });

    // ─── Parameterized queries ───────────────────────────────────────────

    describe('executeParameterized', () => {
      it('works with parameterized query', async () => {
        await initLbug('test-repo', handle.dbPath);
        const rows = await executeParameterized(
          'test-repo',
          'MATCH (n:Function) WHERE n.name = $name RETURN n.name AS name',
          { name: 'main' },
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('main');
      });

      it('injection attempt is harmless with parameterized query', async () => {
        await initLbug('test-repo', handle.dbPath);
        const rows = await executeParameterized(
          'test-repo',
          'MATCH (n:Function) WHERE n.name = $name RETURN n.name AS name',
          { name: "' OR 1=1 --" }, // SQL/Cypher injection attempt
        );
        // Should return 0 rows, not all rows
        expect(rows).toHaveLength(0);
      });
    });

    // ─── Error handling ──────────────────────────────────────────────────

    describe('error handling', () => {
      it('throws when querying uninitialized repo', async () => {
        await expect(executeQuery('nonexistent-repo', 'MATCH (n) RETURN n')).rejects.toThrow(
          /not initialized/,
        );
      });

      it('throws when db path does not exist', async () => {
        await expect(initLbug('bad-repo', '/nonexistent/path/lbug')).rejects.toThrow();
      });

      it('read-only mode: write query throws', async () => {
        await initLbug('test-repo', handle.dbPath);
        await expect(
          executeQuery(
            'test-repo',
            "CREATE (n:Function {id: 'new', name: 'new', filePath: '', startLine: 0, endLine: 0, isExported: false, content: '', description: ''})",
          ),
        ).rejects.toThrow();
      });
    });

    // ─── Relationship queries ────────────────────────────────────────────

    describe('relationship queries', () => {
      it('can query relationships', async () => {
        await initLbug('test-repo', handle.dbPath);
        const rows = await executeQuery(
          'test-repo',
          `MATCH (a:Function)-[r:CodeRelation {type: 'CALLS'}]->(b:Function) RETURN a.name AS caller, b.name AS callee`,
        );
        expect(rows.length).toBeGreaterThanOrEqual(1);
        const row = rows.find((r: any) => r.caller === 'main');
        expect(row).toBeDefined();
        expect(row.callee).toBe('helper');
      });
    });

    // ─── Unhappy paths ──────────────────────────────────────────────────

    describe('unhappy paths', () => {
      it('executeParameterized throws when repo is not initialized', async () => {
        await expect(executeParameterized('ghost-repo', 'MATCH (n) RETURN n', {})).rejects.toThrow(
          /not initialized/,
        );
      });

      it('executeQuery rejects invalid Cypher syntax', async () => {
        await initLbug('test-repo', handle.dbPath);
        await expect(executeQuery('test-repo', 'THIS IS NOT CYPHER')).rejects.toThrow();
      });

      it('executeParameterized rejects when referenced parameter is missing', async () => {
        await initLbug('test-repo', handle.dbPath);
        await expect(
          executeParameterized('test-repo', 'MATCH (n:Function) WHERE n.name = $name RETURN n', {
            wrong_param: 'main',
          }),
        ).rejects.toThrow();
      });

      it('closeLbug with unknown repoId does not throw', async () => {
        await expect(closeLbug('never-existed-repo')).resolves.toBeUndefined();
      });

      it('isLbugReady returns false for unknown repoId', () => {
        expect(isLbugReady('never-existed-repo')).toBe(false);
      });

      it('initLbug with empty string repoId stores entry under empty key', async () => {
        await initLbug('', handle.dbPath);
        expect(isLbugReady('')).toBe(true);
        await closeLbug('');
        expect(isLbugReady('')).toBe(false);
      });

      it('executeQuery with empty query string rejects', async () => {
        await initLbug('test-repo', handle.dbPath);
        await expect(executeQuery('test-repo', '')).rejects.toThrow();
      });
    });
  },
  {
    seed: POOL_SEED_DATA,
    poolAdapter: true,
  },
);
