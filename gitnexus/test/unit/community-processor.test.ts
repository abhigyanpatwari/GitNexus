import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  getCommunityColor,
  COMMUNITY_COLORS,
  processCommunities,
} from '../../src/core/ingestion/community-processor.js';
import { buildTestGraph } from '../helpers/test-graph.js';

describe('community-processor', () => {
  describe('COMMUNITY_COLORS', () => {
    it('has 12 colors', () => {
      expect(COMMUNITY_COLORS).toHaveLength(12);
    });

    it('contains valid hex color strings', () => {
      for (const color of COMMUNITY_COLORS) {
        expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });

    it('has no duplicate colors', () => {
      const unique = new Set(COMMUNITY_COLORS);
      expect(unique.size).toBe(COMMUNITY_COLORS.length);
    });
  });

  describe('getCommunityColor', () => {
    it('returns first color for index 0', () => {
      expect(getCommunityColor(0)).toBe(COMMUNITY_COLORS[0]);
    });

    it('wraps around when index exceeds color count', () => {
      expect(getCommunityColor(12)).toBe(COMMUNITY_COLORS[0]);
      expect(getCommunityColor(13)).toBe(COMMUNITY_COLORS[1]);
    });

    it('returns different colors for different indices', () => {
      const c0 = getCommunityColor(0);
      const c1 = getCommunityColor(1);
      expect(c0).not.toBe(c1);
    });
  });

  describe('processCommunities', () => {
    it('uses a content-stable fallback label when no heuristic name is available', async () => {
      const filePaths = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
      const graph = buildTestGraph(
        [
          { id: 'Function:one', label: 'Function', name: 'a', filePath: filePaths[0] },
          { id: 'Function:two', label: 'Function', name: 'b', filePath: filePaths[1] },
          { id: 'Function:three', label: 'Function', name: 'c', filePath: filePaths[2] },
        ],
        [
          { sourceId: 'Function:one', targetId: 'Function:two', type: 'CALLS' },
          { sourceId: 'Function:two', targetId: 'Function:three', type: 'CALLS' },
          { sourceId: 'Function:three', targetId: 'Function:one', type: 'CALLS' },
        ],
      );

      const result = await processCommunities(graph);
      const expectedHash = createHash('sha1')
        .update(filePaths.slice().sort().join('|'))
        .digest('hex')
        .slice(0, 6);

      expect(result.communities).toHaveLength(1);
      expect(result.communities[0].heuristicLabel).toBe(`cluster-${expectedHash}`);
      expect(result.communities[0].heuristicLabel).toMatch(/^cluster-[0-9a-f]{6}$/);
    });
  });
});
