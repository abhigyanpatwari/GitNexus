/**
 * P1 Unit Tests: Hybrid Search (mergeWithRRF + hybridSearch)
 *
 * Tests: mergeWithRRF from hybrid-search.ts
 * - BM25-only merge
 * - Semantic-only merge
 * - Combined ranking
 * - Limit parameter
 * - Empty inputs
 * - Undefined/null inputs (#1489)
 *
 * Tests: hybridSearch fallback when FTS unavailable (#1489)
 */
import { describe, it, expect, vi } from 'vitest';
import { mergeWithRRF, hybridSearch } from '../../src/core/search/hybrid-search.js';
import type { BM25SearchResult } from '../../src/core/search/bm25-index.js';
import type { SemanticSearchResult } from '../../src/core/embeddings/types.js';

vi.mock('../../src/core/search/bm25-index.js', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, searchFTSFromLbug: vi.fn() };
});

let bm25Rank = 0;
function makeBM25(filePath: string, score: number): BM25SearchResult {
  return { filePath, score, rank: ++bm25Rank };
}

function makeSemantic(filePath: string, distance: number): SemanticSearchResult {
  return {
    filePath,
    distance,
    nodeId: `node:${filePath}`,
    name: filePath
      .split('/')
      .pop()!
      .replace(/\.\w+$/, ''),
    label: 'Function',
    startLine: 1,
    endLine: 10,
  };
}

describe('mergeWithRRF', () => {
  it('handles empty inputs', () => {
    const result = mergeWithRRF([], []);
    expect(result).toHaveLength(0);
  });

  it('handles BM25-only results', () => {
    const bm25: BM25SearchResult[] = [makeBM25('src/a.ts', 10), makeBM25('src/b.ts', 5)];
    const result = mergeWithRRF(bm25, []);
    expect(result).toHaveLength(2);
    expect(result[0].filePath).toBe('src/a.ts');
    expect(result[0].sources).toEqual(['bm25']);
    expect(result[0].rank).toBe(1);
    expect(result[1].rank).toBe(2);
  });

  it('handles semantic-only results', () => {
    const semantic: SemanticSearchResult[] = [
      makeSemantic('src/a.ts', 0.1),
      makeSemantic('src/b.ts', 0.2),
    ];
    const result = mergeWithRRF([], semantic);
    expect(result).toHaveLength(2);
    expect(result[0].filePath).toBe('src/a.ts');
    expect(result[0].sources).toEqual(['semantic']);
  });

  it('combined: shared results get higher score', () => {
    const bm25: BM25SearchResult[] = [
      makeBM25('src/shared.ts', 10),
      makeBM25('src/bm25-only.ts', 5),
    ];
    const semantic: SemanticSearchResult[] = [
      makeSemantic('src/shared.ts', 0.1),
      makeSemantic('src/semantic-only.ts', 0.2),
    ];

    const result = mergeWithRRF(bm25, semantic);
    // Shared result should be ranked first (higher combined RRF score)
    expect(result[0].filePath).toBe('src/shared.ts');
    expect(result[0].sources).toContain('bm25');
    expect(result[0].sources).toContain('semantic');
    // Its score should be higher than any single-source result
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it('respects limit parameter', () => {
    const bm25: BM25SearchResult[] = Array.from({ length: 20 }, (_, i) =>
      makeBM25(`src/${i}.ts`, 100 - i),
    );
    const result = mergeWithRRF(bm25, [], 5);
    expect(result).toHaveLength(5);
  });

  it('default limit is 10', () => {
    const bm25: BM25SearchResult[] = Array.from({ length: 20 }, (_, i) =>
      makeBM25(`src/${i}.ts`, 100 - i),
    );
    const result = mergeWithRRF(bm25, []);
    expect(result).toHaveLength(10);
  });

  it('assigns ranks starting from 1', () => {
    const bm25: BM25SearchResult[] = [
      makeBM25('src/a.ts', 10),
      makeBM25('src/b.ts', 5),
      makeBM25('src/c.ts', 1),
    ];
    const result = mergeWithRRF(bm25, []);
    expect(result.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('preserves semantic metadata on shared results', () => {
    const bm25: BM25SearchResult[] = [makeBM25('src/a.ts', 10)];
    const semantic: SemanticSearchResult[] = [makeSemantic('src/a.ts', 0.1)];

    const result = mergeWithRRF(bm25, semantic);
    expect(result[0].nodeId).toBe('node:src/a.ts');
    expect(result[0].name).toBe('a');
    expect(result[0].label).toBe('Function');
  });

  it('stores original scores for debugging', () => {
    const bm25: BM25SearchResult[] = [makeBM25('src/a.ts', 15)];
    const semantic: SemanticSearchResult[] = [makeSemantic('src/a.ts', 0.3)];

    const result = mergeWithRRF(bm25, semantic);
    expect(result[0].bm25Score).toBe(15);
    expect(result[0].semanticScore).toBeCloseTo(0.7); // 1 - distance
  });

  // Regression: #1489 — bm25Results is not iterable when FTS unavailable
  it('does not crash when bm25Results is undefined (#1489)', () => {
    const semantic: SemanticSearchResult[] = [makeSemantic('src/a.ts', 0.1)];
    // Force undefined to simulate the crash path where FTS returns unexpected shape
    const result = mergeWithRRF(undefined as any, semantic);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe('src/a.ts');
    expect(result[0].sources).toEqual(['semantic']);
  });

  it('does not crash when semanticResults is undefined (#1489)', () => {
    const bm25: BM25SearchResult[] = [makeBM25('src/a.ts', 10)];
    const result = mergeWithRRF(bm25, undefined as any);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe('src/a.ts');
    expect(result[0].sources).toEqual(['bm25']);
  });

  it('does not crash when both inputs are undefined (#1489)', () => {
    const result = mergeWithRRF(undefined as any, undefined as any);
    expect(result).toHaveLength(0);
  });
});

// Regression: #1489 — hybridSearch must not crash when FTS is unavailable
describe('hybridSearch — FTS failure fallback (#1489)', () => {
  it('falls back to semantic-only when searchFTSFromLbug throws', async () => {
    const { searchFTSFromLbug } = await import('../../src/core/search/bm25-index.js');
    vi.mocked(searchFTSFromLbug).mockRejectedValueOnce(new Error('bm25Results is not iterable'));

    const mockExecuteQuery = vi.fn().mockResolvedValue([]);
    const mockSemanticSearch = vi
      .fn()
      .mockResolvedValue([makeSemantic('src/semantic-hit.ts', 0.15)]);

    const results = await hybridSearch('test query', 10, mockExecuteQuery, mockSemanticSearch);
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe('src/semantic-hit.ts');
    expect(results[0].sources).toEqual(['semantic']);
  });

  it('returns empty when both FTS and semantic return nothing', async () => {
    const { searchFTSFromLbug } = await import('../../src/core/search/bm25-index.js');
    vi.mocked(searchFTSFromLbug).mockRejectedValueOnce(new Error('FTS unavailable'));

    const mockExecuteQuery = vi.fn().mockResolvedValue([]);
    const mockSemanticSearch = vi.fn().mockResolvedValue([]);

    const results = await hybridSearch('test query', 10, mockExecuteQuery, mockSemanticSearch);
    expect(results).toHaveLength(0);
  });

  it('works normally when FTS succeeds', async () => {
    const { searchFTSFromLbug } = await import('../../src/core/search/bm25-index.js');
    vi.mocked(searchFTSFromLbug).mockResolvedValueOnce({
      results: [{ filePath: 'src/fts-hit.ts', score: 5, rank: 1 }],
      ftsAvailable: true,
    });

    const mockExecuteQuery = vi.fn().mockResolvedValue([]);
    const mockSemanticSearch = vi.fn().mockResolvedValue([]);

    const results = await hybridSearch('test query', 10, mockExecuteQuery, mockSemanticSearch);
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe('src/fts-hit.ts');
    expect(results[0].sources).toEqual(['bm25']);
  });
});
