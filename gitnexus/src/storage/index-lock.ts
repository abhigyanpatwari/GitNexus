/**
 * Cross-process single-writer lock for a GitNexus index directory (#2658).
 *
 * `analyze` is the only writer of a `.gitnexus/` (or `branches/<slug>/`) slot,
 * but nothing stopped two `analyze` runs — e.g. two editor/agent SessionStart
 * hooks firing on the same repo at once — from wiping and rebuilding the same
 * store concurrently. They raced on `lbug` and its sidecars, wasted N× CPU
 * producing one index, and left orphaned WAL fragments (#2637). This module
 * gives the write path an exclusive, index-directory-scoped lock so a second
 * writer waits for the first instead of colliding; after acquiring, the caller
 * re-runs its normal freshness check, so a run whose work the holder already
 * did exits up-to-date rather than rebuilding (single-flight coalescing).
 *
 * Ownership lives with the process that runs the pipeline (the heap-respawn
 * child when a respawn happens, the original otherwise) — NOT a supervising
 * parent. The liveness pid in the lock record is therefore always the real
 * writer: if a supervising parent is SIGKILLed while an orphaned child keeps
 * writing, the lock stays valid (child pid alive) instead of looking dead and
 * inviting a second writer. See run-analyze.ts for the acquire site.
 *
 * Backend: an `O_EXCL` lock FILE holding a JSON record. This is deliberately a
 * behind-an-interface choice — a kernel advisory lock (`flock`/`LockFileEx`),
 * which the OS releases automatically on ANY exit, is the stronger end state
 * but needs a native dependency. `acquireIndexLock` is the seam: swap the
 * backend later without touching analyze orchestration. Final ownership is
 * always decided by the atomic `O_EXCL` create — the liveness/stale logic only
 * governs whether a *dead* holder's file may be removed first.
 *
 * Scope: cross-process, same logical index dir. Cross-HOST contention (a shared
 * network mount) is never force-stolen — a foreign hostname's lock is waited on,
 * never reclaimed — because pid liveness is meaningless across hosts. The
 * motivating case (local hook-driven re-index) is single-host.
 *
 * Waiting is bounded by a finite default timeout, not because a live holder
 * won't finish, but because a *reused* pid can masquerade as a live holder on
 * any platform without process start-time verification (everything but Linux).
 * The timeout stops waiting and errors — it never steals a possibly-live
 * holder — so a pid-reuse ghost costs a bounded wait, never a corrupt
 * double-write. See AcquireOptions.timeoutMs.
 */
import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  unlinkSync,
  renameSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';

const LOCK_FILENAME = 'analyze.lock';
const LOCK_RECORD_VERSION = 1 as const;

/** Base poll interval while waiting for a live holder; jittered per attempt. */
const DEFAULT_POLL_MS = 250;
/** How often to re-emit the "still waiting for pid N" diagnostic. */
const DIAGNOSTIC_INTERVAL_MS = 15_000;
/**
 * Default wait ceiling (10 min). Generous enough to sit behind a normal
 * analyze, finite so a pid-reuse ghost on a platform without start-time
 * verification can't wedge acquisition forever (see AcquireOptions.timeoutMs).
 * A repo whose analyze legitimately runs longer can raise
 * GITNEXUS_INDEX_LOCK_TIMEOUT_MS (or set it ≤ 0 for unbounded).
 */
const DEFAULT_TIMEOUT_MS = 600_000;
/**
 * How long a lock file must stay unreadable (empty/partial JSON) before we
 * treat it as a crash orphan and reclaim it. Tolerates the microsecond
 * create→write→close window of a *live* owner (see acquireIndexLock), so we
 * never steal a lock that is a poll-interval away from being written. Scaled
 * off the poll interval, floored at 1s.
 */
const malformedGraceMs = (pollMs: number): number => Math.max(1000, pollMs * 2);

/**
 * On-disk lock record. `token` proves ownership on release/steal; `startTime`
 * (Linux only) defends against pid reuse; `invocationId` is a human-traceable
 * id distinct from the security-irrelevant `token`.
 */
export interface LockRecord {
  v: typeof LOCK_RECORD_VERSION;
  pid: number;
  hostname: string;
  /** /proc/<pid>/stat starttime (clock ticks) on Linux; null where unavailable. */
  startTime: string | null;
  token: string;
  invocationId: string;
  acquiredAt: string;
}

export interface IndexLockHandle {
  /** Our own record — `invocationId` is shown to waiters as the holder id. */
  readonly record: LockRecord;
  /** Idempotent; only removes the lock file if it still carries our token. */
  release(): void;
}

export interface AcquireOptions {
  log?: (msg: string) => void;
  /**
   * Give up waiting after this long (ms), throwing {@link IndexLockTimeoutError}.
   * Default: {@link DEFAULT_TIMEOUT_MS} ({@link resolveTimeoutMs}). A finite
   * default is deliberate: on platforms without process start-time verification
   * (anything but Linux — see {@link readProcStartTime}) a crashed holder whose
   * pid was reused by an unrelated long-lived process reads as a live holder and
   * would otherwise block acquisition forever. Timing out is safe — it stops
   * *waiting*, never *steals* a possibly-live holder — and names the holder so
   * the caller can retry. Override (including to unbounded, value ≤ 0) via
   * GITNEXUS_INDEX_LOCK_TIMEOUT_MS.
   */
  timeoutMs?: number;
  /** Base poll interval (ms); jittered. Default 250. */
  pollMs?: number;
  /** Called once when we start waiting on a live holder. */
  onWaitStart?: (holder: LockRecord) => void;
}

export class IndexLockTimeoutError extends Error {
  readonly holder: LockRecord;
  constructor(holder: LockRecord, waitedMs: number) {
    super(
      `Timed out after ${waitedMs}ms waiting for another gitnexus analyze ` +
        `(pid ${holder.pid} on ${holder.hostname}, invocation ${holder.invocationId}) ` +
        `to release the index lock.`,
    );
    this.name = 'IndexLockTimeoutError';
    this.holder = holder;
  }
}

const HOSTNAME = os.hostname();

/** Linux: field 22 of /proc/<pid>/stat (starttime). null elsewhere / on error. */
const readProcStartTime = (pid: number): string | null => {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) is parenthesized and may contain spaces/')' — split after
    // the last ')' so the remaining fields align to their documented numbers.
    const afterComm = stat
      .slice(stat.lastIndexOf(') ') + 2)
      .trim()
      .split(' ');
    // afterComm[0] is field 3 (state); starttime is field 22 → index 19.
    return afterComm[19] ?? null;
  } catch {
    return null;
  }
};

/** true if the pid exists (signal 0). EPERM means it exists but isn't ours. */
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const buildRecord = (): LockRecord => ({
  v: LOCK_RECORD_VERSION,
  pid: process.pid,
  hostname: HOSTNAME,
  startTime: readProcStartTime(process.pid),
  token: randomBytes(16).toString('hex'),
  invocationId: randomUUID(),
  acquiredAt: new Date().toISOString(),
});

const readRecord = (lockPath: string): LockRecord | null => {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string') return null;
    return parsed as LockRecord;
  } catch {
    // Missing (won the race, file gone) or malformed/half-written → treat as
    // "no readable holder"; the caller retries the O_EXCL create.
    return null;
  }
};

/**
 * A same-host holder is stale iff its process is gone, or (Linux) its pid is
 * alive but was reused — a different start time. A live holder is never stolen
 * on age alone (a large repo legitimately analyzes for many minutes), and a
 * foreign-host holder is never stale (its liveness is unknowable here). Where
 * start-time verification is unavailable (non-Linux), a reused pid cannot be
 * distinguished from a genuine live holder, so it is NOT stolen — the finite
 * acquire timeout is what bounds that case instead (see AcquireOptions).
 */
const isStale = (holder: LockRecord): boolean => {
  if (holder.hostname !== HOSTNAME) return false;
  if (!pidAlive(holder.pid)) return true;
  const now = readProcStartTime(holder.pid);
  if (holder.startTime && now && holder.startTime !== now) return true; // pid reused
  return false;
};

/**
 * Reclaim a lock file we judged stale (dead holder) or malformed (unreadable),
 * atomically. `rename` moves the exact inode aside in ONE syscall to a name
 * unique to us (`<lock>.dead.<our token>`), so when two waiters both try to
 * reclaim the same dead holder exactly one wins — the loser's `rename` fails
 * with ENOENT because the inode is already gone. This closes the check-then-
 * unlink TOCTOU where a waiter could `unlink` a *different* owner's freshly
 * O_EXCL-created lock. The aside file is then removed best-effort; the O_EXCL
 * create in the acquire loop remains the sole arbiter of new ownership.
 *
 * Returns true if we won the reclaim (caller retries the create), false if we
 * lost the race (caller re-loops and re-reads).
 */
const stealLock = (lockPath: string, me: LockRecord): boolean => {
  const aside = `${lockPath}.dead.${me.token}`;
  try {
    renameSync(lockPath, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; // another stealer won
    throw err;
  }
  try {
    unlinkSync(aside); // uniquely ours by token → safe; best-effort
  } catch {
    /* leftover .dead.<token> is inert (not analyze.lock, not swept) — harmless */
  }
  return true;
};

/**
 * Placeholder holder for an {@link IndexLockTimeoutError} thrown while the lock
 * file exists but no valid record can be read (malformed/partial), or it keeps
 * vanishing — there is no real holder to name, but the error still needs one so
 * the CLI's `err.holder.pid` stays defined. This path is a rare backstop:
 * malformed files are reclaimed within {@link MALFORMED_GRACE_MS}.
 */
const unknownHolder = (): LockRecord => ({
  v: LOCK_RECORD_VERSION,
  pid: -1,
  hostname: HOSTNAME,
  startTime: null,
  token: '',
  invocationId: '<unreadable>',
  acquiredAt: '',
});

/**
 * Delete orphaned build/staging artifacts left in the lock directory by a
 * crashed prior writer. Safe precisely because we hold the exclusive lock: no
 * other writer can be creating these here right now, so anything present is a
 * crash orphan. Matches this slot's staging files ONLY — never `lbug` itself,
 * never `lbug.wal`/`lbug.shadow` (the LIVE index's own sidecars), and never a
 * `branches/<slug>/` sub-slot (which owns its own lock + sweep). Non-recursive.
 */
export const sweepStagingArtifacts = (lockDir: string, log?: (msg: string) => void): void => {
  // Matches `lbug.new`, `lbug.new.wal`, `lbug.staging.<id>`, `lbug.staging.<id>.wal`, …
  // Does NOT match `lbug`, `lbug.wal`, `lbug.shadow`.
  const stagingRe = /^lbug\.(staging\..+|new(\..+)?)$/;
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(lockDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!stagingRe.test(name)) continue;
    try {
      unlinkSync(path.join(lockDir, name));
      removed++;
    } catch {
      /* best-effort */
    }
  }
  if (removed > 0) {
    log?.(`Cleared ${removed} orphaned index-staging file(s) from a prior interrupted analyze.`);
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll delay with jitter (avoids two waiters lock-stepping), clamped so it
 *  never overshoots the remaining timeout budget. Callers guarantee
 *  `waited < timeoutMs`, so the result is ≥ 1. */
const jitteredDelay = (pollMs: number, timeoutMs: number, waited: number): number => {
  const jitter = Math.floor(Math.random() * pollMs);
  const remaining = timeoutMs - waited;
  return Math.max(1, Math.min(pollMs + jitter, remaining));
};

/**
 * Resolve the wait ceiling. Explicit `opt` wins; else
 * GITNEXUS_INDEX_LOCK_TIMEOUT_MS; else {@link DEFAULT_TIMEOUT_MS}. A value ≤ 0
 * (from either source) means unbounded.
 */
const resolveTimeoutMs = (opt?: number): number => {
  const raw =
    typeof opt === 'number'
      ? opt
      : (() => {
          const env = process.env.GITNEXUS_INDEX_LOCK_TIMEOUT_MS;
          if (env === undefined || env === '') return DEFAULT_TIMEOUT_MS;
          const n = Number(env);
          return Number.isFinite(n) ? n : DEFAULT_TIMEOUT_MS;
        })();
  return raw <= 0 ? Number.POSITIVE_INFINITY : raw;
};

/**
 * Acquire the exclusive write lock for `lockDir` (the resolved index slot
 * directory, e.g. `<repo>/.gitnexus` or `<repo>/.gitnexus/branches/<slug>`).
 *
 * Blocks until the lock is held (waiting only on live holders, stealing dead
 * ones immediately), then sweeps orphaned staging files under the lock and
 * returns a handle. Rejects with `IndexLockTimeoutError` if `timeoutMs` is
 * exceeded while a live holder still holds the lock.
 */
export const acquireIndexLock = async (
  lockDir: string,
  opts: AcquireOptions = {},
): Promise<IndexLockHandle> => {
  mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, LOCK_FILENAME);
  const me = buildRecord();
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
  const startedAt = Date.now();
  let announcedWait = false;
  let lastDiagnosticAt = 0;
  // When the lock file exists but has no readable record, the timestamp we
  // first observed it unreadable — used to reclaim a crash-orphan after a grace.
  let malformedSince: number | null = null;

  for (;;) {
    try {
      // O_WRONLY | O_CREAT | O_EXCL — the atomic arbiter of ownership.
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, JSON.stringify(me));
      } finally {
        closeSync(fd);
      }
      sweepStagingArtifacts(lockDir, opts.log);
      return {
        record: me,
        release: () => {
          const current = readRecord(lockPath);
          if (current && current.token !== me.token) return; // no longer ours
          try {
            unlinkSync(lockPath);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    const holder = readRecord(lockPath);
    const waited = Date.now() - startedAt;

    if (holder) {
      malformedSince = null;
      if (isStale(holder)) {
        opts.log?.(
          `Reclaiming stale index lock from dead analyze (pid ${holder.pid}, ` +
            `invocation ${holder.invocationId}).`,
        );
        stealLock(lockPath, me);
        continue;
      }
      // Live holder → wait.
      if (!announcedWait) {
        announcedWait = true;
        opts.onWaitStart?.(holder);
        opts.log?.(
          `Another gitnexus analyze (pid ${holder.pid} on ${holder.hostname}) is ` +
            `refreshing this index — waiting for it to finish.`,
        );
      }
      if (waited >= timeoutMs) throw new IndexLockTimeoutError(holder, waited);
      if (Date.now() - lastDiagnosticAt >= DIAGNOSTIC_INTERVAL_MS) {
        lastDiagnosticAt = Date.now();
        if (waited >= DIAGNOSTIC_INTERVAL_MS) {
          opts.log?.(
            `Still waiting for analyze pid ${holder.pid} (${Math.round(waited / 1000)}s elapsed).`,
          );
        }
      }
      await sleep(jitteredDelay(pollMs, timeoutMs, waited));
      continue;
    }

    // holder === null: the lock file is either gone (vanished between the failed
    // create and our read) or present-but-unreadable (a crash between the
    // O_EXCL create and the record write, or a partial write). NEVER hot-loop
    // here — both branches are bounded by sleep + timeout.
    if (!existsSync(lockPath)) {
      malformedSince = null; // genuinely vanished → the next create likely wins
      if (waited >= timeoutMs) throw new IndexLockTimeoutError(unknownHolder(), waited);
      await sleep(jitteredDelay(pollMs, timeoutMs, waited));
      continue;
    }
    // Malformed orphan present. Reclaim only after a grace, so a live owner's
    // microsecond create→write window is never mistaken for a crash.
    if (malformedSince === null) malformedSince = Date.now();
    if (Date.now() - malformedSince >= malformedGraceMs(pollMs)) {
      opts.log?.('Reclaiming a malformed/partial index lock file (no readable owner record).');
      stealLock(lockPath, me);
      malformedSince = null;
      continue;
    }
    if (waited >= timeoutMs) throw new IndexLockTimeoutError(unknownHolder(), waited);
    await sleep(jitteredDelay(pollMs, timeoutMs, waited));
  }
};
