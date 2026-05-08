/**
 * Full-Text Search via LadybugDB FTS
 *
 * Uses LadybugDB's built-in full-text search indexes for keyword-based search.
 * Always reads from the database (no cached state to drift).
 */

import { queryFTS } from '../lbug/lbug-adapter.js';
import { FTS_INDEXES } from './fts-schema.js';

export interface BM25SearchResult {
  filePath: string;
  score: number;
  rank: number;
  nodeIds?: string[];
}

export interface FTSSearchResponse {
  results: BM25SearchResult[];
  /** True when at least one FTS index query succeeded (index exists). */
  ftsAvailable: boolean;
}

/**
 * Execute a single FTS query via a custom executor (for MCP connection pool).
 * Returns `null` when the query fails (e.g. FTS index does not exist) so the
 * caller can distinguish "zero matches" from "index missing".
 */
async function queryFTSViaExecutor(
  executor: (cypher: string) => Promise<any[]>,
  tableName: string,
  indexName: string,
  query: string,
  limit: number,
): Promise<Array<{ filePath: string; score: number; nodeId: string }> | null> {
  // Escape single quotes and backslashes to prevent Cypher injection
  const escapedQuery = query.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const cypher = `
    CALL QUERY_FTS_INDEX('${tableName}', '${indexName}', '${escapedQuery}', conjunctive := false)
    RETURN node, score
    ORDER BY score DESC
    LIMIT ${limit}
  `;
  try {
    const rows = await executor(cypher);
    return rows.map((row: any) => {
      const node = row.node || row[0] || {};
      const score = row.score ?? row[1] ?? 0;
      return {
        filePath: node.filePath || '',
        score: typeof score === 'number' ? score : parseFloat(score) || 0,
        nodeId: node.nodeId || node.id || '',
      };
    });
  } catch {
    return null;
  }
}

/**
 * Search using LadybugDB's built-in FTS (always fresh, reads from disk)
 *
 * Queries multiple node tables (File, Function, Class, Method) in parallel
 * and merges results by filePath, summing scores for the same file.
 *
 * @param query - Search query string
 * @param limit - Maximum results
 * @param repoId - If provided, queries will be routed via the MCP connection pool
 * @returns Ranked search results from FTS indexes
 */
export const searchFTSFromLbug = async (
  query: string,
  limit: number = 20,
  repoId?: string,
): Promise<FTSSearchResponse> => {
  const resultsByIndex: any[][] = [];
  let queriesSucceeded = 0;

  if (repoId) {
    // Use MCP connection pool via dynamic import
    // IMPORTANT: FTS queries run sequentially to avoid connection contention.
    // The MCP pool supports multiple connections, but FTS is best run serially.
    const poolMod = await import('../lbug/pool-adapter.js');
    const { executeQuery } = poolMod;
    const executor = (cypher: string) => executeQuery(repoId, cypher);

    for (const { table, indexName } of FTS_INDEXES) {
      const result = await queryFTSViaExecutor(executor, table, indexName, query, limit);
      if (result !== null) {
        queriesSucceeded++;
        resultsByIndex.push(result);
      }
    }
  } else {
    // Use core lbug adapter (CLI / pipeline context) — also sequential for safety.
    for (const { table, indexName } of FTS_INDEXES) {
      try {
        const result = await queryFTS(table, indexName, query, limit, false);
        queriesSucceeded++;
        resultsByIndex.push(result);
      } catch {
        // FTS index may not exist — count as failed
      }
    }
  }

  const ftsAvailable = queriesSucceeded > 0;

  // Collect all node scores per filePath to track which nodes actually matched
  const fileNodeScores = new Map<string, Array<{ score: number; nodeId: string }>>();

  const addResults = (results: any[]) => {
    for (const r of results) {
      if (!fileNodeScores.has(r.filePath)) fileNodeScores.set(r.filePath, []);
      fileNodeScores.get(r.filePath)!.push({ score: r.score, nodeId: r.nodeId });
    }
  };

  for (const results of resultsByIndex) addResults(results);

  // Sum the top-3 highest-scoring nodes per file and collect their nodeIds.
  // Summing all nodes naively inflates scores for files with many mediocre
  // matches (e.g. test files) over files with a single highly-relevant symbol.
  const merged = new Map<string, { filePath: string; score: number; nodeIds: string[] }>();
  for (const [filePath, entries] of fileNodeScores) {
    const top3 = [...entries].sort((a, b) => b.score - a.score).slice(0, 3);
    merged.set(filePath, {
      filePath,
      score: top3.reduce((acc, e) => acc + e.score, 0),
      nodeIds: top3.map((e) => e.nodeId).filter((id) => id),
    });
  }

  // Sort by score descending and add rank
  const sorted = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    results: sorted.map((r, index) => ({
      filePath: r.filePath,
      score: r.score,
      rank: index + 1,
      nodeIds: r.nodeIds,
    })),
    ftsAvailable,
  };
};
