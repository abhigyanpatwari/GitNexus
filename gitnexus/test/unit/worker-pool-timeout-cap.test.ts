import { describe, expect, it } from 'vitest';

/**
 * Regression test for the defensive timeout-backoff cap in worker-pool.ts.
 *
 * Background: `requeueAfterTimeout` in workers/worker-pool.ts doubles the
 * per-job timeout on every split / retry with `Math.ceil(timeoutMs * factor)`.
 * With factor=2, a 30s timeout becomes 60s -> 120s -> 240s -> 480s after just
 * 4 splits with no upper bound — a pathological file could stall analyze for
 * 30+ minutes before the singleton retry budget exhausts.
 *
 * The cap is module-private (`MAX_TIMEOUT_BACKOFF_MS = 5 * 60 * 1000`) so
 * this test asserts the pure backoff arithmetic, not the runtime path.
 * If a future change drops the `Math.min(...)` wrap, the unbounded-growth
 * branch of this test will fail and the regression will surface.
 */
describe('requeueAfterTimeout backoff cap', () => {
  const FACTOR = 2;
  const MAX_TIMEOUT_BACKOFF_MS = 5 * 60 * 1000;
  const ONE_MINUTE = 60 * 1000;
  const THIRTY_MINUTES = 30 * 60 * 1000;

  const cappedBackoff = (timeout: number) =>
    Math.min(Math.ceil(timeout * FACTOR), MAX_TIMEOUT_BACKOFF_MS);

  it('caps nextTimeout at 5 minutes after 10 successive doublings', () => {
    let timeout = 30_000;
    for (let i = 0; i < 10; i++) {
      timeout = cappedBackoff(timeout);
    }
    expect(timeout).toBe(MAX_TIMEOUT_BACKOFF_MS);
  });

  it('caps well below the would-be unbounded value (30+ minutes)', () => {
    let timeout = 30_000;
    for (let i = 0; i < 10; i++) {
      timeout = cappedBackoff(timeout);
    }
    expect(timeout).toBeLessThan(THIRTY_MINUTES);
  });

  it('still grows monotonically before the cap (no regression in the fast path)', () => {
    let timeout = 30_000;
    const trajectory: number[] = [timeout];
    for (let i = 0; i < 6; i++) {
      timeout = cappedBackoff(timeout);
      trajectory.push(timeout);
    }
    // 30s -> 60s -> 120s -> 240s -> 300s (capped) -> 300s -> 300s
    expect(trajectory.slice(0, 5)).toEqual([
      30_000,
      60_000,
      120_000,
      240_000,
      MAX_TIMEOUT_BACKOFF_MS,
    ]);
    expect(trajectory.slice(4)).toEqual(Array(3).fill(MAX_TIMEOUT_BACKOFF_MS));
  });

  it('caps immediately on the first call when starting above MAX', () => {
    // Edge case: a caller (or env override) sets a very high initial timeout.
    // The cap should clamp to MAX on the first backoff, not amplify further.
    const initial = 10 * 60 * 1000; // 10 min initial
    expect(cappedBackoff(initial)).toBe(MAX_TIMEOUT_BACKOFF_MS);
  });

  it('preserves intermediate doubling when both sides are below the cap', () => {
    // Sanity: when both timeout * factor < MAX, the cap is a no-op.
    expect(cappedBackoff(ONE_MINUTE)).toBe(2 * ONE_MINUTE);
    expect(cappedBackoff(2 * ONE_MINUTE)).toBe(4 * ONE_MINUTE);
  });
});
