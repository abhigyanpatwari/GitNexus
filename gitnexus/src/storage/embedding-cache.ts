/**
 * Embedding Cache — content-addressed cache for per-node embedding vectors.
 * Keyed by SHA-256 of the embedding input text. Survives --force and LadybugDB drops.
 */

import { sha256, loadJsonCache, saveJsonCache, deleteJsonCache } from './cache-io.js';

export const EMBEDDING_CACHE_VERSION = 1;
const FILENAME = 'embedding-cache.json';

export { sha256 as embeddingTextHash };

export interface EmbeddingCacheEntry {
  embedding: number[];
}

export interface EmbeddingCache {
  version: number;
  dimensions: number;
  modelId: string;
  entries: Record<string, EmbeddingCacheEntry>;
}

export function createEmptyEmbeddingCache(dimensions: number, modelId: string): EmbeddingCache {
  return { version: EMBEDDING_CACHE_VERSION, dimensions, modelId, entries: {} };
}

export async function loadEmbeddingCache(storagePath: string): Promise<EmbeddingCache | null> {
  return loadJsonCache<EmbeddingCache>(storagePath, FILENAME, EMBEDDING_CACHE_VERSION);
}

export const saveEmbeddingCache = (storagePath: string, cache: EmbeddingCache) =>
  saveJsonCache(storagePath, FILENAME, cache);

export const deleteEmbeddingCache = (storagePath: string) =>
  deleteJsonCache(storagePath, FILENAME);
