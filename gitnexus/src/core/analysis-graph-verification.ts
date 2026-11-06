/** Read-only verification after the graph writer has physically released its DB. */
import lbug from '@ladybugdb/core';
import type { RepoMeta } from '../storage/repo-meta.js';
import { NODE_TABLES, REL_TABLE_NAME, SCHEMA_FINGERPRINT } from './lbug/schema.js';
import { closeLbugConnection, openLbugConnection, estimateBufferPool } from './lbug/lbug-config.js';
import { assertLbugPublicationReady } from './lbug/publication.js';
import { getFtsIndexes } from './search/fts-schema.js';
import { verifySearchFTSIndexes } from './search/fts-indexes.js';
import { ExtensionManager } from './lbug/extension-loader.js';

function count(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'bigint')
    throw new Error('Published graph count is unverified');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error('Published graph count is invalid');
  return result;
}

export async function verifyPublishedAnalysisGraph(
  graphPath: string,
  metadata: RepoMeta,
  resources: { bufferPoolBytes: number; threads: number },
): Promise<void> {
  if (
    metadata.incrementalInProgress ||
    metadata.graphWriteCollapsed ||
    metadata.schemaFingerprint !== SCHEMA_FINGERPRINT ||
    !metadata.graphGeneration
  )
    throw new Error('Prepared graph has no compatible, verified schema generation');
  const expectedNodes = count(metadata.stats?.nodes);
  const expectedEdges = count(metadata.stats?.edges);
  await assertLbugPublicationReady(graphPath);
  const handle = await openLbugConnection(lbug, graphPath, {
    ...resources,
    bufferPoolBytes: Math.min(
      resources.bufferPoolBytes,
      estimateBufferPool(expectedNodes + expectedEdges),
    ),
    readOnly: true,
  });
  const query = async (sql: string): Promise<Record<string, unknown>[]> => {
    const result = await handle.conn.query(sql);
    const cursors = Array.isArray(result) ? result : [result];
    try {
      if (cursors.length !== 1) throw new Error('Unexpected publication verification result');
      return await cursors[0].getAll();
    } finally {
      for (const cursor of cursors) cursor.close();
    }
  };
  try {
    // Binding every structural table also rejects incomplete native catalogs.
    // Count metadata is bounded; no source text, graph rows or vectors enter JS.
    const nodes = await query(
      NODE_TABLES.map((table) => `MATCH (n:\`${table}\`) RETURN count(n) AS count`).join(
        ' UNION ALL ',
      ),
    );
    const edges = await query(`MATCH ()-[r:${REL_TABLE_NAME}]->() RETURN count(r) AS count`);
    if (
      nodes.length !== NODE_TABLES.length ||
      edges.length !== 1 ||
      nodes.reduce((total, row) => total + count(row.count), 0) !== expectedNodes ||
      count(edges[0].count) !== expectedEdges
    )
      throw new Error('Prepared graph counts differ after writer release; artifacts retained');
    if (metadata.capabilities?.fts.status === 'available') {
      if (
        !(await new ExtensionManager().ensure(query, 'fts', 'publication verification', {
          policy: 'load-only',
        }))
      )
        throw new Error('Prepared graph FTS extension could not be loaded; artifacts retained');
      const missing = await verifySearchFTSIndexes(query, getFtsIndexes(metadata.ftsProfile));
      if (missing.length)
        throw new Error(`Prepared graph search indexes are incomplete: ${missing.join(', ')}`);
    }
  } finally {
    await closeLbugConnection(handle, { strict: true, databasePath: graphPath });
  }
}
