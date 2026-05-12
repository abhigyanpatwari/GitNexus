import { describe, it, expect, vi } from 'vitest';
import { computeBackoffMs, withRetry, type RetryOptions } from 'gitnexus-shared';

describe('computeBackoffMs', () => {
  it('returns afterMs (capped) when caller supplies it', () => {
    expect(computeBackoffMs(0, 500, 5000, 1500, () => 0.5)).toBe(1500);
    expect(computeBackoffMs(0, 500, 5000, 99_999, () => 0.5)).toBe(5000);
    expect(computeBackoffMs(0, 500, 5000, 0, () => 0.5)).toBe(0);
    expect(computeBackoffMs(0, 500, 5000, -1, () => 0.5)).toBe(0);
  });

  it('full-jitter delay falls within [0, min(cap, base * 2^attempt)]', () => {
    // attempt 0: upper = min(5000, 500 * 1) = 500
    expect(computeBackoffMs(0, 500, 5000, undefined, () => 0)).toBe(0);
    expect(computeBackoffMs(0, 500, 5000, undefined, () => 0.999)).toBeLessThan(500);
    // attempt 1: upper = min(5000, 500 * 2) = 1000
    expect(computeBackoffMs(1, 500, 5000, undefined, () => 0.5)).toBe(500);
    // attempt 4: 500 * 16 = 8000, capped at 5000
    expect(computeBackoffMs(4, 500, 5000, undefined, () => 0.5)).toBe(2500);
    expect(computeBackoffMs(4, 500, 5000, undefined, () => 0.999)).toBeLessThan(5000);
  });
});

describe('withRetry', () => {
  function makeOpts(overrides: Partial<RetryOptions> = {}): RetryOptions {
    return {
      maxAttempts: 3,
      baseDelayMs: 10,
      capDelayMs: 100,
      isRetryable: () => ({ retry: true }),
      sleep: vi.fn(async () => {}),
      random: () => 0.5,
      ...overrides,
    };
  }

  it('returns immediately when fn succeeds first try', async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => 'ok');
    const result = await withRetry(fn, makeOpts({ sleep }));
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries when isRetryable returns retry:true and second call succeeds', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return 'ok';
    };
    const result = await withRetry(fn, makeOpts({ sleep }));
    expect(result).toBe('ok');
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('honors afterMs returned by isRetryable', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls === 1) throw new Error('throttle');
      return 'ok';
    };
    await withRetry(
      fn,
      makeOpts({
        sleep,
        isRetryable: () => ({ retry: true, afterMs: 1500 }),
        capDelayMs: 5000,
      }),
    );
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it('caps afterMs at capDelayMs', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls === 1) throw new Error('throttle');
      return 'ok';
    };
    await withRetry(
      fn,
      makeOpts({
        sleep,
        isRetryable: () => ({ retry: true, afterMs: 10_000 }),
        capDelayMs: 3000,
      }),
    );
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('rethrows immediately when isRetryable returns retry:false', async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => {
      throw new Error('terminal');
    });
    await expect(
      withRetry(fn, makeOpts({ sleep, isRetryable: () => ({ retry: false }) })),
    ).rejects.toThrow('terminal');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws the last error when maxAttempts exhausted', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const fn = async () => {
      calls += 1;
      throw new Error(`boom-${calls}`);
    };
    await expect(withRetry(fn, makeOpts({ sleep, maxAttempts: 3 }))).rejects.toThrow('boom-3');
    expect(calls).toBe(3);
    // 3 attempts → 2 sleeps between them; final attempt does not sleep.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('rejects maxAttempts < 1', async () => {
    await expect(withRetry(async () => 'ok', makeOpts({ maxAttempts: 0 }))).rejects.toThrow(
      /maxAttempts must be >= 1/,
    );
  });
});
