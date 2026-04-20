import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchFTSFromLbug, type BM25SearchResult } from '../../src/core/search/bm25-index.js';

vi.mock('../../src/core/lbug/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/lbug/lbug-adapter.js')>();
  return {
    ...actual,
    queryFTS: vi.fn().mockResolvedValue([]),
  };
});

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

    it('accepts optional nodeIds field', () => {
      const result: BM25SearchResult = {
        filePath: 'src/index.ts',
        score: 1.5,
        rank: 1,
        nodeIds: ['func:id1', 'func:id2'],
      };
      expect(result.nodeIds).toEqual(['func:id1', 'func:id2']);
    });
  });

  describe('score aggregation', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('sums only top-3 scoring nodes per file when more than 3 match', async () => {
      const { queryFTS } = await import('../../src/core/lbug/lbug-adapter.js');
      // File table: empty; Function table: 5 hits for the same file; rest: empty
      vi.mocked(queryFTS)
        .mockResolvedValueOnce([]) // File
        .mockResolvedValueOnce([
          // Function — 5 hits, scores 10/9/8/7/6
          { filePath: 'src/views.py', score: 10, nodeId: 'func:node1', name: 'get_queryset' },
          { filePath: 'src/views.py', score: 9, nodeId: 'func:node2', name: 'post' },
          { filePath: 'src/views.py', score: 8, nodeId: 'func:node3', name: 'delete' },
          { filePath: 'src/views.py', score: 7, nodeId: 'func:node4', name: 'patch' },
          { filePath: 'src/views.py', score: 6, nodeId: 'func:node5', name: 'put' },
        ])
        .mockResolvedValueOnce([]) // Class
        .mockResolvedValueOnce([]) // Method
        .mockResolvedValueOnce([]); // Interface

      const results = await searchFTSFromLbug('queryset');

      expect(results).toHaveLength(1);
      expect(results[0].filePath).toBe('src/views.py');
      // Only top-3 scores (10+9+8=27), not naive sum of all 5 (10+9+8+7+6=40)
      expect(results[0].score).toBe(27);
      expect(results[0].nodeIds).toEqual(['func:node1', 'func:node2', 'func:node3']);
    });

    it('propagates nodeIds for files with fewer than 3 matching nodes', async () => {
      const { queryFTS } = await import('../../src/core/lbug/lbug-adapter.js');
      vi.mocked(queryFTS)
        .mockResolvedValueOnce([]) // File
        .mockResolvedValueOnce([
          // Function — 2 hits
          { filePath: 'src/models.py', score: 5, nodeId: 'func:m1', name: 'save' },
          { filePath: 'src/models.py', score: 3, nodeId: 'func:m2', name: 'delete' },
        ])
        .mockResolvedValueOnce([]) // Class
        .mockResolvedValueOnce([]) // Method
        .mockResolvedValueOnce([]); // Interface

      const results = await searchFTSFromLbug('model');

      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(8); // 5+3
      expect(results[0].nodeIds).toEqual(['func:m1', 'func:m2']);
    });

    it('filters out empty nodeIds', async () => {
      const { queryFTS } = await import('../../src/core/lbug/lbug-adapter.js');
      vi.mocked(queryFTS)
        .mockResolvedValueOnce([]) // File
        .mockResolvedValueOnce([
          // Function — nodes with no id
          { filePath: 'src/utils.py', score: 5, nodeId: '', name: 'helper' },
          { filePath: 'src/utils.py', score: 3, nodeId: '', name: 'util' },
        ])
        .mockResolvedValueOnce([]) // Class
        .mockResolvedValueOnce([]) // Method
        .mockResolvedValueOnce([]); // Interface

      const results = await searchFTSFromLbug('util');

      expect(results).toHaveLength(1);
      expect(results[0].nodeIds).toEqual([]);
    });

    it('merges hits across multiple index tables for the same file', async () => {
      const { queryFTS } = await import('../../src/core/lbug/lbug-adapter.js');
      vi.mocked(queryFTS)
        .mockResolvedValueOnce([
          // File table
          { filePath: 'src/auth.py', score: 4, nodeId: 'file:auth', name: 'auth.py' },
        ])
        .mockResolvedValueOnce([
          // Function table
          { filePath: 'src/auth.py', score: 9, nodeId: 'func:login', name: 'login' },
        ])
        .mockResolvedValueOnce([
          // Class table
          { filePath: 'src/auth.py', score: 7, nodeId: 'cls:User', name: 'User' },
        ])
        .mockResolvedValueOnce([]) // Method
        .mockResolvedValueOnce([]); // Interface

      const results = await searchFTSFromLbug('auth');

      expect(results).toHaveLength(1);
      // All 3 hits (scores 9+7+4=20) — each from a different table, all top-3
      expect(results[0].score).toBe(20);
      expect(results[0].nodeIds).toEqual(['func:login', 'cls:User', 'file:auth']);
    });

    it('ranks files by aggregated score descending', async () => {
      const { queryFTS } = await import('../../src/core/lbug/lbug-adapter.js');
      vi.mocked(queryFTS)
        .mockResolvedValueOnce([]) // File
        .mockResolvedValueOnce([
          // Function — hits across two files
          { filePath: 'src/low.py', score: 2, nodeId: 'func:a', name: 'a' },
          { filePath: 'src/high.py', score: 9, nodeId: 'func:b', name: 'b' },
        ])
        .mockResolvedValueOnce([]) // Class
        .mockResolvedValueOnce([]) // Method
        .mockResolvedValueOnce([]); // Interface

      const results = await searchFTSFromLbug('fn');

      expect(results[0].filePath).toBe('src/high.py');
      expect(results[1].filePath).toBe('src/low.py');
      expect(results[0].rank).toBe(1);
      expect(results[1].rank).toBe(2);
    });
  });
});
