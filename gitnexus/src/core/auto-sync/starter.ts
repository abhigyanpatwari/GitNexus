import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquireFileLock, FileLockBusyError } from '../../storage/file-lock.js';
import { getGlobalDir } from '../../storage/repo-manager.js';
import { isProcessAlive, readProcessStartTime } from '../../utils/process-identity.js';
import { loadAutoSyncConfig } from './config.js';
import { runAutoSyncOnce } from './runner.js';
import { getAutoSyncMutexPath, getAutoSyncWatchDir } from './state.js';

export interface AutoSyncStartHandle {
  stop(): Promise<void>;
}

export type WatchStatusState =
  | 'running'
  | 'cancelling'
  | 'stopping'
  | 'stopped'
  | 'stale'
  | 'error';
export type AutoSyncWatchStopResult = 'stopped' | 'not_running' | 'refused' | 'timeout';

export interface WatchStatusRecord {
  state: WatchStatusState;
  pid?: number;
  ownerId?: string;
  configPath?: string;
  message?: string;
  updatedAt: string;
}

export interface WatchOwnerRecord {
  pid: number;
  ownerId: string;
  processStartTime: string;
  createdAt: string;
}

interface WatchStopRequestRecord {
  pid: number;
  ownerId: string;
  processStartTime: string;
  requestedAt: string;
}

const WATCH_STOP_POLL_MS = 250;

export interface AutoSyncWatchPaths {
  pidPath: string;
  mutexPath: string;
  ownerPath: string;
  statusPath: string;
}

export interface AutoSyncWatchControlDeps {
  isProcessAlive(pid: number): boolean;
  readProcessCommand(pid: number): string | undefined;
  readProcessStartTime(pid: number): string | undefined;
  sleep(ms: number): Promise<void>;
}

export function getAutoSyncWatchPaths(gitnexusDir = getGlobalDir()): AutoSyncWatchPaths {
  const watchDir = getAutoSyncWatchDir(gitnexusDir);
  return {
    pidPath: path.join(watchDir, 'watch.pid'),
    mutexPath: getAutoSyncMutexPath(gitnexusDir),
    ownerPath: path.join(watchDir, 'watch.owner.json'),
    statusPath: path.join(watchDir, 'watch.status.json'),
  };
}

export async function startAutoSyncWatch(
  options: {
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
    runOnce?: typeof runAutoSyncOnce;
    stderr?: Pick<NodeJS.WriteStream, 'write'>;
    keepAlive?: boolean;
    paths?: AutoSyncWatchPaths;
    deps?: Partial<AutoSyncWatchControlDeps>;
  } = {},
): Promise<AutoSyncStartHandle | null> {
  const stderr = options.stderr ?? process.stderr;
  const paths = options.paths ?? getAutoSyncWatchPaths();
  const deps = resolveWatchDeps(options.deps);
  const ownerId = crypto.randomUUID();
  const processStartTime = deps.readProcessStartTime(process.pid);
  if (!processStartTime) {
    stderr.write('[auto-sync] Unable to verify the watch process start time.\n');
    return null;
  }
  await fs.mkdir(path.dirname(paths.pidPath), { recursive: true });
  const releaseLock = await acquireWatchLock(paths, deps, stderr, processStartTime);
  if (!releaseLock) return null;

  try {
    await writeWatchOwner(paths, {
      pid: process.pid,
      ownerId,
      processStartTime,
      createdAt: new Date().toISOString(),
    });
    await writeAtomicText(paths.pidPath, `${process.pid}\n`);

    const loaded = await loadAutoSyncConfig();
    if (loaded.ok === false) {
      stderr.write(`${loaded.message}\n`);
      await writeWatchStatus(paths, {
        state: 'error',
        pid: process.pid,
        ownerId,
        message: loaded.message,
        updatedAt: new Date().toISOString(),
      });
      await cleanupWatchFiles(paths, ownerId, releaseLock);
      return null;
    }
    await writeWatchStatus(paths, {
      state: 'running',
      pid: process.pid,
      ownerId,
      configPath: loaded.config.configPath,
      updatedAt: new Date().toISOString(),
    });

    const runOnce = options.runOnce ?? runAutoSyncOnce;
    const setIntervalFn = options.setIntervalFn ?? setInterval;
    const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    let activeRun: Promise<void> | undefined;
    let activeAbortController: AbortController | undefined;
    let stopping = false;
    let statusWrite = Promise.resolve();
    const updateStatus = (state: WatchStatusState, message?: string) => {
      const write = statusWrite.then(() =>
        writeWatchStatus(paths, {
          state,
          pid: process.pid,
          ownerId,
          configPath: loaded.config.configPath,
          message,
          updatedAt: new Date().toISOString(),
        }),
      );
      statusWrite = write.catch(() => {});
      return write;
    };
    const reportStatusWriteFailure = (error: unknown) => {
      stderr.write(
        `[auto-sync] Failed to publish watch status: ${(error as Error).message}\n`,
      );
    };
    const runSafely = () => {
      if (stopping) return;
      if (activeRun) {
        stderr.write('[auto-sync] Previous run is still active; skipping overlapping run.\n');
        return;
      }
      const startedAt = new Date();
      stderr.write(`[auto-sync] Watch loop started at ${startedAt.toISOString()}.\n`);
      const abortController = new AbortController();
      const run = runOnce(loaded.config, {
        signal: abortController.signal,
        onAnalysisCancellationRequested: () => {
          if (!stopping) {
            void updateStatus(
              'cancelling',
              'Analysis cancellation requested; waiting for the worker to reach a safe shutdown point.',
            ).catch(reportStatusWriteFailure);
          }
        },
      })
        .then((result) => {
          stderr.write(
            `[auto-sync] Watch loop finished: synced=${result.synced} analyzed=${result.analyzed} skipped=${result.skippedAnalysis} failed=${result.failed}.\n`,
          );
        })
        .catch((err: unknown) => {
          stderr.write(`[auto-sync] Scheduled run failed: ${(err as Error).message}\n`);
          stderr.write('[auto-sync] Watch loop finished: failed.\n');
        })
        .finally(async () => {
          if (activeRun === run) {
            activeRun = undefined;
            activeAbortController = undefined;
          }
          if (!stopping) {
            await updateStatus('running').catch(reportStatusWriteFailure);
          }
        });
      activeRun = run;
      activeAbortController = abortController;
    };

    let stopPromise: Promise<void> | undefined;
    const stop = () =>
      (stopPromise ??= (async () => {
        stopping = true;
        clearIntervalFn(timer);
        clearIntervalFn(controlTimer);
        activeAbortController?.abort();
        try {
          await updateStatus('stopping');
          await activeRun?.catch(() => {});
          await updateStatus('stopped');
        } finally {
          await cleanupWatchFiles(paths, ownerId, releaseLock);
        }
      })());
    const checkStopRequest = async () => {
      const request = await readStopRequest(stopRequestPath(paths, ownerId));
      if (
        request?.pid === process.pid &&
        request.ownerId === ownerId &&
        request.processStartTime === processStartTime
      ) {
        void stop().catch((error: unknown) => {
          stderr.write(`[auto-sync] Failed to stop watch: ${(error as Error).message}\n`);
        });
      }
    };

    runSafely();
    const controlTimer = setIntervalFn(() => void checkStopRequest(), WATCH_STOP_POLL_MS);
    const timer = setIntervalFn(runSafely, loaded.config.syncIntervalMinutes * 60_000);
    if (options.keepAlive === false) {
      controlTimer.unref?.();
      timer.unref?.();
    }
    return { stop };
  } catch (error) {
    await cleanupWatchFiles(paths, ownerId, releaseLock).catch(() => {});
    throw error;
  }
}

async function acquireWatchLock(
  paths: AutoSyncWatchPaths,
  deps: AutoSyncWatchControlDeps,
  stderr: Pick<NodeJS.WriteStream, 'write'>,
  processStartTime: string,
): Promise<(() => Promise<void>) | null> {
  try {
    return await acquireFileLock(paths.mutexPath, {
      pid: process.pid,
      processStartTime,
      isProcessAlive: deps.isProcessAlive,
      readProcessStartTime: deps.readProcessStartTime,
    });
  } catch (err: unknown) {
    if (!(err instanceof FileLockBusyError)) throw err;
  }

  const owner = await readOwnerFile(paths.ownerPath);
  if (!owner) {
    stderr.write(
      `[auto-sync] Watch mutex is held but owner metadata is not ready or invalid. Confirm no watch process is running, then remove ${paths.mutexPath}.\n`,
    );
    return null;
  }
  if (!deps.isProcessAlive(owner.pid)) {
    stderr.write(
      `[auto-sync] Watch mutex remains after owner pid ${owner.pid} exited. Confirm no watch process is running, then remove ${paths.mutexPath}.\n`,
    );
    return null;
  }
  const reason = getWatchProcessIdentityError(owner, deps);
  if (reason) {
    stderr.write(`[auto-sync] Refusing to trust existing watch pid ${owner.pid}; ${reason}.\n`);
    return null;
  }
  stderr.write(`[auto-sync] Watch is already running with pid ${owner.pid}.\n`);
  return null;
}

export async function stopAutoSyncWatch(
  options: {
    paths?: AutoSyncWatchPaths;
    stderr?: Pick<NodeJS.WriteStream, 'write'>;
    deps?: Partial<AutoSyncWatchControlDeps>;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<AutoSyncWatchStopResult> {
  const stderr = options.stderr ?? process.stderr;
  const paths = options.paths ?? getAutoSyncWatchPaths();
  const deps = resolveWatchDeps(options.deps);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 100;
  const pid = await readPid(paths.pidPath);
  if (!pid) {
    const owner = await readOwnerFile(paths.ownerPath);
    if (owner && deps.isProcessAlive(owner.pid)) {
      stderr.write(
        `[auto-sync] Watch appears to be starting with pid ${owner.pid}; pid file is not ready.\n`,
      );
      return 'refused';
    }
    if (owner || (await fileExists(paths.mutexPath))) {
      stderr.write(
        `[auto-sync] Watch ownership is stale or incomplete. Confirm no watch process is running, then remove ${paths.mutexPath}.\n`,
      );
      return 'refused';
    }
    stderr.write('[auto-sync] Watch is not running.\n');
    return 'not_running';
  }
  if (!deps.isProcessAlive(pid)) {
    stderr.write(
      `[auto-sync] Watch pid ${pid} is stale. Confirm no watch process is running, then remove ${paths.mutexPath}.\n`,
    );
    return 'refused';
  }

  const owner = await readVerifiedWatchOwner(paths, pid, deps);
  if (owner.ok === false) {
    stderr.write(`[auto-sync] Refusing to stop pid ${pid}; ${owner.reason}.\n`);
    return 'refused';
  }

  const currentPid = await readPid(paths.pidPath);
  const currentOwner = await readVerifiedWatchOwner(paths, pid, deps);
  if (
    currentPid !== pid ||
    currentOwner.ok === false ||
    currentOwner.owner.ownerId !== owner.owner.ownerId
  ) {
    stderr.write(`[auto-sync] Refusing to stop pid ${pid}; watch ownership changed.\n`);
    return 'refused';
  }

  await writeAtomicText(
    stopRequestPath(paths, owner.owner.ownerId),
    `${JSON.stringify({
      pid,
      ownerId: owner.owner.ownerId,
      processStartTime: owner.owner.processStartTime,
      requestedAt: new Date().toISOString(),
    } satisfies WatchStopRequestRecord)}\n`,
  );
  stderr.write(`[auto-sync] Stop requested for watch pid ${pid}.\n`);
  const stopped = await waitForProcessExit(pid, {
    deps,
    timeoutMs,
    pollMs,
    processStartTime: owner.owner.processStartTime,
  });
  if (!stopped) {
    stderr.write(`[auto-sync] Watch pid ${pid} did not exit within ${timeoutMs}ms.\n`);
    return 'timeout';
  }
  return 'stopped';
}

export async function readAutoSyncWatchStatus(
  paths = getAutoSyncWatchPaths(),
  deps: Partial<AutoSyncWatchControlDeps> = {},
): Promise<WatchStatusRecord> {
  const resolvedDeps = resolveWatchDeps(deps);
  const pid = await readPid(paths.pidPath);
  if (pid && !resolvedDeps.isProcessAlive(pid)) {
    return {
      state: 'stale',
      pid,
      message: 'pid file exists but process is not running',
      updatedAt: new Date().toISOString(),
    };
  }
  if (pid) {
    const stored = await readStatusFile(paths.statusPath);
    const owner = await readVerifiedWatchOwner(paths, pid, resolvedDeps);
    if (owner.ok === false) {
      return {
        ...stored,
        state: 'error',
        pid,
        message: owner.reason,
        updatedAt: new Date().toISOString(),
      };
    }
    if (stored?.state === 'error') {
      return {
        ...stored,
        pid,
        ownerId: owner.owner.ownerId,
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      ...stored,
      state:
        stored?.state === 'cancelling' || stored?.state === 'stopping' ? stored.state : 'running',
      pid,
      ownerId: owner.owner.ownerId,
      updatedAt: new Date().toISOString(),
    };
  }
  const stored = await readStatusFile(paths.statusPath);
  return stored ?? { state: 'stopped', updatedAt: new Date().toISOString() };
}

function isSafeWatchOwnerId(ownerId: string): boolean {
  return (
    ownerId === path.basename(ownerId) &&
    !ownerId.includes('..') &&
    !ownerId.includes('/') &&
    !ownerId.includes('\\')
  );
}

async function readOwnerFile(ownerPath: string): Promise<WatchOwnerRecord | undefined> {
  try {
    const raw = await fs.readFile(ownerPath, 'utf-8');
    const parsed = JSON.parse(raw) as WatchOwnerRecord;
    if (
      parsed &&
      typeof parsed === 'object' &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.ownerId === 'string' &&
      parsed.ownerId &&
      isSafeWatchOwnerId(parsed.ownerId) &&
      typeof parsed.processStartTime === 'string' &&
      parsed.processStartTime
    ) {
      return parsed;
    }
    return undefined;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

async function readVerifiedWatchOwner(
  paths: AutoSyncWatchPaths,
  pid: number,
  deps: AutoSyncWatchControlDeps,
): Promise<{ ok: true; owner: WatchOwnerRecord } | { ok: false; reason: string }> {
  const [status, owner] = await Promise.all([
    readStatusFile(paths.statusPath),
    readOwnerFile(paths.ownerPath),
  ]);
  if (!owner) return { ok: false, reason: 'watch owner is missing or invalid' };
  if (!status) return { ok: false, reason: 'watch status is missing or invalid' };
  if (owner.pid !== pid) return { ok: false, reason: 'watch owner pid does not match pid file' };
  if (status.pid !== pid) return { ok: false, reason: 'watch status pid does not match pid file' };
  if (!status.ownerId || status.ownerId !== owner.ownerId) {
    return { ok: false, reason: 'watch status owner does not match watch owner' };
  }
  const identityError = getWatchProcessIdentityError(owner, deps);
  if (identityError) return { ok: false, reason: identityError };
  return { ok: true, owner };
}

function getWatchProcessIdentityError(
  owner: WatchOwnerRecord,
  deps: AutoSyncWatchControlDeps,
): string | undefined {
  const processStartTime = deps.readProcessStartTime(owner.pid);
  if (!processStartTime) return 'unable to verify process start time';
  if (processStartTime !== owner.processStartTime) return 'pid belongs to a different process';
  const command = deps.readProcessCommand(owner.pid);
  if (!command) return 'unable to verify process command';
  if (
    !/(?:^|\s)(?:watch|auto-sync)(?:\s|$)/.test(command) ||
    !/(?:gitnexus|[\\/]cli[\\/]index\.(?:ts|[cm]?js))/.test(command)
  ) {
    return 'pid command is not a GitNexus auto-sync process';
  }
  return undefined;
}

async function waitForProcessExit(
  pid: number,
  options: {
    deps: AutoSyncWatchControlDeps;
    timeoutMs: number;
    pollMs: number;
    processStartTime?: string;
  },
): Promise<boolean> {
  // A bare liveness poll cannot tell "still running" from "exited, and the OS
  // handed the pid to something else" — so a reused pid would keep us waiting
  // on an unrelated process and then report the watch stopped once THAT exits.
  // The start time identifies the process behind the number.
  const isOriginalProcessAlive = () => {
    if (!options.deps.isProcessAlive(pid)) return false;
    if (!options.processStartTime) return true;
    const startTime = options.deps.readProcessStartTime(pid);
    return startTime === undefined || startTime === options.processStartTime;
  };
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (!isOriginalProcessAlive()) return true;
    await options.deps.sleep(options.pollMs);
  }
  return !isOriginalProcessAlive();
}

async function readPid(pidPath: string): Promise<number | undefined> {
  try {
    const raw = await fs.readFile(pidPath, 'utf-8');
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function readStatusFile(statusPath: string): Promise<WatchStatusRecord | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(statusPath, 'utf-8')) as WatchStatusRecord;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return {
      state: 'error',
      message: `unable to read status file: ${(err as Error).message}`,
      updatedAt: new Date().toISOString(),
    };
  }
}

function stopRequestPath(paths: AutoSyncWatchPaths, ownerId: string): string {
  if (!isSafeWatchOwnerId(ownerId)) {
    throw new Error('watch ownerId is not a safe filename component');
  }
  return path.join(path.dirname(paths.pidPath), `watch.stop.${ownerId}.json`);
}

async function readStopRequest(filePath: string): Promise<WatchStopRequestRecord | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8')) as WatchStopRequestRecord;
    if (
      parsed &&
      typeof parsed === 'object' &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.ownerId === 'string' &&
      parsed.ownerId &&
      typeof parsed.processStartTime === 'string' &&
      parsed.processStartTime &&
      typeof parsed.requestedAt === 'string' &&
      parsed.requestedAt
    ) {
      return parsed;
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
  }
  return undefined;
}

async function writeWatchStatus(
  paths: AutoSyncWatchPaths,
  record: WatchStatusRecord,
): Promise<void> {
  await fs.mkdir(path.dirname(paths.statusPath), { recursive: true });
  const tmpPath = `${paths.statusPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  await fs.rename(tmpPath, paths.statusPath);
}

async function writeWatchOwner(paths: AutoSyncWatchPaths, record: WatchOwnerRecord): Promise<void> {
  await writeAtomicText(paths.ownerPath, `${JSON.stringify(record, null, 2)}\n`);
}

async function cleanupWatchFiles(
  paths: AutoSyncWatchPaths,
  ownerId: string,
  releaseLock: () => Promise<void>,
): Promise<void> {
  try {
    const owner = await readOwnerFile(paths.ownerPath);
    if (owner?.ownerId === ownerId) {
      if ((await readPid(paths.pidPath)) === owner.pid) await removeIfExists(paths.pidPath);
      if ((await readOwnerFile(paths.ownerPath))?.ownerId === ownerId) {
        await removeIfExists(paths.ownerPath);
      }
      await removeIfExists(stopRequestPath(paths, ownerId));
    }
  } finally {
    await releaseLock();
  }
}

async function writeAtomicText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, filePath);
}

async function removeIfExists(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(
    () => true,
    () => false,
  );
}

function resolveWatchDeps(deps: Partial<AutoSyncWatchControlDeps> = {}): AutoSyncWatchControlDeps {
  return {
    isProcessAlive: deps.isProcessAlive ?? isProcessAlive,
    readProcessCommand:
      deps.readProcessCommand ??
      ((pid) => {
        try {
          const command =
            process.platform === 'win32'
              ? execFileSync(
                  'powershell.exe',
                  [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`,
                  ],
                  { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
                ).trim()
              : execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
                  encoding: 'utf-8',
                  stdio: ['ignore', 'pipe', 'ignore'],
                }).trim();
          return command || undefined;
        } catch {
          return undefined;
        }
      }),
    readProcessStartTime: deps.readProcessStartTime ?? readProcessStartTime,
    sleep:
      deps.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        })),
  };
}
