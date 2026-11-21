/**
 * Cross-branch embedding reuse (#3631, Phase 1).
 *
 * Every branch slot of a repository owns a full LadybugDB, and until now its
 * CodeEmbedding rows were computed from scratch: two branches differing by
 * one file paid the full embedding cost twice. This module harvests the
 * embedding rows of SIBLING indexes of the same repository (the flat slot,
 * the other `branches/*` slots, or the other checkout slots of the shared
 * store) into a repo-scoped cache the embedding pipeline can copy from.
 *
 * The cache is keyed by CONTENT HASH, never by node id: node ids are
 * branch-local graph identities, while a content hash (see
 * `contentHashForNode`) names the exact text that was embedded. A sibling
 * row is eligible only when the sibling slot's persisted identity digests
 * match the consuming run on BOTH halves —
 *
 *   - `vectorIdentity` (provider + model + dimensions): the vectors must
 *     live in the same vector space. The content hash alone cannot prove
 *     this: it folds in the model id only for non-default models.
 *   - `inputIdentity` (EMBEDDING_TEXT_VERSION + chunking + retention +
 *     length caps): the chunk rows must have been produced from the same
 *     inputs, or a "hit" could copy chunk boundaries the current run
 *     would never produce.
 *
 * The digests are read from the sibling's metadata — `vectorGeneration`
 * for a published run, `embeddingIdentity` for an inline-pipeline run —
 * and both carry the `embeddingVectorIdentity` / `embeddingInputIdentity`
 * recipes, so slots written by either analyze flavor interoperate.
 *
 * Copying is best-effort throughout: a sibling that is missing, locked,
 * legacy-shaped (no contentHash column), or identity-mismatched is skipped
 * and the run embeds fresh, exactly as if the cache did not exist. Rows
 * are copied INTO the target database (no shared vector table), and a
 * copied row keeps the start/end lines of the index it came from — the
 * same line provenance the existing same-index restore already accepts
 * when a file is edited above an unchanged node.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import { closeLbugConnection, openLbugConnection } from '../lbug/lbug-config.js';
import { closeQueryResults } from '../lbug/query-result-utils.js';
import { EMBEDDING_TABLE_NAME } from '../lbug/schema.js';
import { logger } from '../logger.js';
import { loadMeta } from '../../storage/repo-manager.js';
import { BRANCHES_DIR } from '../../storage/branch-index.js';
import { resolveGraphPath, type SharedStoreLayout } from '../../storage/shared-store.js';
import {
  abortCachedEmbeddingsBuilder,
  createCachedEmbeddingsBuilder,
  disposeEmbeddingSpill,
  finalizeCachedEmbeddingsSnapshot,
  ingestCachedEmbeddingRow,
  materializeCachedEmbeddings,
  snapshotEmbeddingDims,
  type CachedEmbeddingMeta,
  type CachedEmbeddingsSnapshot,
} from './embedding-restore-spill.js';
import type { CachedEmbedding } from './types.js';

/** The identity digests a sibling slot must match for its rows to be reusable. */
export interface SiblingEmbeddingIdentities {
  vectorIdentity: string;
  inputIdentity: string;
}

/** One sibling slot's harvested CodeEmbedding rows. */
export interface SiblingEmbeddingSource {
  /** Slot directory the rows were harvested from (diagnostics only). */
  slotDir: string;
  snapshot: CachedEmbeddingsSnapshot;
}

/** A harvested row, tied to the source snapshot its vector index addresses. */
export interface SiblingEmbeddingRowRef {
  source: SiblingEmbeddingSource;
  meta: CachedEmbeddingMeta;
}

export interface SiblingEmbeddingCache {
  sources: SiblingEmbeddingSource[];
  /**
   * Content hash → the COMPLETE chunk-row set for that hash, claimed from
   * the first sibling that held it whole. Partial sets are never offered:
   * copying half a node's chunks would leave it worse than re-embedding.
   */
  byContentHash: Map<string, SiblingEmbeddingRowRef[]>;
  /** Total rows offered across all claimed hashes. */
  rowCount: number;
  /** Delete any spill files backing the harvested snapshots. */
  dispose(): void;
}

const listSubDirs = async (dir: string): Promise<string[]> => {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    try {
      if ((await fs.stat(full)).isDirectory()) dirs.push(full);
    } catch {
      // A dangling entry must not starve the remaining slots.
    }
  }
  return dirs;
};

/**
 * Enumerate the slot directories that may hold sibling indexes of the
 * target slot: the flat slot and every `branches/*` slot of the local
 * storage root, or — for a shared-store checkout — every other checkout
 * slot of the store. The target slot itself is always excluded.
 */
export async function findSiblingSlotDirs(options: {
  targetMetaDir: string;
  storagePath: string;
  sharedStore?: SharedStoreLayout;
}): Promise<string[]> {
  const target = path.resolve(options.targetMetaDir);
  const candidates = options.sharedStore
    ? await listSubDirs(options.sharedStore.checkoutsDir)
    : [
        path.resolve(options.storagePath),
        ...(await listSubDirs(path.join(options.storagePath, BRANCHES_DIR))),
      ];
  return candidates.filter((dir) => path.resolve(dir) !== target);
}

/**
 * Merge harvested sibling snapshots into the content-hash-keyed cache.
 * Pure (no I/O): the first source holding a hash's complete, contiguous
 * chunk set (chunkIndex 0..n-1) claims it; hashless legacy rows and
 * partial sets are dropped. Returns undefined when nothing is reusable.
 */
export function buildSiblingEmbeddingCache(
  sources: SiblingEmbeddingSource[],
): SiblingEmbeddingCache | undefined {
  const byContentHash = new Map<string, SiblingEmbeddingRowRef[]>();
  let rowCount = 0;
  for (const source of sources) {
    const byHash = new Map<string, CachedEmbeddingMeta[]>();
    for (const meta of source.snapshot.rows) {
      if (!meta.contentHash) continue;
      const group = byHash.get(meta.contentHash);
      if (group) group.push(meta);
      else byHash.set(meta.contentHash, [meta]);
    }
    for (const [hash, group] of byHash) {
      if (byContentHash.has(hash)) continue;
      const sorted = [...group].sort((a, b) => a.chunkIndex - b.chunkIndex);
      if (!sorted.every((meta, i) => meta.chunkIndex === i)) continue;
      byContentHash.set(
        hash,
        sorted.map((meta) => ({ source, meta })),
      );
      rowCount += sorted.length;
    }
  }
  if (rowCount === 0) {
    for (const source of sources) disposeEmbeddingSpill(source.snapshot.spill);
    return undefined;
  }
  return {
    sources,
    byContentHash,
    rowCount,
    dispose() {
      for (const source of sources) disposeEmbeddingSpill(source.snapshot.spill);
    },
  };
}

/**
 * Materialize the copied rows for one target node: vectors are read from
 * the claiming source's snapshot and every row is rewritten to the target
 * node id (the sibling's node id is meaningless in this branch's graph).
 * `contentHash` is set by the caller, which matched it against the node's
 * current hash.
 */
export function materializeSiblingRows(
  refs: readonly SiblingEmbeddingRowRef[],
  targetNodeId: string,
): CachedEmbedding[] {
  const bySource = new Map<SiblingEmbeddingSource, CachedEmbeddingMeta[]>();
  for (const ref of refs) {
    const metas = bySource.get(ref.source);
    if (metas) metas.push(ref.meta);
    else bySource.set(ref.source, [ref.meta]);
  }
  const rows: CachedEmbedding[] = [];
  for (const [source, metas] of bySource) {
    for (const row of materializeCachedEmbeddings(source.snapshot, metas)) {
      rows.push({ ...row, nodeId: targetNodeId });
    }
  }
  return rows.sort((a, b) => a.chunkIndex - b.chunkIndex);
}

/** Stream one sibling database's CodeEmbedding rows into a snapshot. */
async function harvestSiblingSnapshot(dbPath: string): Promise<CachedEmbeddingsSnapshot> {
  const handle = await openLbugConnection(lbug, dbPath, {
    readOnly: true,
    throwOnWalReplayFailure: false,
  });
  const builder = createCachedEmbeddingsBuilder();
  try {
    const queryResult = await handle.conn.query(
      `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding, e.contentHash AS contentHash`,
    );
    try {
      const results = Array.isArray(queryResult) ? queryResult : [queryResult];
      const result = results[0];
      if (!result) throw new Error('Sibling embedding query returned no result');
      while (await result.hasNext()) {
        const row = await result.getNext();
        ingestCachedEmbeddingRow(builder, row, true);
      }
    } finally {
      await closeQueryResults(queryResult);
    }
    return finalizeCachedEmbeddingsSnapshot(builder);
  } catch (err) {
    abortCachedEmbeddingsBuilder(builder);
    throw err;
  } finally {
    await closeLbugConnection(handle);
  }
}

/**
 * Harvest every eligible sibling slot into a cache for one analyze run.
 * Eligibility, in order: readable metadata, a recorded identity
 * (`vectorGeneration` or `embeddingIdentity`) matching BOTH digests of
 * the consuming run, a graph database distinct from the target's own, and
 * harvested rows whose width equals the run's dimensions. Any failure
 * skips that sibling; the function itself only returns undefined when no
 * sibling offered a single reusable row.
 */
export async function loadSiblingEmbeddingCache(options: {
  slotDirs: string[];
  identities: SiblingEmbeddingIdentities;
  dimensions: number;
  /** Graph paths of the target slot (read + write resolutions) to never read. */
  excludeDbPaths?: string[];
}): Promise<SiblingEmbeddingCache | undefined> {
  const excluded = new Set((options.excludeDbPaths ?? []).map((p) => path.resolve(p)));
  const sources: SiblingEmbeddingSource[] = [];
  for (const slotDir of options.slotDirs) {
    try {
      const meta = await loadMeta(slotDir);
      const recorded = meta?.vectorGeneration ?? meta?.embeddingIdentity;
      if (!meta || !recorded) continue;
      if (
        recorded.vectorIdentity !== options.identities.vectorIdentity ||
        recorded.inputIdentity !== options.identities.inputIdentity
      ) {
        continue;
      }
      const dbPath = resolveGraphPath(slotDir, meta);
      if (excluded.has(path.resolve(dbPath))) continue;
      const stat = await fs.stat(dbPath).catch(() => undefined);
      if (!stat?.isFile()) continue;
      const snapshot = await harvestSiblingSnapshot(dbPath);
      if (snapshot.rows.length === 0 || snapshotEmbeddingDims(snapshot) !== options.dimensions) {
        disposeEmbeddingSpill(snapshot.spill);
        continue;
      }
      sources.push({ slotDir, snapshot });
    } catch (err) {
      // Best-effort by design: an unreadable or legacy sibling simply means
      // its rows are embedded fresh, never a failed analyze.
      logger.debug({ err, slotDir }, 'Skipping sibling index for embedding reuse');
    }
  }
  if (sources.length === 0) return undefined;
  return buildSiblingEmbeddingCache(sources);
}
