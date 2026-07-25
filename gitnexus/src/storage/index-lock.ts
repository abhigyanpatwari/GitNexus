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
 * parent — so the entity the OS tracks for liveness is always the real writer.
 * See run-analyze.ts for the acquire site.
 *
 * TWO BACKENDS behind the {@link acquireIndexLock} seam:
 *
 *  - **socket** (Windows named pipe / Linux abstract socket, via `net`) — the
 *    preferred, KERNEL-OWNED lock. Holding it = holding a listening endpoint the
 *    kernel binds to this process; `EADDRINUSE` therefore means a *live* holder,
 *    and the kernel drops the binding the instant the holder exits for ANY reason
 *    (clean exit, crash, OOM, SIGKILL). That makes it provably race-free: no
 *    stale detection, no pid-reuse guess, no takeover, and — since the endpoint
 *    lives outside the index dir — no filesystem write, so it works unchanged on
 *    a read-only index mount. This is the same class of kernel object as the
 *    Windows named mutex the issue's reporter used as an external workaround, but
 *    built from Node's stdlib `net`, so it adds NO native dependency and cannot
 *    break `npx gitnexus` install anywhere.
 *
 *  - **file** (`O_EXCL` pidfile) — the portable fallback for macOS/BSD (no
 *    abstract sockets; filesystem sockets don't release cleanly on death) and
 *    for any environment where the socket backend can't bind. It uses pid-
 *    liveness staleness, an atomic rename-steal reclaim, bounded malformed-file
 *    handling, read-only tolerance, and a finite wait timeout (a reused pid can
 *    masquerade as live where process start-time isn't verifiable, so waiting is
 *    bounded rather than a hang). Its stale-takeover has an irreducible narrow
 *    race — inherent to file-based advisory locks — which is precisely why the
 *    socket backend is preferred; only a kernel primitive closes it.
 *
 * Scope: cross-process, same logical index dir. The file backend never steals a
 * foreign-host lock (pid liveness is meaningless across hosts); the socket
 * backend is single-host by nature. The motivating case (local hook-driven
 * re-index) is single-host. See AcquireOptions.timeoutMs for the wait ceiling.
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
  realpathSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

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
  /**
   * Whether `holder` carries a real, identifiable owner. False on the socket
   * backend (and the file backend's malformed/vanished-lock timeouts), where the
   * holder is a placeholder (`pid -1`) — the OS socket lock exposes no owner
   * metadata (#2658 review M3). Consumers must not present `holder.pid` as a real
   * pid when this is false.
   */
  readonly holderKnown: boolean;
  constructor(holder: LockRecord, waitedMs: number, holderKnown = true) {
    super(
      holderKnown
        ? `Timed out after ${waitedMs}ms waiting for another gitnexus analyze ` +
            `(pid ${holder.pid} on ${holder.hostname}, invocation ${holder.invocationId}) ` +
            `to release the index lock.`
        : `Timed out after ${waitedMs}ms waiting for another gitnexus analyze ` +
            `(holder identity unknown) to release the index lock.`,
    );
    this.name = 'IndexLockTimeoutError';
    this.holder = holder;
    this.holderKnown = holderKnown;
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
    // `typeof NaN === 'number'`, so a bare number check lets NaN/0/-1/Infinity/
    // fractional pids reach process.kill (#2658 review L4): a garbled or crafted
    // lock file with `{"pid":0}` reads as a live holder and wedges a real analyze
    // for the full wait timeout. A real pid is a positive integer.
    if (!Number.isInteger(parsed.pid) || (parsed.pid as number) <= 0) return null;
    if (typeof parsed.token !== 'string') return null;
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
 * Reclaim a lock file we judged reclaimable — a dead holder (`expected` = its
 * record) or a malformed/unreadable crash-orphan (`expected` = null) — moving
 * the exact inode aside in ONE `rename` syscall to a token-unique name so two
 * waiters reclaiming the same orphan can't both win (the loser's rename ENOENTs).
 *
 * CRITICAL (#2658 review): the reclaim must not act on a STALE judgment. The
 * staleness decision (`isStale` / malformed-grace) happened a few syscalls ago;
 * a live writer may have O_EXCL-created its own lock at `lockPath` since. Blindly
 * renaming that live lock aside would delete it and admit a SECOND writer — the
 * exact double-writer this lock exists to prevent (reproduced: ~18%/round under
 * 4-way reclaim contention on the file backend). So:
 *   1. re-read `lockPath` immediately BEFORE the rename and confirm it still holds
 *      exactly what we judged (same token, or still-unreadable) — shrinking the
 *      window to the single gap between this read and the rename;
 *   2. after the rename, confirm what we ACTUALLY moved matches the judgment; if a
 *      live lock slipped into that residual gap, RESTORE it (rename back) so its
 *      holder is never displaced, and lose the reclaim.
 * A concurrent creator whose fresh lock the restore overwrites is caught by the
 * acquire loop's post-write read-back verify (see acquireViaFile), so it backs
 * off rather than proceeding as a second writer.
 *
 * Returns true if we won the reclaim (caller retries the create), false if we
 * lost the race or the judgment went stale (caller re-loops and re-reads).
 */
const matchesJudgment = (record: LockRecord | null, expected: LockRecord | null): boolean =>
  expected === null ? record === null : record?.token === expected.token;

const stealLock = (lockPath: string, me: LockRecord, expected: LockRecord | null): boolean => {
  // (1) Re-verify the judgment still holds right before we move anything.
  if (!matchesJudgment(readRecord(lockPath), expected)) return false;
  if (expected === null && !existsSync(lockPath)) return false; // malformed → but now vanished

  const aside = `${lockPath}.dead.${me.token}`;
  try {
    renameSync(lockPath, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; // another stealer won
    throw err;
  }
  // (2) Confirm what we moved is what we judged; if a live lock slipped into the
  // read→rename gap, put it back — a live holder must never be displaced.
  if (!matchesJudgment(readRecord(aside), expected)) {
    try {
      renameSync(aside, lockPath); // restore; an overwritten concurrent creator's read-back backs it off
    } catch {
      /* slot re-taken between our move and restore — leave it; we lost the reclaim */
    }
    return false;
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
 * Filesystem-create error codes we tolerate by proceeding lock-free: a
 * read-only mount (EROFS) or a denied create (EACCES/EPERM). Such a filesystem
 * rejects every index WRITE in the same directory too, so no concurrent writer
 * can exist and the lock is moot — an already-indexed repo on a `:ro` mount
 * must still reach its `alreadyUpToDate` fast path (#2658). A genuinely-needed
 * write fails later exactly as it would have without the lock.
 */
export const LOCK_UNWRITABLE_CODES: ReadonlySet<string> = new Set(['EROFS', 'EACCES', 'EPERM']);
export const isLockUnwritableCode = (code: string | undefined): boolean =>
  code !== undefined && LOCK_UNWRITABLE_CODES.has(code);

/** A lock handle that owns nothing — returned when the filesystem refuses to
 *  create the lock file (see {@link LOCK_UNWRITABLE_CODES}). Release is a no-op. */
const noopHandle = (record: LockRecord): IndexLockHandle => ({ record, release: () => {} });

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
/**
 * File-based (O_EXCL pidfile) backend. The portable fallback used on platforms
 * without the socket backend (macOS/BSD) or when the OS socket lock is
 * unavailable. Carries the pid-liveness staleness, atomic rename-steal reclaim,
 * bounded malformed-file handling, and read-only tolerance. Its stale-takeover
 * has an irreducible (narrow) race — see the module header — which is why the
 * socket backend is preferred where available.
 */
const acquireViaFile = async (
  lockDir: string,
  me: LockRecord,
  opts: AcquireOptions,
): Promise<IndexLockHandle> => {
  try {
    mkdirSync(lockDir, { recursive: true });
  } catch (err) {
    // Read-only / denied filesystem → proceed lock-free (see LOCK_UNWRITABLE_CODES).
    if (isLockUnwritableCode((err as NodeJS.ErrnoException).code)) return noopHandle(me);
    throw err;
  }
  const lockPath = path.join(lockDir, LOCK_FILENAME);
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
      // Read-back verify (#2658 review L5): if this process stalled (a >graceMs
      // GC pause) between the O_EXCL create of the *empty* file and the write
      // above, a waiter could have reclaimed the empty file (renamed it aside)
      // and O_EXCL-created its own lock at `lockPath`. Our write then landed on
      // the renamed-aside inode, not `lockPath`. Confirm `lockPath` still carries
      // our token before claiming ownership; if it was stolen, contend normally.
      const confirmed = readRecord(lockPath);
      if (!confirmed || confirmed.token !== me.token) continue;
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
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        // fall through to holder inspection / wait / reclaim below
      } else if (isLockUnwritableCode(code)) {
        return noopHandle(me); // read-only / denied → proceed lock-free
      } else {
        throw err;
      }
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
        stealLock(lockPath, me, holder); // reclaim ONLY this dead record; live locks are never stolen
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
      if (waited >= timeoutMs) throw new IndexLockTimeoutError(unknownHolder(), waited, false);
      await sleep(jitteredDelay(pollMs, timeoutMs, waited));
      continue;
    }
    // Malformed orphan present. Reclaim only after a grace, so a live owner's
    // microsecond create→write window is never mistaken for a crash.
    if (malformedSince === null) malformedSince = Date.now();
    if (Date.now() - malformedSince >= malformedGraceMs(pollMs)) {
      opts.log?.('Reclaiming a malformed/partial index lock file (no readable owner record).');
      stealLock(lockPath, me, null); // reclaim ONLY while still unreadable; a live lock written since is left
      malformedSince = null;
      continue;
    }
    if (waited >= timeoutMs) throw new IndexLockTimeoutError(unknownHolder(), waited, false);
    await sleep(jitteredDelay(pollMs, timeoutMs, waited));
  }
};

/** Signals that the OS socket backend can't be used here (e.g. abstract
 *  namespace disabled, sandbox, or an unexpected bind error) so the caller
 *  should fall back to the file backend. NOT thrown for EADDRINUSE (that is a
 *  live holder → wait) or timeouts (those propagate as IndexLockTimeoutError). */
class SocketLockUnavailable extends Error {
  constructor(readonly cause: NodeJS.ErrnoException) {
    super(`OS socket lock unavailable: ${cause.code ?? cause.message}`);
    this.name = 'SocketLockUnavailable';
  }
}

/**
 * Canonicalize a path to its real filesystem identity so lexical aliases of the
 * same directory (a symlink, a bind-mount path, a Windows junction, a `\\?\`
 * prefix) map to ONE name (#2658 review H1). `lockDir` (the index slot) often
 * does not exist yet, so `realpathSync` the deepest existing ancestor and
 * re-append the not-yet-created remainder. A path with no symlink components
 * realpaths to itself, so the common (non-aliased) case is unchanged — a holder
 * that used the old resolved name is never orphaned.
 */
const canonicalizeDir = (p: string): string => {
  const resolved = path.resolve(p);
  const tail: string[] = [];
  let dir = resolved;
  for (;;) {
    try {
      const real = realpathSync(dir);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return resolved; // reached the root with nothing to resolve
      tail.push(path.basename(dir));
      dir = parent;
    }
  }
};

/**
 * Stable OS-IPC endpoint name for an index directory. The name is derived from
 * the REAL path (case-folded on Windows), so two processes targeting the same
 * physical slot — even via different lexical aliases — collide, and separate
 * worktrees/branches never do. The endpoint lives OUTSIDE the index directory
 * (abstract namespace / pipe namespace), so the lock needs no filesystem write
 * and is unaffected by a read-only index mount.
 */
const socketLockName = (lockDir: string): string => {
  const resolved = canonicalizeDir(lockDir);
  const key = createHash('sha256')
    .update(process.platform === 'win32' ? resolved.toLowerCase() : resolved)
    .digest('hex')
    .slice(0, 32);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\gitnexus-idx-${key}`
    : `\0gitnexus-idx-${key}`; // Linux abstract socket (no filesystem entry)
};

/** Attempt to listen; resolve to null on success or the error on failure. */
const tryListen = (server: net.Server, name: string): Promise<NodeJS.ErrnoException | null> =>
  new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      resolve(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve(null);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(name);
  });

/**
 * OS-owned socket/pipe backend (Windows named pipe, Linux abstract socket).
 * Holding the lock = holding a listening endpoint the kernel binds to this
 * process; `EADDRINUSE` therefore means a *live* holder, and the kernel drops
 * the binding the instant the holder exits (clean exit, crash, OOM, SIGKILL) —
 * so there is no stale detection, no reclaim, and no takeover race. See the
 * module header for why this is preferred over the file backend.
 */
const acquireViaSocket = async (
  lockDir: string,
  me: LockRecord,
  opts: AcquireOptions,
): Promise<IndexLockHandle> => {
  const name = socketLockName(lockDir);
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
  const startedAt = Date.now();
  let announcedWait = false;
  let lastDiagnosticAt = 0;

  for (;;) {
    const server = net.createServer();
    // Never keep the process alive on the lock's account, and never hold an
    // incoming connection (nothing should connect; drop any stray peer).
    server.unref();
    server.on('connection', (sock) => sock.destroy());
    const listenErr = await tryListen(server, name);

    if (!listenErr) {
      return {
        record: me,
        release: () => {
          try {
            server.close();
          } catch {
            /* already closed / releasing on exit */
          }
        },
      };
    }

    // This server never bound (listen failed); release its handle before the
    // next poll or the fallback, so a long contended wait doesn't churn one
    // unclosed net.Server per iteration (#2658 review L3).
    try {
      server.close();
    } catch {
      /* never listened */
    }

    // Only EADDRINUSE means "held by a live holder → wait". Anything else means
    // this environment can't use the socket backend → fall back to the file one.
    if (listenErr.code !== 'EADDRINUSE') throw new SocketLockUnavailable(listenErr);

    if (!announcedWait) {
      announcedWait = true;
      opts.onWaitStart?.(me);
      opts.log?.('Another gitnexus analyze is refreshing this index — waiting for it to finish.');
    }
    const waited = Date.now() - startedAt;
    // Socket backend exposes no owner metadata → holder identity is unknown (M3).
    if (waited >= timeoutMs) throw new IndexLockTimeoutError(unknownHolder(), waited, false);
    if (Date.now() - lastDiagnosticAt >= DIAGNOSTIC_INTERVAL_MS) {
      lastDiagnosticAt = Date.now();
      if (waited >= DIAGNOSTIC_INTERVAL_MS) {
        opts.log?.(`Still waiting for another analyze (${Math.round(waited / 1000)}s elapsed).`);
      }
    }
    await sleep(jitteredDelay(pollMs, timeoutMs, waited));
  }
};

/** Platforms whose OS IPC namespace gives a clean, auto-releasing lock via
 *  `net`: Windows named pipes and Linux abstract sockets. Elsewhere (macOS/BSD)
 *  the file backend is used (no abstract namespace; filesystem sockets don't
 *  release cleanly on death). Override for tests via GITNEXUS_INDEX_LOCK_BACKEND
 *  = 'socket' | 'file'.
 *
 *  Scope caveat: the socket backend's mutual-exclusion domain is NOT uniform.
 *  Windows `\\.\pipe\` names are machine-wide (all sessions); Linux abstract
 *  sockets are network-namespace-scoped (network_namespaces(7)). So two writers
 *  that share a bind-mounted index dir but sit in separate netns (e.g. two
 *  containers, Docker's default) do NOT collide on Linux — "single-host" is
 *  really "single-netns" here. That cross-netns-shared-mount case is the one
 *  the file backend (shared-filesystem O_EXCL) would cover; set
 *  GITNEXUS_INDEX_LOCK_BACKEND=file there. The motivating case (local hook-
 *  driven re-index) is single-netns, so the default socket backend covers it. */
const selectBackend = (): 'socket' | 'file' => {
  const override = process.env.GITNEXUS_INDEX_LOCK_BACKEND;
  if (override === 'socket' || override === 'file') return override;
  return process.platform === 'win32' || process.platform === 'linux' ? 'socket' : 'file';
};

/**
 * Acquire the exclusive write lock for `lockDir` (the resolved index slot
 * directory). Uses the OS socket/pipe backend where available (Windows/Linux),
 * falling back to the file backend otherwise or if the socket backend is
 * unusable in this environment. After acquiring, sweeps orphaned staging files
 * under the lock (best-effort; a no-op on a read-only mount). Rejects with
 * `IndexLockTimeoutError` if `timeoutMs` elapses while another live holder holds
 * the lock.
 */
export const acquireIndexLock = async (
  lockDir: string,
  opts: AcquireOptions = {},
): Promise<IndexLockHandle> => {
  const me = buildRecord();
  let handle: IndexLockHandle;
  if (selectBackend() === 'socket') {
    try {
      handle = await acquireViaSocket(lockDir, me, opts);
    } catch (err) {
      if (!(err instanceof SocketLockUnavailable)) throw err; // timeout etc. propagate
      opts.log?.('Index lock: OS socket lock unavailable here — using the file lock.');
      handle = await acquireViaFile(lockDir, me, opts);
    }
  } else {
    handle = await acquireViaFile(lockDir, me, opts);
  }
  // Reclaim crashed-build staging orphans while we hold the lock. Best-effort:
  // a read-only mount (no orphans reachable) just no-ops.
  try {
    sweepStagingArtifacts(lockDir, opts.log);
  } catch {
    /* best-effort */
  }
  return handle;
};
