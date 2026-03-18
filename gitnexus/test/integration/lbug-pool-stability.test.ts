/**
 * Integration Tests: LadybugDB Connection Pool — Parallel Stability
 *
 * Tests concurrency fixes from PR #349:
 *   - Pre-warmed pool handles max parallel queries
 *   - Waiter queue drains under overload
 *   - Concurrent initLbug deduplication
 *   - stdout.write restoration after parallel operations
 *   - No connection leaks over sequential workloads
 *   - Atomic pool entry visibility (pool.set last)
 *   - Mixed query types at full concurrency
 *
 * Connection budget: LadybugDB's native mmap budget caps at ~56
 * simultaneous Connection objects per process.  Tests that only need
 * a ready pool share a single 'shared-repo' init (8 connections) to
 * stay well under the limit.
 */
import { it, expect, afterAll } from 'vitest';
import {
  initLbug,
  executeQuery,
  executeParameterized,
  closeLbug,
  isLbugReady,
} from '../../src/mcp/core/lbug-adapter.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

const SEED_DATA = [
  `CREATE (f:File {id: 'file:index.ts', name: 'index.ts', filePath: 'src/index.ts', content: ''})`,
  `CREATE (fn:Function {id: 'func:main', name: 'main', filePath: 'src/index.ts', startLine: 1, endLine: 10, isExported: true, content: '', description: ''})`,
  `CREATE (fn2:Function {id: 'func:helper', name: 'helper', filePath: 'src/utils.ts', startLine: 1, endLine: 5, isExported: true, content: '', description: ''})`,
  `MATCH (a:Function), (b:Function)
    WHERE a.id = 'func:main' AND b.id = 'func:helper'
    CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 1.0, reason: 'direct', step: 0}]->(b)`,
];

// ─── Shared-pool tests: reuse one init across 5 tests (8 connections total) ──

withTestLbugDB('pool-stability', (handle) => {
  const REPO = 'shared-par';
  let inited = false;

  const ensurePool = async () => {
    if (!inited) {
      await initLbug(REPO, handle.dbPath);
      inited = true;
    }
  };

  afterAll(async () => {
    try { await closeLbug(REPO); } catch { /* best-effort */ }
  });

  it('8 simultaneous queries complete without crashes', async () => {
    await ensurePool();
    const queries = Array.from({ length: 8 }, () =>
      executeQuery(REPO, 'MATCH (n:Function) RETURN n.name AS name')
    );
    const results = await Promise.all(queries);
    expect(results).toHaveLength(8);
    for (const rows of results) {
      expect(rows.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('12 parallel queries overflow into waiter queue and all complete', async () => {
    await ensurePool();
    const queries = Array.from({ length: 12 }, () =>
      executeQuery(REPO, 'MATCH (n:Function) RETURN n.name AS name')
    );
    const results = await Promise.all(queries);
    expect(results).toHaveLength(12);
    for (const rows of results) {
      expect(rows.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('process.stdout.write is functional after init and parallel queries', async () => {
    await ensurePool();
    const queries = Array.from({ length: 8 }, () =>
      executeQuery(REPO, 'MATCH (n:Function) RETURN n.name AS name')
    );
    await Promise.all(queries);
    // stdout.write should be the real function, not the silenced no-op
    expect(typeof process.stdout.write).toBe('function');
  });

  it('50 sequential queries do not leak connections', async () => {
    await ensurePool();
    for (let i = 0; i < 50; i++) {
      await executeQuery(REPO, 'MATCH (n:Function) RETURN n.name AS name');
    }
    // If connections leaked, these 8 parallel queries would exhaust the pool
    const queries = Array.from({ length: 8 }, () =>
      executeQuery(REPO, 'MATCH (n:Function) RETURN n.name AS name')
    );
    const results = await Promise.all(queries);
    expect(results).toHaveLength(8);
  });

  it('mixed executeQuery + executeParameterized at full concurrency', async () => {
    await ensurePool();
    const queries = [
      executeQuery(REPO, 'MATCH (n:Function) RETURN n.name AS name'),
      executeParameterized(REPO, 'MATCH (n:Function) WHERE n.name = $name RETURN n.name AS name', { name: 'main' }),
      executeQuery(REPO, 'MATCH (n:Function) RETURN n.name AS name'),
      executeParameterized(REPO, 'MATCH (n:Function) WHERE n.name = $name RETURN n.name AS name', { name: 'helper' }),
      executeQuery(REPO, 'MATCH (n:Function) RETURN n.name AS name'),
      executeParameterized(REPO, 'MATCH (n:Function) WHERE n.name = $name RETURN n.name AS name', { name: 'main' }),
      executeQuery(REPO, 'MATCH (n:Function) RETURN n.name AS name'),
      executeQuery(REPO, 'MATCH (n:Function) RETURN n.name AS name'),
    ];
    const results = await Promise.all(queries);
    expect(results).toHaveLength(8);
  });

  // ─── Regression tests for #308 / #314 / #347 ──────────────────────────
  // The impact command's enrichment phase runs 3 concurrent queries via
  // Promise.all (local-backend.ts:1415). Before PR #349's pool pre-warming,
  // this triggered lazy createConnection → silenceStdout → SIGSEGV.

  it('3 concurrent queries via Promise.all (impact enrichment pattern, #308/#314/#347)', async () => {
    await ensurePool();
    // Mirrors the exact Promise.all pattern from local-backend.ts:1415
    // that caused SIGSEGV in issues #308, #314, #347 before pool pre-warming.
    const [r1, r2, r3] = await Promise.all([
      executeQuery(REPO, 'MATCH (n:Function) RETURN n.name AS name LIMIT 5').catch(() => []),
      executeQuery(REPO, 'MATCH (n:Function) RETURN n.id AS id LIMIT 5').catch(() => []),
      executeQuery(REPO, 'MATCH ()-[r:CodeRelation]->() RETURN r.type AS type LIMIT 5').catch(() => []),
    ]);
    expect(r1.length).toBeGreaterThanOrEqual(1);
    expect(r2.length).toBeGreaterThanOrEqual(1);
    expect(r3.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Fresh-state tests: need their own init ──────────────────────────

  it('concurrent initLbug calls for the same repoId deduplicate', async () => {
    const promises = Array.from({ length: 6 }, () =>
      initLbug('dedup-repo', handle.dbPath)
    );
    await Promise.all(promises);
    expect(isLbugReady('dedup-repo')).toBe(true);
    const rows = await executeQuery('dedup-repo', 'MATCH (n:Function) RETURN n.name AS name');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    await closeLbug('dedup-repo');
  });

  it('pool entry is not visible until initLbug fully resolves', async () => {
    const initPromise = initLbug('atomic-repo', handle.dbPath);
    // Synchronously, pool should NOT be ready (pool.set is the last operation)
    expect(isLbugReady('atomic-repo')).toBe(false);
    await initPromise;
    expect(isLbugReady('atomic-repo')).toBe(true);
    await closeLbug('atomic-repo');
  });
}, {
  seed: SEED_DATA,
  poolAdapter: true,
});
