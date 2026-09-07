import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isProcessAlive, readProcessStartTime } from '../utils/process-identity.js';

const HOSTNAME = os.hostname();

export interface FileLockOptions {
  retries?: number;
  retryDelayMs?: number;
  pid?: number;
  processStartTime?: string;
  hostname?: string;
  isProcessAlive?: (pid: number) => boolean;
  readProcessStartTime?: (pid: number) => string | undefined;
}

interface FileLockOwner {
  pid: number;
  ownerId: string;
  processStartTime: string;
  hostname: string;
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
    hostname: options.hostname ?? HOSTNAME,
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
        if (!(await isLockConflict(error, resolvedPath))) throw error;
        if (
          await reclaimStaleLock(
            resolvedPath,
            owner,
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
    // The lock is already published by now, but the release closure below is
    // not yet in the caller's hands. Letting a staging-file cleanup error
    // escape would strand a lock nobody can release, so prefer leaking the
    // pending file — its name is per-acquisition, so it can never block anyone.
    await fs.rm(pendingPath, { force: true }).catch(() => {});
  }

  let releasePromise: Promise<void> | undefined;
  return () => (releasePromise ??= releaseOwnedLock(resolvedPath, owner.ownerId));
}

async function reclaimStaleLock(
  lockPath: string,
  guardOwner: FileLockOwner,
  ownerIsAlive: (pid: number) => boolean,
  getProcessStartTime: (pid: number) => string | undefined,
): Promise<boolean> {
  const reclaimGuardPath = `${lockPath}.reclaim`;
  let releaseReclaimGuard: () => Promise<void>;
  try {
    releaseReclaimGuard = await acquireFileLock(reclaimGuardPath, {
      pid: guardOwner.pid,
      processStartTime: guardOwner.processStartTime,
      hostname: guardOwner.hostname,
      isProcessAlive: ownerIsAlive,
      readProcessStartTime: getProcessStartTime,
    });
  } catch (error) {
    if (error instanceof FileLockBusyError) return false;
    throw error;
  }

  try {
    const owner = await readOwner(lockPath);
    if (!owner) return false;
    // A pid only means something on the machine that issued it. Asking this
    // kernel about a holder on another host answers about an unrelated process
    // — or nothing — and either way the answer is "stale", which would steal a
    // live lock whenever GITNEXUS_HOME is a shared volume.
    if (owner.hostname !== guardOwner.hostname) return false;
    if (ownerIsAlive(owner.pid)) {
      const currentStartTime = getProcessStartTime(owner.pid);
      if (!currentStartTime || currentStartTime === owner.processStartTime) return false;
    }

    await fs.rm(lockPath, { force: true });
    return true;
  } finally {
    await releaseReclaimGuard();
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
      parsed.processStartTime &&
      typeof parsed.hostname === 'string' &&
      parsed.hostname
    ) {
      return parsed as FileLockOwner;
    }
  } catch {
    // Invalid or legacy locks fail closed; only verified dead owners are reclaimed.
  }
  return undefined;
}

async function isLockConflict(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EEXIST') return true;
  if (code !== 'EPERM') return false;
  try {
    await fs.access(lockPath);
    return true;
  } catch {
    return false;
  }
}
