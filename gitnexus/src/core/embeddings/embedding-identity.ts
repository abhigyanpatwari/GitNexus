import { createHash } from 'node:crypto';
import { getEmbeddingDimensions } from './embedder.js';
import { resolveEmbeddingConfig } from './config.js';
import { isHttpMode, safeUrl } from './http-client.js';

export interface EmbeddingIdentity {
  model: string;
  dimensions: number;
  provider: string;
}

/**
 * Identify the vector space strongly enough to resume without mixing providers.
 * The HTTP fingerprint excludes URL credentials and query parameters before
 * hashing, so metadata contains neither an endpoint nor a secret-derived hash.
 */
export function resolveEmbeddingIdentity(): EmbeddingIdentity {
  const httpMode = isHttpMode();
  const provider = httpMode
    ? `http:${createHash('sha256')
        .update(safeUrl(process.env.GITNEXUS_EMBEDDING_URL ?? ''))
        .digest('hex')}`
    : 'local';

  return {
    model: httpMode
      ? (process.env.GITNEXUS_EMBEDDING_MODEL as string)
      : resolveEmbeddingConfig().modelId,
    dimensions: getEmbeddingDimensions(),
    provider,
  };
}
