/**
 * Integration Tests: Vector extension loading and state reset
 *
 * Tests: loadVectorExtension idempotency, vectorExtensionLoaded reset
 * on closeLbug and busy-retry cleanup paths.
 *
 * Follows existing lbug integration test patterns (lbug-core-adapter,
 * lbug-lock-retry).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

withTestLbugDB('vector-extension', (handle) => {
  describe('loadVectorExtension', () => {
    it('reports VECTOR availability without throwing', async () => {
      const { loadVectorExtension } = await import('../../src/core/lbug/lbug-adapter.js');

      await expect(loadVectorExtension()).resolves.toEqual(expect.any(Boolean));
    });

    it('is idempotent -- calling twice does not throw', async () => {
      const { loadVectorExtension } = await import('../../src/core/lbug/lbug-adapter.js');

      await loadVectorExtension();
      await expect(loadVectorExtension()).resolves.toEqual(expect.any(Boolean));
    });
  });

  describe('vectorExtensionLoaded reset on closeLbug', () => {
    it('re-initializes vector extension after close + re-init cycle', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');

      // Ensure vector extension is loaded
      await adapter.loadVectorExtension();

      // Close the adapter -- should reset vectorExtensionLoaded
      await adapter.closeLbug();
      expect(adapter.isLbugReady()).toBe(false);

      // Re-initialize -- VECTOR is lazy, so the stale loaded flag must not mask
      // a subsequent explicit availability check.
      await adapter.initLbug(handle.dbPath);
      expect(adapter.isLbugReady()).toBe(true);

      // loadVectorExtension should succeed (not skip due to stale flag)
      await expect(adapter.loadVectorExtension()).resolves.toEqual(expect.any(Boolean));
    });
  });

  describe('vectorExtensionLoaded reset on busy-retry cleanup', () => {
    it('withLbugDb resets vectorExtensionLoaded on BUSY retry', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');

      // Ensure vector extension is loaded
      await adapter.loadVectorExtension();

      // Simulate a BUSY error on first attempt, success on second.
      // The retry path should reset vectorExtensionLoaded so the
      // re-initialized DB gets a fresh extension load.
      let callCount = 0;
      const result = await adapter.withLbugDb(handle.dbPath, async () => {
        callCount++;
        if (callCount === 1) throw new Error('database is BUSY');
        return 'recovered';
      });

      expect(result).toBe('recovered');
      expect(callCount).toBe(2);

      // After recovery, vector extension should still be loadable
      // (the flag was reset and re-loaded during re-init)
      await expect(adapter.loadVectorExtension()).resolves.toEqual(expect.any(Boolean));
    });
  });
});

/**
 * Regression: VECTOR/HNSW index creation during analyze (#2114).
 *
 * `CALL CREATE_VECTOR_INDEX(...)` compiles to multiple statements, which
 * LadybugDB cannot run through `conn.prepare()`. Routing it through the
 * prepared `executeQuery` path (as #1655 inadvertently did when it switched the
 * singleton `executeQuery` from `conn.query()` to `conn.prepare()`) makes it
 * throw "We do not support prepare multiple statements", which `analyze`
 * swallowed and silently downgraded to exact-scan. The fix gives the adapter a
 * `createVectorIndex()` that runs the procedure via `conn.query()` (like
 * `createFTSIndex`). These tests exercise the real adapter against a real
 * LadybugDB so a revert to the prepared path fails loudly.
 */
withTestLbugDB('vector-index-creation', () => {
  // VECTOR is platform-sensitive (skipped on win32 / unsupported platforms,
  // and when it cannot be installed offline). Probe once, skip the suite if
  // unavailable — mirrors the FTS-skip convention in withTestLbugDB.
  let vectorAvailable = false;
  let skipWarned = false;
  beforeAll(async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { resolveAnalyzeInstallPolicy } = await import('../../src/core/lbug/extension-loader.js');
    // Mirror the analyze write path (`auto`: LOAD-first, then one bounded
    // INSTALL) so this suite runs wherever analyze would have vector support.
    vectorAvailable = await adapter.loadVectorExtension(undefined, {
      policy: resolveAnalyzeInstallPolicy(),
    });
  });
  beforeEach((ctx) => {
    if (!vectorAvailable) {
      if (!skipWarned) {
        skipWarned = true;
        console.warn(
          '[withTestLbugDB(vector-index-creation)] Skipping — the LadybugDB VECTOR ' +
            'extension is unavailable (unsupported platform or could not be installed).',
        );
      }
      ctx.skip();
    }
  });

  describe('createVectorIndex', () => {
    it('creates the HNSW index via conn.query (the prepared path cannot)', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');

      const created = await adapter.createVectorIndex();
      expect(created).toBe(true);

      const rows = await adapter.executeQuery('CALL SHOW_INDEXES() RETURN *');
      const idx = rows.find((r: any) => r.index_name === 'code_embedding_idx');
      expect(idx).toBeDefined();
      expect(idx.index_type).toBe('HNSW');
    });

    it('is idempotent — a second call returns true so incremental re-runs do not downgrade to exact scan', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');

      await adapter.createVectorIndex();
      await expect(adapter.createVectorIndex()).resolves.toBe(true);

      // No duplicate index created by the repeat call.
      const rows = await adapter.executeQuery('CALL SHOW_INDEXES() RETURN *');
      const matches = rows.filter((r: any) => r.index_name === 'code_embedding_idx');
      expect(matches).toHaveLength(1);
    });
  });
});

/**
 * Regression for the #2114 root cause: the prepared `executeQuery` path cannot
 * create the index. This lives in its OWN suite (a fresh, index-free DB) on
 * purpose — in the `vector-index-creation` suite above the index already exists
 * by the time this would run, so `conn.prepare()` fails with "index already
 * exists" instead of the multi-statement rejection we want to pin. With no index
 * present, `CALL CREATE_VECTOR_INDEX(...)` (which compiles to multiple
 * statements) is rejected by `conn.prepare()` with "We do not support prepare
 * multiple statements" — the exact failure that silently downgraded analyze to
 * exact-scan, and why `createVectorIndex` must use `conn.query()` instead.
 */
withTestLbugDB('vector-index-prepare-rejects', () => {
  let vectorAvailable = false;
  let skipWarned = false;
  beforeAll(async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { resolveAnalyzeInstallPolicy } = await import('../../src/core/lbug/extension-loader.js');
    vectorAvailable = await adapter.loadVectorExtension(undefined, {
      policy: resolveAnalyzeInstallPolicy(),
    });
  });
  beforeEach((ctx) => {
    if (!vectorAvailable) {
      if (!skipWarned) {
        skipWarned = true;
        console.warn(
          '[withTestLbugDB(vector-index-prepare-rejects)] Skipping — the LadybugDB VECTOR ' +
            'extension is unavailable (unsupported platform or could not be installed).',
        );
      }
      ctx.skip();
    }
  });

  it('the prepared executeQuery path rejects CREATE_VECTOR_INDEX (#2114 root cause)', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { CREATE_VECTOR_INDEX_QUERY } = await import('../../src/core/lbug/schema.js');

    // executeQuery -> executePrepared -> conn.prepare(): the multi-statement
    // CREATE_VECTOR_INDEX procedure cannot be prepared. Anchored to the specific
    // error so the test can only pass for the #2114 reason — not for an
    // unrelated throw (e.g. a missing table or an already-existing index).
    await expect(adapter.executeQuery(CREATE_VECTOR_INDEX_QUERY)).rejects.toThrow(
      /prepare multiple statements/i,
    );
  });
});
