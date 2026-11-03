/** Published capability receipts, gated by current routing and artifact ownership.
 * Runtime query probes may further degrade these facts; status never loads a DB. */
import path from 'node:path';
import type { RepoMeta } from './repo-meta.js';
import { assertOwnedVectorGeneration, selectVectorGeneration } from './vector-generation.js';
import { getExactScanLimit } from '../core/platform/capabilities.js';

export async function readIndexCapabilities(
  directory: string,
  metadata: RepoMeta | null | undefined,
): Promise<RepoMeta['capabilities']> {
  if (!metadata?.graphGeneration && !metadata?.vectorGeneration && !metadata?.embeddingJob)
    return metadata?.capabilities;
  const exactScanLimit = getExactScanLimit();
  let vectorSearch: NonNullable<RepoMeta['capabilities']>['vectorSearch'];
  try {
    const selection = selectVectorGeneration(
      directory,
      metadata,
      path.resolve(directory, metadata?.graphPath ?? 'lbug'),
      exactScanLimit,
    );
    if (selection.kind === 'ready') {
      await assertOwnedVectorGeneration(directory, selection.generation.identity);
      vectorSearch = {
        provider: selection.generation.indexKind === 'hnsw' ? 'ladybugdb-vector' : 'exact-scan',
        status: selection.generation.indexKind === 'hnsw' ? 'vector-index' : 'exact-scan',
        exactScanLimit,
      };
    } else {
      vectorSearch = {
        provider: 'ladybugdb-vector',
        status: 'unavailable',
        exactScanLimit,
        reason:
          selection.kind === 'unavailable' ? selection.reason : 'vector-generation-unverified',
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
