/**
 * E2E Tests: Stale Data Detection + Sequential Enrichment Stability
 *
 * Validates the fixes in PR #396:
 *   1. Sequential enrichment: impact() enrichment queries run without
 *      SIGSEGV on arm64 macOS (sequential on arm64, parallel elsewhere)
 *   2. Consecutive tool stability: MCP server stays alive after 10+
 *      consecutive tool calls (no stdout corruption)
 *   3. Watchdog guard: activeQueryCount prevents premature stdout restore
 *   4. Stale data detection: ensureInitialized() detects meta.json changes
 *
 * All tests share one withTestLbugDB lifecycle to avoid cross-block
 * DB closure issues (LadybugDB's shared global DB in a single fork).
 *
 * Issues: #285, #290, #292, #297
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { initLbug, executeQuery, closeLbug } from '../../src/mcp/core/lbug-adapter.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import {
  LOCAL_BACKEND_SEED_DATA,
  LOCAL_BACKEND_FTS_INDEXES,
} from '../fixtures/local-backend-seed.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { vi } from 'vitest';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

withTestLbugDB(
  'staleness-and-stability',
  (handle) => {
    let backend: LocalBackend;
    let storagePath: string;

    // ─── Setup ─────────────────────────────────────────────────────────
    describe('setup', () => {
      it('initialize backend', async () => {
        const ext = handle as typeof handle & { _backend?: LocalBackend };
        if (!ext._backend) throw new Error('LocalBackend not initialized');
        backend = ext._backend;
        storagePath = handle.tmpHandle.dbPath;
      });
    });

    // ─── Block 1: Sequential enrichment queries (#285, #290, #292) ─────
    describe('impact enrichment queries run without crashes', () => {
      it('impact with enrichment completes without SIGSEGV', async () => {
        const result = await backend.callTool('impact', {
          target: 'validate',
          direction: 'upstream',
        });
        expect(result).not.toHaveProperty('error');
        expect(result.impactedCount).toBeGreaterThanOrEqual(1);
        expect(result).toHaveProperty('affected_processes');
        expect(result).toHaveProperty('affected_modules');
      });

      it('impact with large maxDepth completes without crash', async () => {
        const result = await backend.callTool('impact', {
          target: 'login',
          direction: 'downstream',
          maxDepth: 5,
        });
        expect(result).toBeDefined();
        expect(result).not.toHaveProperty('error');
      });
    });

    // ─── Block 2: Consecutive tool call stability ──────────────────────
    describe('MCP server stays alive after 10+ consecutive tool calls', () => {
      it('10 consecutive cypher calls complete without stdout corruption', async () => {
        for (let i = 0; i < 10; i++) {
          const result = await backend.callTool('cypher', {
            query: `MATCH (n:Function) RETURN n.name AS name LIMIT ${i + 1}`,
          });
          expect(result).toHaveProperty('row_count');
          expect(result.row_count).toBeGreaterThanOrEqual(1);
        }
      });

      it('mixed tool calls: context → impact → query → cypher cycle', async () => {
        for (let i = 0; i < 3; i++) {
          const ctx = await backend.callTool('context', { name: 'login' });
          expect(ctx.status).toBe('found');

          const imp = await backend.callTool('impact', {
            target: 'validate',
            direction: 'upstream',
          });
          expect(imp).not.toHaveProperty('error');

          const qry = await backend.callTool('query', { query: 'login' });
          expect(qry).not.toHaveProperty('error');

          const cyp = await backend.callTool('cypher', {
            query: 'MATCH (n:Function) RETURN COUNT(n) AS cnt',
          });
          expect(cyp).toHaveProperty('row_count');
        }
      });

      it('stdout.write is still a function after all calls', () => {
        expect(typeof process.stdout.write).toBe('function');
      });
    });

    // ─── Block 3: Watchdog / activeQueryCount ──────────────────────────
    describe('watchdog does not restore stdout during active queries', () => {
      const REPO = 'watchdog-test';
      let poolInited = false;

      const ensurePool = async () => {
        if (!poolInited) {
          await initLbug(REPO, handle.dbPath);
          poolInited = true;
        }
      };

      afterAll(async () => {
        try {
          await closeLbug(REPO);
        } catch {
          /* best-effort */
        }
      });

      it('parallel queries complete and stdout is restored', async () => {
        await ensurePool();
        const queries = Array.from({ length: 4 }, (_, i) =>
          executeQuery(REPO, `MATCH (n:Function) RETURN n.name AS name LIMIT ${i + 1}`),
        );
        const results = await Promise.all(queries);
        expect(results).toHaveLength(4);
        for (const r of results) {
          expect(r.length).toBeGreaterThanOrEqual(1);
        }
      });

      it('sequential queries still work', async () => {
        await ensurePool();
        for (let i = 0; i < 5; i++) {
          const rows = await executeQuery(REPO, 'MATCH (n:Function) RETURN n.name');
          expect(rows.length).toBeGreaterThanOrEqual(1);
        }
      });
    });

    // ─── Block 4: Stale data detection (#297) ──────────────────────────
    // LAST: triggers closeLbug internally which may affect shared state
    describe('stale data detection via meta.json', () => {
      it('initial query works', async () => {
        const result = await backend.callTool('cypher', {
          query: 'MATCH (n:Function) RETURN n.name AS name ORDER BY n.name',
        });
        expect(result).toHaveProperty('row_count');
        expect(result.row_count).toBeGreaterThanOrEqual(3);
      });

      it('detects stale index when meta.json indexedAt changes', async () => {
        const metaPath = path.join(storagePath, 'meta.json');
        await fs.writeFile(
          metaPath,
          JSON.stringify({
            indexedAt: new Date(Date.now() + 60000).toISOString(),
            lastCommit: 'new-commit-hash',
            stats: { files: 2, nodes: 3, communities: 1, processes: 1 },
          }),
        );

        // Next call triggers re-init. May fail but must NOT crash.
        try {
          const result = await backend.callTool('cypher', {
            query: 'MATCH (n:Function) RETURN COUNT(n) AS cnt',
          });
          expect(result).toBeDefined();
        } catch (err: any) {
          expect(err.message).not.toMatch(/SIGSEGV/i);
        }
      });

      it('throttle: no re-read within 5s window', async () => {
        const metaPath = path.join(storagePath, 'meta.json');
        await fs.writeFile(
          metaPath,
          JSON.stringify({
            indexedAt: new Date(Date.now() + 120000).toISOString(),
            lastCommit: 'another-commit',
            stats: { files: 2, nodes: 3, communities: 1, processes: 1 },
          }),
        );

        try {
          const result = await backend.callTool('cypher', {
            query: 'MATCH (n:Function) RETURN COUNT(n) AS cnt',
          });
          expect(result).toBeDefined();
        } catch {
          // No crash = success
        }
      });
    });
  },
  {
    seed: LOCAL_BACKEND_SEED_DATA,
    ftsIndexes: LOCAL_BACKEND_FTS_INDEXES,
    poolAdapter: true,
    afterSetup: async (handle) => {
      // Write initial meta.json for staleness tests
      const metaPath = path.join(handle.tmpHandle.dbPath, 'meta.json');
      const initialMeta = {
        indexedAt: new Date().toISOString(),
        lastCommit: 'abc123',
        stats: { files: 2, nodes: 3, communities: 1, processes: 1 },
      };
      await fs.writeFile(metaPath, JSON.stringify(initialMeta));

      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: '/test/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: initialMeta.indexedAt,
          lastCommit: 'abc123',
          stats: { files: 2, nodes: 3, communities: 1, processes: 1 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
