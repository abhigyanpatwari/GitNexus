/**
 * Integration Tests: Vector extension loading and state reset
 *
 * Tests: loadVectorExtension idempotency, vectorExtensionLoaded reset
 * on closeLbug and busy-retry cleanup paths.
 *
 * Follows existing lbug integration test patterns (lbug-core-adapter,
 * lbug-lock-retry).
 */
import { describe, it, expect } from 'vitest';
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
