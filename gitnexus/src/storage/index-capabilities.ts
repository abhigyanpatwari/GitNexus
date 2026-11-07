/** Published capability receipts, gated by current routing and artifact ownership.
 * Runtime query probes may further degrade these facts; status never loads a DB. */
import type { RepoMeta } from './repo-meta.js';
import { resolveGraphPath } from './shared-store.js';
import { assertOwnedVectorGeneration, selectVectorGeneration } from './vector-generation.js';
import { getExactScanLimit } from '../core/platform/capabilities.js';

export async function readIndexCapabilities(
  directory: string,
  metadata: RepoMeta | null | undefined,
): Promise<RepoMeta['capabilities']> {
  if (
    !metadata?.graphGeneration &&
    !metadata?.vectorGeneration &&
    !metadata?.embeddingJob &&
    !metadata?.embeddingCheckpoint &&
    !metadata?.incrementalInProgress &&
    !metadata?.graphWriteCollapsed
  )
    return metadata?.capabilities;
  const exactScanLimit = getExactScanLimit();
  // Runtime readers can verify the count themselves; stored receipts cannot.
  const countUnverified = metadata?.embeddingCheckpoint?.kind === 'unverified-count';
  let vectorSearch: NonNullable<RepoMeta['capabilities']>['vectorSearch'];
  try {
    const selection = selectVectorGeneration(
      directory,
      metadata,
      resolveGraphPath(directory, metadata),
      exactScanLimit,
    );
    if (selection.kind === 'ready' && !countUnverified) {
      await assertOwnedVectorGeneration(
        directory,
        selection.generation.artifactIdentity ?? selection.generation.identity,
      );
      vectorSearch = {
        provider: selection.generation.indexKind === 'hnsw' ? 'ladybugdb-vector' : 'exact-scan',
        status: selection.generation.indexKind === 'hnsw' ? 'vector-index' : 'exact-scan',
        exactScanLimit,
        coverage: selection.coverage ?? 'current',
        sourceGraphGeneration: selection.generation.graphGeneration,
        ...(selection.generation.excludedNodes ? { reason: 'embedding-inputs-rejected' } : {}),
      };
    } else if (
      selection.kind === 'legacy' &&
      !countUnverified &&
      metadata?.capabilities?.vectorSearch
    ) {
      vectorSearch = { ...metadata.capabilities.vectorSearch, coverage: 'preserved' };
    } else {
      vectorSearch = {
        provider: 'ladybugdb-vector',
        status: 'unavailable',
        exactScanLimit,
        reason:
          selection.kind === 'unavailable'
            ? selection.reason
            : countUnverified
              ? 'embedding-count-unverified'
              : 'vector-generation-unverified',
      };
    }
  } catch {
    vectorSearch = {
      provider: 'ladybugdb-vector',
      status: 'unavailable',
      exactScanLimit,
      reason: 'vector-artifact-unavailable',
    };
  }
  return {
    graph: metadata?.capabilities?.graph ?? { provider: 'ladybugdb', status: 'unavailable' },
    fts: metadata?.capabilities?.fts ?? { provider: 'ladybugdb-fts', status: 'unavailable' },
    vectorSearch,
  };
}
