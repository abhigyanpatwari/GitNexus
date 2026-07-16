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

import { CircuitOpenError, ResilientFetchExhaustedError, resilientFetch } from 'gitnexus-shared';

const HTTP_TIMEOUT_MS = 30_000;
const HTTP_MAX_RETRIES = 2;
const HTTP_RETRY_BACKOFF_MS = 1_000;
const HTTP_RETRY_CAP_MS = 5_000;
const HTTP_BATCH_SIZE = 64;
const DEFAULT_DIMS = 384;
const HTTP_BREAKER_KEY = 'embeddings-http';

interface HttpConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  dimensions?: number;
  maxAttempts: number;
  retryCapMs: number;
  minIntervalMs: number;
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
 * Stable lead of the {@link readConfig} malformed-`GITNEXUS_EMBEDDING_DIMS`
 * error. `readConfig` throws a plain `Error` (not an {@link HttpEmbeddingError})
 * because this is a *config* mistake, not an endpoint failure — so the CLI
 * recognizes it by this lead ({@link isHttpEmbeddingDimsError}) and prints a
 * clean config message instead of a raw stack dump. See #2385.
 */
const EMBEDDING_DIMS_ENV_ERROR_LEAD = 'GITNEXUS_EMBEDDING_DIMS must be a positive integer';

/**
 * @internal Exported for the CLI analyze error handler. True when `message` is
 * the {@link readConfig} malformed-DIMS config error (a plain `Error`).
 */
export const isHttpEmbeddingDimsError = (message: string): boolean =>
  message.includes(EMBEDDING_DIMS_ENV_ERROR_LEAD);

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
 *   recognise the field may ignore it or return 400. Leave
 *   `GITNEXUS_EMBEDDING_DIMS` unset for strict backends that reject
 *   unknown fields.
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
): Promise<EmbeddingItem[]> => {
  const requestBody: { input: string[]; model: string; dimensions?: number } = {
    input: batch,
    model,
  };
  if (dimensions !== undefined) {
    requestBody.dimensions = dimensions;
  }

  let resp: Response;
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
          const timeoutSignal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
          const signal = requestOptions.signal
            ? AbortSignal.any([requestOptions.signal, timeoutSignal])
            : timeoutSignal;
          return globalThis.fetch(input, { ...init, signal });
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
    if (err instanceof CircuitOpenError) {
      throw new HttpEmbeddingError(
        `Embedding endpoint circuit open (${safeUrl(url)}, batch ${batchIndex}): retry in ${Math.ceil(err.retryAfterMs / 1000)}s`,
        { cause: err },
      );
    }
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new HttpEmbeddingError(
        `Embedding request timed out after ${HTTP_TIMEOUT_MS}ms (${safeUrl(url)}, batch ${batchIndex})`,
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

  // A reachable-but-wrong endpoint (e.g. a captive portal or a non-embeddings
  // service) can answer 200 with an HTML/truncated body. Parse inside the
  // typed-error boundary so that lands as an endpoint failure the CLI can
  // classify, not a raw SyntaxError/TypeError on the generic stack-dump path.
  let data: { data: EmbeddingItem[] };
  try {
    data = (await resp.json()) as { data: EmbeddingItem[] };
  } catch (err) {
    throw new HttpEmbeddingError(
      `Embedding endpoint returned an unparseable response (${safeUrl(url)}, batch ${batchIndex})`,
      { cause: err },
    );
  }
  if (!Array.isArray(data?.data) || !data.data.every(isEmbeddingItem)) {
    throw new HttpEmbeddingError(
      `Embedding endpoint returned an unexpected response shape (${safeUrl(url)}, batch ${batchIndex})`,
    );
  }
  return data.data;
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

  for (let i = 0; i < texts.length; i += HTTP_BATCH_SIZE) {
    const batch = texts.slice(i, i + HTTP_BATCH_SIZE);
    const batchIndex = Math.floor(i / HTTP_BATCH_SIZE);
    const items = await httpEmbedBatch(
      url,
      batch,
      config.model,
      config.apiKey,
      batchIndex,
      config.dimensions,
      requestOptions,
      config.maxAttempts,
      config.retryCapMs,
      config.minIntervalMs,
    );

    if (items.length !== batch.length) {
      throw new HttpEmbeddingError(
        `Embedding endpoint returned ${items.length} vectors for ${batch.length} texts ` +
          `(${safeUrl(url)}, batch ${batchIndex})`,
      );
    }

    for (const item of items) {
      const vec = new Float32Array(item.embedding);
      // Fail fast on dimension mismatch rather than inserting bad vectors
      // into the FLOAT[N] column which would cause a cryptic Kuzu error.
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
    config.dimensions,
    requestOptions,
    config.maxAttempts,
    config.retryCapMs,
    config.minIntervalMs,
  );
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
