import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type lbug from '@ladybugdb/core';

/**
 * Shared configuration for `@ladybugdb/core` `Database` construction.
 *
 * Two values changed meaningfully in `@ladybugdb/core` 0.16.0 and need to be
 * pinned explicitly by every caller, otherwise GitNexus regresses:
 *
 * 1. `maxDBSize` defaults to `0`, which the native runtime interprets as
 *    "use the platform's full mmap address space" — typically 8 TB on
 *    64-bit Linux. Constrained environments (CI runners, containers, WSL)
 *    cannot reserve that much address space and crash with
 *    `Buffer manager exception: Mmap for size 8796093022208 failed.`
 *    See LadybugDB upstream JSDoc:
 *    > "introduced temporarily for now to get around with the default 8TB
 *    > mmap address space limit some environment".
 *
 * 2. `enableCompression` flipped its default from `false` (0.15.x) to
 *    `true` (0.16.0). Existing call sites that relied on the positional
 *    default must now pass `false` explicitly to preserve behaviour.
 *
 * Putting both in one shared module guarantees every `new lbug.Database(...)`
 * call site agrees on the same ceiling and behaviour.
 */

/**
 * Upper bound for any single GitNexus LadybugDB file (graph index, group
 * bridge, install scratch, test fixture). 16 GiB is intentionally generous
 * for real-world code graphs (the GitNexus self-index uses < 50 MiB) while
 * remaining far below any 64-bit OS mmap ceiling.
 *
 * Override with the `GITNEXUS_LBUG_MAX_DB_SIZE` environment variable when
 * indexing genuinely huge monorepos. Values are coerced to a positive
 * integer; anything invalid falls back to the default.
 */
export const LBUG_MAX_DB_SIZE: number = (() => {
  const raw = process.env.GITNEXUS_LBUG_MAX_DB_SIZE;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return 16 * 1024 * 1024 * 1024;
})();

/** Matches WAL corruption errors from the LadybugDB engine. */
const WAL_CORRUPTION_RE = /corrupt(ed)?\s+wal|invalid\s+wal\s+record|wal.*corrupt|checksum.*wal/i;

export const WAL_RECOVERY_SUGGESTION =
  'WAL corruption detected. Run `gitnexus analyze` to rebuild the index.';

export function isWalCorruptionError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return WAL_CORRUPTION_RE.test(msg);
}

type LbugModule = typeof lbug;

export interface LbugDatabaseOptions {
  readOnly?: boolean;
  throwOnWalReplayFailure?: boolean;
}

export interface LbugConnectionHandle {
  db: lbug.Database;
  conn: lbug.Connection;
}

/**
 * Return true when the error message indicates that a LadybugDB file lock
 * could not be acquired — either at construction time
 * (`new lbug.Database(...)` raises from `local_file_system.cpp`) or during
 * a query (another writer holds the exclusive lock).
 *
 * Lives here (not in `lbug-adapter.ts`) so both the construction-time
 * retry (`openWithLockRetry` in this file) and the query-time retry
 * (`withLbugDb` in `lbug-adapter.ts`) consult the same matcher. Callers
 * import directly from this module — no re-export to keep in sync.
 */
export const isDbBusyError = (err: unknown): boolean => {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // `lock` already subsumes `could not set lock`; the broader term is kept
  // because graph-DB transient errors include "deadlock", "lock contention",
  // and the LadybugDB native module's "could not set lock on file" — all of
  // which deserve a retry. If a non-transient lock-shaped error ever
  // surfaces (e.g., "lock file missing" during recovery), tighten this
  // matcher rather than raising the retry budget.
  return msg.includes('busy') || msg.includes('lock') || msg.includes('already in use');
};

export function createLbugDatabase(
  lbugModule: LbugModule,
  databasePath: string,
  options: LbugDatabaseOptions = {},
): lbug.Database {
  // .d.ts declares fewer args than the native constructor accepts.
  return new (lbugModule.Database as any)(
    databasePath,
    0, // bufferManagerSize
    false, // enableCompression (pinned for v0.16.0)
    options.readOnly ?? false,
    LBUG_MAX_DB_SIZE,
    true, // autoCheckpoint
    -1, // checkpointThreshold
    options.throwOnWalReplayFailure ?? true,
    true, // enableChecksums
  ) as lbug.Database;
}

// ─── Lock-busy retry tuning knobs ───────────────────────────────────────────
//
// All four GitNexus retry pairs that touch native LadybugDB locks live with
// a comment cross-reference here so an SRE tuning Windows flakes finds them
// in one grep:
//
//   1. OPEN_LOCK_RETRY_ATTEMPTS / OPEN_LOCK_RETRY_DELAY_MS  (this file)
//      → `new lbug.Database()` constructor lock failures
//   2. HANDLE_RELEASE_PROBE_ATTEMPTS / HANDLE_RELEASE_PROBE_DELAY_MS  (this file)
//      → post-close fs.open probe to absorb Windows handle-release lag
//   3. DB_LOCK_RETRY_ATTEMPTS / DB_LOCK_RETRY_DELAY_MS  (lbug-adapter.ts withLbugDb)
//      → query-time busy/lock retry around already-open connections
//
// `new lbug.Database()` calls into the native module which performs an
// OS-level exclusive lock on `<dbPath>`. On Windows that lock can fail
// for reasons specific to the OS (Defender briefly opens new files,
// libuv handle release lags the JS-side close). 5 attempts × 100ms
// linear back-off (max sleep 100+200+300+400 = 1s, plus 5 ctor RTTs
// of 10–50ms each = ~1.0–1.2s worst case) clears the typical
// AV-scanner hold without masking real cross-process conflicts.
//
// Source: https://github.com/LadybugDB/ladybug/blob/v0.16.1/src/common/file_system/local_file_system.cpp#L126
const OPEN_LOCK_RETRY_ATTEMPTS = 5;
const OPEN_LOCK_RETRY_DELAY_MS = 100;

const HANDLE_RELEASE_PROBE_ATTEMPTS = 5;
const HANDLE_RELEASE_PROBE_DELAY_MS = 50;
const HANDLE_RELEASE_LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/**
 * Test-fixture directory prefixes recognized by `isTestFixturePath`.
 *
 * IMPORTANT: this list must stay in sync with the prefixes passed to
 * `createTempDir` in `gitnexus/test/helpers/test-db.ts` and the prefixes
 * used by `withTestLbugDB` (`gitnexus/test/helpers/test-indexed-db.ts`).
 * If you add a new test that passes a custom prefix to `createTempDir`,
 * add it here too — otherwise the stale-sidecar sweep silently won't
 * fire for that fixture and CI flakes return.
 *
 * The default `createTempDir('gitnexus-test-')` and the lbug variant
 * `'gitnexus-lbug-'` cover today's call sites.
 */
const TEST_FIXTURE_PREFIXES = ['gitnexus-lbug-', 'gitnexus-test-'];

/**
 * Marker symbol attached to lock errors after `openWithLockRetry` exhausts
 * its budget. `withLbugDb`'s outer query-time retry consults this so it
 * does not re-retry a path that just spent up to ~1.5s in the open-time
 * loop — preventing 6s tail latencies (3× outer × 5× inner attempts).
 *
 * The symbol is internal to GitNexus; consumers should treat the underlying
 * error message as the user-visible signal.
 */
export const LBUG_OPEN_RETRY_EXHAUSTED = Symbol.for('gitnexus.lbug.openRetryExhausted');

export const isOpenRetryExhausted = (err: unknown): boolean => {
  if (err === null || err === undefined || typeof err !== 'object') return false;
  return (err as { [LBUG_OPEN_RETRY_EXHAUSTED]?: boolean })[LBUG_OPEN_RETRY_EXHAUSTED] === true;
};

const tagOpenRetryExhausted = (err: unknown): unknown => {
  if (err && typeof err === 'object') {
    (err as { [LBUG_OPEN_RETRY_EXHAUSTED]?: boolean })[LBUG_OPEN_RETRY_EXHAUSTED] = true;
  }
  return err;
};

/**
 * True when `dbPath` resolves to a recognized test fixture under the OS
 * temp directory. Used to gate the stale-sidecar sweep so production
 * paths never have their `.wal` / `.lock` files deleted.
 *
 * Defensive shape:
 *   - `path.resolve` normalizes `..` segments before the prefix check, so
 *     `<tmp>/gitnexus-lbug-x/../../etc/passwd` is rejected.
 *   - The tmpRoot check trims any trailing separator returned by some
 *     Windows TMP configurations (`C:\Users\X\Temp\`) so the startsWith
 *     comparison stays correct.
 *   - Only the IMMEDIATE parent directory is matched against the prefix
 *     list. An ancestor walk would let a tmpdir whose own basename starts
 *     with `gitnexus-lbug-` accept arbitrary nested paths under it.
 */
const isTestFixturePath = (dbPath: string): boolean => {
  const tmpRoot = os.tmpdir().replace(new RegExp(`${path.sep === '\\' ? '\\\\' : path.sep}+$`), '');
  const resolved = path.resolve(dbPath);
  if (!resolved.startsWith(tmpRoot + path.sep) && resolved !== tmpRoot) return false;
  const parentBase = path.basename(path.dirname(resolved));
  return TEST_FIXTURE_PREFIXES.some((p) => parentBase.startsWith(p));
};

/** Exported only for direct unit testing — production callers use `openWithLockRetry`. */
export const _isTestFixturePathForTest = isTestFixturePath;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Attempt to remove stale `.wal` / `.lock` sidecars that a previous aborted
 * test run may have left behind. Best-effort: ENOENT is normal, anything
 * else is swallowed so the caller's retry can surface the original error.
 */
const sweepStaleSidecars = async (dbPath: string): Promise<void> => {
  for (const suffix of ['.wal', '.lock']) {
    try {
      await fs.unlink(dbPath + suffix);
    } catch {
      /* missing sidecar or permission error — let the open retry surface it */
    }
  }
};

/**
 * Run `construct` with bounded retries when `new lbug.Database(...)` throws
 * a busy/lock error. The original (loop-captured) error is preferred over
 * any post-sweep error so triage sees the real LadybugDB lock message.
 * On exhaustion the rethrown error is tagged via
 * `LBUG_OPEN_RETRY_EXHAUSTED` so the outer query-time retry in
 * `withLbugDb` skips re-retrying a freshly-exhausted path.
 */
const openWithLockRetry = async (
  construct: () => lbug.Database,
  dbPath: string,
): Promise<lbug.Database> => {
  let originalLockError: unknown;
  for (let attempt = 1; attempt <= OPEN_LOCK_RETRY_ATTEMPTS; attempt++) {
    try {
      return construct();
    } catch (err) {
      if (!isDbBusyError(err)) throw err;
      originalLockError = err;
      if (attempt === OPEN_LOCK_RETRY_ATTEMPTS) break;
      await sleep(OPEN_LOCK_RETRY_DELAY_MS * attempt);
    }
  }

  // Final defense: only for recognized test fixtures, sweep stale sidecars
  // (a prior aborted test run can leave a `.wal` lock that survives the
  // tmp dir cleanup). Production paths never reach this branch — the guard
  // requires the immediate parent dir to match a test prefix AND the
  // resolved path to live under the OS temp directory.
  if (isTestFixturePath(dbPath)) {
    await sweepStaleSidecars(dbPath);
    try {
      return construct();
    } catch {
      // Intentionally do NOT overwrite originalLockError. The user-actionable
      // signal is "we exhausted lock retries" — a different error from the
      // post-sweep attempt is less useful than the lock failure that drove
      // the sweep in the first place.
    }
  }
  throw tagOpenRetryExhausted(originalLockError);
};

export async function openLbugConnection(
  lbugModule: LbugModule,
  databasePath: string,
  options: LbugDatabaseOptions = {},
): Promise<LbugConnectionHandle> {
  let db: lbug.Database | undefined;
  try {
    db = await openWithLockRetry(
      () => createLbugDatabase(lbugModule, databasePath, options),
      databasePath,
    );
    return { db, conn: new lbugModule.Connection(db) };
  } catch (err) {
    if (db) await db.close().catch(() => {});
    throw err;
  }
}

export async function closeLbugConnection(handle: LbugConnectionHandle): Promise<void> {
  await handle.conn.close().catch(() => {});
  await handle.db.close().catch(() => {});
}

/**
 * Probe `dbPath` AND its `.wal` sidecar after `db.close()` so any
 * residual native file handle surfaces as EBUSY/EPERM/EACCES and the
 * bounded retry absorbs the release lag. Windows-only — Linux/macOS do
 * not exhibit this race.
 *
 * Both files matter. Empirically, on rapid open→close→reopen cycles the
 * main `dbPath` handle releases first; the `.wal` handle from the
 * previous Database lingers and the new Database's first write (CREATE
 * NODE TABLE during schema init) fails with "Could not set lock on
 * file". Probing both makes safeClose actually return when the kernel
 * is fully done with the path.
 *
 * Returns `true` when both probes succeeded (or skipped on non-lock
 * errors / missing files). Returns `false` when either probe exhausted
 * its budget with a lock code still in flight.
 *
 * Defensive shape:
 *   - Opens read+write (`'r+'`) so the probe actually surfaces exclusive
 *     locks held by the previous Database. A read-only probe (`'r'`) is
 *     insufficient — Windows will grant read access while the previous
 *     handle's exclusive write lock is still in flight, which lets
 *     `safeClose` return before the next CREATE NODE TABLE can lock the
 *     file.
 *   - `try/finally` around `handle.close()` guarantees no fd leak even
 *     if close itself throws.
 */
export const waitForWindowsHandleRelease = async (dbPath: string): Promise<boolean> => {
  const mainReleased = await probeSinglePath(dbPath);
  const walReleased = await probeSinglePath(dbPath + '.wal');
  return mainReleased && walReleased;
};

const probeSinglePath = async (filePath: string): Promise<boolean> => {
  for (let attempt = 1; attempt <= HANDLE_RELEASE_PROBE_ATTEMPTS; attempt++) {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(filePath, 'r+');
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (!code || !HANDLE_RELEASE_LOCK_CODES.has(code)) return true; // ENOENT / unrelated → not our problem
      if (attempt === HANDLE_RELEASE_PROBE_ATTEMPTS) return false;
      await sleep(HANDLE_RELEASE_PROBE_DELAY_MS * attempt);
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          /* swallow — caller cannot do anything useful with a probe-close failure */
        }
      }
    }
  }
  return false;
};
