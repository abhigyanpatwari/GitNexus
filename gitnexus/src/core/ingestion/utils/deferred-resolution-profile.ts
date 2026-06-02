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
/**
 * Always-on (NOT gated on verbose/profile) threshold above which a single
 * file's deferred call resolution earns a `logger.warn`. The verbose
 * slow-file profile (above) only fires with `-v`/`GITNEXUS_PROFILE_DEFERRED`;
 * a plain `analyze` run that hangs in "Resolving calls" (the #1741 symptom)
 * gives the user a frozen progress bar and nothing in the log. This higher
 * default (15s — never hit by a healthy file) turns that silence into one
 * actionable line naming the expensive file. Override via
 * `GITNEXUS_SLOW_FILE_WARN_MS`; the throttle in the caller bounds volume.
 */
const DEFAULT_ALWAYS_ON_SLOW_FILE_WARN_MS = 15_000;
/** Min wall-clock gap between always-on slow-file warnings (throttle). */
export const ALWAYS_ON_SLOW_FILE_WARN_THROTTLE_MS = 30_000;

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

/**
 * Always-on per-file slow threshold (ms) for the `logger.warn` watchdog in
 * `processCallsFromExtracted`. Unlike {@link deferredCallFileSlowMs} this is
 * NOT gated on verbose/profile — it fires on every run. `0` (or a negative /
 * non-finite override) disables the watchdog entirely. Override via
 * `GITNEXUS_SLOW_FILE_WARN_MS`.
 */
export const alwaysOnSlowFileWarnMs = (): number => {
  const raw = process.env.GITNEXUS_SLOW_FILE_WARN_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    // 0 / negative / NaN → disabled. Use Number() not parseInt (see
    // deferredCallFileSlowMs for the '1e9' prefix-parse hazard).
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return DEFAULT_ALWAYS_ON_SLOW_FILE_WARN_MS;
};

export const profileNow = (): bigint => process.hrtime.bigint();

export const profileElapsedMs = (start: bigint): number =>
  Number(process.hrtime.bigint() - start) / 1e6;

// Module-private counter for `[deferred-profile]` log lines the underlying
// logger refused to accept. Pino's SonicBoom transport is sync:false today,
// so steady-state `logger.info(string)` calls don't throw — but first-use
// construction paths (pino-pretty resolve, level validation) and any future
// transport reconfiguration could. The wrap below catches and counts so a
// failing logger cannot abort the deferred band, and the count surfaces in
// the deferred-band done-summary (see processCallsFromExtracted) so the
// failure is visible rather than silently swallowed (DoD §2.8).
let droppedLogLines = 0;

/**
 * Number of `logDeferredProfile` calls whose underlying `logger.info` threw.
 * Surfaced in the deferred-band done-summary when greater than zero.
 */
export const getDeferredProfileDroppedCount = (): number => droppedLogLines;

/**
 * Reset the dropped-line counter. Call from test `afterEach` to keep the
 * module-private state from leaking across tests. Also used inside
 * `processCallsFromExtracted` at function entry so each analyze run gets
 * a fresh count rather than accumulating across the process lifetime.
 */
export const resetDeferredProfileDroppedCount = (): void => {
  droppedLogLines = 0;
};

export const logDeferredProfile = (message: string): void => {
  try {
    logger.info(`[deferred-profile] ${message}`);
  } catch {
    // Do not call the failing logger from the handler — that would risk
    // an infinite loop if the failure mode is steady-state. Just count.
    droppedLogLines++;
  }
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
 *
 * The format callback runs inside a try/catch so a throwing formatter
 * (custom toString, JSON.stringify on a circular object) cannot abort the
 * deferred resolution band — observability code must never escalate to a
 * load-bearing failure. On catch we emit a single `formatter error: …`
 * line via logDeferredProfile and return; the caller's stage continues
 * as if profiling had no-op'd for this timer. DoD §2.8 ("no silent
 * catches that swallow diagnostics") is satisfied by surfacing the
 * failure message rather than dropping it.
 */
export const endTimer = (start: bigint | null, format: (elapsedMs: number) => string): void => {
  if (start === null) return;
  const elapsedMs = profileElapsedMs(start);
  let message: string;
  try {
    message = format(elapsedMs);
  } catch (err) {
    logDeferredProfile(`formatter error: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  logDeferredProfile(message);
};
