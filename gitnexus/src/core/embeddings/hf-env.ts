import os from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Download resilience defaults
// ---------------------------------------------------------------------------

/** Per-attempt timeout for the full model download (5 minutes). */
export const HF_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1_000;
/** Maximum total download attempts (1 initial + N-1 retries). */
export const HF_MAX_ATTEMPTS = 3;
/** Initial delay between retry attempts; doubles on each subsequent retry. */
export const HF_BASE_DELAY_MS = 2_000;
/** Number of consecutive failures required to open the circuit. */
export const CB_FAILURE_THRESHOLD = 3;
/** How long the circuit stays open before transitioning to half-open. */
export const CB_RESET_TIMEOUT_MS = 60_000;
/** Upper bound clamped on the env-override per-attempt timeout (30 minutes). */
export const HF_MAX_TIMEOUT_MS = 30 * 60 * 1_000;
/** Upper bound clamped on the env-override attempt count. */
export const HF_MAX_ATTEMPTS_CAP = 10;

/**
 * @internal Exported only for unit tests and the two embedder entry points
 * (`core/embeddings/embedder.ts` + `mcp/core/embedder.ts`). Not part of the
 * public package API.
 *
 * Minimal subset of `@huggingface/transformers`' `env` object that gitnexus
 * mutates. Defining a local structural type keeps this helper free of a
 * transitive dependency on transformers' generated `.d.ts` while still
 * giving full type-checking on the two fields we actually touch.
 */
export interface HfEnvSubset {
  cacheDir: string;
  remoteHost: string;
}

/**
 * @internal Exported only for unit tests and the two embedder entry points
 * (`core/embeddings/embedder.ts` + `mcp/core/embedder.ts`). Not part of the
 * public package API.
 *
 * Apply user-controlled HuggingFace environment overrides to the
 * `@huggingface/transformers` `env` object. Centralises the two env-var
 * bridges so every gitnexus embedder entry point (the analyze pipeline
 * and the MCP server) behaves identically.
 *
 * - **`HF_HOME`** → `env.cacheDir` (default: `~/.cache/huggingface`).
 *   transformers.js otherwise defaults to `./node_modules/.cache` inside
 *   its own install dir, which is unwritable when gitnexus is installed
 *   globally (e.g. `/usr/lib/node_modules/`).
 *
 * - **`HF_ENDPOINT`** → `env.remoteHost` (#1205). transformers.js does
 *   not read `HF_ENDPOINT` on its own — it reads `env.remoteHost` —
 *   even though `HF_ENDPOINT` is the standard env var the upstream
 *   `huggingface_hub` Python client and the official HF mirror docs
 *   tell users to set. Bridging the two unblocks `--embeddings` for
 *   users behind networks where `huggingface.co` is unreachable
 *   (corporate proxies, the GFW, air-gapped mirrors). The trailing
 *   slash is normalised because transformers.js builds URLs by string
 *   concatenation and a missing slash silently falls through to its
 *   default `huggingface.co/...` host.
 *
 * Mutation rather than return-and-apply because callers already hold a
 * reference to the live `env` object imported from
 * `@huggingface/transformers` — passing the same reference in keeps the
 * call site a single line at each entry point.
 */
export function applyHfEnvOverrides(env: HfEnvSubset): void {
  env.cacheDir = process.env.HF_HOME ?? join(os.homedir(), '.cache', 'huggingface');
  // `.trim()` guards against the common copy-paste failure mode of
  // `HF_ENDPOINT="  https://hf-mirror.com  "` (leading/trailing whitespace
  // from shell scripts or docs) — without it, a whitespace-only value
  // would be truthy and produce an invalid `env.remoteHost = '   /'` that
  // silently misroutes downloads. Empty string remains falsy in JS so the
  // truthy guard already handles the unset/empty cases.
  const endpoint = process.env.HF_ENDPOINT?.trim();
  if (endpoint) {
    env.remoteHost = endpoint.endsWith('/') ? endpoint : endpoint + '/';
  }
}

/**
 * @internal Exported for unit tests and the two embedder entry points.
 *
 * Returns true when an error message indicates a network-level fetch failure
 * during HuggingFace model download (e.g. `TypeError: fetch failed`,
 * `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`).
 *
 * These errors are not device-specific and cannot be fixed by falling back to
 * a different ONNX device — the caller should rethrow immediately with
 * guidance about `HF_ENDPOINT`.
 */
export function isNetworkFetchError(message: string): boolean {
  return (
    message.includes('fetch failed') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ENOTFOUND') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ECONNRESET')
  );
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

/** @internal Used by `withHfDownloadRetry` to mark a circuit-open rejection. */
export const CIRCUIT_OPEN_TAG = 'hf-circuit-open';

/** Circuit-breaker states. */
type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Circuit breaker for HuggingFace model downloads.
 *
 * After `failureThreshold` consecutive network failures the circuit opens and
 * all subsequent calls to `withHfDownloadRetry` fail immediately without
 * issuing any network requests. After `resetTimeoutMs` the circuit enters the
 * half-open state and the next call is attempted — if it succeeds the circuit
 * closes again; if it fails the circuit re-opens.
 *
 * Exported for unit-testing; production code should use the module-level
 * `hfDownloadCircuit` singleton.
 */
export class HfDownloadCircuitBreaker {
  private _state: CircuitState = 'closed';
  private _failures = 0;
  /** Timestamp of the last recorded failure (ms since epoch). */
  lastFailureAt = 0;

  constructor(
    readonly failureThreshold: number = CB_FAILURE_THRESHOLD,
    readonly resetTimeoutMs: number = CB_RESET_TIMEOUT_MS,
  ) {}

  /** Effective state, factoring in the reset-timeout transition. */
  get state(): CircuitState {
    if (this._state === 'open' && Date.now() - this.lastFailureAt > this.resetTimeoutMs) {
      this._state = 'half-open';
    }
    return this._state;
  }

  /** Returns true when the circuit is open and calls should be rejected. */
  isOpen(): boolean {
    return this.state === 'open';
  }

  /** Record a successful call — resets the failure counter and closes the circuit. */
  recordSuccess(): void {
    this._failures = 0;
    this._state = 'closed';
  }

  /** Record a failed call — increments the counter and opens the circuit when the threshold is reached. */
  recordFailure(): void {
    this._failures++;
    this.lastFailureAt = Date.now();
    if (this._failures >= this.failureThreshold) {
      this._state = 'open';
    }
  }

  /** @internal Reset to initial state (used in tests). */
  reset(): void {
    this._failures = 0;
    this._state = 'closed';
    this.lastFailureAt = 0;
  }
}

/** Module-level singleton shared by both embedder entry points. */
export const hfDownloadCircuit = new HfDownloadCircuitBreaker();

// ---------------------------------------------------------------------------
// Retry + timeout wrapper
// ---------------------------------------------------------------------------

/** @internal Returns true for errors that should abort without retry (circuit-open). */
export function isHfCircuitOpenError(message: string): boolean {
  return message.includes(CIRCUIT_OPEN_TAG);
}

/**
 * Returns true for any HuggingFace download failure that warrants showing the
 * `HF_ENDPOINT` remediation hint: either a raw network error or a
 * circuit-open rejection (which itself was caused by repeated network errors).
 */
export function isHfDownloadFailure(message: string): boolean {
  return isNetworkFetchError(message) || isHfCircuitOpenError(message);
}

/** @internal Wraps `fn` in a hard time-limit. The timeout error contains
 *  `ETIMEDOUT` so that `isNetworkFetchError` classifies it correctly.
 */
export function withDownloadTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `ETIMEDOUT: model download timed out after ${Math.round(timeoutMs / 1000)}s — ` +
              `check your network speed or set HF_ENDPOINT to a faster mirror`,
          ),
        ),
      timeoutMs,
    );
    fn().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** @internal Async sleep (exposed for testing). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HfRetryOptions {
  /** Maximum total attempts including the initial one (default: `HF_MAX_ATTEMPTS`). */
  maxAttempts?: number;
  /** Delay before the first retry; doubles on each subsequent attempt (default: `HF_BASE_DELAY_MS`). */
  baseDelayMs?: number;
  /** Per-attempt wall-clock timeout in ms (default: `HF_DOWNLOAD_TIMEOUT_MS`). */
  timeoutMs?: number;
  /**
   * Circuit-breaker instance to use. Defaults to the module-level
   * `hfDownloadCircuit` singleton. Pass a fresh instance in tests.
   */
  circuit?: HfDownloadCircuitBreaker;
  /**
   * Optional callback invoked before each retry (not the initial attempt).
   * @param attempt - 1-based retry number
   * @param max - total allowed attempts
   * @param error - the error that triggered the retry
   */
  onRetry?: (attempt: number, max: number, error: Error) => void;
}

/**
 * Retry wrapper for HuggingFace model downloads with per-attempt timeout and
 * circuit-breaker protection.
 *
 * Behaviour:
 * - If the circuit is **open**, fails immediately with a `CIRCUIT_OPEN_TAG`
 *   message (so `isHfDownloadFailure` still returns true and the caller can
 *   show `HF_ENDPOINT` guidance).
 * - Each attempt is wrapped in `withDownloadTimeout`.
 * - On a network-level error (`isNetworkFetchError`) the attempt is retried
 *   with exponential back-off; non-network errors (e.g. ONNX device failure)
 *   are rethrown immediately without retry.
 * - Every network failure is recorded on the circuit breaker; a success resets
 *   it.
 * - After all attempts are exhausted, the last network error is rethrown
 *   so the existing `isNetworkFetchError` / `isHfDownloadFailure` guards in
 *   the calling code still fire.
 */
export async function withHfDownloadRetry<T>(
  fn: () => Promise<T>,
  options: HfRetryOptions = {},
): Promise<T> {
  // Resolve effective values — explicit options take precedence over env vars,
  // which take precedence over built-in defaults. This lets users lower the
  // per-attempt timeout without rebuilding (e.g.
  //   HF_DOWNLOAD_TIMEOUT_MS=60000 npx gitnexus analyze --embeddings
  // reduces the worst-case wait from 15 minutes to ~3 minutes).
  //
  // Upper bounds are clamped to prevent accidental runaway configuration:
  //   - timeoutMs is capped at HF_MAX_TIMEOUT_MS (30 min)
  //   - maxAttempts is floored (fractional values → integer) and capped at
  //     HF_MAX_ATTEMPTS_CAP (10).  Values ≤ 0, NaN, or Infinity fall back to
  //     the built-in defaults.
  const envTimeout = Number(process.env.HF_DOWNLOAD_TIMEOUT_MS);
  const envMaxAttempts = Number(process.env.HF_MAX_ATTEMPTS);
  const resolvedTimeout =
    Number.isFinite(envTimeout) && envTimeout > 0
      ? Math.min(envTimeout, HF_MAX_TIMEOUT_MS)
      : HF_DOWNLOAD_TIMEOUT_MS;
  const resolvedMaxAttempts =
    Number.isFinite(envMaxAttempts) && envMaxAttempts > 0
      ? Math.min(Math.floor(envMaxAttempts), HF_MAX_ATTEMPTS_CAP)
      : HF_MAX_ATTEMPTS;
  const {
    maxAttempts = resolvedMaxAttempts,
    baseDelayMs = HF_BASE_DELAY_MS,
    timeoutMs = resolvedTimeout,
    circuit = hfDownloadCircuit,
    onRetry,
  } = options;
  if (circuit.isOpen()) {
    const secsUntilReset = Math.ceil(
      (circuit.resetTimeoutMs - (Date.now() - circuit.lastFailureAt)) / 1000,
    );
    throw new Error(
      `${CIRCUIT_OPEN_TAG}: HuggingFace download circuit is open after repeated network failures` +
        (secsUntilReset > 0 ? ` — will reset in ~${secsUntilReset}s` : ''),
    );
  }

  let lastError: Error = new Error('unknown error');

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await withDownloadTimeout(fn, timeoutMs);
      circuit.recordSuccess();
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (!isNetworkFetchError(lastError.message)) {
        // Non-network error (e.g. CUDA unavailable) — propagate without retry
        throw lastError;
      }

      circuit.recordFailure();

      if (circuit.isOpen()) {
        // Circuit just tripped — fail fast, no more retries
        throw new Error(
          `${CIRCUIT_OPEN_TAG}: HuggingFace download circuit opened after ${circuit.failureThreshold} consecutive failures`,
        );
      }

      if (attempt < maxAttempts - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        onRetry?.(attempt + 1, maxAttempts, lastError);
        await sleep(delay);
      }
    }
  }

  // All retries exhausted — throw the last network error so isNetworkFetchError
  // patterns in the calling code still match and surface HF_ENDPOINT guidance.
  throw lastError;
}
