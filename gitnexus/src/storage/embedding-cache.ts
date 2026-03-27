/**
 * Embedding Cache — content-addressed cache for per-node embedding vectors.
 * Keyed by SHA-256 of the embedding input text. Survives --force and LadybugDB drops.
 *
 * Metadata (version, dimensions, modelId) stored separately in embedding-cache-meta.json
 * so callers can check staleness without deserializing the full entries file.
 * Entries stored in a single embedding-cache.json with atomic tmp+rename writes.
 */

import { sha256, loadJsonCache, saveJsonCache, deleteJsonCache } from './cache-io.js';
import fs from 'fs/promises';
import path from 'path';

export const EMBEDDING_CACHE_VERSION = 1;
const ENTRIES_FILENAME = 'embedding-cache.json';
const META_FILENAME = 'embedding-cache-meta.json';

export { sha256 as embeddingTextHash };

export interface EmbeddingCacheEntry {
  embedding: number[];
}

export interface EmbeddingCacheMeta {
  version: number;
  dimensions: number;
  modelId: string;
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

export async function loadEmbeddingCacheMeta(storagePath: string): Promise<EmbeddingCacheMeta | null> {
  try {
    const raw = await fs.readFile(path.join(storagePath, META_FILENAME), 'utf-8');
    const parsed = JSON.parse(raw) as EmbeddingCacheMeta;
    if (parsed.version !== EMBEDDING_CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function validateEmbeddingCacheMeta(
  meta: EmbeddingCacheMeta,
  dimensions: number,
  modelId: string,
): boolean {
  return meta.dimensions === dimensions && meta.modelId === modelId;
}

export async function loadEmbeddingCache(storagePath: string): Promise<EmbeddingCache | null> {
  const meta = await loadEmbeddingCacheMeta(storagePath);
  if (!meta) return null;

  try {
    const raw = await fs.readFile(path.join(storagePath, ENTRIES_FILENAME), 'utf-8');
    const entries = JSON.parse(raw) as Record<string, EmbeddingCacheEntry>;
    return {
      version: meta.version,
      dimensions: meta.dimensions,
      modelId: meta.modelId,
      entries,
    };
  } catch {
    return null;
  }
}

export async function saveEmbeddingCache(storagePath: string, cache: EmbeddingCache): Promise<void> {
  await fs.mkdir(storagePath, { recursive: true });

  // Write entries first — meta acts as the commit marker
  await saveJsonCache(storagePath, ENTRIES_FILENAME, cache.entries);

  const metaPath = path.join(storagePath, META_FILENAME);
  const tmpMeta = metaPath + '.tmp';
  await fs.writeFile(tmpMeta, JSON.stringify({
    version: cache.version,
    dimensions: cache.dimensions,
    modelId: cache.modelId,
  }), 'utf-8');
  await fs.rename(tmpMeta, metaPath);
}

export async function deleteEmbeddingCache(storagePath: string): Promise<void> {
  await deleteJsonCache(storagePath, ENTRIES_FILENAME);
  await deleteJsonCache(storagePath, META_FILENAME);
}
