/**
 * Integration test: orphan sidecar recovery in doInitLbug.
 *
 * Exercises the real `initLbug` → `doInitLbug` path against a native
 * LadybugDB instance. Creates actual orphan `.shadow` and
 * `.wal.checkpoint` files on disk (without a main DB file) and confirms
 * that `initLbug` cleans them up and opens a fresh database successfully.
 *
 * This complements the unit-level mocked coverage in
 * `lbug-checkpoint-lifecycle.test.ts` with a real-filesystem,
 * real-LadybugDB integration proof required by DoD §2.7.
 */
import fs from 'fs/promises';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { createTempDir } from '../helpers/test-db.js';

/**
 * LadybugDB 0.16.0 has a known Windows-only regression: `Database.close()`
 * does not release the underlying file lock until the process exits, so any
 * `closeLbug()` followed by `initLbug(samePath)` in the same process raises
 * Win32 Error 33. Skip reopen-dependent tests on Windows.
 */
const itLbugReopen = process.platform === 'win32' ? it.skip : it;

describe('orphan sidecar recovery — native integration', () => {
  itLbugReopen(
    'initLbug recovers when both .shadow and .wal.checkpoint orphan sidecars are present without a main DB file',
    async () => {
      const tmp = await createTempDir('gitnexus-lbug-orphan-');
      const dbPath = path.join(tmp.dbPath, 'lbug');
      const shadowPath = `${dbPath}.shadow`;
      const walCheckpointPath = `${dbPath}.wal.checkpoint`;

      try {
        // Simulate crash-recovery state: orphan sidecars without main DB file
        await fs.writeFile(shadowPath, 'stale-shadow-data');
        await fs.writeFile(walCheckpointPath, 'stale-wal-checkpoint-data');

        // Confirm precondition: main DB file does NOT exist, sidecars DO
        await expect(fs.access(dbPath)).rejects.toThrow();
        await expect(fs.access(shadowPath)).resolves.toBeUndefined();
        await expect(fs.access(walCheckpointPath)).resolves.toBeUndefined();

        const adapter = await import('../../src/core/lbug/lbug-adapter.js');

        // initLbug should clean up orphan sidecars and open a fresh DB
        await adapter.initLbug(dbPath);

        // Verify the database is functional — execute a simple query
        const rows = await adapter.executeQuery('RETURN 1 AS result');
        expect(rows).toEqual([{ result: 1 }]);

        // Verify orphan sidecars were removed
        await expect(fs.access(shadowPath)).rejects.toThrow();
        await expect(fs.access(walCheckpointPath)).rejects.toThrow();

        await adapter.closeLbug();
      } finally {
        await tmp.cleanup();
      }
    },
  );

  itLbugReopen(
    'initLbug recovers when only .shadow orphan sidecar is present (partial crash state)',
    async () => {
      const tmp = await createTempDir('gitnexus-lbug-orphan-');
      const dbPath = path.join(tmp.dbPath, 'lbug');
      const shadowPath = `${dbPath}.shadow`;
      const walCheckpointPath = `${dbPath}.wal.checkpoint`;

      try {
        // Only .shadow present — partial crash state
        await fs.writeFile(shadowPath, 'stale-shadow-data');

        const adapter = await import('../../src/core/lbug/lbug-adapter.js');
        await adapter.initLbug(dbPath);

        const rows = await adapter.executeQuery('RETURN 42 AS answer');
        expect(rows).toEqual([{ answer: 42 }]);

        // .shadow cleaned, .wal.checkpoint was never present
        await expect(fs.access(shadowPath)).rejects.toThrow();
        await expect(fs.access(walCheckpointPath)).rejects.toThrow();

        await adapter.closeLbug();
      } finally {
        await tmp.cleanup();
      }
    },
  );

  itLbugReopen('initLbug succeeds on a clean path with no orphan sidecars (baseline)', async () => {
    const tmp = await createTempDir('gitnexus-lbug-orphan-');
    const dbPath = path.join(tmp.dbPath, 'lbug');

    try {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.initLbug(dbPath);

      const rows = await adapter.executeQuery('RETURN 1 AS ok');
      expect(rows).toEqual([{ ok: 1 }]);

      await adapter.closeLbug();
    } finally {
      await tmp.cleanup();
    }
  });

  itLbugReopen(
    'initLbug does not attempt orphan cleanup when the main DB file exists',
    async () => {
      const tmp = await createTempDir('gitnexus-lbug-orphan-');
      const dbPath = path.join(tmp.dbPath, 'lbug');
      // Place a marker file with a non-sidecar extension next to the DB path.
      // Our cleanup only targets `.shadow` and `.wal.checkpoint` and only when
      // the main DB is missing. We verify the DB opens normally and the marker
      // remains — proving that init did not perform broad sibling file cleanup.
      const markerPath = `${dbPath}.test-marker`;

      try {
        const adapter = await import('../../src/core/lbug/lbug-adapter.js');

        // Create a real DB file by initializing normally
        await adapter.initLbug(dbPath);
        await adapter.closeLbug();

        // Plant marker file next to the existing DB
        await fs.writeFile(markerPath, 'should-survive');

        // Re-init: main DB exists, so orphan cleanup should NOT fire
        await adapter.initLbug(dbPath);

        const rows = await adapter.executeQuery('RETURN 1 AS ok');
        expect(rows).toEqual([{ ok: 1 }]);

        // Marker file survives — no broad cleanup happened
        const content = await fs.readFile(markerPath, 'utf-8');
        expect(content).toBe('should-survive');

        await adapter.closeLbug();
      } finally {
        // Clean up marker file — best-effort; may already be absent
        await fs.unlink(markerPath).catch(() => {
          /* test cleanup only */
        });
        await tmp.cleanup();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Init lock — cross-process ownership contract
// ---------------------------------------------------------------------------

describe('init lock — single-process ownership contract', () => {
  itLbugReopen('acquireInitLock succeeds when parent directory does not exist yet', async () => {
    const tmp = await createTempDir('gitnexus-lbug-orphan-');
    // Use a nested path whose parent directory does NOT exist
    const dbPath = path.join(tmp.dbPath, 'nonexistent-subdir', 'lbug');
    const lockPath = `${dbPath}.init.lock`;

    try {
      // Precondition: parent directory must not exist
      await expect(fs.access(path.dirname(dbPath))).rejects.toThrow();

      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const release = await adapter.acquireInitLock(dbPath);

      // Lock file should exist — parent dir was created automatically
      const content = await fs.readFile(lockPath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.pid).toBe(process.pid);

      await release();

      // Lock file gone after release
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      await tmp.cleanup();
    }
  });

  itLbugReopen('acquireInitLock creates and releases lock file atomically', async () => {
    const tmp = await createTempDir('gitnexus-lbug-orphan-');
    const dbPath = path.join(tmp.dbPath, 'lbug');
    const lockPath = `${dbPath}.init.lock`;

    try {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const release = await adapter.acquireInitLock(dbPath);

      // Lock file should exist while held
      const content = await fs.readFile(lockPath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.pid).toBe(process.pid);
      expect(typeof parsed.ts).toBe('number');

      // Release the lock
      await release();

      // Lock file should be gone after release
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      await tmp.cleanup();
    }
  });

  itLbugReopen('acquireInitLock blocks concurrent acquire from same process', async () => {
    const tmp = await createTempDir('gitnexus-lbug-orphan-');
    const dbPath = path.join(tmp.dbPath, 'lbug');

    try {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');

      const release1 = await adapter.acquireInitLock(dbPath);

      // Second acquire should fail because the lock is held by this (alive) process.
      // The lock retry budget is small enough that this completes quickly.
      await expect(adapter.acquireInitLock(dbPath)).rejects.toThrow(/unable to acquire init lock/);

      await release1();
    } finally {
      await tmp.cleanup();
    }
  });

  itLbugReopen('acquireInitLock reclaims stale lock from dead process', async () => {
    const tmp = await createTempDir('gitnexus-lbug-orphan-');
    const dbPath = path.join(tmp.dbPath, 'lbug');
    const lockPath = `${dbPath}.init.lock`;

    try {
      // PID far above any realistic range — guaranteed not running on any OS.
      const DEAD_PROCESS_PID = 2_000_000_000;
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: DEAD_PROCESS_PID, ts: Date.now() - 60_000 }),
      );

      const adapter = await import('../../src/core/lbug/lbug-adapter.js');

      // Should break the stale lock and acquire successfully
      const release = await adapter.acquireInitLock(dbPath);

      // Verify we own the lock now
      const content = await fs.readFile(lockPath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.pid).toBe(process.pid);

      await release();
    } finally {
      await tmp.cleanup();
    }
  });

  itLbugReopen('release is idempotent — calling twice does not throw', async () => {
    const tmp = await createTempDir('gitnexus-lbug-orphan-');
    const dbPath = path.join(tmp.dbPath, 'lbug');

    try {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const release = await adapter.acquireInitLock(dbPath);

      await release();
      // Second release — lock file already gone, should not throw
      await release();
    } finally {
      await tmp.cleanup();
    }
  });

  itLbugReopen(
    'initLbug cleans up lock file after successful init with orphan sidecars',
    async () => {
      const tmp = await createTempDir('gitnexus-lbug-orphan-');
      const dbPath = path.join(tmp.dbPath, 'lbug');
      const lockPath = `${dbPath}.init.lock`;

      try {
        // Plant orphan sidecars
        await fs.writeFile(`${dbPath}.shadow`, 'stale-shadow');
        await fs.writeFile(`${dbPath}.wal.checkpoint`, 'stale-wal');

        const adapter = await import('../../src/core/lbug/lbug-adapter.js');
        await adapter.initLbug(dbPath);

        // Lock file should be released after init completes
        await expect(fs.access(lockPath)).rejects.toThrow();

        // DB should be functional
        const rows = await adapter.executeQuery('RETURN 1 AS ok');
        expect(rows).toEqual([{ ok: 1 }]);

        await adapter.closeLbug();
      } finally {
        await tmp.cleanup();
      }
    },
  );

  itLbugReopen('initLbug cleans up lock file even when DB open fails', async () => {
    const tmp = await createTempDir('gitnexus-lbug-orphan-');
    // Use an invalid path that will cause LadybugDB to fail
    const dbPath = path.join(tmp.dbPath, 'nonexistent-subdir', 'deep', 'lbug');
    const lockPath = `${dbPath}.init.lock`;

    try {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');

      // initLbug should fail (parent dir structure may cause issues), but
      // we primarily care that the lock file is cleaned up even on failure.
      // Use a try/catch since the DB open may or may not fail depending
      // on how mkdir works.
      try {
        await adapter.initLbug(dbPath);
        await adapter.closeLbug();
      } catch {
        // Expected — DB open can fail for various reasons
      }

      // Lock file should always be released, even on failure
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      await tmp.cleanup();
    }
  });
});
