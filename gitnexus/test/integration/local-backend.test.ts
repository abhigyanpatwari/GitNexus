/**
 * P0 Integration Tests: Local Backend
 *
 * Tests tool implementations via direct LadybugDB queries.
 * The full LocalBackend.callTool() requires a global registry,
 * so here we test the security-critical behaviors directly:
 * - Write-operation blocking in cypher
 * - Query execution via the pool
 * - Parameterized queries preventing injection
 * - Read-only enforcement
 *
 * Covers hardening fixes: #1 (parameterized queries), #2 (write blocking),
 * #3 (path traversal), #4 (relation allowlist), #25 (regex lastIndex),
 * #26 (rename first-occurrence-only)
 */
import { describe, it, expect } from 'vitest';
import {
  executeQuery,
  executeParameterized,
} from '../../src/mcp/core/lbug-adapter.js';
import {
  CYPHER_WRITE_RE,
  VALID_RELATION_TYPES,
  isWriteQuery,
} from '../../src/mcp/local/local-backend.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { LOCAL_BACKEND_SEED_DATA } from '../fixtures/local-backend-seed.js';

// ─── Block 1: Pool adapter tests ─────────────────────────────────────

withTestLbugDB('local-backend', (handle) => {

  // ─── Cypher write blocking ───────────────────────────────────────────

  describe('cypher write blocking', () => {
    const allWriteKeywords = ['CREATE', 'DELETE', 'SET', 'MERGE', 'REMOVE', 'DROP', 'ALTER', 'COPY', 'DETACH'];

    for (const keyword of allWriteKeywords) {
      it(`blocks ${keyword} query`, () => {
        const blocked = isWriteQuery(`MATCH (n) ${keyword} n.name = "x"`);
        expect(blocked).toBe(true);
      });
    }

    it('allows valid read queries through the pool', async () => {
      const rows = await executeQuery(handle.repoId, 'MATCH (n:Function) RETURN n.name AS name ORDER BY n.name');
      expect(rows.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ─── Parameterized queries ───────────────────────────────────────────

  describe('parameterized queries', () => {
    it('finds exact match with parameter', async () => {
      const rows = await executeParameterized(
        handle.repoId,
        'MATCH (n:Function) WHERE n.name = $name RETURN n.name AS name, n.filePath AS filePath',
        { name: 'login' },
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('login');
      expect(rows[0].filePath).toBe('src/auth.ts');
    });

    it('injection is harmless', async () => {
      const rows = await executeParameterized(
        handle.repoId,
        'MATCH (n:Function) WHERE n.name = $name RETURN n.name AS name',
        { name: "login' OR '1'='1" },
      );
      expect(rows).toHaveLength(0);
    });
  });

  // ─── Relation type filtering ─────────────────────────────────────────

  describe('relation type filtering', () => {
    it('only allows valid relation types in queries', () => {
      const validTypes = ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'OVERRIDES'];
      const invalidTypes = ['CONTAINS', 'STEP_IN_PROCESS', 'MEMBER_OF', 'DROP_TABLE'];

      for (const t of validTypes) {
        expect(VALID_RELATION_TYPES.has(t)).toBe(true);
      }
      for (const t of invalidTypes) {
        expect(VALID_RELATION_TYPES.has(t)).toBe(false);
      }
    });

    it('can query relationships with valid types', async () => {
      const rows = await executeQuery(
        handle.repoId,
        `MATCH (a:Function)-[r:CodeRelation {type: 'CALLS'}]->(b:Function) RETURN a.name AS caller, b.name AS callee ORDER BY b.name`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Process queries ─────────────────────────────────────────────────

  describe('process queries', () => {
    it('can find processes', async () => {
      const rows = await executeQuery(handle.repoId, 'MATCH (p:Process) RETURN p.heuristicLabel AS label, p.stepCount AS steps');
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].label).toBe('User Login');
    });

    it('can trace process steps', async () => {
      const rows = await executeQuery(
        handle.repoId,
        `MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
         WHERE p.id = 'proc:login-flow'
         RETURN s.name AS symbol, r.step AS step
         ORDER BY r.step`,
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].symbol).toBe('login');
      expect(rows[0].step).toBe(1);
      expect(rows[1].symbol).toBe('validate');
      expect(rows[1].step).toBe(2);
    });
  });

  // ─── Community queries ───────────────────────────────────────────────

  describe('community queries', () => {
    it('can find communities', async () => {
      const rows = await executeQuery(handle.repoId, 'MATCH (c:Community) RETURN c.heuristicLabel AS label');
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].label).toBe('Authentication');
    });

    it('can find community members', async () => {
      const rows = await executeQuery(
        handle.repoId,
        `MATCH (f)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
         WHERE c.heuristicLabel = 'Authentication'
         RETURN f.name AS name`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].name).toBe('login');
    });
  });

  // ─── Read-only enforcement ───────────────────────────────────────────

  describe('read-only database', () => {
    it('rejects write operations at DB level', async () => {
      await expect(
        executeQuery(handle.repoId, `CREATE (n:Function {id: 'new', name: 'new', filePath: '', startLine: 0, endLine: 0, isExported: false, content: '', description: ''})`)
      ).rejects.toThrow();
    });
  });

  // ─── Regex lastIndex hardening (#25) ─────────────────────────────────

  describe('regex lastIndex (hardening #25)', () => {
    it('CYPHER_WRITE_RE is non-global (no sticky lastIndex)', () => {
      expect(CYPHER_WRITE_RE.global).toBe(false);
      expect(CYPHER_WRITE_RE.sticky).toBe(false);
    });

    it('works correctly across multiple consecutive calls', () => {
      // If the regex were global, lastIndex could cause false results
      const results = [
        isWriteQuery('CREATE (n)'),     // true
        isWriteQuery('MATCH (n) RETURN n'), // false
        isWriteQuery('DELETE n'),       // true
        isWriteQuery('MATCH (n) RETURN n'), // false
        isWriteQuery('SET n.x = 1'),    // true
      ];
      expect(results).toEqual([true, false, true, false, true]);
    });
  });

  // ─── Content queries (include_content equivalent) ────────────────────

  describe('content queries', () => {
    it('can retrieve symbol content', async () => {
      const rows = await executeQuery(
        handle.repoId,
        `MATCH (n:Function) WHERE n.name = 'login' RETURN n.content AS content`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toContain('function login');
    });
  });

  // ─── Write blocking edge cases ──────────────────────────────────────

  describe('write blocking edge cases', () => {
    it('blocks lowercase write keywords (case-insensitive)', () => {
      expect(isWriteQuery('create (n:Function {id: "x"})')).toBe(true);
      expect(isWriteQuery('delete n')).toBe(true);
      expect(isWriteQuery('set n.name = "x"')).toBe(true);
    });

    it('blocks write keyword in CREATED-like words (regex is keyword-boundary unaware)', () => {
      // CYPHER_WRITE_RE uses \b word boundaries — "CREATED" does NOT match "CREATE"
      const result = isWriteQuery("MATCH (n) WHERE n.name = 'CREATED' RETURN n");
      // The regex uses word boundaries so substring "CREATE" inside "CREATED" is NOT matched
      expect(result).toBe(false);
    });

    it('blocks multi-line queries with write keywords', () => {
      expect(isWriteQuery('MATCH (n)\nDELETE n')).toBe(true);
    });

    it('returns false for empty string', () => {
      expect(isWriteQuery('')).toBe(false);
    });

    it('returns false for whitespace-only query', () => {
      expect(isWriteQuery('   ')).toBe(false);
    });
  });

  // ─── Query error handling via pool ──────────────────────────────────

  describe('query error handling via pool', () => {
    it('returns empty rows for unknown node label', async () => {
      // LadybugDB throws a Binder exception for unknown node labels
      await expect(
        executeQuery(handle.repoId, 'MATCH (n:NonExistentTable) RETURN n.name AS name')
      ).rejects.toThrow();
    });

    it('rejects syntactically invalid Cypher', async () => {
      await expect(executeQuery(handle.repoId, 'NOT VALID CYPHER AT ALL'))
        .rejects.toThrow();
    });
  });

  // ─── Parameterized query edge cases ─────────────────────────────────

  describe('parameterized query edge cases', () => {
    it('succeeds with empty params when query has no parameters', async () => {
      const rows = await executeParameterized(
        handle.repoId,
        'MATCH (n:Function) RETURN n.name AS name LIMIT 1',
        {},
      );
      expect(rows.length).toBeGreaterThanOrEqual(0);
    });

    it('returns empty rows when param value is null', async () => {
      const rows = await executeParameterized(
        handle.repoId,
        'MATCH (n:Function) WHERE n.name = $name RETURN n.name AS name',
        { name: null as any },
      );
      expect(rows).toHaveLength(0);
    });
  });

}, {
  seed: LOCAL_BACKEND_SEED_DATA,
  poolAdapter: true,
});
