/**
 * HTTP Embedding Client
 *
 * Shared fetch+retry logic for OpenAI-compatible /v1/embeddings endpoints.
 * Imported by both the core embedder (batch) and MCP embedder (query).
 *
 * Network resilience is delegated to `resilientFetch` from
 * `gitnexus-shared` — bounded retries with exponential-backoff jitter,
 * `Retry-After` honored on 429, and an in-process circuit breaker that
 * fails fast on a flapping endpoint. Per-attempt timeout is enforced
 * via `AbortSignal.timeout` on the underlying fetch.
 */

import { chunk } from '../lbug/query-batch.js';
import {
  CircuitOpenError,
  ResilientFetchExhaustedError,
  isTerminalNetworkError,
  resilientFetch,
} from 'gitnexus-shared';

const DEFAULT_HTTP_TIMEOUT_MS = 180_000;
const MAX_HTTP_TIMEOUT_MS = 300_000;
const HTTP_MAX_RETRIES = 2;
const HTTP_RETRY_BACKOFF_MS = 1_000;
const HTTP_RETRY_CAP_MS = 5_000;
const HTTP_BATCH_SIZE = 64;
const DEFAULT_DIMS = 384;
const HTTP_BREAKER_KEY = 'embeddings-http';

const HTTP_TIMEOUT_ENV = 'GITNEXUS_EMBEDDING_HTTP_TIMEOUT_MS';

interface HttpConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  dimensions?: number;
  maxAttempts: number;
  retryCapMs: number;
  minIntervalMs: number;
  timeoutMs: number;
  requestDimensions?: number;
}

export interface EmbeddingRequestOptions {
  signal?: AbortSignal;
}

let lastHttpRequestStartedAt: number | undefined;
let httpPaceQueue: Promise<void> = Promise.resolve();

const parsePositiveIntegerEnv = (name: string, fallback: number, max: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be a positive integer <= ${max}, got "${raw}"`);
  }
  return parsed;
};

const parseNonNegativeIntegerEnv = (name: string, fallback: number, max: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`${name} must be a non-negative integer <= ${max}, got "${raw}"`);
  }
  return parsed;
};

const cancelledError = (): DOMException =>
  new DOMException('Embedding request cancelled', 'AbortError');

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw cancelledError();
};

const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  throwIfAborted(signal);
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(cancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

const paceHttpRequest = async (minIntervalMs: number, signal?: AbortSignal): Promise<void> => {
  throwIfAborted(signal);
  if (minIntervalMs <= 0) return;
  const waitTurn = httpPaceQueue.then(async () => {
    throwIfAborted(signal);
    const waitMs =
      lastHttpRequestStartedAt === undefined
        ? 0
        : Math.max(0, lastHttpRequestStartedAt + minIntervalMs - Date.now());
    await abortableSleep(waitMs, signal);
    throwIfAborted(signal);
    lastHttpRequestStartedAt = Date.now();
  });
  httpPaceQueue = waitTurn.catch(() => undefined);
  await waitTurn;
};

/**
 * Stable lead of a {@link readConfig} malformed dims-env error. `readConfig`
 * throws a plain `Error` (not an {@link HttpEmbeddingError}) for a malformed
 * `GITNEXUS_EMBEDDING_DIMS` or `GITNEXUS_EMBEDDING_REQUEST_DIMS` because it's a
 * *config* mistake, not an endpoint failure — so the CLI recognizes it by this
 * lead ({@link isHttpEmbeddingDimsError}) and prints a clean config message
 * instead of a raw stack dump. Each var names itself so the message points the
 * operator at the variable they actually set, not a sibling. See #2385.
 */
const dimsEnvErrorLead = (name: string): string => `${name} must be a positive integer`;
const EMBEDDING_DIMS_ENV_ERROR_LEAD = dimsEnvErrorLead('GITNEXUS_EMBEDDING_DIMS');
const EMBEDDING_REQUEST_DIMS_ENV_ERROR_LEAD = dimsEnvErrorLead('GITNEXUS_EMBEDDING_REQUEST_DIMS');

/**
 * @internal Exported for the CLI analyze error handler. True when `message` is a
 * {@link readConfig} malformed dims-env config error (a plain `Error`) — for
 * either `GITNEXUS_EMBEDDING_DIMS` or `GITNEXUS_EMBEDDING_REQUEST_DIMS`.
 */
export const isHttpEmbeddingDimsError = (message: string): boolean =>
  message.includes(EMBEDDING_DIMS_ENV_ERROR_LEAD) ||
  message.includes(EMBEDDING_REQUEST_DIMS_ENV_ERROR_LEAD);

/**
 * Build config from the current process.env snapshot.
 * Returns null when GITNEXUS_EMBEDDING_URL + GITNEXUS_EMBEDDING_MODEL are unset.
 * Not cached — env vars are read fresh so late configuration takes effect.
 * Validates GITNEXUS_EMBEDDING_DIMS and throws on a malformed value; callers
 * that only need to know whether HTTP mode is *configured* must use
 * {@link isHttpMode} (a presence probe that never throws), not this.
 */
const readConfig = (): HttpConfig | null => {
  const baseUrl = process.env.GITNEXUS_EMBEDDING_URL;
  const model = process.env.GITNEXUS_EMBEDDING_MODEL;
  if (!baseUrl || !model) return null;

  const rawDims = process.env.GITNEXUS_EMBEDDING_DIMS;
  let dimensions: number | undefined;
  if (rawDims !== undefined) {
    if (!/^\d+$/.test(rawDims)) {
      throw new Error(`${EMBEDDING_DIMS_ENV_ERROR_LEAD}, got "${rawDims}"`);
    }
    const parsed = parseInt(rawDims, 10);
    if (parsed <= 0) {
      throw new Error(`${EMBEDDING_DIMS_ENV_ERROR_LEAD}, got "${rawDims}"`);
    }
    dimensions = parsed;
  }

  const rawRequestDims = process.env.GITNEXUS_EMBEDDING_REQUEST_DIMS?.trim();
  let requestDimensions = dimensions;
  if (rawRequestDims) {
    if (/^(omit|none|off|false|0)$/i.test(rawRequestDims)) {
      requestDimensions = undefined;
    } else {
      if (!/^\d+$/.test(rawRequestDims)) {
        throw new Error(`${EMBEDDING_REQUEST_DIMS_ENV_ERROR_LEAD}, got "${rawRequestDims}"`);
      }
      const parsed = parseInt(rawRequestDims, 10);
      if (parsed <= 0) {
        throw new Error(`${EMBEDDING_REQUEST_DIMS_ENV_ERROR_LEAD}, got "${rawRequestDims}"`);
      }
      requestDimensions = parsed;
    }
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKey: process.env.GITNEXUS_EMBEDDING_API_KEY ?? 'unused',
    dimensions,
    maxAttempts: parsePositiveIntegerEnv(
      'GITNEXUS_EMBEDDING_MAX_ATTEMPTS',
      HTTP_MAX_RETRIES + 1,
      20,
    ),
    retryCapMs: parsePositiveIntegerEnv(
      'GITNEXUS_EMBEDDING_RETRY_CAP_MS',
      HTTP_RETRY_CAP_MS,
      300_000,
    ),
    minIntervalMs: parseNonNegativeIntegerEnv('GITNEXUS_EMBEDDING_MIN_INTERVAL_MS', 0, 300_000),
    timeoutMs: parsePositiveIntegerEnv(
      HTTP_TIMEOUT_ENV,
      DEFAULT_HTTP_TIMEOUT_MS,
      MAX_HTTP_TIMEOUT_MS,
    ),
    requestDimensions,
  };
};

/**
 * Whether HTTP embedding mode is active — i.e. both `GITNEXUS_EMBEDDING_URL` and
 * `GITNEXUS_EMBEDDING_MODEL` are set. A pure presence probe: it deliberately does
 * NOT call {@link readConfig}, so it never throws on a malformed
 * `GITNEXUS_EMBEDDING_DIMS`. This lets its ~13 call sites (analyze, doctor,
 * run-analyze, embedder, mcp) probe the mode without a defensive try/catch; the
 * DIMS value is validated where it is actually used (`readConfig` in
 * `httpEmbed`/`httpEmbedQuery`), surfacing a recognizable config error. See #2385.
 */
export const isHttpMode = (): boolean =>
  Boolean(process.env.GITNEXUS_EMBEDDING_URL && process.env.GITNEXUS_EMBEDDING_MODEL);

/**
 * Return the configured embedding dimensions for HTTP mode, or undefined
 * if HTTP mode is not active or no explicit dimensions are set.
 */
export const getHttpDimensions = (): number | undefined => readConfig()?.dimensions;

/**
 * Return the configured per-request HTTP timeout for HTTP mode, or undefined
 * when HTTP mode is not active.
 */
export const getHttpTimeoutMs = (): number | undefined => readConfig()?.timeoutMs;
/**
 * Return a safe representation of a URL for logs and error messages.
 * Strips query string (may contain tokens) and userinfo (may contain
 * credentials), keeping protocol + host + path. Exported so the CLI's
 * custom-endpoint confirmation can mask the same way.
 */
export const safeUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
};

/**
 * Strip credentials from an underlying transport error message before it is
 * surfaced. A credential-bearing endpoint URL (`https://user:secret@host/v1`)
 * makes undici throw `TypeError: Request cannot be constructed from a URL that
 * includes credentials: <that full URL>`; interpolating `err.message` verbatim
 * would re-leak the secret to stderr + logs even though the URL argument is
 * already masked with {@link safeUrl}. First swap the exact configured `url` for
 * its masked form, then strip any residual `scheme://userinfo@` the transport may
 * have echoed in a normalized (non-exact) form. See #2385.
 */
const sanitizeReason = (reason: string, url: string, apiKey?: string): string => {
  const withoutUrlCredentials = reason
    .split(url)
    .join(safeUrl(url))
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1');
  return apiKey && apiKey !== 'unused'
    ? withoutUrlCredentials.split(apiKey).join('[redacted]')
    : withoutUrlCredentials;
};

/**
 * Error thrown by this module's HTTP embedding path (`httpEmbedBatch` /
 * `httpEmbed` / `httpEmbedQuery`) for any endpoint failure — a
 * connection/timeout/DNS error, an open circuit, a non-OK status, an
 * unparseable or wrong-shape response body, an empty response, or a dimension
 * mismatch.
 *
 * Carrying a distinct type (rather than a plain `Error`) lets the CLI tell a
 * *custom endpoint* failure apart from a HuggingFace *model download* failure
 * without matching message text: the two share the same underlying network
 * substrings (`fetch failed`, `ECONNREFUSED`, …), which is exactly why
 * `isNetworkFetchError` in `hf-env.ts` cannot tell them apart. Keying on the
 * type instead of the message is also locale-proof and survives message
 * rewording. The human-readable `.message` (built with `safeUrl` and the
 * underlying reason) is what the CLI surfaces to the user. See #2385.
 */
export class HttpEmbeddingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'HttpEmbeddingError';
  }
}

/**
 * @internal Exported for the CLI analyze error handler and unit tests.
 *
 * Type-guard for {@link HttpEmbeddingError}. The `name` fallback keeps the
 * check working across module-realm boundaries where `instanceof` can fail
 * (two loaded copies of the class) — mirroring the codebase's existing
 * `err.name === 'TimeoutError'` idiom. Matches on the stable class
 * discriminator, never on the human-readable (potentially localized) message.
 */
export const isHttpEmbeddingError = (err: unknown): boolean =>
  err instanceof HttpEmbeddingError || (err instanceof Error && err.name === 'HttpEmbeddingError');

interface EmbeddingItem {
  embedding: number[];
}

/**
 * Runtime guard for a single response item. The `Array.isArray(data.data)` shape
 * check only validates the outer array — a 200 body like `{"data":[null]}` passes
 * it, then crashes at `new Float32Array(item.embedding)` (`httpEmbed`) or
 * `items[0].embedding` (`httpEmbedQuery`) with a raw `TypeError` that escapes the
 * typed boundary, landing on the CLI's generic stack-dump path — the exact class
 * #2385 closes. Validate each item so every wrong-shape body stays classifiable.
 */
const isEmbeddingItem = (item: unknown): item is EmbeddingItem =>
  typeof item === 'object' &&
  item !== null &&
  Array.isArray((item as { embedding?: unknown }).embedding);

/**
 * Module-private signal that a 2xx response carried a body this client cannot
 * use (unparseable, or parseable but wrong-shaped). Deliberately not exported:
 * it never escapes {@link httpEmbedBatch}, which converts it into the
 * user-facing {@link HttpEmbeddingError} it carries in `terminalMessage`.
 *
 * Thrown from inside the `fetchImpl` callback so `resilientFetch` classifies it
 * as `retryable-network` — a truncated or HTML body is the same class of
 * endpoint failure as a 503 and deserves the same backoff loop, and routing it
 * through the retry loop also makes the circuit breaker see it as a failure
 * instead of erasing the outage signal with `recordSuccess()`. See #2790.
 */
class RetryableEmbeddingBodyError extends Error {
  constructor(
    readonly terminalMessage: string,
    options?: { cause?: unknown },
  ) {
    super(terminalMessage, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'RetryableEmbeddingBodyError';
  }
}

/**
 * Build the message for a 2xx body carrying the wrong number of vectors.
 *
 * Hoisted to module scope because two layers report this same fault — the
 * in-loop check inside {@link httpEmbedBatch} and the defensive backstop in
 * {@link httpEmbed} — and the operator must see one wording regardless of which
 * one catches it. Names both counts: "0 vectors for 64 texts" is actionable,
 * "unexpected response shape" is not.
 */
const countMismatchMessage = (
  received: number,
  expected: number,
  safeEndpoint: string,
  batchIndex: number,
): string =>
  `Embedding endpoint returned ${received} vectors for ${expected} texts ` +
  `(${safeEndpoint}, batch ${batchIndex})`;

/**
 * Send a single batch of texts to the embedding endpoint with retry.
 *
 * @param url - Full endpoint URL (e.g. https://host/v1/embeddings)
 * @param batch - Texts to embed
 * @param model - Model name for the request body
 * @param apiKey - Bearer token (only used in Authorization header)
 * @param batchIndex - Logical batch number (for error context)
 * @param dimensions - Optional output-vector size. When provided, sent as
 *   the `dimensions` field in the request body. Endpoints that implement
 *   Matryoshka truncation (OpenAI text-embedding-3-*, Cohere embed-v3,
 *   Voyage) return a truncated vector at that size; endpoints that do not
 *   recognise the field may ignore it or return 400. Set
 *   `GITNEXUS_EMBEDDING_REQUEST_DIMS=omit` for strict backends while keeping
 *   `GITNEXUS_EMBEDDING_DIMS` set to the returned vector size.
 */
const httpEmbedBatch = async (
  url: string,
  batch: string[],
  model: string,
  apiKey: string,
  batchIndex = 0,
  dimensions?: number,
  requestOptions: EmbeddingRequestOptions = {},
  maxAttempts = HTTP_MAX_RETRIES + 1,
  retryCapMs = HTTP_RETRY_CAP_MS,
  minIntervalMs = 0,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<EmbeddingItem[]> => {
  const requestBody: { input: string[]; model: string; dimensions?: number } = {
    input: batch,
    model,
  };
  if (dimensions !== undefined) {
    requestBody.dimensions = dimensions;
  }

  // Built on demand, not up front. Both describe faults, so in a healthy run —
  // every call of it — they are garbage, and each `safeUrl` parses a URL. A
  // 300k-chunk run at subBatchSize 8 makes ~37.5k `httpEmbedBatch` calls, so
  // eager construction spent two `new URL()` per call describing failures that
  // never happened. Same shape as `countMismatchMessage` above.
  const unparseableMessage = (): string =>
    `Embedding endpoint returned an unparseable response (${safeUrl(url)}, batch ${batchIndex})`;
  const unexpectedShapeMessage = (): string =>
    `Embedding endpoint returned an unexpected response shape (${safeUrl(url)}, batch ${batchIndex})`;

  let resp: Response;
  // Set by `fetchImpl` on the attempt that produced a usable body. Reads back
  // as `undefined` only on a path that must already have thrown — see the
  // defensive check after the retry loop.
  let parsed: EmbeddingItem[] | undefined;
  try {
    throwIfAborted(requestOptions.signal);
    resp = await resilientFetch(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      },
      {
        fetchImpl: async (input, init) => {
          await paceHttpRequest(minIntervalMs, requestOptions.signal);
          throwIfAborted(requestOptions.signal);
          const timeoutSignal = AbortSignal.timeout(timeoutMs);
          const signal = requestOptions.signal
            ? AbortSignal.any([requestOptions.signal, timeoutSignal])
            : timeoutSignal;
          const attemptResp = await globalThis.fetch(input, { ...init, signal });
          // Non-OK bodies are none of our business: hand the response straight
          // back so `resilientFetch` keeps classifying 4xx/5xx/429 unchanged.
          if (!attemptResp.ok) return attemptResp;

          // The body is read *here*, inside the retried callback, rather than
          // after `resilientFetch` returns. A reachable-but-wrong endpoint (a
          // captive portal, a non-embeddings service, a truncated stream) can
          // answer 200 with HTML or half a JSON document; parsing outside the
          // loop made that a one-shot terminal failure while a 503 got three
          // attempts. Throwing from in here gives a bad body the same backoff
          // and the same breaker accounting as any other endpoint fault (#2790).
          let payload: { data: EmbeddingItem[] };
          try {
            payload = (await attemptResp.json()) as { data: EmbeddingItem[] };
          } catch (err) {
            // Not every `.json()` rejection is a parse error: the per-attempt
            // signal (`AbortSignal.any([caller, AbortSignal.timeout(...)])`) is
            // wired to the body stream, so a stalled body rejects with the abort
            // reason. Re-raise those untouched — `isTerminalNetworkError` is
            // `resilientFetch`'s own predicate, so this test agrees with
            // `classifyOutcome` by construction. Wrapping one would flip its
            // verdict from `terminal-network` (returned without retry AND
            // without touching the breaker, via `recordNeutral()`) to
            // `retryable-network` (retried, then `breaker.recordFailure()`): the
            // same timeout would take 3 attempts instead of 1, count toward the
            // process-global `embeddings-http` breaker, and reach the operator as
            // "unparseable response" so they never reach for the timeout knob.
            if (isTerminalNetworkError(err)) throw err;
            throw new RetryableEmbeddingBodyError(unparseableMessage(), { cause: err });
          }
          if (!Array.isArray(payload?.data) || !payload.data.every(isEmbeddingItem)) {
            throw new RetryableEmbeddingBodyError(unexpectedShapeMessage());
          }
          // Cardinality belongs *inside* the retry loop. `every(isEmbeddingItem)`
          // is vacuously true for `[]` and true for any array shorter than the
          // request, so a 200 carrying `{"data": []}` — or half the vectors —
          // used to be classified `success`, call `breaker.recordSuccess()`
          // (erasing the outage signal), and only then fail terminally after a
          // single attempt. A short body is a truncated body: same backoff, same
          // breaker accounting as any other endpoint fault (#2790).
          if (payload.data.length !== batch.length) {
            throw new RetryableEmbeddingBodyError(
              countMismatchMessage(payload.data.length, batch.length, safeUrl(url), batchIndex),
            );
          }
          parsed = payload.data;
          return attemptResp;
        },
        breakerKey: HTTP_BREAKER_KEY,
        retry: {
          maxAttempts,
          baseDelayMs: HTTP_RETRY_BACKOFF_MS,
          capDelayMs: retryCapMs,
          retryAfterCapMs: retryCapMs,
          sleep: (ms) => abortableSleep(ms, requestOptions.signal),
        },
      },
    );
  } catch (err) {
    if (
      requestOptions.signal?.aborted ||
      (err instanceof DOMException && err.name === 'AbortError')
    ) {
      throw new HttpEmbeddingError(
        `Embedding request cancelled (${safeUrl(url)}, batch ${batchIndex})`,
        { cause: err },
      );
    }
    // Retries are exhausted on a bad 2xx body. Surface the message the sentinel
    // carried, keeping the underlying parse error in `cause` only — the body
    // text must never reach the `sanitizeReason` fallback and leak to stderr.
    if (err instanceof RetryableEmbeddingBodyError) {
      throw new HttpEmbeddingError(err.terminalMessage, { cause: err.cause });
    }
    if (err instanceof CircuitOpenError) {
      throw new HttpEmbeddingError(
        `Embedding endpoint circuit open (${safeUrl(url)}, batch ${batchIndex}): retry in ${Math.ceil(err.retryAfterMs / 1000)}s`,
        { cause: err },
      );
    }
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new HttpEmbeddingError(
        `Embedding request timed out after ${timeoutMs}ms (${safeUrl(url)}, batch ${batchIndex})`,
        { cause: err },
      );
    }
    if (err instanceof ResilientFetchExhaustedError) {
      throw new HttpEmbeddingError(
        `Embedding endpoint returned ${err.response.status} (${safeUrl(url)}, batch ${batchIndex})`,
        { cause: err },
      );
    }
    const reason = sanitizeReason(err instanceof Error ? err.message : String(err), url, apiKey);
    const safeCause = new Error(reason);
    safeCause.name = err instanceof Error ? err.name : 'EmbeddingTransportError';
    throw new HttpEmbeddingError(
      `Embedding request failed (${safeUrl(url)}, batch ${batchIndex}): ${reason}`,
      { cause: safeCause },
    );
  }

  if (!resp.ok) {
    // resilientFetch already retried 5xx/429; any non-OK response here is
    // a terminal client error (4xx other than 429).
    throw new HttpEmbeddingError(
      `Embedding endpoint returned ${resp.status} (${safeUrl(url)}, batch ${batchIndex})`,
    );
  }

  if (parsed === undefined) {
    // Defensively unreachable: an OK response either sets `parsed` or throws
    // out of `fetchImpl`. Kept so the narrowing holds without a non-null
    // assertion, and so a future `resilientFetch` change can't return an
    // unvalidated body silently.
    throw new HttpEmbeddingError(unparseableMessage());
  }
  return parsed;
};

/**
 * Embed texts via the HTTP backend, splitting into batches.
 * Reads config from env vars on every call.
 *
 * @param texts - Array of texts to embed
 * @returns Array of Float32Array embedding vectors
 */
export const httpEmbed = async (
  texts: string[],
  requestOptions: EmbeddingRequestOptions = {},
): Promise<Float32Array[]> => {
  if (texts.length === 0) return [];

  const config = readConfig();
  if (!config) throw new Error('HTTP embedding not configured');

  const url = `${config.baseUrl}/embeddings`;
  const allVectors: Float32Array[] = [];

  for (const [batchIndex, batch] of chunk(texts, HTTP_BATCH_SIZE).entries()) {
    const items = await httpEmbedBatch(
      url,
      batch,
      config.model,
      config.apiKey,
      batchIndex,
      config.requestDimensions,
      requestOptions,
      config.maxAttempts,
      config.retryCapMs,
      config.minIntervalMs,
      config.timeoutMs,
    );

    // Defensive backstop, deliberately kept: `httpEmbedBatch` now rejects a
    // short body from *inside* the retry loop (through the same
    // `countMismatchMessage`), so in practice this branch is unreachable. It
    // stays so a future change to the in-loop check can't silently hand a short
    // vector list to the caller — that failure would land as a Kuzu/FLOAT[N]
    // error far from its cause.
    if (items.length !== batch.length) {
      throw new HttpEmbeddingError(
        countMismatchMessage(items.length, batch.length, safeUrl(url), batchIndex),
      );
    }

    for (const item of items) {
      const vec = new Float32Array(item.embedding);
      // Fail fast on dimension mismatch rather than inserting bad vectors
      // into the FLOAT[N] column which would cause a cryptic Kuzu error.
      //
      // Unlike the cardinality check this one stays *outside* the retry loop,
      // deliberately. The expected width is `config.dimensions ?? DEFAULT_DIMS`
      // (GITNEXUS_EMBEDDING_DIMS), which is NOT the `dimensions` value
      // `httpEmbedBatch` receives — that is `config.requestDimensions`, which
      // `GITNEXUS_EMBEDDING_REQUEST_DIMS` can set to a different number or to
      // `undefined` (`omit`). More importantly a width mismatch is an operator
      // *configuration* error, not an endpoint fault: retrying it three times
      // can never change the answer, and routing it through the retry loop
      // would count a healthy endpoint's responses toward the shared circuit
      // breaker. The message is an actionable config hint, so it is terminal
      // on the first attempt by design (#2790).
      const expected = config.dimensions ?? DEFAULT_DIMS;
      if (vec.length !== expected) {
        const hint = config.dimensions
          ? 'Update GITNEXUS_EMBEDDING_DIMS to match your model output.'
          : `Set GITNEXUS_EMBEDDING_DIMS=${vec.length} to match your model output.`;
        throw new HttpEmbeddingError(
          `Embedding dimension mismatch: endpoint returned ${vec.length}d vector, ` +
            `but expected ${expected}d. ${hint}`,
        );
      }

      allVectors.push(vec);
    }
  }

  return allVectors;
};

/**
 * Embed a single query text via the HTTP backend.
 * Convenience for MCP search where only one vector is needed.
 *
 * @param text - Query text to embed
 * @returns Embedding vector as number array
 */
export const httpEmbedQuery = async (
  text: string,
  requestOptions: EmbeddingRequestOptions = {},
): Promise<number[]> => {
  const config = readConfig();
  if (!config) throw new Error('HTTP embedding not configured');

  const url = `${config.baseUrl}/embeddings`;
  const items = await httpEmbedBatch(
    url,
    [text],
    config.model,
    config.apiKey,
    0,
    config.requestDimensions,
    requestOptions,
    config.maxAttempts,
    config.retryCapMs,
    config.minIntervalMs,
    config.timeoutMs,
  );
  // Defensive backstop like the `httpEmbed` one above: an empty `data` array is
  // now a cardinality mismatch (0 vectors for 1 text) rejected and retried
  // inside `httpEmbedBatch`, so this branch is unreachable in practice.
  if (!items.length) {
    throw new HttpEmbeddingError(`Embedding endpoint returned empty response (${safeUrl(url)})`);
  }

  const embedding = items[0].embedding;
  // Same dimension checks as httpEmbed — catch mismatches before they
  // reach the Kuzu FLOAT[N] cast in search queries.
  const expected = config.dimensions ?? DEFAULT_DIMS;
  if (embedding.length !== expected) {
    const hint = config.dimensions
      ? 'Update GITNEXUS_EMBEDDING_DIMS to match your model output.'
      : `Set GITNEXUS_EMBEDDING_DIMS=${embedding.length} to match your model output.`;
    throw new HttpEmbeddingError(
      `Embedding dimension mismatch: endpoint returned ${embedding.length}d vector, ` +
        `but expected ${expected}d. ${hint}`,
    );
  }
  return embedding;
};
