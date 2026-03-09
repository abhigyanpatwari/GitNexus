/**
 * Full-Text Search via KuzuDB FTS
 * 
 * Uses KuzuDB's built-in full-text search indexes for keyword-based search.
 * Always reads from the database (no cached state to drift).
 */

import { queryFTS } from '../kuzu/kuzu-adapter.js';

export interface BM25SearchResult {
  filePath: string;
  score: number;
  rank: number;
}

/**
 * Execute a single FTS query via a custom executor (for MCP connection pool).
 * Returns the same shape as core queryFTS.
 */
async function queryFTSViaExecutor(
  executor: (cypher: string) => Promise<any[]>,
  tableName: string,
  indexName: string,
  query: string,
  limit: number,
): Promise<Array<{ filePath: string; score: number }>> {
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
      };
    });
  } catch {
    return [];
  }
}

/**
 * Search using KuzuDB's built-in FTS (always fresh, reads from disk)
 * 
 * Queries multiple node tables (File, Function, Class, Method) in parallel
 * and merges results by filePath, summing scores for the same file.
 * 
 * @param query - Search query string
 * @param limit - Maximum results
 * @param repoId - If provided, queries will be routed via the MCP connection pool
 * @returns Ranked search results from FTS indexes
 */
export const searchFTSFromKuzu = async (query: string, limit: number = 20, repoId?: string): Promise<BM25SearchResult[]> => {
  let fileResults: any[], functionResults: any[], classResults: any[], methodResults: any[], interfaceResults: any[];

  if (repoId) {
    // Use MCP connection pool via dynamic import
    // IMPORTANT: KuzuDB uses a single connection per repo — queries must be sequential
    // to avoid deadlocking. Do NOT use Promise.all here.
    const { executeQuery } = await import('../../mcp/core/kuzu-adapter.js');
    const executor = (cypher: string) => executeQuery(repoId, cypher);
    fileResults = await queryFTSViaExecutor(executor, 'File', 'file_fts', query, limit);
    functionResults = await queryFTSViaExecutor(executor, 'Function', 'function_fts', query, limit);
    classResults = await queryFTSViaExecutor(executor, 'Class', 'class_fts', query, limit);
    methodResults = await queryFTSViaExecutor(executor, 'Method', 'method_fts', query, limit);
    interfaceResults = await queryFTSViaExecutor(executor, 'Interface', 'interface_fts', query, limit);
  } else {
    // Use core kuzu adapter (CLI / pipeline context) — also sequential for safety
    fileResults = await queryFTS('File', 'file_fts', query, limit, false).catch(() => []);
    functionResults = await queryFTS('Function', 'function_fts', query, limit, false).catch(() => []);
    classResults = await queryFTS('Class', 'class_fts', query, limit, false).catch(() => []);
    methodResults = await queryFTS('Method', 'method_fts', query, limit, false).catch(() => []);
    interfaceResults = await queryFTS('Interface', 'interface_fts', query, limit, false).catch(() => []);
  }
  
  // Merge results by filePath, summing scores for same file
  const merged = new Map<string, { filePath: string; score: number }>();
  
  const addResults = (results: any[]) => {
    for (const r of results) {
      const existing = merged.get(r.filePath);
      if (existing) {
        existing.score += r.score;
      } else {
        merged.set(r.filePath, { filePath: r.filePath, score: r.score });
      }
    }
  };
  
  addResults(fileResults);
  addResults(functionResults);
  addResults(classResults);
  addResults(methodResults);
  addResults(interfaceResults);
  
  // Sort by score descending and add rank
  const sorted = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  
  return sorted.map((r, index) => ({
    filePath: r.filePath,
    score: r.score,
    rank: index + 1,
  }));
};
