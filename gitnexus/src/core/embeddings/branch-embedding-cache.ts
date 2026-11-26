/** Read-only, spill-backed reuse of completed vectors from local sibling branches. */
import lbug from '@ladybugdb/core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { INDEX_METADATA_FILE, type RepoMeta } from '../../storage/repo-meta.js';
import { resolveGraphPath } from '../../storage/shared-store.js';
import { closeLbugConnection, openLbugConnection } from '../lbug/lbug-config.js';
import {
  createCachedEmbeddingsBuilder,
  disposeEmbeddingSpill,
  finalizeCachedEmbeddingsSnapshot,
  ingestCachedEmbeddingRow,
  type ReusableEmbeddingIdentity,
  type ReusableEmbeddingSource,
} from './embedding-restore-spill.js';
import { compatibleEmbeddingIdentity, snapshotEmbeddingDims } from './embedding-restore-spill.js';

export interface BranchEmbeddingCacheOptions {
  storagePath: string;
  targetMetaDir: string;
  excludeGraphPath?: string;
  additionalMetaRoots?: readonly string[];
  identity: ReusableEmbeddingIdentity;
  dimensions: number;
  bufferPoolBytes?: number;
  threads?: number;
}

export interface BranchEmbeddingCaches {
  sources: ReusableEmbeddingSource[];
  close(): void;
}

/**
 * Enumerate completed branch slots under one flat GitNexus storage directory.
 * A malformed or unreadable sibling is ignored: reuse is an optimization and
 * ordinary embedding remains the correctness path.
 */
export async function loadBranchEmbeddingCaches(
  options: BranchEmbeddingCacheOptions,
): Promise<BranchEmbeddingCaches> {
  const base = path.resolve(options.storagePath);
  const target = path.resolve(options.targetMetaDir);
  const slots: string[] = [];
  const addSlots = async (root: string, includeRoot: boolean): Promise<void> => {
    if (includeRoot) slots.push(root);
    const children = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of children) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = path.join(root, entry.name);
      if (entry.name === 'branches') {
        for (const branch of await fs.readdir(child, { withFileTypes: true }).catch(() => [])) {
          if (branch.isDirectory() && !branch.isSymbolicLink())
            slots.push(path.join(child, branch.name));
        }
      }
    }
  };
  await addSlots(base, true);
  for (const root of options.additionalMetaRoots ?? []) {
    await addSlots(path.resolve(root), false);
  }

  const sources: ReusableEmbeddingSource[] = [];
  for (const slot of new Set(slots)) {
    if (path.resolve(slot) === target) continue;
    let builder: ReturnType<typeof createCachedEmbeddingsBuilder> | undefined;
    let handle: Awaited<ReturnType<typeof openLbugConnection>> | undefined;
    try {
      const metaPath = path.join(slot, INDEX_METADATA_FILE);
      const stat = await fs.lstat(metaPath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as RepoMeta;
      const receipt = meta.branchEmbeddingCache;
      if (
        !receipt ||
        receipt.version !== 1 ||
        meta.embeddingJob ||
        meta.embeddingCheckpoint ||
        meta.incrementalInProgress ||
        !compatibleEmbeddingIdentity(options.identity, receipt) ||
        receipt.dimensions !== options.dimensions ||
        !Number.isSafeInteger(receipt.chunks) ||
        receipt.chunks < 1
      )
        continue;
      const dbPath = resolveGraphPath(slot, meta);
      if (options.excludeGraphPath && path.resolve(dbPath) === path.resolve(options.excludeGraphPath))
        continue;
      handle = await openLbugConnection(lbug, dbPath, {
        readOnly: true,
        bufferPoolBytes: options.bufferPoolBytes,
        threads: options.threads,
      });
      builder = createCachedEmbeddingsBuilder({ inMemoryRowLimit: 0 });
      const query = await handle.conn.query(
        'MATCH (e:CodeEmbedding) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding, e.contentHash AS contentHash',
      );
      const results = Array.isArray(query) ? query : [query];
      for (const result of results) {
        while (await result.hasNext()) ingestCachedEmbeddingRow(builder, await result.getNext(), true);
        result.close();
      }
      const snapshot = finalizeCachedEmbeddingsSnapshot(builder);
      builder = undefined;
      if (
        snapshot.rows.length !== receipt.chunks ||
        snapshot.rows.some((row) => !row.contentHash) ||
        snapshotEmbeddingDims(snapshot) !== options.dimensions
      ) {
        disposeEmbeddingSpill(snapshot.spill);
        continue;
      }
      sources.push({ identity: options.identity, snapshot });
    } catch {
      // Never make a sibling's availability a prerequisite for target analysis.
      if (builder) {
        try {
          const snapshot = finalizeCachedEmbeddingsSnapshot(builder);
          disposeEmbeddingSpill(snapshot.spill);
        } catch {
          /* incomplete builder is discarded below */
        }
      }
    } finally {
      if (handle) await closeLbugConnection(handle).catch(() => {});
    }
  }
  return {
    sources,
    close() {
      for (const source of sources) disposeEmbeddingSpill(source.snapshot.spill);
      sources.length = 0;
    },
  };
}
