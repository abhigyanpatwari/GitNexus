import path from 'node:path';
import type { RepoMeta } from '../../storage/repo-meta.js';
import {
  assertOwnedVectorGeneration,
  selectVectorGeneration,
  type PublishedVectorGeneration,
} from '../../storage/vector-generation.js';
import { VectorStore } from '../lbug/vector-store.js';
import { syncPublishedMetadata } from '../analysis-publication.js';
import { getExactScanLimit } from '../platform/capabilities.js';
import { reclaimAnalysisArtifacts } from '../../storage/analysis-artifact-cleanup.js';
import { readEmbeddingArtifactOwners } from '../../storage/embedding-artifact.js';

export interface VectorPublicationActions {
  loadMetadata: () => Promise<RepoMeta | null>;
  saveMetadata: (metadata: RepoMeta) => Promise<void>;
}

/** Caller holds the checkout's index lock and has closed the vector writer.
 * A failed verify/close/save leaves the job in indexing, with no paid replay.
 * null means ANN remains pending beyond the exact-scan policy limit.
 */
export async function publishVectorGeneration(
  metadataDirectory: string,
  generation: PublishedVectorGeneration,
  resources: { bufferPoolBytes: number; threads: number; batchBytes: number },
  actions: VectorPublicationActions,
  migratedLegacySource?: string,
): Promise<RepoMeta | null> {
  const exactScanLimit = getExactScanLimit();
  if (generation.indexKind === 'exact' && generation.chunks > exactScanLimit) return null;
  const previous = await actions.loadMetadata();
  if (
    !previous?.graphGeneration ||
    previous.incrementalInProgress ||
    previous.graphGeneration.id !== generation.graphGeneration ||
    previous.embeddingJob?.identity !== generation.identity ||
    previous.embeddingJob?.graphGeneration !== generation.graphGeneration ||
    (previous.embeddingJob.artifactIdentity ?? previous.embeddingJob.identity) !==
      (generation.artifactIdentity ?? generation.identity)
  )
    throw new Error('Vector publication does not match the active graph job');
  const metadata: RepoMeta = {
    ...previous,
    vectorGeneration: generation,
    embeddingJob: undefined,
    embeddingCheckpoint: undefined,
    embeddingDims: generation.dimensions,
    stats: { ...previous.stats, embeddings: generation.chunks },
    capabilities: {
      graph: previous.capabilities?.graph ?? { provider: 'ladybugdb', status: 'available' },
      fts: previous.capabilities?.fts ?? { provider: 'ladybugdb-fts', status: 'unavailable' },
      vectorSearch: {
        provider: generation.indexKind === 'hnsw' ? 'ladybugdb-vector' : 'exact-scan',
        status: generation.chunks
          ? generation.indexKind === 'hnsw'
            ? 'vector-index'
            : 'exact-scan'
          : 'unavailable',
        exactScanLimit,
        ...(generation.excludedNodes ? { reason: 'embedding-inputs-rejected' } : {}),
      },
    },
  };
  const selection = selectVectorGeneration(
    metadataDirectory,
    metadata,
    path.resolve(metadataDirectory, metadata.graphPath ?? 'lbug'),
    exactScanLimit,
  );
  if (
    selection.kind !== 'ready' &&
    !(selection.kind === 'unavailable' && selection.reason === 'embeddings-empty')
  )
    throw new Error('Invalid vector publication receipt');
  const artifactIdentity = generation.artifactIdentity ?? generation.identity;
  const file = await assertOwnedVectorGeneration(metadataDirectory, artifactIdentity);
  const store = await VectorStore.open({
    directory: path.dirname(file),
    identity: artifactIdentity,
    dimensions: generation.dimensions,
    mode: 'read',
    ...resources,
  });
  try {
    if (
      (await store.seal(generation.nodes - (generation.excludedNodes ?? 0), generation.chunks)) !==
      generation.indexKind
    )
      throw new Error('Published vector index does not match the native artifact');
  } finally {
    await store.close();
  }
  if (previous.legacyVectorSource && previous.legacyVectorSource === migratedLegacySource) {
    const owners = await readEmbeddingArtifactOwners(metadataDirectory);
    if (
      owners.some(
        (owner) => owner.artifactIdentity === artifactIdentity && owner.phase === 'sealed',
      ) &&
      !owners.some((owner) => owner.fallbackLegacy === previous.legacyVectorSource)
    )
      delete metadata.legacyVectorSource;
  }
  await actions.saveMetadata(metadata);
  await syncPublishedMetadata(metadataDirectory, metadata);
  await reclaimAnalysisArtifacts(metadataDirectory, metadata);
  return metadata;
}
