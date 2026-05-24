/**
 * Integration Tests: read-only doInitLbug path (#1783)
 *
 * Verifies that read-only LadybugDB opens skip filesystem mutations
 * (init lock, orphan sidecar cleanup, mkdir) so they work on read-only
 * filesystems such as Docker :ro bind mounts.
 */
import fs from 'fs/promises';
import { it, expect } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { _initLockPathForTest } from '../../src/core/lbug/lbug-adapter.js';

withTestLbugDB('lbug-readonly-init', (handle) => {
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
