/**
 * `resilientFetch` — fetch wrapped in retry + circuit breaker, with
 * GitHub-flavoured retry classification baked in (Retry-After parsing,
 * 401/403/404/422 treated as terminal client errors).
 *
 * Designed for the `gitnexus publish` GitHub `repository_dispatch`
 * call, but the classification rules apply to any GitHub REST endpoint.
 * Runtime-agnostic — no Node-only imports.
 */

import {
  CircuitBreaker,
  CircuitOpenError,
  getBreaker,
  type CircuitBreakerOptions,
} from './circuit-breaker.js';
import { computeBackoffMs, type RetryOptions } from './retry.js';

export { CircuitOpenError };

export interface ResilientFetchOptions {
  /** Optional fetch implementation override. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Logical key for the breaker. Defaults to `<host><pathname>` of the
   * request URL — call sites targeting the same endpoint share breaker
   * state regardless of query-string differences.
   */
  breakerKey?: string;
  /** Per-call breaker override. Used for tests and one-off configuration. */
  breaker?: CircuitBreaker;
  /** Tuning knobs for the breaker registered under `breakerKey`. */
  breakerOptions?: CircuitBreakerOptions;
  /** Tuning knobs for the retry helper. */
  retry?: Partial<Pick<RetryOptions, 'maxAttempts' | 'baseDelayMs' | 'capDelayMs'>> & {
    sleep?: RetryOptions['sleep'];
    random?: RetryOptions['random'];
  };
  /** Clock override propagated into Retry-After HTTP-date math and breaker. */
  now?: () => number;
}

/** Cap on any single Retry-After wait — protects CLI from a buggy registry. */
export const RETRY_AFTER_CAP_MS = 30_000;

const DEFAULT_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 500,
  capDelayMs: 5_000,
};

/**
 * Parse a `Retry-After` header value into milliseconds.
 * Accepts either a delta-seconds integer (`"30"`) or an HTTP-date.
 * Returns null on parse failure or negative deltas.
 */
export function parseRetryAfter(value: string | null, now: () => number = Date.now): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  if (/^[0-9]+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    if (Number.isNaN(seconds) || seconds < 0) return null;
    return seconds * 1000;
  }

  const target = Date.parse(trimmed);
  if (Number.isNaN(target)) return null;
  const delta = target - now();
  return delta >= 0 ? delta : 0;
}

/** Internal: outcome classification used by the resilientFetch loop. */
type Outcome =
  | { kind: 'success'; resp: Response }
  | { kind: 'terminal-client'; resp: Response } // 4xx other than 429: no retry, no breaker hit
  | { kind: 'retryable-status'; resp: Response; afterMs: number | undefined } // 5xx, 429
  | { kind: 'terminal-network'; err: unknown } // timeout: no retry, no breaker hit
  | { kind: 'retryable-network'; err: unknown }; // DNS, ECONNRESET, etc.

/** Exported for unit tests. */
export function classifyOutcome(
  result: { kind: 'error'; err: unknown } | { kind: 'response'; resp: Response },
  now: () => number,
): Outcome {
  if (result.kind === 'error') {
    if (result.err instanceof DOMException && result.err.name === 'TimeoutError') {
      return { kind: 'terminal-network', err: result.err };
    }
    return { kind: 'retryable-network', err: result.err };
  }
  const resp = result.resp;
  if (resp.status >= 200 && resp.status < 400) return { kind: 'success', resp };
  if (resp.status === 429) {
    const parsed = parseRetryAfter(resp.headers.get('Retry-After'), now);
    return {
      kind: 'retryable-status',
      resp,
      afterMs: parsed !== null ? Math.min(parsed, RETRY_AFTER_CAP_MS) : undefined,
    };
  }
  if (resp.status >= 500) return { kind: 'retryable-status', resp, afterMs: undefined };
  return { kind: 'terminal-client', resp };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function defaultBreakerKey(input: string | URL): string {
  try {
    const url = typeof input === 'string' ? new URL(input) : input;
    return `${url.host}${url.pathname}`;
  } catch {
    return String(input);
  }
}

/** Final error thrown when retries are exhausted on a 5xx / 429. */
export class ResilientFetchExhaustedError extends Error {
  override readonly name = 'ResilientFetchExhaustedError';
  constructor(public readonly response: Response) {
    super(`Request failed after retries (HTTP ${response.status})`);
  }
}

/**
 * Wrap `fetch` with bounded retries and a per-process circuit breaker.
 *
 * Semantics:
 * - 5xx and 429 responses are retried; 429 honors `Retry-After` (capped).
 * - Network throws are retried unless they are `TimeoutError` DOMExceptions.
 * - Timeouts and 4xx (other than 429) are returned/thrown without retry
 *   AND without incrementing the breaker — they reflect caller config
 *   or local network state, not registry health.
 * - Each `fetch` call carries the caller-supplied `signal` (e.g. an
 *   `AbortSignal.timeout()`) — that timeout bounds each individual
 *   attempt, not the whole retry sequence.
 * - When the breaker is open, throws `CircuitOpenError` synchronously
 *   without invoking `fetch`.
 * - When retries are exhausted on a 5xx / 429, throws
 *   `ResilientFetchExhaustedError` carrying the last response.
 */
export async function resilientFetch(
  input: string | URL,
  init: RequestInit | undefined,
  opts: ResilientFetchOptions = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? (() => Date.now());
  const breaker =
    opts.breaker ?? getBreaker(opts.breakerKey ?? defaultBreakerKey(input), opts.breakerOptions);

  const retryConfig = {
    maxAttempts: opts.retry?.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
    baseDelayMs: opts.retry?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
    capDelayMs: opts.retry?.capDelayMs ?? DEFAULT_RETRY.capDelayMs,
  };
  const sleep = opts.retry?.sleep ?? defaultSleep;
  const random = opts.retry?.random ?? Math.random;

  // Fail fast on an open breaker, before invoking fetch.
  breaker.check();

  let lastRetryableResp: Response | null = null;

  for (let attempt = 0; attempt < retryConfig.maxAttempts; attempt++) {
    let result: { kind: 'error'; err: unknown } | { kind: 'response'; resp: Response };
    try {
      const resp = await fetchImpl(input, init);
      result = { kind: 'response', resp };
    } catch (err) {
      result = { kind: 'error', err };
    }

    const outcome = classifyOutcome(result, now);

    switch (outcome.kind) {
      case 'success':
        breaker.recordSuccess();
        return outcome.resp;

      case 'terminal-client':
        // 4xx: do not count as breaker failure. The caller will see
        // the Response and emit its own targeted error message
        // (401: bad token, 403: missing scope, 404: wrong repo, ...).
        breaker.recordSuccess();
        return outcome.resp;

      case 'terminal-network':
        // Timeout: the local `AbortSignal.timeout()` fired. The server
        // never had a chance to answer; this most likely reflects the
        // user's network rather than registry health. Don't punish
        // the breaker. Rethrow so the caller sees the timeout.
        breaker.recordSuccess();
        throw outcome.err;

      case 'retryable-status':
        lastRetryableResp = outcome.resp;
        if (attempt + 1 >= retryConfig.maxAttempts) {
          breaker.recordFailure();
          throw new ResilientFetchExhaustedError(outcome.resp);
        }
        await sleep(
          computeBackoffMs(
            attempt,
            retryConfig.baseDelayMs,
            retryConfig.capDelayMs,
            outcome.afterMs,
            random,
          ),
        );
        break;

      case 'retryable-network':
        if (attempt + 1 >= retryConfig.maxAttempts) {
          breaker.recordFailure();
          throw outcome.err;
        }
        await sleep(
          computeBackoffMs(
            attempt,
            retryConfig.baseDelayMs,
            retryConfig.capDelayMs,
            undefined,
            random,
          ),
        );
        break;
    }
  }

  // Loop terminated without returning — should be unreachable, but
  // surface a defensive error so we fail loudly rather than hanging.
  /* c8 ignore next 4 */
  if (lastRetryableResp) {
    breaker.recordFailure();
    throw new ResilientFetchExhaustedError(lastRetryableResp);
  }
  throw new Error('resilientFetch: retry loop terminated unexpectedly');
}
