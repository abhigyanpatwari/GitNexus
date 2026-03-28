/**
 * Integration Tests: Cluster Enricher
 *
 * enrichClusters / enrichClustersBatch with mock LLM
 *   - Valid JSON response populates enrichments
 *   - Invalid JSON response falls back to heuristic label
 *   - Batch processing with enrichClustersBatch
 *   - Empty members use heuristicLabel fallback
 */
import { describe, it, expect, vi } from 'vitest';
import {
  enrichClusters,
  enrichClustersBatch,
  type LLMClient,
  type ClusterMemberInfo,
} from '../../src/core/ingestion/cluster-enricher.js';
import type { CommunityNode } from '../../src/core/ingestion/community-processor.js';

describe('enrichment', () => {
  describe('enrichClusters', () => {
    const communities: CommunityNode[] = [
      {
        id: 'comm_0',
        label: 'Auth',
        heuristicLabel: 'Authentication',
        cohesion: 0.8,
        symbolCount: 3,
      },
      {
        id: 'comm_1',
        label: 'Utils',
        heuristicLabel: 'Utilities',
        cohesion: 0.5,
        symbolCount: 2,
      },
    ];

    const memberMap = new Map<string, ClusterMemberInfo[]>([
      [
        'comm_0',
        [
          { name: 'login', filePath: 'src/auth.ts', type: 'Function' },
          { name: 'validate', filePath: 'src/auth.ts', type: 'Function' },
          { name: 'AuthService', filePath: 'src/auth.ts', type: 'Class' },
        ],
      ],
      [
        'comm_1',
        [
          { name: 'hash', filePath: 'src/utils.ts', type: 'Function' },
          { name: 'format', filePath: 'src/utils.ts', type: 'Function' },
        ],
      ],
    ]);

    it('populates enrichments when LLM returns valid JSON', async () => {
      const mockLLM: LLMClient = {
        generate: vi
          .fn()
          .mockResolvedValueOnce('{"name": "Auth Module", "description": "Handles authentication"}')
          .mockResolvedValueOnce('{"name": "Utility Helpers", "description": "Common utilities"}'),
      };

      const result = await enrichClusters(communities, memberMap, mockLLM);

      expect(result.enrichments.size).toBe(2);

      const auth = result.enrichments.get('comm_0')!;
      expect(auth.name).toBe('Auth Module');
      expect(auth.description).toBe('Handles authentication');

      const utils = result.enrichments.get('comm_1')!;
      expect(utils.name).toBe('Utility Helpers');
      expect(utils.description).toBe('Common utilities');

      expect(result.tokensUsed).toBeGreaterThan(0);
      expect(mockLLM.generate).toHaveBeenCalledTimes(2);
    });

    it('falls back to heuristic label when LLM returns invalid JSON', async () => {
      const badLLM: LLMClient = {
        generate: vi.fn().mockResolvedValue('this is not json at all'),
      };

      const result = await enrichClusters(communities, memberMap, badLLM);

      expect(result.enrichments.size).toBe(2);

      // Invalid JSON -> parseEnrichmentResponse falls back to heuristicLabel
      const auth = result.enrichments.get('comm_0')!;
      expect(auth.name).toBe('Authentication');
      expect(auth.keywords).toEqual([]);
      expect(auth.description).toBe('');

      const utils = result.enrichments.get('comm_1')!;
      expect(utils.name).toBe('Utilities');
    });

    it('uses heuristicLabel fallback for clusters with empty members', async () => {
      const emptyMemberMap = new Map<string, ClusterMemberInfo[]>([
        ['comm_0', []],
        ['comm_1', []],
      ]);

      const mockLLM: LLMClient = {
        generate: vi.fn().mockResolvedValue('{"name": "Should Not Appear", "description": "nope"}'),
      };

      const result = await enrichClusters(communities, emptyMemberMap, mockLLM);

      expect(result.enrichments.size).toBe(2);

      // Empty members -> skip LLM, use heuristic directly
      const auth = result.enrichments.get('comm_0')!;
      expect(auth.name).toBe('Authentication');
      expect(auth.keywords).toEqual([]);
      expect(auth.description).toBe('');

      // LLM should never be called for empty members
      expect(mockLLM.generate).not.toHaveBeenCalled();
    });

    it('calls onProgress callback with correct current/total', async () => {
      const mockLLM: LLMClient = {
        generate: vi.fn().mockResolvedValue('{"name": "X", "description": "Y"}'),
      };
      const progress: Array<[number, number]> = [];

      await enrichClusters(communities, memberMap, mockLLM, (current, total) => {
        progress.push([current, total]);
      });

      expect(progress).toEqual([
        [1, 2],
        [2, 2],
      ]);
    });

    // ─── Unhappy paths ────────────────────────────────────────────────

    it('falls back to heuristic when LLM returns empty string', async () => {
      const emptyLLM: LLMClient = {
        generate: vi.fn().mockResolvedValue(''),
      };

      const result = await enrichClusters(communities, memberMap, emptyLLM);
      expect(result.enrichments.size).toBe(2);
      expect(result.enrichments.get('comm_0')!.name).toBe('Authentication');
      expect(result.enrichments.get('comm_1')!.name).toBe('Utilities');
    });

    it('handles zero communities gracefully', async () => {
      const mockLLM: LLMClient = {
        generate: vi.fn(),
      };

      const result = await enrichClusters([], new Map(), mockLLM);
      expect(result.enrichments.size).toBe(0);
      expect(mockLLM.generate).not.toHaveBeenCalled();
    });

    it('handles LLM returning JSON with missing description field', async () => {
      const partialLLM: LLMClient = {
        generate: vi.fn().mockResolvedValue('{"name": "Auth Only"}'),
      };

      const result = await enrichClusters(communities, memberMap, partialLLM);
      expect(result.enrichments.size).toBe(2);
      const auth = result.enrichments.get('comm_0')!;
      expect(auth.name).toBe('Auth Only');
    });
  });

  describe('enrichClustersBatch', () => {
    const communities: CommunityNode[] = [
      {
        id: 'comm_0',
        label: 'Auth',
        heuristicLabel: 'Authentication',
        cohesion: 0.8,
        symbolCount: 3,
      },
      { id: 'comm_1', label: 'Utils', heuristicLabel: 'Utilities', cohesion: 0.5, symbolCount: 2 },
      { id: 'comm_2', label: 'Router', heuristicLabel: 'Routing', cohesion: 0.6, symbolCount: 2 },
    ];

    const memberMap = new Map<string, ClusterMemberInfo[]>([
      ['comm_0', [{ name: 'login', filePath: 'src/auth.ts', type: 'Function' }]],
      ['comm_1', [{ name: 'hash', filePath: 'src/utils.ts', type: 'Function' }]],
      ['comm_2', [{ name: 'route', filePath: 'src/router.ts', type: 'Function' }]],
    ]);

    it('processes all clusters in batches and returns enrichments', async () => {
      const batchResponse = JSON.stringify([
        {
          id: 'comm_0',
          name: 'Auth Module',
          keywords: ['auth', 'login'],
          description: 'Authentication logic',
        },
        {
          id: 'comm_1',
          name: 'Utility Helpers',
          keywords: ['utils'],
          description: 'Common utilities',
        },
      ]);
      const batchResponse2 = JSON.stringify([
        {
          id: 'comm_2',
          name: 'HTTP Router',
          keywords: ['routing'],
          description: 'Request routing',
        },
      ]);

      const mockLLM: LLMClient = {
        generate: vi
          .fn()
          .mockResolvedValueOnce(batchResponse)
          .mockResolvedValueOnce(batchResponse2),
      };

      const result = await enrichClustersBatch(communities, memberMap, mockLLM, 2);

      expect(result.enrichments.size).toBe(3);

      const auth = result.enrichments.get('comm_0')!;
      expect(auth.name).toBe('Auth Module');
      expect(auth.keywords).toEqual(['auth', 'login']);
      expect(auth.description).toBe('Authentication logic');

      const utils = result.enrichments.get('comm_1')!;
      expect(utils.name).toBe('Utility Helpers');

      const router = result.enrichments.get('comm_2')!;
      expect(router.name).toBe('HTTP Router');

      expect(result.tokensUsed).toBeGreaterThan(0);
      // 3 communities with batchSize=2 -> 2 LLM calls
      expect(mockLLM.generate).toHaveBeenCalledTimes(2);
    });

    it('falls back to heuristic labels on batch parse failure', async () => {
      const mockLLM: LLMClient = {
        generate: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
      };

      const result = await enrichClustersBatch(communities, memberMap, mockLLM, 5);

      // All communities should get heuristic fallback
      expect(result.enrichments.size).toBe(3);
      expect(result.enrichments.get('comm_0')!.name).toBe('Authentication');
      expect(result.enrichments.get('comm_1')!.name).toBe('Utilities');
      expect(result.enrichments.get('comm_2')!.name).toBe('Routing');
    });
  });
});
