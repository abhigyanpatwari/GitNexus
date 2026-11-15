/**
 * Integration Tests: read-only doInitLbug path (#1783)
 *
 * Verifies that read-only LadybugDB opens skip filesystem mutations
 * (init lock, orphan sidecar cleanup, mkdir) so they work on read-only
 * filesystems such as Docker :ro bind mounts.
 */
import fs from 'fs/promises';
import lbug from '@ladybugdb/core';
import { it, expect } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { _initLockPathForTest } from '../../src/core/lbug/lbug-adapter.js';
import { openLbugConnection, closeLbugConnection } from '../../src/core/lbug/lbug-config.js';

withTestLbugDB('lbug-readonly-init', (handle) => {
  it('closes a read-only graph without leaving a checkpoint marker that blocks the next reader', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.closeLbug();
    await adapter.withLbugDb(handle.dbPath, () => adapter.executeQuery('RETURN 1 AS value'), {
      readOnly: true,
    });
    expect(await adapter.tryFlushWAL()).toBe(false);
    await adapter.closeLbug();
    // Open through the raw bounded reader, so the adapter cannot hide a bad
    // read-only close by recovering it through a subsequent writable open.
    const next = await openLbugConnection(lbug, handle.dbPath, {
      readOnly: true,
      bufferPoolBytes: 64 * 1024 ** 2,
      threads: 1,
    });
    try {
      const result = await next.conn.query('RETURN 1 AS value');
      const cursors = Array.isArray(result) ? result : [result];
      try {
        expect(await cursors[0].getAll()).toEqual([{ value: 1 }]);
      } finally {
        for (const cursor of cursors) cursor.close();
      }
    } finally {
      await closeLbugConnection(next, { strict: true, databasePath: handle.dbPath });
    }
  });
  it('read-only open never creates lbug.init.lock on disk', async () => {
    const { dbPath } = handle;
    const lockPath = _initLockPathForTest(dbPath);

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.closeLbug();

    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await adapter.withLbugDb(dbPath, async () => {}, { readOnly: true });

    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await adapter.closeLbug();
  });
});
