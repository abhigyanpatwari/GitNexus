/**
 * Per-process circuit breaker.
 *
 * Closed -> Open transition fires after `failureThreshold` consecutive
 * failures. While Open, `check` throws `CircuitOpenError` until
 * `cooldownMs` has elapsed since the breaker tripped. The first call
 * after the cooldown enters Half-Open: a recorded success returns to
 * Closed; a recorded failure flips back to Open with a fresh timestamp.
 *
 * Runtime-agnostic: depends only on a `now()` clock and standard JS —
 * no Node-only imports. Tests inject `now` to advance the clock
 * deterministically without `vi.useFakeTimers()`.
 */

export class CircuitOpenError extends Error {
  override readonly name = 'CircuitOpenError';
  /** Approximate wait time before the breaker may transition to Half-Open. */
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
  /** Optional key for error messages and registry lookups. */
  key?: string;
  /** Clock override — defaults to `Date.now`. Tests inject deterministic time. */
  now?: () => number;
}

type State = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly key: string | undefined;
  private readonly now: () => number;

  private state: State = 'closed';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.key = opts.key;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Throw `CircuitOpenError` if the breaker is open and still in
   * cooldown. Otherwise transition Open -> Half-Open silently and
   * return so the caller can attempt the protected work.
   *
   * Call this immediately before invoking the protected operation;
   * pair it with `recordSuccess` / `recordFailure` based on the
   * outcome. The two-phase API (vs. `execute(fn)`) lets callers
   * classify outcomes themselves — a `resilient-fetch` caller
   * needs to count "5xx after retries exhausted" as a failure
   * but "401 auth error" as a no-op for breaker purposes.
   */
  check(): void {
    if (this.state === 'open' && this.openedAt !== null) {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < this.cooldownMs) {
        throw new CircuitOpenError(this.cooldownMs - elapsed, this.key);
      }
      this.state = 'half-open';
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
    this.openedAt = null;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === 'half-open' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  /** Inspection-only accessors for tests. */
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
