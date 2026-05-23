import fs from 'fs/promises';
import path from 'path';

export type LbugSidecarState =
  | { kind: 'clean'; dbPath: string }
  | { kind: 'wal-with-shadow'; dbPath: string; walBytes: number; shadowBytes: number }
  | { kind: 'tiny-orphan-wal'; dbPath: string; walBytes: number }
  | { kind: 'orphan-wal'; dbPath: string; walBytes: number }
  | { kind: 'orphan-shadow'; dbPath: string; shadowBytes: number };

export interface SidecarRecoveryLogger {
  warn: (message: string) => void;
  info?: (message: string) => void;
  debug?: (message: string) => void;
}

export const TINY_ORPHAN_WAL_BYTES = 4 * 1024;

/**
 * Counter-based warn anti-spam (PR #1747 review, Finding 6).
 *
 * The previous design (`warnedKeys: Set<string>`) warned exactly once per key
 * per process and silently downgraded all subsequent occurrences to debug. In
 * a long-lived `gitnexus serve` process touching the same dbPath repeatedly,
 * a persistent condition produced one warn at the first occurrence and then
 * 99+ silent debug lines — invisible to operators reading warn-level logs.
 *
 * The counter-based design warns on logarithmic milestones so persistence
 * stays visible. Geometric spacing keeps total warn count bounded at O(log N)
 * for a condition that fires N times.
 */
const warnedKeyCounts = new Map<string, number>();

const WARN_MILESTONES = [1, 10, 100, 1000, 10000] as const;

const ordinal = (n: number): string => {
  switch (n) {
    case 1:
      return '1st';
    case 10:
      return '10th';
    case 100:
      return '100th';
    case 1000:
      return '1000th';
    case 10000:
      return '10000th';
    default:
      return `${n}th`;
  }
};

export const isMissingFsError = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

const missing = isMissingFsError;

const sidecarPreflightDisabled = (): boolean =>
  /^(1|true|yes|on)$/i.test(process.env.GITNEXUS_DISABLE_LBUG_SIDECAR_PREFLIGHT ?? '');

export const statIfExists = async (filePath: string): Promise<{ size: number } | null> => {
  try {
    const statFn = (fs as typeof fs & { stat?: typeof fs.stat }).stat;
    if (typeof statFn === 'function') {
      const stat = await statFn(filePath);
      return { size: stat.size };
    }
    // Some focused unit tests provide a deliberately tiny fs mock. Treat a
    // path as present only when access succeeds, with an unknown/zero size.
    await fs.access(filePath);
    return { size: 0 };
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
};

const logDebug = (logger: SidecarRecoveryLogger, message: string): void => {
  if (logger.debug) logger.debug(message);
};

const logInfo = (logger: SidecarRecoveryLogger, message: string): void => {
  if (logger.info) logger.info(message);
  else logDebug(logger, message);
};

/**
 * Log at warn-level on logarithmic milestone occurrences (1st, 10th, 100th,
 * 1000th, 10000th); debug-level otherwise. Past the first occurrence the warn
 * message is suffixed with the occurrence count so operators can see the
 * condition's persistence at a glance.
 *
 * The signature and key convention (`${dbPath}:suffix`) are unchanged from the
 * previous warn-once implementation — call sites need no edits.
 */
const warnOnce = (logger: SidecarRecoveryLogger, key: string, message: string): void => {
  const next = (warnedKeyCounts.get(key) ?? 0) + 1;
  warnedKeyCounts.set(key, next);
  const isMilestone = (WARN_MILESTONES as readonly number[]).includes(next);
  if (!isMilestone) {
    logDebug(logger, message);
    return;
  }
  if (next === 1) {
    logger.warn(message);
    return;
  }
  logger.warn(`${message} (${ordinal(next)} occurrence of this condition)`);
};

// LADYBUGDB-CONTRACT: matches @ladybugdb/core ^0.16.1 native error text.
// When bumping LadybugDB, re-validate this regex against the new error format
// — `git grep "LADYBUGDB-CONTRACT"` enumerates every version-coupled spot.
export const isMissingShadowSidecarError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return /Cannot open file .*\.shadow: No such file or directory/i.test(msg);
};

// LADYBUGDB-CONTRACT: matches @ladybugdb/core ^0.16.1 native error text.
// When bumping LadybugDB, re-validate this regex against the new error format
// — `git grep "LADYBUGDB-CONTRACT"` enumerates every version-coupled spot.
export const isReadOnlyShadowReplayError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return /replay shadow pages under read-only mode/i.test(msg);
};

export const shadowSidecarRecoveryMessage = (dbPath: string, err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    `LadybugDB checkpoint sidecar is missing for ${dbPath}. ` +
    'Rebuild the index with `gitnexus analyze --force <repo-path> --index-only` and restart `gitnexus serve`.' +
    `\n  Original error: ${msg.slice(0, 200)}`
  );
};

const PERMISSION_RENAME_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);

export const isPermissionRenameError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && PERMISSION_RENAME_CODES.has(code);
};

/**
 * Classify a failure surfaced by quarantine rename into an actionable user-facing
 * message.
 *
 * - EACCES / EPERM / EBUSY → permission-specific message pointing at filesystem
 *   ACLs, AV exclusions, and file-locks. Importantly does NOT instruct the user
 *   to rebuild the index — the underlying problem is environmental, not data
 *   integrity, and re-running after fixing the lock/permission will succeed.
 * - Everything else (including the LadybugDB "Cannot open file *.shadow"
 *   missing-shadow error, ENOSPC, EROFS, EIO, and any other thrown Error) →
 *   falls back to `shadowSidecarRecoveryMessage`, preserving today's behavior.
 *
 * Use at caller catches around `quarantineWalForMissingShadow` and any other
 * path where an `fs.rename`-class failure may surface to operators.
 */
export const renameFailureMessage = (dbPath: string, err: unknown): string => {
  if (isPermissionRenameError(err)) {
    const code = (err as NodeJS.ErrnoException).code;
    const msg = err instanceof Error ? err.message : String(err);
    return (
      `GitNexus could not move the LadybugDB WAL sidecar at ${dbPath}.wal because of a ` +
      `filesystem permission or file-lock error (${code}). ` +
      'Check filesystem ACLs, antivirus exclusions for the index directory, and ' +
      'whether another process holds an open handle on the file. ' +
      'The index does not need to be rebuilt — re-running the failing command after ' +
      'resolving the lock or permission should succeed.' +
      `\n  Original error: ${msg.slice(0, 200)}`
    );
  }
  return shadowSidecarRecoveryMessage(dbPath, err);
};

export async function inspectLbugSidecars(dbPath: string): Promise<LbugSidecarState> {
  const wal = await statIfExists(`${dbPath}.wal`);
  const shadow = await statIfExists(`${dbPath}.shadow`);

  if (wal && shadow) {
    return { kind: 'wal-with-shadow', dbPath, walBytes: wal.size, shadowBytes: shadow.size };
  }
  if (wal) {
    if (wal.size <= TINY_ORPHAN_WAL_BYTES) {
      return { kind: 'tiny-orphan-wal', dbPath, walBytes: wal.size };
    }
    return { kind: 'orphan-wal', dbPath, walBytes: wal.size };
  }
  if (shadow) {
    return { kind: 'orphan-shadow', dbPath, shadowBytes: shadow.size };
  }
  return { kind: 'clean', dbPath };
}

export async function quarantineWalForMissingShadow(
  dbPath: string,
  options: {
    logger: SidecarRecoveryLogger;
    level?: 'debug' | 'info' | 'warn';
    reason?: string;
  },
): Promise<string> {
  const walPath = `${dbPath}.wal`;
  const quarantinePath = `${walPath}.missing-shadow.${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  await fs.rename(walPath, quarantinePath);

  const message =
    `GitNexus: quarantined WAL ${path.basename(quarantinePath)} because LadybugDB shadow sidecar was missing; ` +
    `continuing from last checkpoint${options.reason ? ` (${options.reason})` : ''}`;

  if (options.level === 'warn') {
    warnOnce(options.logger, `${dbPath}:missing-shadow-quarantine`, message);
  } else if (options.level === 'info') {
    logInfo(options.logger, message);
  } else {
    logDebug(options.logger, message);
  }

  return quarantinePath;
}

export async function preflightLbugSidecars(
  dbPath: string,
  options: {
    mode: 'read-only' | 'write';
    logger: SidecarRecoveryLogger;
    allowQuarantine: boolean;
  },
): Promise<LbugSidecarState> {
  let state: LbugSidecarState;
  try {
    state = await inspectLbugSidecars(dbPath);
  } catch (err) {
    logDebug(
      options.logger,
      `GitNexus: unable to inspect LadybugDB sidecars before ${options.mode} open; continuing without preflight repair: ${(err as Error).message}`,
    );
    return { kind: 'clean', dbPath };
  }
  if (sidecarPreflightDisabled() || !options.allowQuarantine) return state;

  if (state.kind === 'tiny-orphan-wal') {
    await quarantineWalForMissingShadow(dbPath, {
      logger: options.logger,
      level: 'debug',
      reason: `${options.mode} preflight tiny orphan WAL (${state.walBytes} bytes)`,
    });
    return inspectLbugSidecars(dbPath);
  }

  if (state.kind === 'orphan-wal') {
    warnOnce(
      options.logger,
      `${dbPath}:orphan-wal-preflight:${options.mode}`,
      `GitNexus: found ${state.walBytes} byte lbug.wal without lbug.shadow before ${options.mode} open; ` +
        'will rely on LadybugDB replay/recovery instead of deleting pending WAL data.',
    );
  }

  return state;
}

export async function finalizeLbugSidecarsAfterClose(
  dbPath: string,
  options: { logger: SidecarRecoveryLogger },
): Promise<void> {
  if (sidecarPreflightDisabled()) return;

  let state: LbugSidecarState;
  try {
    state = await inspectLbugSidecars(dbPath);
  } catch (err) {
    logDebug(
      options.logger,
      `GitNexus: unable to inspect LadybugDB sidecars after close; skipping post-close repair: ${(err as Error).message}`,
    );
    return;
  }
  if (state.kind === 'clean' || state.kind === 'wal-with-shadow') return;

  for (const delayMs of [25, 50, 100]) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      state = await inspectLbugSidecars(dbPath);
    } catch (err) {
      logDebug(
        options.logger,
        `GitNexus: unable to inspect LadybugDB sidecars after close; skipping post-close repair: ${(err as Error).message}`,
      );
      return;
    }
    if (state.kind === 'clean' || state.kind === 'wal-with-shadow') return;
  }

  if (state.kind === 'tiny-orphan-wal') {
    try {
      await quarantineWalForMissingShadow(dbPath, {
        logger: options.logger,
        level: 'debug',
        reason: `post-close tiny orphan WAL (${state.walBytes} bytes)`,
      });
    } catch (err) {
      if (!missing(err)) {
        warnOnce(
          options.logger,
          `${dbPath}:post-close-tiny-quarantine-failed`,
          `GitNexus: failed to quarantine tiny orphan WAL after close (${(err as Error).message}); next read may recover reactively.`,
        );
      }
    }
    return;
  }

  if (state.kind === 'orphan-wal') {
    warnOnce(
      options.logger,
      `${dbPath}:post-close-orphan-wal`,
      `GitNexus: lbug.wal (${state.walBytes} bytes) remains without lbug.shadow after close; ` +
        'keeping it for recovery. If this repeats, run `gitnexus analyze --force --index-only` or the sidecar repair command.',
    );
  }
}

export async function listQuarantinedMissingShadowWals(dbPath: string): Promise<string[]> {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (missing(err)) return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.startsWith(`${base}.wal.missing-shadow.`))
    .map((entry) => path.join(dir, entry))
    .sort();
}

export async function cleanQuarantinedMissingShadowWals(dbPath: string): Promise<string[]> {
  const files = await listQuarantinedMissingShadowWals(dbPath);
  const deleted: string[] = [];
  for (const file of files) {
    await fs.unlink(file);
    deleted.push(file);
  }
  return deleted;
}

export const _resetSidecarRecoveryWarningsForTest = (): void => {
  warnedKeyCounts.clear();
};
