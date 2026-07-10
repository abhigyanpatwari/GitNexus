import fs from 'fs/promises';
import path from 'path';
import {
  HANDLE_RELEASE_PROBE_ATTEMPTS,
  HANDLE_RELEASE_PROBE_DELAY_MS,
  sleep,
} from './lbug-config.js';

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
 * Canonical remediation guidance for the LadybugDB file-lock class
 * (EBUSY/EPERM/EACCES — an MCP/serve process holding the index, or an
 * antivirus scan). One exported producer (this shipping review, FIX 7):
 * the dirty-recovery park warning below, `LbugWipeError`'s message builder
 * (lbug-adapter.ts) and {@link renameFailureMessage} previously carried
 * three divergent hand-written copies of the same advice.
 *
 * `rerun` names the command to retry once the lock clears — the analyze
 * wipe/park surfaces re-run the analyze; the read-path quarantine surface
 * re-runs whatever command failed. No trailing period: callers own the
 * sentence end.
 */
export const lbugLockRemediation = (rerun = 're-run `gitnexus analyze`'): string =>
  'stop any GitNexus MCP or serve process using this repository, add an antivirus ' +
  `exclusion for the GitNexus storage directory, then ${rerun}`;

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
      'The index does not need to be rebuilt — ' +
      // Shared remediation copy (FIX 7); this surface serves read paths too,
      // so the re-run target is the failing command, not the analyze.
      `${lbugLockRemediation('re-run the failing command once the lock or permission is resolved')}.` +
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
 * EBUSY/EPERM framing via the shared {@link lbugLockRemediation} copy
 * (FIX 7): the problem is environmental (file lock, AV), not data
 * integrity — fix the lock and re-run.
 */
const sidecarParkRefusedWarning = (from: string, err: unknown): string =>
  `Warning: could not park or remove ${path.basename(from)} before the recovery rebuild ` +
  `(${err instanceof Error ? err.message : String(err)}). Another process likely holds an ` +
  `open handle on it — ${lbugLockRemediation()}.`;

/**
 * The sidecar family parked by {@link quarantineSidecarsForDirtyRecovery}
 * and enumerated by {@link listParkedDirtyRecoverySidecars} — one shared
 * roster so the park and clean surfaces cannot drift apart (tri-review
 * 4669518496 P2-7).
 */
const DIRTY_RECOVERY_SIDECAR_SUFFIXES = ['.wal', '.shadow'] as const;

/**
 * Every fixed name the dirty-recovery park can leave beside `dbPath`: the
 * two `.dirty-recovery` destinations PLUS their `.next` probe residues
 * (this shipping review, FIX 5 — the residue used to be invisible to every
 * cleanup surface while the docs said "remove manually"). Single roster
 * authority for {@link listParkedDirtyRecoverySidecars}.
 */
const dirtyRecoveryParkedNames = (dbPath: string): string[] =>
  DIRTY_RECOVERY_SIDECAR_SUFFIXES.flatMap((suffix) => [
    `${dbPath}${suffix}.dirty-recovery`,
    `${dbPath}${suffix}.dirty-recovery.next`,
  ]);

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
 * Renamed when possible, so the bytes stay available for post-mortem
 * debugging — and, like {@link quarantineWalForMissingShadow}'s quarantine
 * files, the parked copies are surfaced and removable by
 * `gitnexus clean --lbug-sidecars` (tri-review 4669518496 P2-7; before
 * that, this comment claimed a "same philosophy" parity while the
 * dirty-recovery files were invisible to every cleanup surface). Real
 * lifecycle: the destinations are FIXED names — no timestamp, see
 * {@link listParkedDirtyRecoverySidecars} — so each new crash overwrites
 * the previous parked copy, capping accumulation at one file per sidecar;
 * remove them via `clean --lbug-sidecars` or manually once their
 * post-mortem value has passed.
 *
 * Escalation ladder per suffix (this shipping review, FIX 1 — replacing
 * the drop-shape design, whose park had ZERO retry while the wipe path
 * retried the very same lock class):
 *
 *   1. `rename(from, to)` retried over the shared handle-release budget
 *      (HANDLE_RELEASE_PROBE_ATTEMPTS × linear HANDLE_RELEASE_PROBE_DELAY_MS,
 *      lbug-config.ts) — a transient AV/handle-lag EBUSY must not cost the
 *      run anything.
 *   2. Structural confirm probe: a bare "does `to` exist?" check cannot
 *      discriminate a Windows rename-onto-existing collision from a locked
 *      source that happens to have a leftover parked copy. Renaming the
 *      source to the collision-free `${to}.next` can — success proves the
 *      failure was the collision, so the stale copy is replaced (newest
 *      forensics win). The crash window between the `rm(to)` and the final
 *      promote rename strands the bytes at `.next` — acceptable: `.next`
 *      residues are enumerated by the dirty-recovery lister and removed by
 *      `clean --lbug-sidecars` (FIX 5). Never pre-delete the previous
 *      crash's parked copy on the bet that a rename will then succeed
 *      (tri-review 4669518496 P2-3: the old rm-first shape destroyed the
 *      prior forensics exactly when the source was locked and nothing
 *      replaced them).
 *   3. rm-fallback: the source itself is locked for RENAME, but Windows
 *      lets some holders' files be unlink-marked — retry
 *      `rm(from, {force:true})` over the same budget and require the file
 *      verifiably GONE. Success eliminates the replay risk at the cost of
 *      the post-mortem forensics (logged exactly so).
 *   4. Report in `failed` with the corrected lock guidance — the caller
 *      must abort (run-analyze throws a LbugWipeError in seconds instead
 *      of running the whole pipeline and dying at the wipe on the same
 *      handle).
 *
 * Per-suffix isolation: a `.wal` failure never skips the `.shadow`
 * attempt.
 *
 * INVARIANT: after this function returns, either no original sidecar
 * remains adjacent to the DB — every entry is in `moved` or `removed`, so
 * every subsequent open this run performs is replay-free — or the entry is
 * in `failed` and the caller MUST abort before any DB open.
 *
 * @returns `moved` — destination paths now holding the parked bytes;
 * `removed` — source sidecars whose bytes are GONE (forensics lost, replay
 * risk eliminated); `failed` — source sidecars still in place: a
 * possibly-poisoned sidecar sits next to the DB and any pre-wipe open
 * would replay it and die (there is no "wipe it in place" fallback).
 */
export async function quarantineSidecarsForDirtyRecovery(
  dbPath: string,
  log: (message: string) => void,
): Promise<{ moved: string[]; removed: string[]; failed: string[] }> {
  const moved: string[] = [];
  const removed: string[] = [];
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

    // 1. Rename, retried over the shared handle-release budget for the
    //    transient lock class only (EACCES/EPERM/EBUSY — an AV scan or
    //    handle-release lag clears within it; a structural failure like
    //    EEXIST goes straight to the confirm probe).
    let outcome: 'moved' | 'raced' | 'rename-failed' = 'rename-failed';
    let renameErr: unknown;
    for (let attempt = 1; attempt <= HANDLE_RELEASE_PROBE_ATTEMPTS; attempt++) {
      try {
        await fs.rename(from, to);
        outcome = 'moved';
        break;
      } catch (err) {
        if (missing(err)) {
          outcome = 'raced'; // source raced away between stat and rename
          break;
        }
        renameErr = err;
        if (!isPermissionRenameError(err) || attempt === HANDLE_RELEASE_PROBE_ATTEMPTS) break;
        await sleep(HANDLE_RELEASE_PROBE_DELAY_MS * attempt);
      }
    }
    if (outcome === 'moved') {
      moved.push(to);
      continue;
    }
    if (outcome === 'raced') continue;

    // 2. Structural confirm probe (see TSDoc step 2).
    const probe = `${to}.next`;
    let probeLanded = false;
    try {
      await fs.rename(from, probe);
      probeLanded = true;
    } catch (probeErr) {
      if (missing(probeErr)) continue; // source raced away mid-probe
      // Source locked for rename — fall through to the rm-fallback below.
    }
    if (probeLanded) {
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
      continue;
    }

    // 3. rm-fallback, retried over the same budget. `force: true` swallows
    //    ENOENT, so a resolving rm proves nothing on Windows (delete-pending
    //    keeps the name visible) — only a verifiably-absent file counts.
    let removedOk = false;
    for (let attempt = 1; attempt <= HANDLE_RELEASE_PROBE_ATTEMPTS; attempt++) {
      try {
        await fs.rm(from, { force: true });
      } catch {
        /* verified below — the absence probe is authoritative */
      }
      let stillPresent = true;
      try {
        stillPresent = (await statIfExists(from)) !== null;
      } catch {
        // Non-ENOENT stat failure: not verifiably gone — keep retrying.
      }
      if (!stillPresent) {
        removedOk = true;
        break;
      }
      if (attempt < HANDLE_RELEASE_PROBE_ATTEMPTS) {
        await sleep(HANDLE_RELEASE_PROBE_DELAY_MS * attempt);
      }
    }
    if (removedOk) {
      removed.push(from);
      log(
        `Removed ${path.basename(from)} from the interrupted run — it could not be parked ` +
          'aside (rename locked), so its bytes were deleted instead: post-mortem forensics ' +
          'are lost, but the replay risk is eliminated and recovery can proceed.',
      );
      continue;
    }

    // 4. Everything failed — the poisoned bytes still sit next to the DB.
    failed.push(from);
    log(sidecarParkRefusedWarning(from, renameErr));
  }
  if (moved.length > 0) {
    log(
      `Parked ${moved.map((p) => path.basename(p)).join(', ')} from the interrupted run ` +
        'so the recovery rebuild opens without replaying it.',
    );
  }
  return { moved, removed, failed };
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

/**
 * Shared unlink walker for the parked-sidecar cleaners (this shipping
 * review, FIX 5). Per-file error policy: ENOENT is skipped silently (a
 * list→delete race means the file is already gone — the desired state);
 * EBUSY/EPERM/anything else lands in `failed` and the walk CONTINUES —
 * the old per-family cleaners threw on the first locked file, crashing
 * the whole clean mid-command after a partial deletion.
 */
const unlinkParkedFiles = async (
  files: readonly string[],
): Promise<{ deleted: string[]; failed: string[] }> => {
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const file of files) {
    try {
      await fs.unlink(file);
      deleted.push(file);
    } catch (err) {
      if (missing(err)) continue;
      failed.push(file);
    }
  }
  return { deleted, failed };
};

/**
 * Delete the missing-shadow WAL quarantines for `dbPath` and return the
 * deleted paths. Locked files are skipped, not thrown (FIX 5) — user-facing
 * surfaces should call {@link cleanParkedLbugSidecars}, which also REPORTS
 * the skipped files.
 */
export async function cleanQuarantinedMissingShadowWals(dbPath: string): Promise<string[]> {
  return (await unlinkParkedFiles(await listQuarantinedMissingShadowWals(dbPath))).deleted;
}

/**
 * List the `.dirty-recovery` sidecars parked beside `dbPath` by
 * {@link quarantineSidecarsForDirtyRecovery}, so `gitnexus clean
 * --lbug-sidecars` can surface them next to the missing-shadow quarantines
 * (tri-review 4669518496 P2-7 — they were previously invisible to every
 * cleanup surface). Only fixed names can exist (see
 * {@link dirtyRecoveryParkedNames}: `<dbPath>.wal.dirty-recovery`,
 * `<dbPath>.shadow.dirty-recovery`, and their `.next` probe residues from a
 * double park failure — enumerated since FIX 5 of this shipping review; the
 * docs used to say "remove manually" while no surface even listed them), so
 * this stats them directly instead of prefix-scanning the directory the way
 * the timestamped missing-shadow lister must.
 *
 * Returns existing parked files as sorted absolute paths. Branch-scoped
 * index slots (`branches/<slug>/`) are outside `clean.ts`'s flat-path
 * resolution — the same documented limitation as the missing-shadow pair.
 */
export async function listParkedDirtyRecoverySidecars(dbPath: string): Promise<string[]> {
  const present: string[] = [];
  for (const parked of dirtyRecoveryParkedNames(dbPath)) {
    if (await statIfExists(parked)) present.push(parked);
  }
  return present.sort();
}

/**
 * Delete the `.dirty-recovery` parked sidecars for `dbPath` and return the
 * deleted paths. Sibling of {@link cleanQuarantinedMissingShadowWals}; same
 * skip-not-throw policy (FIX 5) — user-facing surfaces should call
 * {@link cleanParkedLbugSidecars}, which also reports locked files.
 */
export async function cleanParkedDirtyRecoverySidecars(dbPath: string): Promise<string[]> {
  return (await unlinkParkedFiles(await listParkedDirtyRecoverySidecars(dbPath))).deleted;
}

/**
 * Aggregate roster of every parked/quarantined sidecar family beside
 * `dbPath` (this shipping review, FIX 5): the timestamped missing-shadow
 * WAL quarantines plus the fixed-name dirty-recovery parks (`.next`
 * residues included). Single roster authority for `clean --lbug-sidecars`
 * — the command previously concatenated the families inline in two places,
 * which is how the `.next` residue stayed invisible.
 */
export async function listParkedLbugSidecars(dbPath: string): Promise<string[]> {
  return [
    ...(await listQuarantinedMissingShadowWals(dbPath)),
    ...(await listParkedDirtyRecoverySidecars(dbPath)),
  ];
}

/**
 * Delete every file {@link listParkedLbugSidecars} enumerates. Per-file
 * error policy via {@link unlinkParkedFiles}: ENOENT skipped silently,
 * locked files collected into `failed` while the rest are still deleted —
 * a locked parked file must not crash the whole clean mid-command.
 */
export async function cleanParkedLbugSidecars(
  dbPath: string,
): Promise<{ deleted: string[]; failed: string[] }> {
  return unlinkParkedFiles(await listParkedLbugSidecars(dbPath));
}

export const _resetSidecarRecoveryWarningsForTest = (): void => {
  warnedKeyCounts.clear();
};
