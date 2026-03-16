/**
 * Hybrid Search with Reciprocal Rank Fusion (RRF)
 * 
 * Combines BM25 (keyword) and semantic (embedding) search results.
 * Uses RRF to merge rankings without needing score normalization.
 * 
 * This is the same approach used by Elasticsearch, Pinecone, and other
 * production search systems.
 */

import { searchFTSFromLbug, type BM25SearchResult } from './bm25-index.js';
import type { SemanticSearchResult } from '../embeddings/types.js';

/**
 * RRF constant - standard value used in the literature
 * Higher values give more weight to lower-ranked results
 */
const RRF_K = 60;

export interface HybridSearchResult {
  filePath: string;
  score: number;           // RRF score
  rank: number;            // Final rank
  sources: ('bm25' | 'semantic')[];  // Which methods found this
  
  // Metadata from semantic search (if available)
  nodeId?: string;
  name?: string;
  label?: string;
  startLine?: number;
  endLine?: number;
  
  // Original scores for debugging
  bm25Score?: number;
  semanticScore?: number;
}

/**
 * Perform hybrid search combining BM25 and semantic results
 * 
 * @param bm25Results - Results from BM25 keyword search
 * @param semanticResults - Results from semantic/embedding search
 * @param limit - Maximum results to return
 * @returns Merged and re-ranked results
 */
export const mergeWithRRF = (
  bm25Results: BM25SearchResult[],
  semanticResults: SemanticSearchResult[],
  limit: number = 10
): HybridSearchResult[] => {
  const merged = new Map<string, HybridSearchResult>();
  
  // Process BM25 results
  for (let i = 0; i < bm25Results.length; i++) {
    const r = bm25Results[i];
    const rrfScore = 1 / (RRF_K + i + 1);  // i+1 because rank starts at 1
    
    merged.set(r.filePath, {
      filePath: r.filePath,
      score: rrfScore,
      rank: 0,  // Will be set after sorting
      sources: ['bm25'],
      bm25Score: r.score,
    });
  }
  
  // Process semantic results and merge
  for (let i = 0; i < semanticResults.length; i++) {
    const r = semanticResults[i];
    const rrfScore = 1 / (RRF_K + i + 1);
    
    const existing = merged.get(r.filePath);
    if (existing) {
      // Found by both methods - add scores
      existing.score += rrfScore;
      existing.sources.push('semantic');
      existing.semanticScore = 1 - r.distance;
      
      // Add semantic metadata
      existing.nodeId = r.nodeId;
      existing.name = r.name;
      existing.label = r.label;
      existing.startLine = r.startLine;
      existing.endLine = r.endLine;
    } else {
      // Only found by semantic
      merged.set(r.filePath, {
        filePath: r.filePath,
        score: rrfScore,
        rank: 0,
        sources: ['semantic'],
        semanticScore: 1 - r.distance,
        nodeId: r.nodeId,
        name: r.name,
        label: r.label,
        startLine: r.startLine,
        endLine: r.endLine,
      });
    }
  }
  
  // Sort by RRF score descending
  const sorted = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  
  // Assign final ranks
  sorted.forEach((r, i) => {
    r.rank = i + 1;
  });
  
  return sorted;
};

/**
 * Check if hybrid search is available
 * LadybugDB FTS is always available once the database is initialized.
 * Semantic search is optional - hybrid works with just FTS if embeddings aren't ready.
 */
export const isHybridSearchReady = (): boolean => {
  return true; // FTS is always available via LadybugDB when DB is open
};

/**
 * Format hybrid results for LLM consumption
 */
export const formatHybridResults = (results: HybridSearchResult[]): string => {
  if (results.length === 0) {
    return 'No results found.';
  }
  
  const formatted = results.map((r, i) => {
    const sources = r.sources.join(' + ');
    const location = r.startLine ? ` (lines ${r.startLine}-${r.endLine})` : '';
    const label = r.label ? `${r.label}: ` : 'File: ';
    const name = r.name || r.filePath.split('/').pop() || r.filePath;
    
    return `[${i + 1}] ${label}${name}
    File: ${r.filePath}${location}
    Found by: ${sources}
    Relevance: ${r.score.toFixed(4)}`;
  });
  
  return `Found ${results.length} results:\n\n${formatted.join('\n\n')}`;
};

/**
 * Execute BM25 + semantic search and merge with RRF.
 * Uses LadybugDB FTS for always-fresh BM25 results (no cached data).
 * The semanticSearch function is injected to keep this module environment-agnostic.
 */
export const hybridSearch = async (
  query: string,
  limit: number,
  executeQuery: (cypher: string) => Promise<any[]>,
  semanticSearch: (executeQuery: (cypher: string) => Promise<any[]>, query: string, k?: number) => Promise<SemanticSearchResult[]>
): Promise<HybridSearchResult[]> => {
  // Use LadybugDB FTS for always-fresh BM25 results
  const bm25Results = await searchFTSFromLbug(query, limit);
  const semanticResults = await semanticSearch(executeQuery, query, limit);
  return mergeWithRRF(bm25Results, semanticResults, limit);
};
