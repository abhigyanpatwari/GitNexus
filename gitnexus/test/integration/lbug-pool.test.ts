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

    // ─── closeLbug rejects pending waiters (#2068 follow-up) ─────────────
    //
    // Before the fix, closeOne() never rejected queued waiters: a caller
    // waiting for a free connection when the pool was closed (e.g. a staleness
    // reinit under concurrent query load) hung for WAITER_TIMEOUT_MS (15s) and
    // then surfaced a misleading "pool exhausted" error. Now they reject
    // immediately with an actionable "pool closed" message. The pool caps at
    // MAX_CONNS_PER_REPO (8); firing a synchronous burst larger than that queues
    // the surplus as waiters, and closing synchronously (before any query
    // settles) must reject every queued waiter at once. The default 5s test
    // timeout also guards promptness — a regression would block ~15s and time
    // out rather than reject.
    describe('closeLbug waiter handling (#2068)', () => {
      it('rejects queued waiters promptly with a pool-closed error on close', async () => {
        await initLbug('test-repo', handle.dbPath);

        // Fire a burst larger than the 8-connection cap WITHOUT awaiting: the
        // first 8 check out connections synchronously, the surplus queue as
        // waiters — all before the synchronous closeLbug below runs.
        const BURST = 24;
        const MAX_CONNS = 8;
        const inflight = Array.from({ length: BURST }, () =>
          executeQuery('test-repo', 'MATCH (n:Function) RETURN n.name AS name'),
        );
        // Close in the same synchronous tick — no microtask has served a waiter.
        const closing = closeLbug('test-repo');

        const settled = await Promise.allSettled(inflight);
        await closing;

        const reasons = settled
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => String(r.reason?.message ?? r.reason));

        // The surplus (BURST - MAX_CONNS) waiters must reject with "pool closed".
        const poolClosed = reasons.filter((m) => /pool closed/i.test(m));
        expect(poolClosed.length).toBeGreaterThanOrEqual(BURST - MAX_CONNS);
        // And none should have hit the 15s "exhausted" waiter-timeout path.
        expect(reasons.some((m) => /waiting for a free connection/i.test(m))).toBe(false);

        expect(isLbugReady('test-repo')).toBe(false);
      });

      it('settles in-flight queries and fully tears down when closed mid-flight', async () => {
        // closeOne-vs-checkin interleave (F4b): with 8 connections in-flight and
        // surplus callers queued, a synchronous close must (a) let every promise
        // settle — no hang — and (b) fully delete the pool entry so checked-in
        // connections are closed as orphans rather than handed to a rejected
        // waiter. We assert the observable contract; the "orphan not handed to a
        // rejected waiter" invariant is single-threaded-by-construction (closeOne
        // drains waiters with no await before any checkin can run).
        await initLbug('test-repo', handle.dbPath);

        const inflight = Array.from({ length: 16 }, () =>
          executeQuery('test-repo', 'MATCH (n:Function) RETURN n.name AS name'),
        );
        const closing = closeLbug('test-repo');

        // allSettled only resolves once EVERY query settled — proving none hangs
        // (a 15s waiter-timeout regression would blow the default test timeout).
        const settled = await Promise.allSettled(inflight);
        await closing;
        expect(settled).toHaveLength(16);
        expect(
          settled.some(
            (r) =>
              r.status === 'rejected' &&
              /waiting for a free connection/i.test(String(r.reason?.message ?? r.reason)),
          ),
        ).toBe(false);

        // Pool entry fully gone — a subsequent query fails fast with the
        // not-initialized error, not a hang or a stale connection.
        expect(isLbugReady('test-repo')).toBe(false);
        await expect(executeQuery('test-repo', 'MATCH (n) RETURN n LIMIT 1')).rejects.toThrow(
          /not initialized/i,
        );
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

      it('keeps seeded rows unchanged for a no-match parameterized write probe', async () => {
        await initLbug('test-repo', handle.dbPath);
        try {
          const rows = await executeParameterized(
            'test-repo',
            'MATCH (n:Function) WHERE n.name = $target SET n.name = $name RETURN n.name AS name',
            { target: '__missing__', name: 'x' },
          );
          expect(rows).toEqual([]);
        } catch (err) {
          expect(String(err)).toMatch(/read-only database|write operations/i);
        }
        const rows = await executeQuery(
          'test-repo',
          'MATCH (n:Function) RETURN n.name AS name ORDER BY n.name',
        );
        expect(rows.map((r: any) => r.name)).toContain('main');
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

      it('keeps seeded data unchanged for a no-match write probe', async () => {
        await initLbug('test-repo', handle.dbPath);
        try {
          await executeQuery(
            'test-repo',
            "MATCH (n:Function) WHERE n.name = '__missing__' SET n.name = 'new' RETURN n",
          );
        } catch (err) {
          expect(String(err)).toMatch(/read-only database|write operations/i);
        }
        const rows = await executeQuery(
          'test-repo',
          'MATCH (n:Function) RETURN n.name AS name ORDER BY n.name',
        );
        expect(rows.map((r: any) => r.name)).toContain('main');
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
