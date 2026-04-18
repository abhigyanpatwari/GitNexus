/**
 * HTTP Embedding Client
 *
 * Shared fetch+retry logic for OpenAI-compatible /v1/embeddings endpoints.
 * Imported by both the core embedder (batch) and MCP embedder (query).
 */

const HTTP_TIMEOUT_MS = 30_000;
const HTTP_MAX_RETRIES = 2;
const HTTP_RETRY_BACKOFF_MS = 1_000;
const HTTP_BATCH_SIZE = 64;
const DEFAULT_DIMS = 384;

interface HttpConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  dimensions?: number;
}

export interface EmbeddingConfigSummary {
  provider: 'openai' | 'http' | 'onnx';
  baseUrl?: string;
  model: string;
  dimensions: number;
}

/**
 * Build config from the current process.env snapshot.
 * Returns null when no HTTP embedding endpoint is configured. OPENAI_API_KEY
 * activates a default OpenAI-compatible endpoint for Claude/Codex sessions.
 * Not cached — env vars are read fresh so late configuration takes effect.
 */
const readConfig = (): HttpConfig | null => {
  const openAiKey = process.env.OPENAI_API_KEY;
  const hasExplicitEndpoint = Boolean(
    process.env.GITNEXUS_EMBEDDING_URL && process.env.GITNEXUS_EMBEDDING_MODEL,
  );
  const useOpenAiDefault = !hasExplicitEndpoint && Boolean(openAiKey);
  const baseUrl = hasExplicitEndpoint
    ? process.env.GITNEXUS_EMBEDDING_URL
    : useOpenAiDefault
      ? 'https://api.openai.com/v1'
      : undefined;
  const model = hasExplicitEndpoint
    ? process.env.GITNEXUS_EMBEDDING_MODEL
    : useOpenAiDefault
      ? 'text-embedding-3-small'
      : undefined;
  if (!baseUrl || !model) return null;

  const rawDims = process.env.GITNEXUS_EMBEDDING_DIMS;
  let dimensions: number | undefined;
  if (rawDims !== undefined) {
    const parsed = parseInt(rawDims, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new Error(`GITNEXUS_EMBEDDING_DIMS must be a positive integer, got "${rawDims}"`);
    }
    dimensions = parsed;
  }
  if (dimensions === undefined && useOpenAiDefault) {
    dimensions = DEFAULT_DIMS;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKey: process.env.GITNEXUS_EMBEDDING_API_KEY ?? openAiKey ?? 'unused',
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
 * Return non-secret embedding backend metadata for index/query compatibility.
 */
export const getHttpConfigSummary = (): EmbeddingConfigSummary | null => {
  const config = readConfig();
  if (!config) return null;

  return {
    provider: config.baseUrl.includes('api.openai.com') ? 'openai' : 'http',
    baseUrl: safeUrl(config.baseUrl),
    model: config.model,
    dimensions: config.dimensions ?? DEFAULT_DIMS,
  };
};

/**
 * Return a safe representation of a URL for error messages.
 * Strips query string (may contain tokens) and userinfo.
 */
const safeUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
};

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
 * @param attempt - Current retry attempt (internal)
 */
const httpEmbedBatch = async (
  url: string,
  batch: string[],
  model: string,
  apiKey: string,
  batchIndex = 0,
  attempt = 0,
  dimensions?: number,
): Promise<EmbeddingItem[]> => {
  let resp: Response;
  try {
    const body: { input: string[]; model: string; dimensions?: number } = { input: batch, model };
    if (dimensions !== undefined) {
      body.dimensions = dimensions;
    }
    resp = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Timeouts should not be retried — the server is unresponsive.
    // AbortSignal.timeout() throws DOMException with name 'TimeoutError'.
    const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
    if (isTimeout) {
      throw new Error(
        `Embedding request timed out after ${HTTP_TIMEOUT_MS}ms (${safeUrl(url)}, batch ${batchIndex})`,
      );
    }
    // DNS, connection errors — retry with backoff
    if (attempt < HTTP_MAX_RETRIES) {
      const delay = HTTP_RETRY_BACKOFF_MS * (attempt + 1);
      await new Promise((r) => setTimeout(r, delay));
      return httpEmbedBatch(url, batch, model, apiKey, batchIndex, attempt + 1, dimensions);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Embedding request failed (${safeUrl(url)}, batch ${batchIndex}): ${reason}`);
  }

  if (!resp.ok) {
    const status = resp.status;
    if ((status === 429 || status >= 500) && attempt < HTTP_MAX_RETRIES) {
      const delay = HTTP_RETRY_BACKOFF_MS * (attempt + 1);
      await new Promise((r) => setTimeout(r, delay));
      return httpEmbedBatch(url, batch, model, apiKey, batchIndex, attempt + 1, dimensions);
    }
    throw new Error(`Embedding endpoint returned ${status} (${safeUrl(url)}, batch ${batchIndex})`);
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
      0,
      config.dimensions,
    );

    if (items.length !== batch.length) {
      throw new Error(
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
        throw new Error(
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
  const items = await httpEmbedBatch(url, [text], config.model, config.apiKey, 0, 0, config.dimensions);
  if (!items.length) {
    throw new Error(`Embedding endpoint returned empty response (${safeUrl(url)})`);
  }

  const embedding = items[0].embedding;
  // Same dimension checks as httpEmbed — catch mismatches before they
  // reach the Kuzu FLOAT[N] cast in search queries.
  const expected = config.dimensions ?? DEFAULT_DIMS;
  if (embedding.length !== expected) {
    const hint = config.dimensions
      ? 'Update GITNEXUS_EMBEDDING_DIMS to match your model output.'
      : `Set GITNEXUS_EMBEDDING_DIMS=${embedding.length} to match your model output.`;
    throw new Error(
      `Embedding dimension mismatch: endpoint returned ${embedding.length}d vector, ` +
        `but expected ${expected}d. ${hint}`,
    );
  }
  return embedding;
};
