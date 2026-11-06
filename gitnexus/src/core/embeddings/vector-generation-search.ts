import type { RepoMeta } from '../../storage/repo-meta.js';
import { createHash } from 'node:crypto';
import type { EmbeddingIdentity } from './embedding-identity.js';
import {
  assertOwnedVectorGeneration,
  selectVectorGeneration,
} from '../../storage/vector-generation.js';
import {
  initLbug,
  pinRepo,
  executeParameterized,
  ensureVectorExtension,
} from '../lbug/pool-adapter.js';
import { VECTOR_STORE_SCHEMA } from '../lbug/vector-store.js';
import { getExactScanLimit } from '../platform/capabilities.js';
import { collectBestChunks } from './types.js';
import { rankExactEmbeddingRows, type ExactSearchChunk } from './exact-search.js';
import { assertQueryIdentity, rethrowSymbolIdentityError } from '../lbug/query-result-integrity.js';
import { logger } from '../logger.js';

export interface VectorSearchSnapshot {
  metadataDirectory: string;
  metadata: RepoMeta | null;
  graphPath: string;
}

const configuredIdentity = async (): Promise<EmbeddingIdentity> => {
  const { resolveEmbeddingIdentity } = await import('./embedding-identity.js');
  return resolveEmbeddingIdentity();
};

/** null means a legacy monolithic reader is required. An empty array is a
 * deliberate unavailable lane and must not fall through to legacy vectors. */
export async function searchVectorGeneration(
  snapshot: VectorSearchSnapshot,
  embed: () => Promise<readonly number[]>,
  limit: number,
  maxDistance: number,
  resolveIdentity: () => Promise<EmbeddingIdentity> = configuredIdentity,
): Promise<ExactSearchChunk[] | null> {
  const exactLimit = getExactScanLimit();
  const selected = selectVectorGeneration(
    snapshot.metadataDirectory,
    snapshot.metadata,
    snapshot.graphPath,
    exactLimit,
  );
  if (selected.kind === 'legacy') return null;
  if (selected.kind !== 'ready') return [];
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || !Number.isFinite(maxDistance))
    throw new Error('Invalid vector search bounds');
  const dbPath = selected.path;
  const artifactIdentity = selected.generation.artifactIdentity ?? selected.generation.identity;
  const release = pinRepo(dbPath);
  try {
    await assertOwnedVectorGeneration(snapshot.metadataDirectory, artifactIdentity);
    await initLbug(dbPath, dbPath, {
      kind: 'vector',
      bufferPoolBytes: 64 * 1024 * 1024,
      threads: 2,
    });
    const execute = (query: string, parameters: Record<string, unknown> = {}) =>
      executeParameterized(dbPath, query, parameters);
    const artifact = await execute(
      "MATCH (a:EmbeddingArtifact {id:'artifact'}) RETURN a.identity AS identity, a.schema AS schema, a.dimensions AS dimensions, a.complete AS complete, a.indexKind AS kind",
    );
    const proof = artifact[0];
    if (
      artifact.length !== 1 ||
      proof.identity !== artifactIdentity ||
      proof.schema !== VECTOR_STORE_SCHEMA ||
      Number(proof.dimensions) !== selected.generation.dimensions ||
      proof.complete !== true ||
      proof.kind !== selected.generation.indexKind
    )
      throw new Error('Published vector identity is unverified');
    const annReady =
      selected.generation.indexKind === 'hnsw' &&
      (await ensureVectorExtension(dbPath).catch((error: unknown) => {
        logger.warn(
          { err: error },
          'Published VECTOR extension could not load; checking the bounded exact-search fallback',
        );
        return false;
      }));
    if (!annReady && selected.generation.chunks > exactLimit) return [];
    const identity = await resolveIdentity();
    const vectorIdentity = createHash('sha256')
      .update(JSON.stringify([identity.provider, identity.model, identity.dimensions]))
      .digest('hex');
    if (vectorIdentity !== selected.generation.vectorIdentity) return [];
    // Neither a metadata pointer nor a timestamp alone authorizes a model call.
    const query = await embed();
    if (
      query.length !== selected.generation.dimensions ||
      query.some((value) => !Number.isFinite(value))
    )
      throw new Error('Query embedding does not match the published vector dimensions');
    if (annReady) {
      try {
        const best = await collectBestChunks(limit, async (fetchLimit) => {
          const rows = await execute(
            `CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', $vector, $limit)
            YIELD node AS emb, distance WITH emb, distance WHERE distance < $distance
            RETURN emb.nodeId AS nodeId, emb.chunkIndex AS chunkIndex, emb.startLine AS startLine, emb.endLine AS endLine, distance ORDER BY distance`,
            { vector: [...query], limit: fetchLimit, distance: maxDistance },
          );
          return rows.map((row) => {
            assertQueryIdentity(row, 'nodeId', 0);
            return row as ExactSearchChunk;
          });
        });
        if (best.size > 0) return [...best].map(([nodeId, chunk]) => ({ nodeId, ...chunk }));
      } catch (error) {
        rethrowSymbolIdentityError(error);
        if (selected.generation.chunks > exactLimit) throw error;
      }
    }
    if (selected.generation.chunks > exactLimit) return [];
    // determinism: probe — fetch the entire verified set; reject partial or oversized coverage before ranking.
    const rows =
      await execute(`MATCH (e:CodeEmbedding) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex,
      e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding LIMIT ${exactLimit + 1}`);
    if (rows.length !== selected.generation.chunks || rows.length > exactLimit)
      throw new Error('Published vector coverage does not match its receipt');
    for (const row of rows) assertQueryIdentity(row, 'nodeId', 0);
    const seen = new Set<string>();
    return rankExactEmbeddingRows(rows, query, rows.length, maxDistance)
      .filter((row) => {
        if (seen.has(row.nodeId)) return false;
        seen.add(row.nodeId);
        return true;
      })
      .slice(0, limit);
  } finally {
    release();
  }
}
