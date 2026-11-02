/**
 * MCP embedder façade — HTTP or the shared embedding sidecar client.
 *
 * Local ONNX inference lives in the sidecar child. This module must not import
 * the Hugging Face transformers package or the ONNX Node binding.
 */

import {
  disposeEmbedder as disposeCoreEmbedder,
  embedText,
  embeddingToArray,
  getEmbeddingDimensions,
  initEmbedder as initCoreEmbedder,
  isEmbedderReady as isCoreEmbedderReady,
} from '../../core/embeddings/embedder.js';
import { httpEmbedQuery, isHttpMode } from '../../core/embeddings/http-client.js';

export const initEmbedder = initCoreEmbedder;

export const isEmbedderReady = isCoreEmbedderReady;

export const embedQuery = async (query: string): Promise<number[]> => {
  if (isHttpMode()) {
    return httpEmbedQuery(query);
  }
  return embeddingToArray(await embedText(query));
};

/**
 * Query-vector width for CAST. HTTP uses GITNEXUS_EMBEDDING_DIMS when set;
 * local is the model default. Do not bind this to schema EMBEDDING_DIMS.
 */
export const getEmbeddingDims = (): number => getEmbeddingDimensions();

/** Reap the sidecar. Never runs ONNX dispose in this process. */
export const disposeEmbedder = disposeCoreEmbedder;
