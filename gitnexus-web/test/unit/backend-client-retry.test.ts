/**
 * Method-aware retry budget + timeout-as-TimeoutError verification for
 * backend-client's `fetchWithTimeout`.
 *
 * Closes review findings on PR #1448:
 *   - Non-idempotent POST/DELETE must NOT be retried by default —
 *     a 5xx on `startAnalyze` could otherwise start a duplicate job.
 *   - Timer-fired timeout must surface as `DOMException(name='TimeoutError')`,
 *     not `AbortError`, so resilientFetch routes it through the
 *     terminal-network branch (no retry, no breaker hit).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBreaker } from 'gitnexus-shared';
import { __resetBreakerRegistry__ } from 'gitnexus-shared/test-helpers';
import { fetchRepos, setBackendUrl, startAnalyze } from '../../src/services/backend-client';

const BASE = 'http://localhost:4747';

describe('backend-client retry budget (method-aware)', () => {
  beforeEach(() => {
    __resetBreakerRegistry__();
    setBackendUrl(BASE);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET retries once on transient 503 (idempotent verb)', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      if (n === 1) return new Response('boom', { status: 503 });
      return new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const repos = await fetchRepos();
    expect(repos).toEqual([]);
    // 1 retry budget on idempotent GET → 2 total fetch calls.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('POST does NOT retry on 503 by default (non-idempotent verb)', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(startAnalyze({ path: '/tmp/repo' })).rejects.toBeTruthy();
    // Single attempt — never duplicates a job-start POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('switching backend URL after a circuit opens reaches a fresh breaker (U3)', async () => {
    // Pre-open the breaker for host-A by directly recording 3 failures.
    setBackendUrl('http://host-a.test:4747');
    const aKey = 'web-backend:http://host-a.test:4747';
    const breakerA = getBreaker(aKey);
    breakerA.recordFailure();
    breakerA.recordFailure();
    breakerA.recordFailure();
    expect(breakerA.getState()).toBe('open');

    // Switch to host-B and make a request — must succeed against the
    // new origin without tripping the host-A circuit. Under the old
    // single-key behaviour the call would throw CircuitOpenError.
    setBackendUrl('http://host-b.test:4747');
    const fetchMock = vi.fn(
      async () =>
        new Response('[]', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const repos = await fetchRepos();
    expect(repos).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Host-A's breaker is still open in cooldown.
    expect(breakerA.getState()).toBe('open');
    // Host-B has its own (fresh) breaker.
    const bKey = 'web-backend:http://host-b.test:4747';
    expect(getBreaker(bKey).getState()).toBe('closed');
    expect(getBreaker(bKey).getConsecutiveFailures()).toBe(0);
  });

  it('breaker not incremented when timeout fires (TimeoutError, not AbortError)', async () => {
    // Reject directly with a TimeoutError DOMException, mimicking what
    // `fetch` produces when its `AbortSignal.timeout()`-wired signal
    // fires. The real-fetch path goes signal.reason → reject(reason);
    // we shortcut that here so the test doesn't have to wait the
    // 30-second default timeout.
    const fetchMock = vi.fn(async () => {
      throw new DOMException('aborted by timeout', 'TimeoutError');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchRepos()).rejects.toMatchObject({ code: 'timeout' });

    // The breaker must not have been penalized for a local timeout.
    expect(getBreaker(`web-backend:${BASE}`).getConsecutiveFailures()).toBe(0);
    // Timeout is terminal — no retry attempted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
