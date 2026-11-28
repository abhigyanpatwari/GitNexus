import fs from 'node:fs/promises';
import { rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireIndexLock,
  IndexLockTimeoutError,
  type LockRecord,
} from '../../src/storage/index-lock.js';
import {
  getGroupSyncLockDir,
  GroupSyncLockError,
  withGroupSyncLock,
} from '../../src/core/group/group-lock.js';
import { faultOf } from '../../src/core/fault-class.js';

const { realAcquireIndexLock } = vi.hoisted(() => ({
  realAcquireIndexLock: { current: undefined as unknown as typeof acquireIndexLock },
}));
vi.mock('../../src/storage/index-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/index-lock.js')>();
  realAcquireIndexLock.current = actual.acquireIndexLock;
  return { ...actual, acquireIndexLock: vi.fn() };
});
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn() } }));

const holder: LockRecord = {
  v: 1,
  pid: 1234,
  hostname: 'host',
  startTime: null,
  token: 'token',
  invocationId: 'invocation',
  acquiredAt: '',
};

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe('group sync lock timeouts', () => {
  const syncWithLockError = async (cause: IndexLockTimeoutError) => {
    vi.mocked(acquireIndexLock).mockRejectedValueOnce(cause);
    const error = await withGroupSyncLock(path.resolve('fault-group'), async () => 'ran').catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(GroupSyncLockError);
    expect(error).toMatchObject({ reason: 'timeout' });
    return error;
  };

  it('another sync holding the lock is a client fault', async () => {
    const error = await syncWithLockError(
      new IndexLockTimeoutError(holder, 10, true, undefined, true),
    );
    expect(faultOf(error)).toBe('client');
  });

  it('a named holder not proven alive is a server fault', async () => {
    const error = await syncWithLockError(new IndexLockTimeoutError(holder, 10, true));
    expect(faultOf(error)).toBe('server');
  });

  it('a stuck acquisition guard is a server fault', async () => {
    const error = await syncWithLockError(
      new IndexLockTimeoutError(holder, 10, false, '/locks/analyze.lock.guard'),
    );
    expect(faultOf(error)).toBe('server');
  });

  it('a lock with no live holder (malformed or vanishing) is a server fault', async () => {
    const error = await syncWithLockError(new IndexLockTimeoutError(holder, 10, false));
    expect(faultOf(error)).toBe('server');
  });

  it('a live holder the backend cannot name (socket) is a client fault', async () => {
    const error = await syncWithLockError(
      new IndexLockTimeoutError(holder, 10, false, undefined, true),
    );
    expect(faultOf(error)).toBe('client');
  });
});

describe('group sync lock timeouts on the file lock', () => {
  /**
   * Time out a real file-lock acquisition against a record seeded in the group's
   * lock dir. `onWait` runs once the first inspection has seen the holder.
   */
  const syncAgainstRecord = async (
    record: Partial<LockRecord>,
    onWait?: (lockPath: string) => void,
  ) => {
    const groupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-group-lock-fault-'));
    try {
      const lockDir = getGroupSyncLockDir(groupDir);
      await fs.mkdir(lockDir, { recursive: true });
      await fs.writeFile(
        path.join(lockDir, 'analyze.lock'),
        JSON.stringify({ ...holder, hostname: os.hostname(), ...record }),
      );
      vi.stubEnv('GITNEXUS_INDEX_LOCK_BACKEND', 'file');
      const lockPath = path.join(lockDir, 'analyze.lock');
      vi.mocked(acquireIndexLock).mockImplementationOnce((dir, opts) =>
        realAcquireIndexLock.current(dir, {
          ...opts,
          timeoutMs: 200,
          pollMs: 20,
          // Called synchronously, before the next inspection is scheduled.
          onWaitStart: (seen) => {
            opts?.onWaitStart?.(seen);
            onWait?.(lockPath);
          },
        }),
      );
      const error = await withGroupSyncLock(groupDir, async () => 'ran').catch(
        (err: unknown) => err,
      );
      expect(error).toMatchObject({ reason: 'timeout' });
      return error;
    } finally {
      await fs.rm(groupDir, { recursive: true, force: true });
    }
  };

  it('a record from this host with a live pid is a client fault', async () => {
    expect(faultOf(await syncAgainstRecord({ pid: process.pid }))).toBe('client');
  });

  it('a record from another host, whose liveness is unknowable, is a server fault', async () => {
    const error = await syncAgainstRecord({ pid: process.pid, hostname: 'another-host.invalid' });
    expect((error as Error).message).toContain('Held by pid');
    expect(faultOf(error)).toBe('server');
  });

  // The wait then times out on a guard nobody releases, without inspecting the
  // lock again: only the lock file itself says whether the holder kept it.
  const orphanGuard = (lockPath: string) => writeFileSync(`${lockPath}.guard`, 'orphan');

  it('a live holder that still holds the lock when the guard wait times out is a client fault', async () => {
    const error = await syncAgainstRecord({ pid: process.pid }, orphanGuard);
    expect(faultOf(error)).toBe('client');
  });

  it('a live holder that released the lock before the guard wait timed out is a server fault', async () => {
    const error = await syncAgainstRecord({ pid: process.pid }, (lockPath) => {
      rmSync(lockPath);
      orphanGuard(lockPath);
    });
    expect((error as Error).message).toContain('Held by pid');
    expect(faultOf(error)).toBe('server');
  });
});
