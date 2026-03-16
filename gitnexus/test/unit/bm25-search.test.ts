import { describe, it, expect } from 'vitest';
import { searchFTSFromLbug, type BM25SearchResult } from '../../src/core/search/bm25-index.js';

describe('BM25 search', () => {
  describe('searchFTSFromLbug', () => {
    it('returns empty array when LadybugDB is not initialized', async () => {
      // Without LadybugDB init, search should return empty (not crash)
      const results = await searchFTSFromLbug('test query');
      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(0);
    });

    it('handles empty query', async () => {
      const results = await searchFTSFromLbug('');
      expect(Array.isArray(results)).toBe(true);
    });

    it('accepts custom limit parameter', async () => {
      const results = await searchFTSFromLbug('test', 5);
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('BM25SearchResult type', () => {
    it('has correct shape', () => {
      const result: BM25SearchResult = {
        filePath: 'src/index.ts',
        score: 1.5,
        rank: 1,
      };
      expect(result.filePath).toBe('src/index.ts');
      expect(result.score).toBe(1.5);
      expect(result.rank).toBe(1);
    });
  });
});
