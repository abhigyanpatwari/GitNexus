/**
 * Wall-clock logging for the post-chunk deferred resolution band
 * (imports → heritage → heritage map → legacy call resolution).
 *
 * Enabled when either:
 *   - `GITNEXUS_VERBOSE=1` / `gitnexus analyze -v` (primary path for #1741), or
 *   - `GITNEXUS_PROFILE_DEFERRED=1` (force on without full verbose ingestion noise)
 *
 * Issue #1741: large Java/Kotlin repos appear stuck at "Resolving calls"
 * because the UI progress bar updates every 100 files and intermediate
 * stages emit little to the log.
 */

import { logger } from '../../logger.js';
import { parseTruthyEnv } from './env.js';
import { isVerboseIngestionEnabled } from './verbose.js';

// Module-private tuning constants for the gates below. Not exported — these
// are internal knobs, not part of the module's API surface.
const LOG_EVERY_N_VERBOSE = 10;
const LOG_EVERY_N_PROFILE = 100;
const DEFAULT_SLOW_MS_VERBOSE = 3_000;
const DEFAULT_SLOW_MS = 5_000;

/** True when deferred-stage timing / progress logs should emit. */
export const isDeferredResolutionProfileEnabled = (): boolean =>
  isVerboseIngestionEnabled() || parseTruthyEnv(process.env.GITNEXUS_PROFILE_DEFERRED);

/** Log a call-resolution progress line every N files (finer when verbose). */
export const deferredCallLogEveryN = (): number =>
  isVerboseIngestionEnabled() ? LOG_EVERY_N_VERBOSE : LOG_EVERY_N_PROFILE;

/** Per-file call-resolution log threshold (ms). Lower default when verbose. */
export const deferredCallFileSlowMs = (): number => {
  const raw = process.env.GITNEXUS_PROFILE_DEFERRED_SLOW_MS;
  if (raw) {
    // Use Number() not parseInt: parseInt('1e9', 10) === 1 (prefix-parses, drops the exponent),
    // which would turn a user-intended "effectively disabled" threshold into a 1 ms log storm.
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return isVerboseIngestionEnabled() ? DEFAULT_SLOW_MS_VERBOSE : DEFAULT_SLOW_MS;
};

export const profileNow = (): bigint => process.hrtime.bigint();

export const profileElapsedMs = (start: bigint): number =>
  Number(process.hrtime.bigint() - start) / 1e6;

export const logDeferredProfile = (message: string): void => {
  logger.info(`[deferred-profile] ${message}`);
};

/**
 * Capture a monotonic timestamp when profiling is enabled; otherwise return null.
 * Pair with `endTimer` so the type system narrows correctly — using `null` instead
 * of a `0n` sentinel makes "profiling disabled" structurally distinct from
 * "zero elapsed time" and lets TypeScript catch missing guards.
 */
export const startTimer = (enabled: boolean): bigint | null =>
  enabled ? process.hrtime.bigint() : null;

/**
 * Emit a `[deferred-profile]` log line for a captured timer. No-op when the
 * timer is `null` (profiling was disabled at capture time). The formatter
 * receives elapsed ms so the call sites stay readable.
 */
export const endTimer = (start: bigint | null, format: (elapsedMs: number) => string): void => {
  if (start === null) return;
  logDeferredProfile(format(profileElapsedMs(start)));
};
