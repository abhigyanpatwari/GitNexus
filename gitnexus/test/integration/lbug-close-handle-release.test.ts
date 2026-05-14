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
import { describe, expect, it } from 'vitest';
import { createTempDir } from '../helpers/test-db.js';

/**
 * LadybugDB's native Windows file lock can outlive Database.close() for
 * same-process close/reopen cycles. Keep true reopen coverage on POSIX and
 * cover ordering deterministically in lbug-checkpoint-lifecycle.test.ts.
 */
const itLbugReopen = process.platform === 'win32' ? it.skip : it;

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

  itLbugReopen('flushes WAL when switching between two database paths in one process', async () => {
    const repoA = await createTempDir('gitnexus-lbug-switch-a-');
    const repoB = await createTempDir('gitnexus-lbug-switch-b-');
    const dbPathA = path.join(repoA.dbPath, 'lbug');
    const dbPathB = path.join(repoB.dbPath, 'lbug');

    try {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');

      await adapter.withLbugDb(dbPathA, async () => {
        await adapter.executeQuery(
          "CREATE (:File {id: 'file:a', name: 'a.ts', filePath: 'a.ts', content: 'repo a'})",
        );
      });

      await adapter.withLbugDb(dbPathB, async () => {
        await adapter.executeQuery(
          "CREATE (:File {id: 'file:b', name: 'b.ts', filePath: 'b.ts', content: 'repo b'})",
        );
      });

      const rows = await adapter.withLbugDb(dbPathA, async () =>
        adapter.executeQuery("MATCH (n:File {id: 'file:a'}) RETURN n.filePath AS filePath"),
      );

      expect(rows).toEqual([{ filePath: 'a.ts' }]);
    } finally {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.closeLbug().catch(() => {});
      await repoA.cleanup();
      await repoB.cleanup();
    }
  });
});
