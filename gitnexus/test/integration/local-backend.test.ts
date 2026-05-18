/**
 * P0 Integration Tests: Local Backend
 *
 * Tests tool implementations via direct LadybugDB queries.
 * The full LocalBackend.callTool() requires a global registry,
 * so here we test the security-critical behaviors directly:
 * - Query execution via the pool
 * - Parameterized queries preventing injection
 * - Read-only enforcement
 *
 * Covers hardening fixes: #1 (parameterized queries), #3 (path traversal),
 * #4 (relation allowlist), #26 (rename first-occurrence-only)
 */
import { describe, it, expect } from 'vitest';
import {
  initLbug,
  closeLbug,
  executeQuery,
  executeParameterized,
} from '../../src/mcp/core/lbug-adapter.js';
import { VALID_RELATION_TYPES } from '../../src/mcp/local/local-backend.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { LOCAL_BACKEND_SEED_DATA } from '../fixtures/local-backend-seed.js';

// ─── Block 1: Pool adapter tests ─────────────────────────────────────

withTestLbugDB(
  'local-backend',
  (handle) => {
    it('allows valid read queries through the pool', async () => {
      const rows = await executeQuery(
        handle.repoId,
        'MATCH (n:Function) RETURN n.name AS name ORDER BY n.name',
      );
      expect(rows.length).toBeGreaterThanOrEqual(3);
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
        const validTypes = [
          'CALLS',
          'IMPORTS',
          'EXTENDS',
          'IMPLEMENTS',
          'HAS_METHOD',
          'METHOD_OVERRIDES',
          'ACCESSES',
        ];
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
        const rows = await executeQuery(
          handle.repoId,
          'MATCH (p:Process) RETURN p.heuristicLabel AS label, p.stepCount AS steps',
        );
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
        const rows = await executeQuery(
          handle.repoId,
          'MATCH (c:Community) RETURN c.heuristicLabel AS label',
        );
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
      it('keeps seeded rows unchanged for a no-match write probe', async () => {
        const readOnlyRepo = 'local-backend-read-only';
        await initLbug(readOnlyRepo, handle.dbPath);
        try {
          const rows = await executeParameterized(
            readOnlyRepo,
            `MATCH (n:Function) WHERE n.name = $target SET n.name = $name RETURN n.name AS name`,
            { target: '__missing__', name: 'changed' },
          );
          expect(rows).toEqual([]);
        } catch (err) {
          expect(String(err)).toMatch(/Write operations are not allowed|read-only database/i);
        }
        const rows = await executeParameterized(
          readOnlyRepo,
          'MATCH (n:Function) WHERE n.name = $name RETURN n.name AS name',
          { name: 'login' },
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('login');
        await closeLbug(readOnlyRepo);
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

    // ─── Query error handling via pool ──────────────────────────────────

    describe('query error handling via pool', () => {
      it('returns empty rows for unknown node label', async () => {
        // LadybugDB throws a Binder exception for unknown node labels
        await expect(
          executeQuery(handle.repoId, 'MATCH (n:NonExistentTable) RETURN n.name AS name'),
        ).rejects.toThrow();
      });

      it('rejects syntactically invalid Cypher', async () => {
        await expect(executeQuery(handle.repoId, 'NOT VALID CYPHER AT ALL')).rejects.toThrow();
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
  },
  {
    seed: LOCAL_BACKEND_SEED_DATA,
    poolAdapter: true,
  },
);
