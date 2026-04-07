/**
 * Full-Text Search via LadybugDB FTS
 *
 * Uses LadybugDB's built-in full-text search indexes for keyword-based search.
 * Always reads from the database (no cached state to drift).
 */

import { queryFTS } from '../lbug/lbug-adapter.js';

export interface BM25SearchResult {
  filePath: string;
  score: number;
  rank: number;
}

/**
 * Execute a single FTS query via a custom executor (for MCP connection pool).
 * Returns the same shape as core queryFTS (from LadybugDB adapter).
 * Optionally filters results by git_namespace.
 */
async function queryFTSViaExecutor(
  executor: (cypher: string) => Promise<any[]>,
  tableName: string,
  indexName: string,
  query: string,
  limit: number,
  gitNamespace?: string,
): Promise<Array<{ filePath: string; score: number; git_namespace?: string }>> {
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
    const results: Array<{ filePath: string; score: number; git_namespace?: string }> = [];
    for (const row of rows) {
      const node = row.node || row[0] || {};
      const score = row.score ?? row[1] ?? 0;
      const ns = node.git_namespace || '';
      // Post-filter by git_namespace if specified
      if (gitNamespace && ns !== gitNamespace) continue;
      results.push({
        filePath: node.filePath || '',
        score: typeof score === 'number' ? score : parseFloat(score) || 0,
        git_namespace: ns,
      });
    }
    return results;
  } catch {
    return [];
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
 * @param gitNamespace - If provided, post-filter results to this git_namespace only
 * @returns Ranked search results from FTS indexes
 */
export const searchFTSFromLbug = async (
  query: string,
  limit: number = 20,
  repoId?: string,
  gitNamespace?: string,
): Promise<BM25SearchResult[]> => {
  // Over-fetch when filtering by namespace
  const fetchLimit = gitNamespace ? limit * 3 : limit;

  let fileResults: any[],
    functionResults: any[],
    classResults: any[],
    methodResults: any[],
    interfaceResults: any[];

  if (repoId) {
    // Use MCP connection pool via dynamic import
    // IMPORTANT: FTS queries run sequentially to avoid connection contention.
    // The MCP pool supports multiple connections, but FTS is best run serially.
    const { executeQuery } = await import('../lbug/pool-adapter.js');
    const executor = (cypher: string) => executeQuery(repoId, cypher);
    fileResults = await queryFTSViaExecutor(executor, 'File', 'file_fts', query, fetchLimit, gitNamespace);
    functionResults = await queryFTSViaExecutor(executor, 'Function', 'function_fts', query, fetchLimit, gitNamespace);
    classResults = await queryFTSViaExecutor(executor, 'Class', 'class_fts', query, fetchLimit, gitNamespace);
    methodResults = await queryFTSViaExecutor(executor, 'Method', 'method_fts', query, fetchLimit, gitNamespace);
    interfaceResults = await queryFTSViaExecutor(
      executor,
      'Interface',
      'interface_fts',
      query,
      fetchLimit,
      gitNamespace,
    );
  } else {
    // Use core lbug adapter (CLI / pipeline context) — also sequential for safety
    fileResults = await queryFTS('File', 'file_fts', query, fetchLimit, false).catch(() => []);
    functionResults = await queryFTS('Function', 'function_fts', query, fetchLimit, false).catch(
      () => [],
    );
    classResults = await queryFTS('Class', 'class_fts', query, fetchLimit, false).catch(() => []);
    methodResults = await queryFTS('Method', 'method_fts', query, fetchLimit, false).catch(() => []);
    interfaceResults = await queryFTS('Interface', 'interface_fts', query, fetchLimit, false).catch(
      () => [],
    );
  }

  // Merge results by filePath, summing scores for same file
  const merged = new Map<string, { filePath: string; score: number; git_namespace?: string }>();

  const addResults = (results: any[]) => {
    for (const r of results) {
      const existing = merged.get(r.filePath);
      if (existing) {
        existing.score += r.score;
      } else {
        merged.set(r.filePath, { filePath: r.filePath, score: r.score, git_namespace: r.git_namespace });
      }
    }
  };

  addResults(fileResults);
  addResults(functionResults);
  addResults(classResults);
  addResults(methodResults);
  addResults(interfaceResults);

  // Post-filter by git_namespace for core adapter path (non-repoId)
  // For repoId path, filtering is done in queryFTSViaExecutor
  let entries = Array.from(merged.values());
  if (gitNamespace && !repoId) {
    entries = entries.filter((r) => r.git_namespace === gitNamespace);
  }

  // Sort by score descending and add rank
  const sorted = entries
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return sorted.map((r, index) => ({
    filePath: r.filePath,
    score: r.score,
    rank: index + 1,
  }));
};
