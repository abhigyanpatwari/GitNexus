import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  __resetBreakerRegistry__,
  CircuitBreaker,
  CircuitOpenError,
  classifyOutcome,
  parseRetryAfter,
  resilientFetch,
  ResilientFetchExhaustedError,
  RETRY_AFTER_CAP_MS,
} from 'gitnexus-shared';

describe('parseRetryAfter', () => {
  it('parses delta-seconds form', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter('0')).toBe(0);
  });
  it('returns null on negative or non-numeric garbage', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('   ')).toBeNull();
    expect(parseRetryAfter('not-a-number')).toBeNull();
  });
  it('parses HTTP-date form against an injected clock', () => {
    const now = () => Date.parse('Wed, 21 Oct 2025 07:28:00 GMT');
    expect(parseRetryAfter('Wed, 21 Oct 2025 07:28:30 GMT', now)).toBe(30_000);
  });
  it('returns 0 (not negative) on past HTTP-date', () => {
    const now = () => Date.parse('Wed, 21 Oct 2025 08:00:00 GMT');
    expect(parseRetryAfter('Wed, 21 Oct 2025 07:28:00 GMT', now)).toBe(0);
  });
});

describe('classifyOutcome', () => {
  const now = () => 1_700_000_000_000;

  it('classifies 2xx as success', () => {
    const resp = new Response(null, { status: 204 });
    const out = classifyOutcome({ kind: 'response', resp }, now);
    expect(out.kind).toBe('success');
  });
  it('classifies 5xx as retryable-status without afterMs', () => {
    const resp = new Response(null, { status: 503 });
    const out = classifyOutcome({ kind: 'response', resp }, now);
    expect(out.kind).toBe('retryable-status');
    if (out.kind === 'retryable-status') expect(out.afterMs).toBeUndefined();
  });
  it('classifies 429 with Retry-After (capped) as retryable-status', () => {
    const resp = new Response(null, { status: 429, headers: { 'Retry-After': '99999' } });
    const out = classifyOutcome({ kind: 'response', resp }, now);
    expect(out.kind).toBe('retryable-status');
    if (out.kind === 'retryable-status') expect(out.afterMs).toBe(RETRY_AFTER_CAP_MS);
  });
  it('classifies 401/403/404/422 as terminal-client', () => {
    for (const status of [401, 403, 404, 422, 400]) {
      const resp = new Response(null, { status });
      const out = classifyOutcome({ kind: 'response', resp }, now);
      expect(out.kind).toBe('terminal-client');
    }
  });
  it('classifies TimeoutError as terminal-network', () => {
    const err = new DOMException('aborted', 'TimeoutError');
    const out = classifyOutcome({ kind: 'error', err }, now);
    expect(out.kind).toBe('terminal-network');
  });
  it('classifies generic network throw as retryable-network', () => {
    const err = new TypeError('fetch failed');
    const out = classifyOutcome({ kind: 'error', err }, now);
    expect(out.kind).toBe('retryable-network');
  });
});

describe('resilientFetch', () => {
  const URL_STR = 'https://example.test/api/dispatch';

  beforeEach(() => __resetBreakerRegistry__());

  function jsonResp(status: number, headers?: Record<string, string>): Response {
    return new Response(null, { status, headers });
  }

  function makeBreaker(opts: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}) {
    let t = 1_700_000_000_000;
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 30_000,
      key: 'test',
      now: () => t,
      ...opts,
    });
    return { breaker, advance: (ms: number) => (t += ms) };
  }

  it('204 returns immediately, no retries, breaker stays closed', async () => {
    const fetchImpl = vi.fn(async () => jsonResp(204));
    const sleep = vi.fn(async () => {});
    const { breaker } = makeBreaker();
    const resp = await resilientFetch(URL_STR, undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      breaker,
      retry: { sleep },
    });
    expect(resp.status).toBe(204);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.getConsecutiveFailures()).toBe(0);
  });

  it('one 503 then 204 → retried once, returns 204, breaker stays closed', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return n === 1 ? jsonResp(503) : jsonResp(204);
    });
    const sleep = vi.fn(async () => {});
    const { breaker } = makeBreaker();
    const resp = await resilientFetch(URL_STR, undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      breaker,
      retry: { sleep, random: () => 0.5, baseDelayMs: 100, capDelayMs: 1000 },
    });
    expect(resp.status).toBe(204);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(breaker.getConsecutiveFailures()).toBe(0);
  });

  it('429 with Retry-After honored (capped at RETRY_AFTER_CAP_MS)', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return n === 1 ? jsonResp(429, { 'Retry-After': '1' }) : jsonResp(204);
    });
    const sleep = vi.fn(async () => {});
    const { breaker } = makeBreaker();
    await resilientFetch(URL_STR, undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      breaker,
      retry: { sleep },
    });
    expect(sleep).toHaveBeenCalledWith(1000); // 1s
  });

  it('429 with absurd Retry-After is capped to RETRY_AFTER_CAP_MS', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return n === 1 ? jsonResp(429, { 'Retry-After': '99999' }) : jsonResp(204);
    });
    const sleep = vi.fn(async () => {});
    const { breaker } = makeBreaker();
    await resilientFetch(URL_STR, undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      breaker,
      retry: { sleep, capDelayMs: 999_999 }, // ensure cap comes from RETRY_AFTER_CAP_MS, not retry config
    });
    expect(sleep).toHaveBeenCalledWith(RETRY_AFTER_CAP_MS);
  });

  it('429 without Retry-After falls back to exponential-backoff delay', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return n === 1 ? jsonResp(429) : jsonResp(204);
    });
    const sleep = vi.fn(async () => {});
    const { breaker } = makeBreaker();
    await resilientFetch(URL_STR, undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      breaker,
      retry: { sleep, baseDelayMs: 100, capDelayMs: 1000, random: () => 0.5 },
    });
    // attempt 0: full-jitter upper = min(1000, 100*1) = 100; floor(0.5*100) = 50
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it('401 returned as Response, no retry, breaker not incremented', async () => {
    const fetchImpl = vi.fn(async () => jsonResp(401));
    const sleep = vi.fn(async () => {});
    const { breaker } = makeBreaker();
    const resp = await resilientFetch(URL_STR, undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      breaker,
      retry: { sleep },
    });
    expect(resp.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(breaker.getConsecutiveFailures()).toBe(0);
  });

  it('422 returned as Response, no retry', async () => {
    const fetchImpl = vi.fn(async () => jsonResp(422));
    const { breaker } = makeBreaker();
    const resp = await resilientFetch(URL_STR, undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      breaker,
      retry: { sleep: async () => {} },
    });
    expect(resp.status).toBe(422);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('TimeoutError rethrown immediately, no retry, breaker not incremented', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('aborted', 'TimeoutError');
    });
    const sleep = vi.fn(async () => {});
    const { breaker } = makeBreaker();
    await expect(
      resilientFetch(URL_STR, undefined, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        breaker,
        retry: { sleep },
      }),
    ).rejects.toThrow(DOMException);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(breaker.getConsecutiveFailures()).toBe(0);
  });

  it('three consecutive 503 throws ResilientFetchExhaustedError; breaker increments by 1', async () => {
    const fetchImpl = vi.fn(async () => jsonResp(503));
    const sleep = vi.fn(async () => {});
    const { breaker } = makeBreaker();
    await expect(
      resilientFetch(URL_STR, undefined, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        breaker,
        retry: { sleep, maxAttempts: 3 },
      }),
    ).rejects.toBeInstanceOf(ResilientFetchExhaustedError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(breaker.getConsecutiveFailures()).toBe(1);
  });

  it('after three exhausted 503 batches, breaker opens and fails fast', async () => {
    const fetchImpl = vi.fn(async () => jsonResp(503));
    const { breaker } = makeBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      await expect(
        resilientFetch(URL_STR, undefined, {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          breaker,
          retry: { sleep: async () => {}, maxAttempts: 3 },
        }),
      ).rejects.toBeInstanceOf(ResilientFetchExhaustedError);
    }
    expect(breaker.getState()).toBe('open');
    // 4th call: breaker open, no fetch invoked.
    const fetchCallsBefore = fetchImpl.mock.calls.length;
    await expect(
      resilientFetch(URL_STR, undefined, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        breaker,
        retry: { sleep: async () => {}, maxAttempts: 3 },
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchImpl.mock.calls.length).toBe(fetchCallsBefore);
  });

  it('retryable-network error retries, breaker counts only on exhaustion', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { breaker } = makeBreaker();
    await expect(
      resilientFetch(URL_STR, undefined, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        breaker,
        retry: { sleep: async () => {}, maxAttempts: 3 },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(breaker.getConsecutiveFailures()).toBe(1);
  });
});
