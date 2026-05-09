/**
 * Per-process circuit breaker.
 *
 * Closed -> Open transition fires after `failureThreshold` consecutive
 * failures. While Open, `check` throws `CircuitOpenError` until
 * `cooldownMs` has elapsed since the breaker tripped. The first call
 * after the cooldown enters Half-Open and consumes the *probe permit*:
 * a recorded success returns to Closed; a recorded failure flips back
 * to Open with a fresh timestamp.
 *
 * Half-open admits exactly one in-flight probe at a time. Concurrent
 * callers attempting `check()` while a probe is outstanding receive
 * `CircuitOpenError` with `retryAfterMs = halfOpenRetryAfterMs` (default
 * 1000ms; configurable). This prevents the recovery-time thundering
 * herd that defeats the breaker's "fail fast" promise.
 *
 * Outcome reporting splits permit-release from state-resolution:
 *   - `recordSuccess` — releases the probe permit, resets the failure
 *     counter, transitions to Closed. Reserved for true 2xx/3xx outcomes.
 *   - `recordFailure` — releases the probe permit, increments the
 *     consecutive-failure counter, transitions to Open with a fresh
 *     `openedAt` (when called from Half-Open or when the threshold
 *     trips from Closed).
 *   - `recordNeutral` — releases the probe permit, BUT leaves state and
 *     counter untouched. Used for outcomes that are neither evidence of
 *     backend health nor evidence of backend failure (caller-driven
 *     cancellation, local timeout, terminal 4xx client errors). Critical
 *     design point: if `recordNeutral` did not release the permit, a
 *     single `TimeoutError` from per-attempt `AbortSignal.timeout` would
 *     route through `recordNeutral` and permanently park the breaker in
 *     half-open until process restart. Releasing the permit while leaving
 *     state half-open keeps the "neutral doesn't claim health" semantic
 *     without creating that wedge.
 *
 * Pairing invariant: every successful `check()` MUST be paired with
 * exactly one `record*()` on every code path including throws. Direct
 * consumers should wrap the protected operation in `try/finally`:
 *
 *   breaker.check();
 *   try {
 *     const result = await operation();
 *     breaker.recordSuccess();
 *     return result;
 *   } catch (err) {
 *     // classify err and call recordFailure / recordNeutral / etc.
 *     throw err;
 *   }
 *
 * `resilientFetch`'s catch-all on `fetchImpl` already satisfies this
 * for that consumer.
 *
 * Atomicity model: the half-open gate relies on JavaScript event-loop
 * single-threadedness within a synchronous `check()` body. There is no
 * `await` inside `check()`; concurrent callers serialize on microtask
 * order, and exactly one observes `probeInFlight === false`. Do not
 * introduce `await` inside `check()` without revisiting the gate. If
 * this code is ever ported to a runtime with shared-memory threads
 * (Node `worker_threads` with `SharedArrayBuffer`, Web Workers with
 * shared registries), the boolean must become an atomic CAS — Resilience4j
 * and Hystrix use atomic permits *because* they run in JVM thread pools.
 *
 * Runtime-agnostic: depends only on a `now()` clock and standard JS —
 * no Node-only imports. Tests inject `now` to advance the clock
 * deterministically without `vi.useFakeTimers()`.
 */

export class CircuitOpenError extends Error {
  override readonly name = 'CircuitOpenError';
  /** Approximate wait time before the breaker may transition to Half-Open
   *  (or before the in-flight probe is expected to resolve). */
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number, key?: string) {
    super(
      key
        ? `Circuit '${key}' is open; retry in ${Math.ceil(retryAfterMs / 1000)}s`
        : `Circuit is open; retry in ${Math.ceil(retryAfterMs / 1000)}s`,
    );
    this.retryAfterMs = retryAfterMs;
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures required to trip Closed -> Open. */
  failureThreshold?: number;
  /** Milliseconds Open before the next call may probe (Half-Open). */
  cooldownMs?: number;
  /**
   * Milliseconds to suggest in `CircuitOpenError.retryAfterMs` when the
   * breaker is Half-Open with the probe permit consumed. Default 1000ms.
   * Consumers with long-running protected ops (LLM streaming, large
   * uploads) should raise this — the cooldown clock is no longer the
   * right answer because cooldown has elapsed. Returning 0 invites
   * retry storms; returning the full cooldown misleads about wait.
   */
  halfOpenRetryAfterMs?: number;
  /** Optional key for error messages and registry lookups. */
  key?: string;
  /** Clock override — defaults to `Date.now`. Tests inject deterministic time. */
  now?: () => number;
}

type State = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenRetryAfterMs: number;
  private readonly key: string | undefined;
  private readonly now: () => number;

  private state: State = 'closed';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  /**
   * True between a successful `check()` and the next `record*()` call
   * during Half-Open. Gates concurrent callers from stampeding a still-
   * recovering dependency. Boolean rather than counter — single-permit
   * is the conservative end of the Hystrix/Resilience4j spectrum.
   */
  private probeInFlight = false;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.halfOpenRetryAfterMs = opts.halfOpenRetryAfterMs ?? 1_000;
    this.key = opts.key;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Throw `CircuitOpenError` if the breaker won't admit this call.
   * Otherwise consume the half-open probe permit (if applicable) and
   * return so the caller can attempt the protected work.
   *
   * Three rejection paths:
   *   1. Open and still in cooldown → throws with `retryAfterMs` =
   *      remaining cooldown.
   *   2. Open with cooldown elapsed AND a probe is already in flight
   *      (race: another caller transitioned to half-open and grabbed
   *      the permit on a microtask before us) → throws with
   *      `halfOpenRetryAfterMs`.
   *   3. Half-Open with probe in flight → throws with `halfOpenRetryAfterMs`.
   *
   * **Pairing invariant**: every successful return from `check()` MUST
   * be paired with exactly one `recordSuccess` / `recordFailure` /
   * `recordNeutral` on every code path including thrown exceptions.
   * Failing to pair leaves the probe permit consumed forever and
   * wedges the breaker. See file-header JSDoc for the canonical
   * try/finally pattern.
   */
  check(): void {
    if (this.state === 'open' && this.openedAt !== null) {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < this.cooldownMs) {
        throw new CircuitOpenError(this.cooldownMs - elapsed, this.key);
      }
      // Cooldown elapsed — transition to Half-Open. The very next
      // `probeInFlight` check below decides whether THIS caller gets
      // the permit or hits the gate.
      this.state = 'half-open';
    }

    if (this.state === 'half-open') {
      if (this.probeInFlight) {
        throw new CircuitOpenError(this.halfOpenRetryAfterMs, this.key);
      }
      this.probeInFlight = true;
    }
    // Closed state falls through silently.
  }

  recordSuccess(): void {
    this.probeInFlight = false;
    this.consecutiveFailures = 0;
    this.state = 'closed';
    this.openedAt = null;
  }

  recordFailure(): void {
    this.probeInFlight = false;
    this.consecutiveFailures += 1;
    if (this.state === 'half-open' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  /**
   * Releases the probe permit BUT leaves state and counter untouched.
   * Use when an attempt produced a response or error that should not
   * influence breaker health in either direction — caller-driven aborts,
   * local AbortSignal timeouts, terminal 4xx client errors.
   *
   * Why permit-release-without-state-resolution: if `recordNeutral` did
   * not clear `probeInFlight`, a single `TimeoutError` from per-attempt
   * `AbortSignal.timeout` (which routes through neutral classification)
   * would permanently park the breaker in half-open. Since timeouts are
   * an *expected* outcome under flaky-dependency conditions, the cited
   * "per-attempt timeout bounds the stuck state" mitigation would itself
   * be the trigger for a permanent wedge. Releasing the permit closes
   * that loop while keeping the "neutral doesn't claim dependency
   * health" semantic.
   *
   * Calling `recordSuccess` for these would erase legitimate prior
   * failure signal; calling `recordFailure` would trip the breaker for
   * outcomes the backend isn't responsible for.
   */
  recordNeutral(): void {
    this.probeInFlight = false;
    // State and consecutiveFailures are preserved by design.
  }

  /**
   * Pure read — no state mutation, no permit accounting. Returns the
   * *would-be* state at the current instant: 'half-open' if the breaker
   * is open with cooldown elapsed (regardless of whether a probe is in
   * flight), 'open' if open and still in cooldown, 'closed' otherwise.
   *
   * Inspection-only; safe to call from tests without consuming a probe
   * permit. The implicit Open -> Half-Open transition that mutates
   * `state` lives in `check()` only.
   */
  getState(): State {
    if (this.state === 'open' && this.openedAt !== null) {
      const elapsed = this.now() - this.openedAt;
      if (elapsed >= this.cooldownMs) return 'half-open';
    }
    return this.state;
  }
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }
  /** Inspection-only test accessor for the half-open probe permit. */
  isProbeInFlight(): boolean {
    return this.probeInFlight;
  }
  /** Timestamp (ms since epoch) when the breaker last transitioned to Open,
   *  or `null` if it's currently Closed. Useful for computing remaining
   *  cooldown without consuming a probe permit via `check()`. */
  getOpenedAt(): number | null {
    return this.openedAt;
  }
  /** Configured cooldown duration in milliseconds. */
  getCooldownMs(): number {
    return this.cooldownMs;
  }
}

// ─── Per-process registry ────────────────────────────────────────────
//
// Single shared map keyed on caller-chosen strings. Used by
// `resilient-fetch.ts` so multiple call sites targeting the same logical
// endpoint share breaker state. Per-process only — not persisted.

const registry = new Map<string, CircuitBreaker>();

export function getBreaker(key: string, opts?: CircuitBreakerOptions): CircuitBreaker {
  let breaker = registry.get(key);
  if (!breaker) {
    breaker = new CircuitBreaker({ ...opts, key });
    registry.set(key, breaker);
  }
  return breaker;
}

/**
 * Test-only: clear all registered breakers. Tests must call this in
 * `beforeEach` to prevent breaker state from leaking across test cases.
 */
export function __resetBreakerRegistry__(): void {
  registry.clear();
}
