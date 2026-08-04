import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isProcessAlive, readProcessStartTime } from '../utils/process-identity.js';

export interface FileLockOptions {
  retries?: number;
  retryDelayMs?: number;
  pid?: number;
  processStartTime?: string;
  isProcessAlive?: (pid: number) => boolean;
  readProcessStartTime?: (pid: number) => string | undefined;
}

interface FileLockOwner {
  pid: number;
  ownerId: string;
  processStartTime: string;
}

export class FileLockBusyError extends Error {
  constructor(public readonly lockPath: string) {
    super(
      `Lock is already held: ${lockPath}. Confirm no owner process is active, then remove it manually.`,
    );
    this.name = 'FileLockBusyError';
  }
}

/** Acquire a recoverable cross-process mutex using an atomically published owner file. */
export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions = {},
): Promise<() => Promise<void>> {
  const resolvedPath = path.resolve(lockPath);
  const retries = options.retries ?? 0;
  const retryDelayMs = options.retryDelayMs ?? 50;
  const pid = options.pid ?? process.pid;
  const owner: FileLockOwner = {
    pid,
    ownerId: crypto.randomUUID(),
    processStartTime:
      options.processStartTime ?? (options.readProcessStartTime ?? readProcessStartTime)(pid) ?? '',
  };
  if (!owner.processStartTime) {
    throw new Error(`Unable to determine process start time for file lock owner pid ${owner.pid}.`);
  }

  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  const pendingPath = `${resolvedPath}.pending-${owner.ownerId}`;
  await fs.writeFile(pendingPath, `${JSON.stringify(owner)}\n`, { encoding: 'utf-8', flag: 'wx' });

  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.link(pendingPath, resolvedPath);
        break;
      } catch (error) {
        if (!isLockConflict(error)) throw error;
        if (
          await reclaimStaleLock(
            resolvedPath,
            options.isProcessAlive ?? isProcessAlive,
            options.readProcessStartTime ?? readProcessStartTime,
          )
        ) {
          continue;
        }
        if (attempt >= retries) throw new FileLockBusyError(lockPath);
        await sleep(retryDelayMs);
      }
    }
  } finally {
    await fs.rm(pendingPath, { force: true });
  }

  let releasePromise: Promise<void> | undefined;
  return () => (releasePromise ??= releaseOwnedLock(resolvedPath, owner.ownerId));
}

async function reclaimStaleLock(
  lockPath: string,
  ownerIsAlive: (pid: number) => boolean,
  getProcessStartTime: (pid: number) => string | undefined,
): Promise<boolean> {
  const reclaimGuardPath = `${lockPath}.reclaim`;
  try {
    await fs.mkdir(reclaimGuardPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }

  try {
    const owner = await readOwner(lockPath);
    if (!owner) return false;
    if (ownerIsAlive(owner.pid)) {
      const currentStartTime = getProcessStartTime(owner.pid);
      if (!currentStartTime || currentStartTime === owner.processStartTime) return false;
    }

    await fs.rm(lockPath, { force: true });
    return true;
  } finally {
    await fs.rmdir(reclaimGuardPath);
  }
}

async function releaseOwnedLock(lockPath: string, ownerId: string): Promise<void> {
  const releasePath = `${lockPath}.release-${ownerId}-${crypto.randomUUID()}`;
  if (!(await moveOwnedLock(lockPath, releasePath, ownerId))) return;
  await fs.rm(releasePath, { force: true });
}

async function moveOwnedLock(
  lockPath: string,
  destinationPath: string,
  ownerId: string,
): Promise<boolean> {
  if ((await readOwner(lockPath))?.ownerId !== ownerId) return false;
  try {
    await fs.rename(lockPath, destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  if ((await readOwner(destinationPath))?.ownerId === ownerId) return true;
  await fs.rename(destinationPath, lockPath).catch(() => {});
  return false;
}

async function readOwner(lockPath: string): Promise<FileLockOwner | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, 'utf-8')) as Partial<FileLockOwner>;
    if (
      Number.isInteger(parsed.pid) &&
      Number(parsed.pid) > 0 &&
      typeof parsed.ownerId === 'string' &&
      parsed.ownerId &&
      typeof parsed.processStartTime === 'string' &&
      parsed.processStartTime
    ) {
      return parsed as FileLockOwner;
    }
  } catch {
    // Invalid or legacy locks fail closed; only verified dead owners are reclaimed.
  }
  return undefined;
}

function isLockConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EEXIST' || code === 'EPERM';
}
