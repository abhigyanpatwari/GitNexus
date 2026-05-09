import { describe, it, expect, beforeEach } from 'vitest';
import {
  CircuitBreaker,
  CircuitOpenError,
  __resetBreakerRegistry__,
  getBreaker,
} from 'gitnexus-shared';

describe('CircuitBreaker', () => {
  beforeEach(() => __resetBreakerRegistry__());

  function makeClock(start = 1_700_000_000_000) {
    let t = start;
    return {
      now: () => t,
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  it('runs through check/recordSuccess in closed state', () => {
    const clock = makeClock();
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000, now: clock.now });
    expect(b.getState()).toBe('closed');
    b.check(); // does not throw
    b.recordSuccess();
    expect(b.getState()).toBe('closed');
    expect(b.getConsecutiveFailures()).toBe(0);
  });

  it('stays closed below the failure threshold', () => {
    const clock = makeClock();
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000, now: clock.now });
    b.recordFailure();
    b.recordFailure();
    expect(b.getState()).toBe('closed');
    expect(b.getConsecutiveFailures()).toBe(2);
  });

  it('opens after failureThreshold consecutive failures and check throws', () => {
    const clock = makeClock();
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000, now: clock.now });
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    expect(b.getState()).toBe('open');
    expect(() => b.check()).toThrow(CircuitOpenError);
  });

  it('CircuitOpenError.retryAfterMs decreases as time advances', () => {
    const clock = makeClock();
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: clock.now });
    b.recordFailure();
    let caught: CircuitOpenError | null = null;
    try {
      b.check();
    } catch (err) {
      caught = err as CircuitOpenError;
    }
    expect(caught?.retryAfterMs).toBe(30_000);

    clock.advance(10_000);
    try {
      b.check();
    } catch (err) {
      caught = err as CircuitOpenError;
    }
    expect(caught?.retryAfterMs).toBe(20_000);
  });

  it('transitions Open -> Half-Open after cooldown elapses (via check)', () => {
    const clock = makeClock();
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: clock.now });
    b.recordFailure();
    expect(b.getState()).toBe('open');
    clock.advance(31_000);
    b.check(); // should not throw
    // After check, internal state is half-open (next call probes).
    expect(b.getConsecutiveFailures()).toBe(1); // unchanged until next outcome
  });

  it('half-open + recordSuccess -> closed and counter reset', () => {
    const clock = makeClock();
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: clock.now });
    b.recordFailure();
    clock.advance(31_000);
    b.check();
    b.recordSuccess();
    expect(b.getState()).toBe('closed');
    expect(b.getConsecutiveFailures()).toBe(0);
  });

  it('half-open + recordFailure -> open with fresh openedAt', () => {
    const clock = makeClock();
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: clock.now });
    b.recordFailure();
    const firstOpen = clock.now();
    clock.advance(31_000); // cooldown expired
    b.check(); // half-open
    b.recordFailure();
    // Open with fresh timestamp — full cooldown again.
    let caught: CircuitOpenError | null = null;
    try {
      b.check();
    } catch (err) {
      caught = err as CircuitOpenError;
    }
    expect(caught).toBeInstanceOf(CircuitOpenError);
    expect(caught?.retryAfterMs).toBe(30_000);
    // Sanity: not the original openedAt (would be negative remaining).
    expect(clock.now()).toBeGreaterThan(firstOpen);
  });

  it('recordSuccess from closed state with prior partial failures resets counter', () => {
    const b = new CircuitBreaker({ failureThreshold: 5 });
    b.recordFailure();
    b.recordFailure();
    expect(b.getConsecutiveFailures()).toBe(2);
    b.recordSuccess();
    expect(b.getConsecutiveFailures()).toBe(0);
    expect(b.getState()).toBe('closed');
  });

  describe('recordNeutral (U1)', () => {
    it('is a no-op from closed state with zero prior failures', () => {
      const b = new CircuitBreaker({ failureThreshold: 3 });
      b.recordNeutral();
      expect(b.getState()).toBe('closed');
      expect(b.getConsecutiveFailures()).toBe(0);
    });

    it('preserves partial-failure progress (does not reset counter)', () => {
      const b = new CircuitBreaker({ failureThreshold: 3 });
      b.recordFailure();
      b.recordFailure();
      b.recordNeutral();
      expect(b.getConsecutiveFailures()).toBe(2);
      expect(b.getState()).toBe('closed');
      // Real third failure still trips the breaker — neutrals didn't
      // erase the running count toward the threshold.
      b.recordFailure();
      expect(b.getState()).toBe('open');
    });

    it('does not reset openedAt or transition out of open state', () => {
      const clock = makeClock();
      const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: clock.now });
      b.recordFailure();
      expect(b.getState()).toBe('open');
      b.recordNeutral();
      // Still open; cooldown clock unchanged.
      expect(() => b.check()).toThrow(CircuitOpenError);
    });

    it('leaves half-open state alone (next true outcome decides)', () => {
      const clock = makeClock();
      const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30_000, now: clock.now });
      b.recordFailure();
      clock.advance(31_000);
      b.check(); // half-open
      b.recordNeutral();
      // Still half-open; a subsequent recordFailure flips to open.
      b.recordFailure();
      let caught: CircuitOpenError | null = null;
      try {
        b.check();
      } catch (err) {
        caught = err as CircuitOpenError;
      }
      expect(caught).toBeInstanceOf(CircuitOpenError);
    });

    it('integration: 2 failures + 5 neutrals + 1 failure → opens on third real failure', () => {
      const b = new CircuitBreaker({ failureThreshold: 3 });
      b.recordFailure();
      b.recordFailure();
      for (let i = 0; i < 5; i++) b.recordNeutral();
      expect(b.getConsecutiveFailures()).toBe(2);
      expect(b.getState()).toBe('closed');
      b.recordFailure();
      expect(b.getState()).toBe('open');
    });
  });

  describe('getBreaker registry', () => {
    it('returns the same instance for the same key', () => {
      const a = getBreaker('endpoint-a');
      const b = getBreaker('endpoint-a');
      expect(a).toBe(b);
    });

    it('returns different instances for different keys', () => {
      const a = getBreaker('endpoint-a');
      const b = getBreaker('endpoint-b');
      expect(a).not.toBe(b);
    });

    it('__resetBreakerRegistry__ clears all instances', () => {
      const a = getBreaker('endpoint-a');
      __resetBreakerRegistry__();
      const a2 = getBreaker('endpoint-a');
      expect(a2).not.toBe(a);
    });
  });
});
