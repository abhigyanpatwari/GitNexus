import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireIndexLock,
  IndexLockTimeoutError,
  type LockRecord,
} from '../../../src/storage/index-lock.js';
import {
  getGroupSyncLockDir,
  GroupSyncLockError,
  withGroupSyncLock,
} from '../../../src/core/group/group-lock.js';

vi.mock('../../../src/storage/index-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/storage/index-lock.js')>()),
  acquireIndexLock: vi.fn(),
}));
vi.mock('../../../src/core/logger.js', () => ({ logger: { info: vi.fn() } }));

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it('preserves quiesced recovery and the exact guard path without running the operation', async () => {
  vi.useFakeTimers();
  vi.stubEnv('GITNEXUS_INDEX_LOCK_BACKEND', 'file');
  const groupDir = mkdtempSync(path.join(os.tmpdir(), 'gnx-group-guard-'));
  const guardPath = path.join(getGroupSyncLockDir(groupDir), 'analyze.lock.guard');
  mkdirSync(getGroupSyncLockDir(groupDir));
  writeFileSync(guardPath, '');
  const actual = await vi.importActual<typeof import('../../../src/storage/index-lock.js')>(
    '../../../src/storage/index-lock.js',
  );
  vi.mocked(acquireIndexLock).mockImplementationOnce(actual.acquireIndexLock);
  const operation = vi.fn(async () => 'must not run');
  try {
    const pending = withGroupSyncLock(groupDir, operation).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect(operation).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(GroupSyncLockError);
    expect(error).toMatchObject({ reason: 'timeout', groupDir });
    expect((error as Error).message).toContain(guardPath);
    expect((error as Error).message).toContain('Quiesce all relevant writers');
    expect((error as Error).message).toContain('prevent restart');
    expect((error as Error).message).toContain('quiesced recovery');
    expect((error as Error).message).not.toContain('Re-run once the other sync');
    expect((error as Error).cause).toBeInstanceOf(IndexLockTimeoutError);
    expect((error as Error).cause).toMatchObject({ guardPath, holderKnown: false });
    expect(readFileSync(guardPath, 'utf8')).toBe('');
  } finally {
    rmSync(groupDir, { recursive: true, force: true });
  }
});

it.each([true, false])(
  'preserves ordinary timeout messaging with holderKnown=%s',
  async (holderKnown) => {
    const groupDir = path.resolve('ordinary-group');
    const holder: LockRecord = {
      v: 1,
      pid: holderKnown ? 1234 : -1,
      hostname: 'host',
      startTime: null,
      token: 'token',
      invocationId: 'invocation',
      acquiredAt: '',
    };
    const cause = new IndexLockTimeoutError(holder, 123, holderKnown);
    vi.useFakeTimers();
    vi.mocked(acquireIndexLock).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 123);
      throw cause;
    });
    const operation = vi.fn(async () => 'must not run');
    const error = await withGroupSyncLock(groupDir, operation).catch((error: unknown) => error);
    expect(operation).not.toHaveBeenCalled();
    expect(error).toMatchObject({ reason: 'timeout', groupDir, cause });
    expect((error as Error).message).toBe(
      `Timed out after 123ms waiting for the sync lock on group "ordinary-group" (${getGroupSyncLockDir(groupDir)}). ` +
        (holderKnown
          ? 'Held by pid 1234 on host (invocation invocation). '
          : 'The lock stayed held for the whole wait, but this lock backend cannot identify the holder. ') +
        'Nothing was written and this group was not synced. Re-run once the other sync of this group has finished.',
    );
    expect(cause).not.toHaveProperty('guardPath', expect.any(String));
  },
);
