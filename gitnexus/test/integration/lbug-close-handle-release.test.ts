/**
 * Integration test: safeClose's Windows post-close handle-release wait.
 *
 * On Windows, libuv reports `db.close()` resolved before the kernel has
 * released the file handle. A subsequent open of the same path can then
 * race the release and surface "Could not set lock on file". `safeClose`
 * probes the file with `fs.open` to force the residual lock to surface,
 * absorbed by the open-time retry in `lbug-config.ts`.
 */
import path from 'path';
import { describe, it } from 'vitest';
import { createTempDir } from '../helpers/test-db.js';

describe('safeClose — close + reopen does not surface lock errors', () => {
  it('survives 10 sequential open/close/reopen cycles on the same path', async () => {
    const tmp = await createTempDir('gitnexus-lbug-close-cycle-');
    const dbPath = path.join(tmp.dbPath, 'lbug');
    try {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      for (let i = 0; i < 10; i++) {
        await adapter.initLbug(dbPath);
        await adapter.closeLbug();
      }
    } finally {
      await tmp.cleanup();
    }
  });

  it('safeClose is idempotent — calling twice in a row does not throw', async () => {
    const tmp = await createTempDir('gitnexus-lbug-idempotent-');
    const dbPath = path.join(tmp.dbPath, 'lbug');
    try {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.initLbug(dbPath);
      await adapter.closeLbug();
      await adapter.closeLbug();
    } finally {
      await tmp.cleanup();
    }
  });
});
