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
  | { kind: 'terminal-client'; resp: Response } // 4xx other than 429: no retry, breaker neutral
  | { kind: 'retryable-status'; resp: Response; afterMs: number | undefined } // 5xx, 429
  | { kind: 'terminal-network'; err: unknown } // TimeoutError or AbortError: no retry, breaker neutral
  | { kind: 'retryable-network'; err: unknown }; // DNS, ECONNRESET, etc.

/** Exported for unit tests. */
export function classifyOutcome(
  result: { kind: 'error'; err: unknown } | { kind: 'response'; resp: Response },
  now: () => number,
): Outcome {
  if (result.kind === 'error') {
    // Both timer-fired aborts (`AbortSignal.timeout()` → `TimeoutError`)
    // and caller-driven aborts (`AbortController.abort()` → `AbortError`)
    // are terminal: retrying against an already-aborted signal would
    // fail again immediately, and neither outcome reflects backend
    // health. They route through the breaker's neutral path.
    if (
      result.err instanceof DOMException &&
      (result.err.name === 'TimeoutError' || result.err.name === 'AbortError')
    ) {
      return { kind: 'terminal-network', err: result.err };
    }
    return { kind: 'retryable-network', err: result.err };
  }
  const resp = result.resp;
  if (resp.status >= 200 && resp.status < 400) return { kind: 'success', resp };
  if (resp.status === 429) {
    // `resp.headers` is always present on a real `Response`, but tests
    // sometimes stub `fetch` with a plain `{ ok, status }` object. Be
    // defensive — a missing `Retry-After` falls through to exponential
    // backoff, which is the correct behaviour anyway.
    const retryAfterHeader =
      typeof resp.headers?.get === 'function' ? resp.headers.get('Retry-After') : null;
    const parsed = parseRetryAfter(retryAfterHeader, now);
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
 *
 * Cumulative wall-clock budget:
 *   maxAttempts × (per-attempt-timeout + capDelayMs)
 *   With defaults (3, 500ms base, 5000ms cap) and a typical 15s per-attempt
 *   timeout from the caller's signal, worst case is ~3 × (15s + 5s) = 60s.
 *   Callers that want a tighter total bound should reduce `maxAttempts` or
 *   wrap `resilientFetch` in their own outer `AbortSignal.timeout()`.
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

  for (let attempt = 0; attempt < retryConfig.maxAttempts; attempt++) {
    let result: { kind: 'error'; err: unknown } | { kind: 'response'; resp: Response };
    try {
      // CodeQL js/server-side-request-forgery — flagged because `input`
      // is caller-supplied. Suppressed: every concrete caller passes
      // either a hardcoded URL constant (UNDERSTAND_QUICKLY_DISPATCH_URL,
      // OpenRouter base URL) or a value derived from configuration
      // (env vars, saved settings, the local backend URL). User-input
      // request fields (e.g. PR title, repo name) never flow into
      // `input`. Validating URL shape here would push false-positive
      // rejection onto every caller — wrong layer for the check.
      // lgtm[js/server-side-request-forgery]
      // codeql[js/server-side-request-forgery]
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
        // 4xx: do not count as breaker failure (the server is healthy
        // and rejecting our request — auth, scope, or routing). But
        // also do NOT call recordSuccess: a 401 sandwiched between
        // 5xx responses would otherwise erase the running outage
        // signal. The breaker's neutral path leaves state untouched.
        breaker.recordNeutral();
        return outcome.resp;

      case 'terminal-network':
        // Either `AbortSignal.timeout()` fired locally OR an external
        // caller cancelled the request via AbortController. The server
        // never had a chance to answer; this reflects the user's
        // network or an explicit cancel, not registry health. Don't
        // punish the breaker AND don't reset its outage signal.
        breaker.recordNeutral();
        throw outcome.err;

      case 'retryable-status':
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

      default: {
        // Exhaustiveness guard. If a sixth `Outcome` kind is added in
        // future, TypeScript will refuse to assign it to `never` and
        // this line forces the maintainer to add an explicit arm
        // rather than silently fall through to retry/no-retry behaviour.
        const _exhaustive: never = outcome;
        throw new Error(`resilientFetch: unhandled outcome ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  // Unreachable: every iteration of the loop either returns (success
  // / terminal-client) or throws (terminal-network / retry exhaustion).
  // The throw is here purely so TypeScript's control-flow analysis sees
  // the function never falls off the end without producing `Promise<Response>`.
  /* c8 ignore next 2 */
  throw new Error('resilientFetch: retry loop terminated unexpectedly');
}
