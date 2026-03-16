import { describe, it, expect } from 'vitest';
import { getCommunityColor, COMMUNITY_COLORS } from '../../src/core/ingestion/community-processor.js';

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
});
