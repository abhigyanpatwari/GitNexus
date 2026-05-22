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
import { isVerboseIngestionEnabled } from './verbose.js';

const truthyEnv = (raw: string | undefined): boolean => {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
};

/** True when deferred-stage timing / progress logs should emit. */
export const isDeferredResolutionProfileEnabled = (): boolean =>
  isVerboseIngestionEnabled() || truthyEnv(process.env.GITNEXUS_PROFILE_DEFERRED);

/** Log a call-resolution progress line every N files (finer when verbose). */
export const deferredCallLogEveryN = (): number => (isVerboseIngestionEnabled() ? 10 : 100);

/** Per-file call-resolution log threshold (ms). Lower default when verbose. */
export const deferredCallFileSlowMs = (): number => {
  const raw = process.env.GITNEXUS_PROFILE_DEFERRED_SLOW_MS;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return isVerboseIngestionEnabled() ? 3_000 : 5_000;
};

export const profileNow = (): bigint => process.hrtime.bigint();

export const profileElapsedMs = (start: bigint): number =>
  Number(process.hrtime.bigint() - start) / 1e6;

export const logDeferredProfile = (message: string): void => {
  logger.info(`[deferred-profile] ${message}`);
};
