/**
 * Shared embedding-seed helpers for the incremental-recovery suites (this
 * shipping review, FIX 8 — incremental-orchestration.test.ts and
 * incremental-dirty-recovery.test.ts carried two divergent copies; a helper
 * module has no describe-registration problem, unlike importing a sibling
 * test file — the mini-repo.ts precedent).
 *
 * Seeding pattern (KTD9, tri-review 4669518496): zero-vector CodeEmbedding
 * rows are inserted for REAL graph nodes through the real
 * `batchInsertEmbeddings` — reopen the repo DB, read actual node ids per
 * file (`Function:<fp>:<name>:<line>` — label-first, so fabricated ids
 * would be dropped by run-analyze's Phase 3.5 live-graph filter), insert,
 * close. Zero vectors need no VECTOR extension: the CodeEmbedding TABLE is
 * plain schema; only the HNSW index is extension-gated.
 */
import { expect } from 'vitest';
import {
  getStoragePaths,
  loadMeta,
  saveMeta,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { EMBEDDING_TABLE_NAME, EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';

/**
 * Seed one zero-vector embedding row per real Function node (up to
 * `maxPerFile` per file) and return the seeded node ids keyed by file path
 * — the more general of the two former signatures (the flat-list consumer
 * derives its list via `[...map.values()].flat()`).
 */
export async function seedEmbeddingsForFiles(
  repoPath: string,
  filePaths: readonly string[],
  maxPerFile: number,
): Promise<Map<string, string[]>> {
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  const { batchInsertEmbeddings } = await import('../../src/core/embeddings/embedding-pipeline.js');
  const { lbugPath } = getStoragePaths(repoPath);
  const idsByFile = new Map<string, string[]>();
  await adapter.initLbug(lbugPath);
  try {
    for (const fp of filePaths) {
      const rows = (await adapter.executeQuery(
        `MATCH (n:Function) WHERE n.filePath = '${fp}' RETURN n.id AS id LIMIT ${maxPerFile}`,
      )) as Array<{ id: string }>;
      idsByFile.set(
        fp,
        rows.map((r) => String(r.id)),
      );
    }
    const allIds = [...idsByFile.values()].flat();
    await batchInsertEmbeddings(
      adapter.executeWithReusedStatement,
      allIds.map((nodeId) => ({
        nodeId,
        chunkIndex: 0,
        startLine: 0,
        endLine: 2,
        embedding: new Array(EMBEDDING_DIMS).fill(0),
      })),
    );
  } finally {
    await adapter.closeLbug();
  }
  return idsByFile;
}

/**
 * Seed one zero-vector embedding row for an explicit (possibly fabricated)
 * nodeId — used to plant a LEGACY ORPHAN row (a row whose owning node does
 * not exist in any graph) for the Phase 3.5 orphan-sweep proof (FIX 3).
 */
export async function seedEmbeddingForNodeId(repoPath: string, nodeId: string): Promise<void> {
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  const { batchInsertEmbeddings } = await import('../../src/core/embeddings/embedding-pipeline.js');
  const { lbugPath } = getStoragePaths(repoPath);
  await adapter.initLbug(lbugPath);
  try {
    await batchInsertEmbeddings(adapter.executeWithReusedStatement, [
      {
        nodeId,
        chunkIndex: 0,
        startLine: 0,
        endLine: 2,
        embedding: new Array(EMBEDDING_DIMS).fill(0),
      },
    ]);
  } finally {
    await adapter.closeLbug();
  }
}

/** Read the surviving CodeEmbedding nodeIds straight from the repo DB. */
export async function readEmbeddingNodeIds(repoPath: string): Promise<string[]> {
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  const { lbugPath } = getStoragePaths(repoPath);
  await adapter.initLbug(lbugPath);
  try {
    const rows = (await adapter.executeQuery(
      `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId`,
    )) as Array<{ nodeId: string }>;
    return rows.map((r) => String(r.nodeId));
  } finally {
    await adapter.closeLbug();
  }
}

/** Tamper meta.stats.embeddings so deriveEmbeddingMode sees an embedded repo
 *  (loadMeta → spread → saveMeta, same pattern as the dirty-flag tests). */
export async function stampEmbeddingCount(storagePath: string, embeddings: number): Promise<void> {
  const meta = await loadMeta(storagePath);
  expect(meta).not.toBeNull();
  const tampered: RepoMeta = { ...meta!, stats: { ...meta!.stats, embeddings } };
  await saveMeta(storagePath, tampered);
}
