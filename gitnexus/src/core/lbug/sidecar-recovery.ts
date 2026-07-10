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

// LADYBUGDB-CONTRACT: matches @ladybugdb/core ^0.18.0 native error text.
// When bumping LadybugDB, re-validate this against the new error format
// — `git grep "LADYBUGDB-CONTRACT"` enumerates every version-coupled spot.
//
// Two native formats reach here for a genuinely-missing shadow sidecar:
//   POSIX:   `Cannot open file <path>.shadow: No such file or directory`
//   Windows: `Cannot open file. path: <path>.shadow - Error 2: <system text>`
// Windows OS text is localized on non-English installs (issue #2382 was filed
// from a non-English Windows), so we key on the locale-invariant Win32 code
// (2 = ERROR_FILE_NOT_FOUND), NOT the English phrase. The code is matched only
// in the reason AFTER the LAST `.shadow` token (the real failing sidecar; the
// reason text never contains `.shadow`), so a repo *path* containing e.g.
// `\error 2\` — even under a `.shadow`-suffixed parent directory — cannot trip
// it. Deliberate exclusions:
//   - `Error 3` (ERROR_PATH_NOT_FOUND): the #1811 non-ASCII path-garble
//     artifact (see lbug-config.ts) where the shadow is PRESENT on disk;
//     treating it as missing would quarantine a live WAL — data loss.
//   - `Error 5` / `Error 32` / POSIX `Permission denied`: present-but-locked;
//     handled as permission/lock classes, must not quarantine.
// The quarantine path adds a present-shadow disk check as a belt (see
// refuseLargeWalQuarantine in lbug-adapter.ts).
//
// The Windows branch is derived from the issue #2382 reported string, not a
// self-produced live crash; unit/consumer tests inject that same string, so
// GREEN TESTS DO NOT PROVE the byte-exact 0.18.0 Windows format — confirm
// against a real Windows run before closing #2382.
export const isMissingShadowSidecarError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/cannot open file/i.test(msg)) return false;
  // Anchor on the LAST `.shadow`, not the first: LadybugDB names the failing
  // sidecar as the final `.shadow` token and its reason text (POSIX
  // `: No such file or directory` / Windows ` - Error N: ...`) never contains
  // `.shadow`. Slicing from the last match isolates the true reason, so an
  // earlier `.shadow`-suffixed path segment (e.g. a `branch=subdir` directory
  // like `snap.shadow\`) can't shift the anchor and let a path-embedded
  // `error 2` be read as the Win32 code (issue #2382 review, Finding A).
  const lastShadow = [...msg.matchAll(/\.shadow\b/gi)].at(-1);
  if (lastShadow?.index === undefined) return false;
  const reason = msg.slice(lastShadow.index);
  return /no such file or directory/i.test(reason) || /\berror\s+2\b/i.test(reason);
};

// LADYBUGDB-CONTRACT: matches @ladybugdb/core ^0.18.0 native error text.
// When bumping LadybugDB, re-validate this regex against the new error format
// — `git grep "LADYBUGDB-CONTRACT"` enumerates every version-coupled spot.
// Verified by upstream source/changelog diff only — a reliable cross-platform
// live trigger for a read-only shadow-replay state isn't practical to
// construct, so this matcher does not have live-trigger test coverage.
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

/**
 * Actionable message for the case where LadybugDB reports a "missing shadow"
 * but `inspectLbugSidecars` finds the `.shadow` PRESENT on disk — the open
 * failed on path reachability or a lock, not a genuinely-missing sidecar (issue
 * #2382 review, S2). Unlike `shadowSidecarRecoveryMessage` it does NOT tell the
 * operator to rebuild the index (the remedy is fixing the lock/path). Keeps the
 * `Original error:` tail so downstream `isMissingShadowSidecarError` recognition
 * still matches the wrapped error.
 */
export const presentShadowUnreachableMessage = (dbPath: string, err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    `LadybugDB checkpoint sidecar is present but unreachable for ${dbPath}. ` +
    'The .shadow file is on disk, so the open likely failed on path reachability or a file lock ' +
    '(antivirus, another process holding a handle, or a non-ASCII path) rather than a missing sidecar. ' +
    'Check filesystem access and locks; only run `gitnexus analyze --force <repo-path> --index-only` ' +
    'if the index is genuinely broken.' +
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

/**
 * Reject the WAL-quarantine path when discarding the WAL would be unsafe or
 * wrong. Shared by every reactive missing-shadow recovery consumer — serve (via
 * lbug-adapter's `refuseLargeWalQuarantine`) and the MCP/wiki/augmentation pool
 * (via pool-adapter's `tryQuarantineForMissingShadow`) — so the quarantine
 * safety policy has a single source of truth (issue #2382 review, Finding B).
 *
 *   1. `wal-with-shadow` — the `.shadow` sidecar is PRESENT on disk. A
 *      "missing shadow" error alongside a present shadow means the open failed
 *      on path reachability or a lock (the #1811 non-ASCII path-garble on
 *      Windows), not a genuinely-missing shadow; quarantining would move a live
 *      WAL sitting next to its shadow — data loss.
 *   2. `orphan-wal` — the orphan WAL is too large to safely discard
 *      (>TINY_ORPHAN_WAL_BYTES); preserve the uncheckpointed pages for explicit
 *      operator recovery.
 *
 * Throws `shadowSidecarRecoveryMessage` in either case. Returns silently only
 * when the shadow is absent AND the WAL is absent or tiny — the states where
 * the existing recovery path is safe to proceed. `mode` is a label used only in
 * the warning text (e.g. 'read-only', 'writable', 'pool read-only recovery').
 */
export const guardWalQuarantine = async (
  dbPath: string,
  mode: string,
  triggeringErr: unknown,
  logger: SidecarRecoveryLogger,
): Promise<void> => {
  const state = await inspectLbugSidecars(dbPath);
  if (state.kind === 'wal-with-shadow') {
    warnOnce(
      logger,
      `${dbPath}:present-shadow-refuse:${mode}`,
      `GitNexus: refusing to quarantine WAL at ${dbPath}.wal during ${mode} recovery — ` +
        'the .shadow sidecar is present on disk, so the open likely failed on path reachability or a lock ' +
        'rather than a missing shadow. Run `gitnexus analyze --force <repo-path> --index-only` if the index is genuinely broken.',
    );
    throw new Error(presentShadowUnreachableMessage(dbPath, triggeringErr));
  }
  if (state.kind === 'orphan-wal') {
    warnOnce(
      logger,
      `${dbPath}:large-wal-refuse:${mode}`,
      `GitNexus: refusing to quarantine large WAL (${state.walBytes} bytes) at ${dbPath}.wal during ${mode} recovery; ` +
        'manual recovery required — run `gitnexus analyze --force <repo-path> --index-only`.',
    );
    throw new Error(shadowSidecarRecoveryMessage(dbPath, triggeringErr));
  }
};

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

/**
 * Corrected parking-failure warning (tri-review 4669518496 P2-3). The old
 * text promised "the rebuild will wipe it in place instead" — false: the
 * recovery run's pre-wipe DB open would replay the poisoned WAL and die
 * before any wipe could happen. Mirrors {@link renameFailureMessage}'s
 * EBUSY/EPERM framing: the problem is environmental (file lock, AV), not
 * data integrity — fix the lock and re-run.
 */
const sidecarParkRefusedWarning = (from: string, err: unknown): string =>
  `Warning: could not park ${path.basename(from)} aside before the recovery rebuild ` +
  `(${err instanceof Error ? err.message : String(err)}). Another process likely holds an ` +
  'open handle on it — stop any GitNexus MCP or serve process using this repository, add an ' +
  'antivirus exclusion for the index directory if needed, then re-run `gitnexus analyze`.';

/**
 * The sidecar family parked by {@link quarantineSidecarsForDirtyRecovery}
 * and enumerated by {@link listParkedDirtyRecoverySidecars} — one shared
 * roster so the park and clean surfaces cannot drift apart (tri-review
 * 4669518496 P2-7).
 */
const DIRTY_RECOVERY_SIDECAR_SUFFIXES = ['.wal', '.shadow'] as const;

/**
 * Move the WAL/shadow sidecars aside before a dirty-flag recovery rebuild
 * (#2409 defect 2).
 *
 * When `incrementalInProgress` forces a full rebuild, the previous run
 * died mid-writeback — its WAL can be poisoned in a way that natively
 * kills the process on replay. The recovery run used to open the DB
 * BEFORE the rebuild wipe (the embedding-cache preservation open), replay
 * the poisoned WAL, and die on the spot — so recovery never happened and
 * only a manual rename-aside of the index dir escaped the loop. The
 * rebuild discards every pending WAL byte anyway (the DB files are wiped),
 * so parking the sidecars first costs nothing and makes every subsequent
 * open replay-free.
 *
 * Renamed, never deleted, so the bytes stay available for post-mortem
 * debugging — and, like {@link quarantineWalForMissingShadow}'s quarantine
 * files, the parked copies are surfaced and removable by
 * `gitnexus clean --lbug-sidecars` (tri-review 4669518496 P2-7; before
 * that, this comment claimed a "same philosophy" parity while the
 * dirty-recovery files were invisible to every cleanup surface). Real
 * lifecycle: the destinations are the two FIXED names — no timestamp, see
 * {@link listParkedDirtyRecoverySidecars} — so each new crash overwrites
 * the previous parked copy, capping accumulation at one file per sidecar;
 * remove them via `clean --lbug-sidecars` or manually once their
 * post-mortem value has passed. Extreme double-failure corner (movable
 * source, locked stale copy): the bytes land at the `${to}.next` residue
 * name instead (logged when it happens) — the fixed-name listers do not
 * enumerate `.next` residues, so remove those manually.
 * Rename-first with a structural confirm probe (tri-review 4669518496
 * P2-3): the old shape pre-deleted a previous crash's parked copy on the
 * bet that the rename would then succeed — destroying the prior forensics
 * exactly when the source was locked and nothing replaced them. Now a
 * failed `rename(from, to)` is retried against the collision-free
 * `${to}.next` name: success proves the first failure was a Windows
 * rename-onto-existing collision (stale copy replaced — newest forensics
 * win); a second failure proves the source itself is locked, and the
 * previous parked copy is left INTACT. Per-suffix isolation: a `.wal`
 * failure never skips the `.shadow` attempt.
 *
 * @returns `moved` — destination paths now holding the parked bytes;
 * `failed` — source sidecars that could not be parked. A non-empty
 * `failed` means a possibly-poisoned sidecar still sits next to the DB:
 * the caller must not open the DB before the rebuild wipe (the open would
 * replay the WAL and die — there is no "wipe it in place" fallback) and
 * must keep the embedder out of the same locked/AV environment
 * (run-analyze derives its embedding mode in drop shape).
 */
export async function quarantineSidecarsForDirtyRecovery(
  dbPath: string,
  log: (message: string) => void,
): Promise<{ moved: string[]; failed: string[] }> {
  const moved: string[] = [];
  const failed: string[] = [];
  for (const suffix of DIRTY_RECOVERY_SIDECAR_SUFFIXES) {
    const from = `${dbPath}${suffix}`;
    const to = `${from}.dirty-recovery`;
    try {
      if (!(await statIfExists(from))) continue;
    } catch (err) {
      // Non-ENOENT stat failure (EPERM/EBUSY class — statIfExists swallows
      // ENOENT itself): assume the sidecar exists and is unreachable; the
      // caller must fail safe.
      failed.push(from);
      log(sidecarParkRefusedWarning(from, err));
      continue;
    }
    try {
      // Rename FIRST — never pre-delete the previous crash's parked copy on
      // the bet that this rename will then succeed (tri-review 4669518496
      // P2-3: the old rm-first shape destroyed the prior forensics exactly
      // when the source was locked and nothing replaced them).
      await fs.rename(from, to);
      moved.push(to);
      continue;
    } catch (err) {
      if (missing(err)) continue; // source raced away between stat and rename
      // Structural confirm probe: a bare "does `to` exist?" check cannot
      // discriminate a Windows rename-onto-existing collision from a locked
      // source that happens to have a leftover parked copy. Renaming the
      // source to a collision-free name can — if it succeeds, the source was
      // movable and the first failure was the collision.
      const probe = `${to}.next`;
      try {
        await fs.rename(from, probe);
      } catch (probeErr) {
        if (missing(probeErr)) continue; // source raced away mid-probe
        // The source itself is locked: the previous crash's parked copy (if
        // any) stays INTACT for post-mortem; report so the caller degrades.
        failed.push(from);
        log(sidecarParkRefusedWarning(from, probeErr));
        continue;
      }
      try {
        // True collision — replace the stale parked copy: newest forensics win.
        await fs.rm(to, { force: true });
        await fs.rename(probe, to);
        moved.push(to);
      } catch {
        // Double failure: the stale copy is itself locked/undeletable. The
        // interrupted run's sidecar is already out of the replay path at the
        // probe name, so the recovery open stays safe — keep both files.
        moved.push(probe);
        log(
          `Warning: parked ${path.basename(from)} as ${path.basename(probe)} — the stale ` +
            `${path.basename(to)} from an earlier crash is locked and could not be replaced.`,
        );
      }
    }
  }
  if (moved.length > 0) {
    log(
      `Parked ${moved.map((p) => path.basename(p)).join(', ')} from the interrupted run ` +
        'so the recovery rebuild opens without replaying it.',
    );
  }
  return { moved, failed };
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

/**
 * List the `.dirty-recovery` sidecars parked beside `dbPath` by
 * {@link quarantineSidecarsForDirtyRecovery}, so `gitnexus clean
 * --lbug-sidecars` can surface them next to the missing-shadow quarantines
 * (tri-review 4669518496 P2-7 — they were previously invisible to every
 * cleanup surface). Exactly two fixed names can exist
 * (`<dbPath>.wal.dirty-recovery`, `<dbPath>.shadow.dirty-recovery`), so this
 * stats them directly instead of prefix-scanning the directory the way the
 * timestamped missing-shadow lister must. The rare `${to}.next` residue from
 * a double park failure is deliberately NOT enumerated — its presence means
 * the fixed name is locked, so unlinking around it would be misleading.
 *
 * Returns existing parked files as sorted absolute paths. Branch-scoped
 * index slots (`branches/<slug>/`) are outside `clean.ts`'s flat-path
 * resolution — the same documented limitation as the missing-shadow pair.
 */
export async function listParkedDirtyRecoverySidecars(dbPath: string): Promise<string[]> {
  const present: string[] = [];
  for (const suffix of DIRTY_RECOVERY_SIDECAR_SUFFIXES) {
    const parked = `${dbPath}${suffix}.dirty-recovery`;
    if (await statIfExists(parked)) present.push(parked);
  }
  return present.sort();
}

/**
 * Delete the `.dirty-recovery` parked sidecars for `dbPath` and return the
 * deleted paths. Sibling of {@link cleanQuarantinedMissingShadowWals} —
 * `clean.ts` concatenates both families (tri-review 4669518496 P2-7).
 */
export async function cleanParkedDirtyRecoverySidecars(dbPath: string): Promise<string[]> {
  const files = await listParkedDirtyRecoverySidecars(dbPath);
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
