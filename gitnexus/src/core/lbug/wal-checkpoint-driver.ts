/**
 * Manual WAL checkpoint driver with bounded retry (#1741 follow-up).
 *
 * Background
 * ----------
 * LadybugDB's native auto-checkpoint runs from inside the C++ engine on a
 * background path that has no JS-side hook for mid-write rotation. When
 * the rename of `<db>.wal` → `<db>.wal.checkpoint` races a transient file
 * lock (Windows Defender, AV scanner, NTFS shadow copy) the engine raises
 * a `Runtime exception: IO exception: Error renaming file …` that aborts
 * the in-flight write. There is no engine-level retry.
 *
 * The auto-checkpoint cannot be made retryable from JS, but a *manual*
 * `CHECKPOINT` query that the JS layer issues itself CAN be wrapped in a
 * bounded retry. By draining the WAL on a tight cadence — more often than
 * the native threshold — the auto-checkpoint almost never has work left
 * to do, so the un-retriable native rename race is moved into the
 * JS-controlled path where this module's retry absorbs it.
 *
 * Design contract
 * ---------------
 * - `autoCheckpoint` stays on (maintainer requirement). This driver is
 *   additive: it preempts the native checkpoint, it does not replace it.
 * - The driver runs ONLY during analyze (callers opt-in explicitly). MCP
 *   and other long-lived flows continue to rely on the close-time
 *   CHECKPOINT in `safeClose`.
 * - Opt-out is via `GITNEXUS_WAL_MANUAL_CHECKPOINT=0`. Default is on.
 * - Retries only fire on `isLbugCheckpointIoError` — every other error
 *   surfaces immediately. The retry budget is small (3 attempts) with
 *   jittered backoff so a chronic rename failure escalates fast.
 * - Retry attempts log at `debug`; only the final, exhausted failure
 *   surfaces to the caller (and is logged at `warn` here for operators).
 */

import { logger } from '../logger.js';
import { tryFlushWAL } from './lbug-adapter.js';
import { markWalDriverActive } from './wal-driver-state.js';
import { isLbugCheckpointIoError } from './lbug-config.js';

/**
 * Bounded retry budget. Total worst-case wall time is dominated by the
 * three sleeps below (~750 ms before jitter) plus three CHECKPOINT round
 * trips — small enough to stay invisible during a large analyze, large
 * enough to ride out a single AV scanner sweep on Windows.
 */
const CHECKPOINT_RETRY_ATTEMPTS = 3;

/**
 * Base back-off in ms. Each attempt waits `BASE_DELAYS[attempt-1]`
 * milliseconds before the next try, plus a small jitter to avoid
 * synchronized retries when multiple analyzers ever share a host.
 */
const BASE_DELAYS_MS: readonly number[] = [50, 200, 500];

/** Maximum jitter added on top of each base delay. */
const JITTER_MAX_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a single CHECKPOINT with bounded retry on
 * `isLbugCheckpointIoError`. Returns the number of attempts actually
 * spent (1-`CHECKPOINT_RETRY_ATTEMPTS`) on success, or rethrows the last
 * checkpoint error after exhausting the budget. Non-checkpoint errors
 * (e.g. WAL corruption, lock-busy) propagate immediately on the first
 * attempt — those are not what this retry is designed to absorb.
 *
 * The split from `flushWAL` is deliberate: `flushWAL` is the swallow-and-
 * log helper used by `safeClose` and the server's best-effort flush,
 * which by contract cannot fail the surrounding operation. The manual
 * driver MUST observe failures to decide whether to retry, and that is
 * the role of `tryFlushWAL`.
 *
 * Exported for direct unit testing — production callers use
 * {@link startWalCheckpointDriver} or {@link checkpointOnce}.
 */
export const runCheckpointWithRetry = async (
  options: {
    /** Override the sleep implementation for tests. */
    sleepFn?: (ms: number) => Promise<void>;
    /** Override the CHECKPOINT call for tests. */
    checkpointFn?: () => Promise<boolean>;
    /** Override the jitter source for tests. Returns a value in [0, 1). */
    randomFn?: () => number;
  } = {},
): Promise<{ attempts: number; flushed: boolean }> => {
  const sleepImpl = options.sleepFn ?? sleep;
  const checkpointImpl = options.checkpointFn ?? tryFlushWAL;
  const randomImpl = options.randomFn ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= CHECKPOINT_RETRY_ATTEMPTS; attempt++) {
    try {
      const flushed = await checkpointImpl();
      return { attempts: attempt, flushed };
    } catch (err) {
      lastError = err;
      if (!isLbugCheckpointIoError(err)) {
        // Non-checkpoint error — propagate immediately. Examples:
        // WAL corruption, missing connection, query syntax failure.
        // Retrying these would only mask the real signal.
        throw err;
      }
      if (attempt === CHECKPOINT_RETRY_ATTEMPTS) break;
      const base = BASE_DELAYS_MS[Math.min(attempt - 1, BASE_DELAYS_MS.length - 1)] ?? 500;
      // randomImpl defaults to Math.random — non-cryptographic by design; jitter only avoids
      // synchronized retries between concurrent analyzers.
      const delayMs = base + Math.floor(randomImpl() * JITTER_MAX_MS);
      logger.debug(
        { attempt, totalAttempts: CHECKPOINT_RETRY_ATTEMPTS, delayMs },
        'GitNexus: WAL checkpoint IO error — retrying',
      );
      await sleepImpl(delayMs);
    }
  }

  logger.warn(
    { attempts: CHECKPOINT_RETRY_ATTEMPTS },
    'GitNexus: manual WAL checkpoint exhausted retry budget — surfacing IO error to caller',
  );
  throw lastError;
};

/**
 * Single-shot manual checkpoint. Use this when the caller drives the
 * cadence itself (e.g. a phase boundary in `runFullAnalysis`).
 *
 * Honors the `GITNEXUS_WAL_MANUAL_CHECKPOINT=0` opt-out so operators can
 * disable the manual path if it ever interacts badly with a future
 * Ladybug release.
 */
export const checkpointOnce = async (): Promise<void> => {
  if (!isManualCheckpointEnabled()) return;
  await runCheckpointWithRetry();
};

/** Default cadence (ms) for the periodic driver. */
const DEFAULT_PERIOD_MS = 5_000;

/**
 * Start a periodic manual checkpoint driver. The returned handle has a
 * `stop()` method that resolves once the in-flight checkpoint (if any)
 * settles, so callers can `await driver.stop()` before close-time
 * `safeClose` and avoid racing the final flush.
 *
 * The first checkpoint fires after `periodMs` (not immediately) so a
 * cold analyze does not pay a CHECKPOINT round trip before any writes
 * have happened.
 */
export interface WalCheckpointDriver {
  /** Stop the driver and await any in-flight checkpoint. Idempotent. */
  stop(): Promise<void>;
}

export const startWalCheckpointDriver = (
  options: { periodMs?: number } = {},
): WalCheckpointDriver => {
  if (!isManualCheckpointEnabled()) {
    return { stop: async () => undefined };
  }

  const periodMs = options.periodMs ?? DEFAULT_PERIOD_MS;
  let stopped = false;
  let inflight: Promise<void> | null = null;

  // Arm the streamQuery guard: while this driver runs, an unlocked streamQuery on
  // the singleton connection could race a CHECKPOINT (#2264). Cleared in stop().
  markWalDriverActive(true);

  const tick = async (): Promise<void> => {
    if (stopped) return;
    // Reentrancy guard: setInterval keeps firing on its fixed cadence even when
    // the previous checkpoint has not settled (a CHECKPOINT can outlast the
    // period during a large `--pdg` writeback). Without this, each overdue tick
    // would queue another CHECKPOINT — they now serialize on the connection lock
    // (lbug-adapter `withConnLock`), but letting them pile up is still pointless
    // work and widens the window for a backlog at stop(). Skip while one is in
    // flight; the next tick covers any WAL accumulated in the meantime.
    if (inflight) return;
    inflight = runCheckpointWithRetry()
      .then(() => undefined)
      .catch((err) => {
        // The retry budget exhausted. The caller's surrounding write
        // will see the same engine error on its next operation and the
        // `analyzeCommand` catch block will emit the recovery hint.
        // Logging here keeps the operator-visible trail without
        // double-logging the user-facing message.
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'GitNexus: manual WAL checkpoint failed after retries',
        );
      });
    try {
      await inflight;
    } finally {
      inflight = null;
    }
  };

  const handle = setInterval(() => {
    // Fire-and-forget: setInterval cannot await directly. The next tick
    // is guarded by `stopped` and the `inflight` reference.
    void tick();
  }, periodMs);
  // `setInterval` returned by Node is a `Timeout` object with `.unref()`
  // so a hung driver never prevents process exit.
  if (typeof (handle as NodeJS.Timeout).unref === 'function') {
    (handle as NodeJS.Timeout).unref();
  }

  return {
    stop: async () => {
      if (stopped) {
        if (inflight) await inflight;
        return;
      }
      stopped = true;
      clearInterval(handle);
      if (inflight) {
        try {
          await inflight;
        } catch {
          /* swallowed in tick() — surface path is the surrounding write */
        }
      }
      // Disarm AFTER the in-flight CHECKPOINT drains — clearing it earlier would
      // briefly let a streamQuery race the still-finishing CHECKPOINT (#2264).
      markWalDriverActive(false);
    },
  };
};

/**
 * Reading `GITNEXUS_WAL_MANUAL_CHECKPOINT` at every call site (rather
 * than caching at module load) keeps `analyzeCommand` env restoration
 * honest: tests that toggle the flag between invocations see the live
 * value, matching the `ANALYZE_CLI_ENV_KEYS` snapshot/restore contract
 * in `analyze.ts`.
 *
 * Accepted opt-out values: '0', 'false', 'off', 'no' (case-insensitive).
 * Anything else — including undefined — leaves the driver enabled.
 */
export const isManualCheckpointEnabled = (): boolean => {
  const raw = process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(normalized);
};
