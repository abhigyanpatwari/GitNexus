/** Filesystem-only vector routing. No DB or embedding runtime is loaded here. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RepoMeta } from './repo-meta.js';

export type PublishedVectorGeneration = NonNullable<RepoMeta['vectorGeneration']>;
export type VectorReadSelection =
  | { kind: 'legacy' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'ready'; path: string; generation: PublishedVectorGeneration; coverage?: 'preserved' };
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

/** Advance only a previously bound completed reference. Called under the slot
 * lock before invalidating an in-place graph, or while preparing a staged one.
 * It neither opens vectors nor upgrades missing/foreign coverage provenance. */
export function preserveVectorCoverage(
  metadata: RepoMeta,
  nextGeneration: string,
): RepoMeta['vectorGeneration'] {
  if (!GENERATION.test(nextGeneration)) throw new Error('Invalid preservation target');
  const vector = metadata.vectorGeneration;
  const graph = metadata.graphGeneration;
  if (
    !vector ||
    vector.version !== 1 ||
    !GENERATION.test(vector.graphGeneration) ||
    !graph ||
    graph.version !== 1 ||
    !GENERATION.test(graph.id) ||
    (vector.graphGeneration !== graph.id && vector.preservedForGraph !== graph.id)
  )
    return vector;
  return { ...vector, preservedForGraph: nextGeneration };
}

/** Run before model initialization, vector COUNTs, or opening an artifact. */
export function selectVectorGeneration(
  metadataDirectory: string,
  metadata: RepoMeta | null | undefined,
  graphPath: string,
  exactScanLimit: number,
): VectorReadSelection {
  if (metadata?.incrementalInProgress || metadata?.graphWriteCollapsed)
    return { kind: 'unavailable', reason: 'graph-generation-unverified' };
  if (metadata?.embeddingCheckpoint && metadata.embeddingCheckpoint.kind !== 'unverified-count')
    return { kind: 'unavailable', reason: 'embedding-pending' };
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
  if (
    !vector &&
    !metadata.embeddingJob &&
    typeof metadata.legacyVectorSource === 'string' &&
    DIGEST.test(metadata.legacyVectorSource) &&
    nonnegative(metadata.stats?.embeddings) &&
    metadata.stats!.embeddings! > 0 &&
    nonnegative(metadata.embeddingDims) &&
    metadata.embeddingDims > 0
  )
    return { kind: 'legacy' };
  if (!vector)
    return {
      kind: 'unavailable',
      reason: metadata.embeddingJob ? 'embedding-pending' : 'embeddings-unavailable',
    };
  if (metadata.embeddingJob) return { kind: 'unavailable', reason: 'embedding-pending' };
  if (
    vector.version !== 1 ||
    !GENERATION.test(vector.graphGeneration) ||
    (vector.graphGeneration !== graph.id && vector.preservedForGraph !== graph.id) ||
    (vector.preservedForGraph !== undefined && !GENERATION.test(vector.preservedForGraph)) ||
    !DIGEST.test(vector.identity) ||
    (vector.artifactIdentity !== undefined && !DIGEST.test(vector.artifactIdentity)) ||
    !DIGEST.test(vector.vectorIdentity) ||
    !DIGEST.test(vector.inputIdentity) ||
    !nonnegative(vector.dimensions) ||
    !vector.dimensions ||
    !nonnegative(vector.nodes) ||
    (vector.excludedNodes !== undefined &&
      (!nonnegative(vector.excludedNodes) ||
        vector.excludedNodes > vector.nodes ||
        vector.exclusionReason !== 'input-rejected')) ||
    !nonnegative(vector.chunks) ||
    vector.chunks < vector.nodes - (vector.excludedNodes ?? 0) ||
    (vector.indexKind !== 'hnsw' && vector.indexKind !== 'exact')
  )
    return { kind: 'unavailable', reason: 'vector-generation-mismatch' };
  if (!vector.chunks) return { kind: 'unavailable', reason: 'embeddings-empty' };
  if (vector.indexKind === 'exact' && vector.chunks > exactScanLimit)
    return { kind: 'unavailable', reason: 'vector-index-pending' };
  return {
    kind: 'ready',
    path: path.join(
      embeddingGenerationDirectory(metadataDirectory, vector.artifactIdentity ?? vector.identity),
      'vectors',
    ),
    generation: vector,
    ...(vector.graphGeneration === graph.id ? {} : { coverage: 'preserved' as const }),
  };
}

/** Refuse symlinks from the owned metadata slot down to the database. Parent
 * path aliases remain valid. The coordinator holds the slot lock while creating
 * jobs; published directories are immutable. */
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
