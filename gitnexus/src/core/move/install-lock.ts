import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { type FileHandle, mkdir, open, readFile, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

export interface LockOptions {
  waitTimeoutMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  retryMs?: number;
}

export interface InstallLockIo {
  openLock(lockPath: string): Promise<FileHandle>;
  removeLock(lockPath: string): Promise<void>;
}

const DEFAULT_LOCK_WAIT_MS = 60_000;
const INSTALL_COMPLETION_GRACE_MS = 60_000;
const DEFAULT_LOCK_LEASE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 100;

const defaultLockIo: InstallLockIo = {
  openLock: (lockPath) => open(lockPath, 'wx'),
  removeLock: async (lockPath) => {
    await rm(lockPath, { force: true });
  },
};

/** Allow for the artifact download, extraction, publication, and version probe. */
export const moveFlowInstallLockWaitMs = (httpTimeoutMs: number): number =>
  Math.max(DEFAULT_LOCK_WAIT_MS, httpTimeoutMs * 2 + INSTALL_COMPLETION_GRACE_MS);

const readLock = async (lockPath: string): Promise<string | null> => {
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as { token?: unknown };
    return typeof parsed.token === 'string' ? parsed.token : null;
  } catch {
    return null;
  }
};

const statOrNull = async (file: string): Promise<Stats | null> => {
  try {
    return await stat(file);
  } catch {
    return null;
  }
};

const removeStaleLock = async (lockPath: string, leaseMs: number): Promise<void> => {
  const first = await statOrNull(lockPath);
  if (!first || Date.now() - first.mtimeMs <= leaseMs) return;
  const token = await readLock(lockPath);

  await wait(25);
  const second = await statOrNull(lockPath);
  if (
    !second ||
    second.mtimeMs !== first.mtimeMs ||
    Date.now() - second.mtimeMs <= leaseMs ||
    (await readLock(lockPath)) !== token
  ) {
    return;
  }
  await rm(lockPath, { force: true });
};

export async function acquireInstallLock(
  lockPath: string,
  options: LockOptions = {},
  io: InstallLockIo = defaultLockIo,
): Promise<() => Promise<void>> {
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_LOCK_WAIT_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LOCK_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const deadline = Date.now() + waitTimeoutMs;
  const token = randomUUID();

  await mkdir(path.dirname(lockPath), { recursive: true });
  while (Date.now() < deadline) {
    let created = false;
    try {
      const handle = await io.openLock(lockPath);
      created = true;
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid }));
      } finally {
        await handle.close();
      }

      let heartbeatRunning = false;
      const heartbeat = setInterval(() => {
        if (heartbeatRunning) return;
        heartbeatRunning = true;
        void (async () => {
          if ((await readLock(lockPath)) !== token) return;
          const now = new Date();
          await utimes(lockPath, now, now);
        })()
          .catch(() => {})
          .finally(() => {
            heartbeatRunning = false;
          });
      }, heartbeatMs);
      heartbeat.unref();

      return async () => {
        clearInterval(heartbeat);
        if ((await readLock(lockPath)) === token) await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (created) await io.removeLock(lockPath).catch(() => {});
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await removeStaleLock(lockPath, leaseMs);
      await wait(retryMs);
    }
  }

  throw new Error('timed out waiting for another move-flow installation');
}
