import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchFTSFromLbug, type BM25SearchResult } from '../../src/core/search/bm25-index.js';
import { FTS_INDEXES } from '../../src/core/search/fts-schema.js';

vi.mock('../../src/core/lbug/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/lbug/lbug-adapter.js')>();
  return {
    ...actual,
    queryFTS: vi.fn().mockResolvedValue([]),
    createFTSIndex: vi.fn().mockResolvedValue(undefined),
    dropFTSIndex: vi.fn().mockResolvedValue(undefined),
  };
});

// Pool adapter is dynamically imported by the MCP-pool path of
// `searchFTSFromLbug`. We mock it so we can drive the executor without
// spinning up a real LadybugDB pool.
const mockExecuteParameterized = vi.fn();
vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: (repoId: string, cypher: string, params: Record<string, any>) =>
    mockExecuteParameterized(repoId, cypher, params),
  addPoolCloseListener: vi.fn(),
}));

describe('BM25 search', () => {
  describe('createSearchFTSIndexes', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('creates every configured index on the writable analysis path', async () => {
      const { createFTSIndex } = await import('../../src/core/lbug/lbug-adapter.js');
      const { createSearchFTSIndexes } = await import('../../src/core/search/fts-indexes.js');

      await createSearchFTSIndexes();

      expect(vi.mocked(createFTSIndex).mock.calls).toEqual(
        FTS_INDEXES.map((i) => [i.table, i.indexName, [...i.properties], 'porter']),
      );
    });

    it('returns no missing indexes when every configured index covers its columns', async () => {
      // One SHOW_INDEXES call returns a catalog row per configured index, each
      // covering exactly its expected properties.
      const showIndexesRows = FTS_INDEXES.map((i) => ({
        index_name: i.indexName,
        property_names: [...i.properties],
      }));
      const executeQuery = vi.fn().mockResolvedValue(showIndexesRows);
      const { verifySearchFTSIndexes } = await import('../../src/core/search/fts-indexes.js');

      const missing = await verifySearchFTSIndexes(executeQuery);

      expect(missing).toEqual([]);
      expect(executeQuery).toHaveBeenCalledTimes(1);
    });

    it('reports an index that exists but does not cover its configured columns', async () => {
      // Model a pre-#2299 stale Function index: present, but name+content only,
      // missing `description`. Every other index covers its columns.
      const staleIndex = 'function_fts';
      const showIndexesRows = FTS_INDEXES.map((i) => ({
        index_name: i.indexName,
        property_names: i.indexName === staleIndex ? ['name', 'content'] : [...i.properties],
      }));
      const executeQuery = vi.fn().mockResolvedValue(showIndexesRows);
      const { verifySearchFTSIndexes } = await import('../../src/core/search/fts-indexes.js');

      const missing = await verifySearchFTSIndexes(executeQuery);

      expect(missing).toEqual(['Function.function_fts']);
    });

    it('reports an index that is absent from the catalog entirely', async () => {
      // Every configured index present and covering, except const_fts is missing.
      const absentIndex = 'const_fts';
      const showIndexesRows = FTS_INDEXES.filter((i) => i.indexName !== absentIndex).map((i) => ({
        index_name: i.indexName,
        property_names: [...i.properties],
      }));
      const executeQuery = vi.fn().mockResolvedValue(showIndexesRows);
      const { verifySearchFTSIndexes } = await import('../../src/core/search/fts-indexes.js');

      const missing = await verifySearchFTSIndexes(executeQuery);

      expect(missing).toEqual(['Const.const_fts']);
    });
  });

  describe('searchFTSFromLbug', () => {
    it('returns empty results when LadybugDB is not initialized', async () => {
      // Simulate an uninitialized DB: queryFTS throws instead of returning rows
      const { queryFTS } = await import('../../src/core/lbug/lbug-adapter.js');
      vi.mocked(queryFTS).mockRejectedValue(new Error('DB not initialized'));

      const { results, ftsAvailable } = await searchFTSFromLbug('test query');
      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(0);
      expect(ftsAvailable).toBe(false);
    });

    it('handles empty query', async () => {
      const { results } = await searchFTSFromLbug('');
      expect(Array.isArray(results)).toBe(true);
    });

    it('accepts custom limit parameter', async () => {
      const { results } = await searchFTSFromLbug('test', 5);
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

      const { results } = await searchFTSFromLbug('queryset');

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

      const { results } = await searchFTSFromLbug('model');

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

      const { results } = await searchFTSFromLbug('util');

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

      const { results } = await searchFTSFromLbug('auth');

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

      const { results } = await searchFTSFromLbug('fn');

      expect(results[0].filePath).toBe('src/high.py');
      expect(results[1].filePath).toBe('src/low.py');
      expect(results[0].rank).toBe(1);
      expect(results[1].rank).toBe(2);
    });
  });

  describe('MCP pool path', () => {
    const REPO = 'test-repo-readonly-fts';

    beforeEach(() => {
      mockExecuteParameterized.mockReset();
    });

    it('queries existing FTS indexes without issuing CREATE_FTS_INDEX', async () => {
      mockExecuteParameterized.mockImplementation(
        async (_repo: string, cypher: string, params: Record<string, any>) => {
          if (cypher.includes('CREATE_FTS_INDEX')) {
            throw new Error('query path must stay read-only');
          }

          if (params.query === 'login' && cypher.includes("QUERY_FTS_INDEX('Function'")) {
            return [{ node: { filePath: 'src/auth.ts', id: 'func:login' }, score: 8 }];
          }
          return [];
        },
      );

      const { results } = await searchFTSFromLbug('login', 5, REPO);

      expect(results).toEqual([
        { filePath: 'src/auth.ts', score: 8, rank: 1, nodeIds: ['func:login'] },
      ]);
      expect(
        mockExecuteParameterized.mock.calls.some((c) => String(c[1]).includes('CREATE_FTS_INDEX')),
      ).toBe(false);
    });

    it('binds FTS user query text as a parameter in pool mode', async () => {
      mockExecuteParameterized.mockResolvedValue([]);

      const userQuery = "BrowserWindow create delete set remove 'main' window";
      await searchFTSFromLbug(userQuery, 5, REPO);

      expect(mockExecuteParameterized).toHaveBeenCalled();
      for (const call of mockExecuteParameterized.mock.calls) {
        const cypher = String(call[1]);
        expect(cypher).toContain('$query');
        expect(cypher).not.toContain(userQuery);
        expect(cypher.toUpperCase()).not.toMatch(/\bCREATE\b/);
        expect(cypher.toUpperCase()).not.toMatch(/\bDELETE\b/);
        expect(cypher.toUpperCase()).not.toMatch(/\bSET\b/);
        expect(cypher.toUpperCase()).not.toMatch(/\bREMOVE\b/);
        expect(call[2]).toEqual({ query: userQuery });
      }
    });

    it('uses the configured FTS query set on every call', async () => {
      mockExecuteParameterized.mockResolvedValue([]);

      await searchFTSFromLbug('anything', 5, REPO);

      const queryCalls = mockExecuteParameterized.mock.calls.filter((c) =>
        String(c[1]).includes('QUERY_FTS_INDEX'),
      );
      expect(queryCalls.map((c) => String(c[1]).match(/QUERY_FTS_INDEX\('([^']+)'/)?.[1])).toEqual(
        FTS_INDEXES.map((i) => i.table),
      );
    });
  });

  describe('GITNEXUS_FTS_CJK_SEGMENTATION query-side transform (#2331)', () => {
    const CJK_REPO = 'test-repo-cjk-query';

    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('leaves the query unchanged by default (mode: none)', async () => {
      const { queryFTS } = await import('../../src/core/lbug/lbug-adapter.js');
      vi.mocked(queryFTS).mockResolvedValue([]);

      await searchFTSFromLbug('审批流程');

      expect(vi.mocked(queryFTS).mock.calls.length).toBeGreaterThan(0);
      for (const call of vi.mocked(queryFTS).mock.calls) {
        expect(call[2]).toBe('审批流程');
      }
    });

    it('bigram-segments the query before it reaches queryFTS when enabled', async () => {
      vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'bigram');
      const { queryFTS } = await import('../../src/core/lbug/lbug-adapter.js');
      vi.mocked(queryFTS).mockResolvedValue([]);

      await searchFTSFromLbug('审批流程');

      expect(vi.mocked(queryFTS).mock.calls.length).toBeGreaterThan(0);
      for (const call of vi.mocked(queryFTS).mock.calls) {
        expect(call[2]).toBe('审批 批流 流程');
      }
    });

    it('bigram-segments the query in pool mode too, still bound via $query', async () => {
      vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'bigram');
      mockExecuteParameterized.mockResolvedValue([]);

      await searchFTSFromLbug('审批流程', 5, CJK_REPO);

      expect(mockExecuteParameterized).toHaveBeenCalled();
      for (const call of mockExecuteParameterized.mock.calls) {
        expect(String(call[1])).toContain('$query');
        expect(String(call[1])).not.toContain('审批流程');
        expect(call[2]).toEqual({ query: '审批 批流 流程' });
      }
    });

    it('skips segmentation for a pathologically long query, searching it unchanged', async () => {
      vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'bigram');
      const { queryFTS } = await import('../../src/core/lbug/lbug-adapter.js');
      vi.mocked(queryFTS).mockResolvedValue([]);

      const longQuery = '审批流程'.repeat(1000); // well past the 2000-char cap
      await searchFTSFromLbug(longQuery);

      expect(vi.mocked(queryFTS).mock.calls.length).toBeGreaterThan(0);
      for (const call of vi.mocked(queryFTS).mock.calls) {
        expect(call[2]).toBe(longQuery);
      }
    });

    it('segments a query at exactly the 2000-character cap', async () => {
      vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'bigram');
      const { queryFTS } = await import('../../src/core/lbug/lbug-adapter.js');
      vi.mocked(queryFTS).mockResolvedValue([]);

      const atCapQuery = '审'.repeat(2000);
      await searchFTSFromLbug(atCapQuery);

      expect(vi.mocked(queryFTS).mock.calls.length).toBeGreaterThan(0);
      for (const call of vi.mocked(queryFTS).mock.calls) {
        expect(call[2]).not.toBe(atCapQuery); // segmented, not passed through raw
        expect(call[2]).toContain(' ');
      }
    });

    it('does not segment a query at exactly 2001 characters, one past the cap', async () => {
      vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'bigram');
      const { queryFTS } = await import('../../src/core/lbug/lbug-adapter.js');
      vi.mocked(queryFTS).mockResolvedValue([]);

      const overCapQuery = '审'.repeat(2001);
      await searchFTSFromLbug(overCapQuery);

      expect(vi.mocked(queryFTS).mock.calls.length).toBeGreaterThan(0);
      for (const call of vi.mocked(queryFTS).mock.calls) {
        expect(call[2]).toBe(overCapQuery); // passed through raw, unsegmented
      }
    });
  });

  // #2339: the query path previously never called normalizeFtsText (only
  // applyCjkSegmentationIfEnabled), unlike the write path which always
  // composes both — a literal tab/newline in a query wouldn't match
  // whitespace-normalized indexed text.
  describe('normalizeFtsText query-side composition (#2339)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('collapses a literal tab in the query to a space (mode: none)', async () => {
      const { queryFTS } = await import('../../src/core/lbug/lbug-adapter.js');
      vi.mocked(queryFTS).mockResolvedValue([]);

      await searchFTSFromLbug('审批\t流程');

      expect(vi.mocked(queryFTS).mock.calls.length).toBeGreaterThan(0);
      for (const call of vi.mocked(queryFTS).mock.calls) {
        expect(call[2]).toBe('审批 流程');
      }
    });

    it('composes segmentation THEN normalization, matching the write path order (mode: bigram)', async () => {
      vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'bigram');
      const { queryFTS } = await import('../../src/core/lbug/lbug-adapter.js');
      vi.mocked(queryFTS).mockResolvedValue([]);

      await searchFTSFromLbug('审批流程\t自动');

      expect(vi.mocked(queryFTS).mock.calls.length).toBeGreaterThan(0);
      for (const call of vi.mocked(queryFTS).mock.calls) {
        // "审批流程" bigram-segments to "审批 批流 流程"; the tab (untouched
        // by segmentCjkSpans, since neither run's boundary needs an extra
        // space next to an already-whitespace neighbor) is then collapsed
        // to a space by normalizeFtsText, keeping "自动" a separate token.
        expect(call[2]).toBe('审批 批流 流程 自动');
      }
    });

    it('applies normalization regardless of the 2000-char segmentation cap', async () => {
      vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'bigram');
      const { queryFTS } = await import('../../src/core/lbug/lbug-adapter.js');
      vi.mocked(queryFTS).mockResolvedValue([]);

      const longQueryWithTab = '审'.repeat(2001) + '\t' + '批';
      await searchFTSFromLbug(longQueryWithTab);

      expect(vi.mocked(queryFTS).mock.calls.length).toBeGreaterThan(0);
      for (const call of vi.mocked(queryFTS).mock.calls) {
        // Segmentation is skipped (over the cap), but normalizeFtsText still
        // runs unconditionally — no per-character cost concern there.
        expect(call[2]).toBe('审'.repeat(2001) + ' ' + '批');
      }
    });
  });
});
