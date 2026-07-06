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
const HTTP_BATCH_SIZE = 64;
const DEFAULT_DIMS = 384;
const HTTP_BREAKER_KEY = 'embeddings-http';

interface HttpConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  dimensions?: number;
}

/**
 * Build config from the current process.env snapshot.
 * Returns null when GITNEXUS_EMBEDDING_URL + GITNEXUS_EMBEDDING_MODEL are unset.
 * Not cached — env vars are read fresh so late configuration takes effect.
 */
const readConfig = (): HttpConfig | null => {
  const baseUrl = process.env.GITNEXUS_EMBEDDING_URL;
  const model = process.env.GITNEXUS_EMBEDDING_MODEL;
  if (!baseUrl || !model) return null;

  const rawDims = process.env.GITNEXUS_EMBEDDING_DIMS;
  let dimensions: number | undefined;
  if (rawDims !== undefined) {
    if (!/^\d+$/.test(rawDims)) {
      throw new Error(`GITNEXUS_EMBEDDING_DIMS must be a positive integer, got "${rawDims}"`);
    }
    const parsed = parseInt(rawDims, 10);
    if (parsed <= 0) {
      throw new Error(`GITNEXUS_EMBEDDING_DIMS must be a positive integer, got "${rawDims}"`);
    }
    dimensions = parsed;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKey: process.env.GITNEXUS_EMBEDDING_API_KEY ?? 'unused',
    dimensions,
  };
};

/**
 * Check whether HTTP embedding mode is active (env vars are set).
 */
export const isHttpMode = (): boolean => readConfig() !== null;

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
 * Error thrown by this module's HTTP embedding path (`httpEmbedBatch` /
 * `httpEmbed` / `httpEmbedQuery`) for any endpoint failure — a
 * connection/timeout/DNS error, an open circuit, a non-OK status, an empty
 * response, or a dimension mismatch.
 *
 * Carrying a distinct type (rather than a plain `Error`) lets the CLI tell an
 * unreachable *custom endpoint* apart from a HuggingFace *model download*
 * failure without matching message text: the two share the same underlying
 * network substrings (`fetch failed`, `ECONNREFUSED`, …), which is exactly
 * why `isNetworkFetchError` in `hf-env.ts` cannot tell them apart. Keying on
 * the type instead of the message is also locale-proof and survives message
 * rewording. See #2385.
 *
 * `status` holds the HTTP status when the failure was a response (4xx/5xx);
 * it is `undefined` for connection/timeout/DNS failures, which never received
 * a response — the reason a plain status-code check cannot classify this bug.
 */
export class HttpEmbeddingError extends Error {
  readonly status?: number;
  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'HttpEmbeddingError';
    this.status = options?.status;
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
    resp = await resilientFetch(
      url,
      {
        method: 'POST',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      },
      {
        breakerKey: HTTP_BREAKER_KEY,
        retry: { maxAttempts: HTTP_MAX_RETRIES + 1, baseDelayMs: HTTP_RETRY_BACKOFF_MS },
      },
    );
  } catch (err) {
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
        { status: err.response.status, cause: err },
      );
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new HttpEmbeddingError(
      `Embedding request failed (${safeUrl(url)}, batch ${batchIndex}): ${reason}`,
      { cause: err },
    );
  }

  if (!resp.ok) {
    // resilientFetch already retried 5xx/429; any non-OK response here is
    // a terminal client error (4xx other than 429).
    throw new HttpEmbeddingError(
      `Embedding endpoint returned ${resp.status} (${safeUrl(url)}, batch ${batchIndex})`,
      { status: resp.status },
    );
  }

  const data = (await resp.json()) as { data: EmbeddingItem[] };
  return data.data;
};

/**
 * Embed texts via the HTTP backend, splitting into batches.
 * Reads config from env vars on every call.
 *
 * @param texts - Array of texts to embed
 * @returns Array of Float32Array embedding vectors
 */
export const httpEmbed = async (texts: string[]): Promise<Float32Array[]> => {
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
export const httpEmbedQuery = async (text: string): Promise<number[]> => {
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
