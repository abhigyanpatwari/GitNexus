/** Filesystem-only vector routing. No DB or embedding runtime is loaded here. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RepoMeta } from './repo-meta.js';

export type PublishedVectorGeneration = NonNullable<RepoMeta['vectorGeneration']>;
export type VectorReadSelection =
  | { kind: 'legacy' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'ready'; path: string; generation: PublishedVectorGeneration };
const DIGEST = /^[a-f0-9]{64}$/;
const GENERATION = /^[a-f0-9]{32}$/;
const nonnegative = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

export function embeddingGenerationDirectory(metadataDirectory: string, identity: string): string {
  if (!DIGEST.test(identity)) throw new Error('Invalid embedding generation identity');
  return path.join(metadataDirectory, 'embeddings', identity);
}

/** Metadata must describe the exact graph handle used for result hydration. */
export function metadataMatchesGraph(
  metadataDirectory: string,
  metadata: RepoMeta,
  graphPath: string,
): boolean {
  const recorded = metadata.graphPath;
  if (recorded !== undefined && typeof recorded !== 'string') return false;
  return path.resolve(metadataDirectory, recorded ?? 'lbug') === path.resolve(graphPath);
}

/** Run before model initialization, vector COUNTs, or opening an artifact. */
export function selectVectorGeneration(
  metadataDirectory: string,
  metadata: RepoMeta | null | undefined,
  graphPath: string,
  exactScanLimit: number,
): VectorReadSelection {
  if (!metadata?.graphGeneration && !metadata?.vectorGeneration && !metadata?.embeddingJob)
    return { kind: 'legacy' };
  const graph = metadata?.graphGeneration;
  const vector = metadata?.vectorGeneration;
  if (
    !graph ||
    graph.version !== 1 ||
    !GENERATION.test(graph.id) ||
    !DIGEST.test(graph.coveredContent) ||
    !metadataMatchesGraph(metadataDirectory, metadata, graphPath)
  )
    return { kind: 'unavailable', reason: 'graph-generation-unverified' };
  if (!vector)
    return {
      kind: 'unavailable',
      reason: metadata.embeddingJob ? 'embedding-pending' : 'embeddings-unavailable',
    };
  if (metadata.embeddingJob && metadata.embeddingJob.identity !== vector.identity)
    return { kind: 'unavailable', reason: 'embedding-pending' };
  if (
    vector.version !== 1 ||
    vector.graphGeneration !== graph.id ||
    !DIGEST.test(vector.identity) ||
    !DIGEST.test(vector.vectorIdentity) ||
    !DIGEST.test(vector.inputIdentity) ||
    !nonnegative(vector.dimensions) ||
    !vector.dimensions ||
    !nonnegative(vector.nodes) ||
    !nonnegative(vector.chunks) ||
    vector.chunks < vector.nodes ||
    (vector.indexKind !== 'hnsw' && vector.indexKind !== 'exact')
  )
    return { kind: 'unavailable', reason: 'vector-generation-mismatch' };
  if (!vector.chunks) return { kind: 'unavailable', reason: 'embeddings-empty' };
  if (vector.indexKind === 'exact' && vector.chunks > exactScanLimit)
    return { kind: 'unavailable', reason: 'vector-index-pending' };
  return {
    kind: 'ready',
    path: path.join(embeddingGenerationDirectory(metadataDirectory, vector.identity), 'vectors'),
    generation: vector,
  };
}

/** Refuse ancestor symlinks as well as a symlinked database. The coordinator
 * holds the slot lock while creating jobs; published directories are immutable. */
export async function assertOwnedVectorGeneration(
  metadataDirectory: string,
  identity: string,
): Promise<string> {
  const directory = embeddingGenerationDirectory(metadataDirectory, identity);
  for (const target of [metadataDirectory, path.dirname(directory), directory]) {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Vector generation must be an owned directory');
  }
  const file = path.join(directory, 'vectors');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Vector generation must be an owned regular file');
  return file;
}
