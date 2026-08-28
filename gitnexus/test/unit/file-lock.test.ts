import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquireFileLock, FileLockBusyError } from '../../src/storage/file-lock.js';

const tempDirs: string[] = [];

async function tempLockPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-file-lock-'));
  tempDirs.push(dir);
  return path.join(dir, 'locks', 'test.mutex');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('file lock', () => {
  it('rejects a second holder for the same path', async () => {
    const lockPath = await tempLockPath();
    const release = await acquireFileLock(lockPath);

    await expect(acquireFileLock(lockPath)).rejects.toBeInstanceOf(FileLockBusyError);

    await release();
  });

  it('propagates hard-link EPERM when no lock exists', async () => {
    const lockPath = await tempLockPath();
    const error = Object.assign(new Error('hard links unavailable'), { code: 'EPERM' });
    const link = vi.spyOn(fs, 'link').mockRejectedValueOnce(error);

    try {
      await expect(acquireFileLock(lockPath)).rejects.toBe(error);
    } finally {
      link.mockRestore();
    }
  });

  it('releases idempotently', async () => {
    const lockPath = await tempLockPath();
    const release = await acquireFileLock(lockPath);

    await release();
    await expect(release()).resolves.toBeUndefined();
    const nextRelease = await acquireFileLock(lockPath);
    await nextRelease();
  });

  it('reclaims a lock whose owner process exited', async () => {
    const lockPath = await tempLockPath();
    const oldRelease = await acquireFileLock(lockPath, {
      pid: 111,
      processStartTime: 'old-start',
    });

    const nextRelease = await acquireFileLock(lockPath, {
      pid: 222,
      processStartTime: 'new-start',
      isProcessAlive: () => false,
    });

    await oldRelease();
    await expect(
      acquireFileLock(lockPath, {
        isProcessAlive: (pid) => pid === 222,
        readProcessStartTime: () => 'new-start',
      }),
    ).rejects.toBeInstanceOf(FileLockBusyError);
    await nextRelease();
  });

  it('reclaims a reused pid only when its start time differs', async () => {
    const lockPath = await tempLockPath();
    await acquireFileLock(lockPath, { pid: 111, processStartTime: 'old-start' });

    await expect(
      acquireFileLock(lockPath, {
        pid: 222,
        processStartTime: 'next-start',
        isProcessAlive: () => true,
        readProcessStartTime: () => 'old-start',
      }),
    ).rejects.toBeInstanceOf(FileLockBusyError);

    const nextRelease = await acquireFileLock(lockPath, {
      pid: 222,
      processStartTime: 'next-start',
      isProcessAlive: () => true,
      readProcessStartTime: () => 'reused-pid-start',
    });

    await nextRelease();
  });

  it('never reclaims a lock held from another host', async () => {
    const lockPath = await tempLockPath();
    await acquireFileLock(lockPath, {
      pid: 111,
      processStartTime: 'peer-start',
      hostname: 'peer-host',
    });

    // Locally pid 111 is alive with a different start time, which is the
    // reuse signature — but the holder is on another machine, so this kernel
    // cannot judge it and the lock must stand.
    await expect(
      acquireFileLock(lockPath, {
        pid: 222,
        processStartTime: 'local-start',
        hostname: 'local-host',
        isProcessAlive: () => true,
        readProcessStartTime: () => 'unrelated-local-start',
      }),
    ).rejects.toBeInstanceOf(FileLockBusyError);
  });

  it('fails closed for legacy or invalid lock contents without owner metadata', async () => {
    const lockPath = await tempLockPath();
    const invalidContents = ['legacy lock', '{not json', JSON.stringify({ pid: 123 })];
    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    for (const content of invalidContents) {
      await fs.writeFile(lockPath, content, 'utf-8');
      await expect(
        acquireFileLock(lockPath, { pid: 456, processStartTime: 'next-start' }),
      ).rejects.toBeInstanceOf(FileLockBusyError);
      await expect(fs.readFile(lockPath, 'utf-8')).resolves.toBe(content);
      await fs.rm(lockPath);
    }

    await fs.mkdir(lockPath, { recursive: true });
    await expect(
      acquireFileLock(lockPath, { pid: 456, processStartTime: 'next-start' }),
    ).rejects.toBeInstanceOf(FileLockBusyError);
    await expect(fs.access(lockPath)).resolves.toBeUndefined();
  });

  it('recovers when a stale reclaim guard was left by a crashed contender', async () => {
    const lockPath = await tempLockPath();
    await acquireFileLock(lockPath, { pid: 999, processStartTime: 'abandoned' });
    await acquireFileLock(`${lockPath}.reclaim`, {
      pid: 998,
      processStartTime: 'abandoned-reclaimer',
    });

    const release = await acquireFileLock(lockPath, {
      pid: 1000,
      processStartTime: 'next',
      isProcessAlive: () => false,
    });

    await release();
  });

  it('waits for the current holder when retries are configured', async () => {
    const lockPath = await tempLockPath();
    const release = await acquireFileLock(lockPath);
    const next = acquireFileLock(lockPath, { retries: 20, retryDelayMs: 5 });

    await sleep(10);
    await release();
    const nextRelease = await next;

    await nextRelease();
  });

  it('fails closed while another stale-lock recovery is in progress', async () => {
    const lockPath = await tempLockPath();
    const oldRelease = await acquireFileLock(lockPath, {
      pid: 999,
      processStartTime: 'abandoned',
    });
    const reclaimGuardPath = `${lockPath}.reclaim`;
    await fs.mkdir(reclaimGuardPath);

    await expect(
      acquireFileLock(lockPath, {
        pid: 1000,
        processStartTime: 'next',
        isProcessAlive: () => false,
      }),
    ).rejects.toBeInstanceOf(FileLockBusyError);
    await expect(fs.access(lockPath)).resolves.toBeUndefined();

    await fs.rmdir(reclaimGuardPath);
    const nextRelease = await acquireFileLock(lockPath, {
      pid: 1000,
      processStartTime: 'next',
      isProcessAlive: () => false,
    });
    await oldRelease();
    await nextRelease();
  });

  it('allows only one contender to recover an abandoned lock', async () => {
    const lockPath = await tempLockPath();
    await acquireFileLock(lockPath, { pid: 999, processStartTime: 'abandoned' });
    const starts = new Map(
      Array.from({ length: 8 }, (_, index) => [1000 + index, `start-${index}`]),
    );

    const results = await Promise.allSettled(
      [...starts].map(([pid, processStartTime]) =>
        acquireFileLock(lockPath, {
          pid,
          processStartTime,
          isProcessAlive: (ownerPid) => ownerPid !== 999,
          readProcessStartTime: (ownerPid) => starts.get(ownerPid),
        }),
      ),
    );

    const acquired = results.filter(
      (result): result is PromiseFulfilledResult<() => Promise<void>> =>
        result.status === 'fulfilled',
    );
    expect(acquired).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(FileLockBusyError);
    }
    await acquired[0].value();
  });
});
