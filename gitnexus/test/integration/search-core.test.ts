/**
 * P0 Integration Tests: BM25/FTS Search against real LadybugDB
 *
 * Tests: searchFTSFromLbug via core adapter (no repoId) path against
 * indexed test data. Verifies ranked result ordering, score merging,
 * and empty-match behavior.
 *
 * Uses withTestLbugDB wrapper for full lifecycle management.
 */
import { describe, it, expect } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { searchFTSFromLbug } from '../../src/core/search/bm25-index.js';
import { SEARCH_SEED_DATA, SEARCH_FTS_INDEXES } from '../fixtures/search-seed.js';

// ─── Core adapter path (no repoId) ──────────────────────────────────

withTestLbugDB('search-core', (_handle) => {
  describe('searchFTSFromLbug — core adapter (no repoId)', () => {
    it('returns ranked results for a matching query', async () => {
      const results = await searchFTSFromLbug('user authentication', 10);

      expect(results.length).toBeGreaterThan(0);

      for (const r of results) {
        expect(r).toHaveProperty('filePath');
        expect(r).toHaveProperty('score');
        expect(r).toHaveProperty('rank');
        expect(typeof r.filePath).toBe('string');
        expect(typeof r.score).toBe('number');
        expect(typeof r.rank).toBe('number');
        expect(r.score).toBeGreaterThan(0);
      }

      // Ranks should be sequential starting from 1
      results.forEach((r, i) => {
        expect(r.rank).toBe(i + 1);
      });
    });

    it('results are ordered by descending score', async () => {
      const results = await searchFTSFromLbug('user authentication', 10);

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('auth-related files rank higher than unrelated files', async () => {
      const results = await searchFTSFromLbug('user authentication', 10);
      const filePaths = results.map((r) => r.filePath);

      expect(filePaths).toContain('src/auth.ts');

      const authIdx = filePaths.indexOf('src/auth.ts');
      const utilsIdx = filePaths.indexOf('src/utils.ts');
      if (utilsIdx !== -1) {
        expect(authIdx).toBeLessThan(utilsIdx);
      }
    });

    it('merges scores from multiple node types for the same filePath', async () => {
      const results = await searchFTSFromLbug('user authentication', 20);

      const authResult = results.find((r) => r.filePath === 'src/auth.ts');
      expect(authResult).toBeDefined();

      const routerResult = results.find((r) => r.filePath === 'src/router.ts');
      if (routerResult) {
        expect(authResult!.score).toBeGreaterThan(routerResult.score);
      }
    });

    it('respects limit parameter', async () => {
      const results = await searchFTSFromLbug('user authentication', 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('returns empty array for a non-matching query', async () => {
      const results = await searchFTSFromLbug('xyzzyplughtwisty', 10);
      expect(results).toEqual([]);
    });
  });

  // ─── Unhappy paths ──────────────────────────────────────────────────

  describe('unhappy paths', () => {
    it('returns empty array for empty query string', async () => {
      const results = await searchFTSFromLbug('', 10);
      expect(results).toEqual([]);
    });

    it('returns empty array for whitespace-only query', async () => {
      const results = await searchFTSFromLbug('   ', 10);
      expect(results).toEqual([]);
    });

    it('handles special characters in query gracefully', async () => {
      const results = await searchFTSFromLbug('user* OR auth+', 10);
      expect(Array.isArray(results)).toBe(true);
    });

    it('handles limit of 0', async () => {
      const results = await searchFTSFromLbug('user authentication', 0);
      expect(results).toEqual([]);
    });

    it('handles negative limit gracefully', async () => {
      const results = await searchFTSFromLbug('user authentication', -1);
      expect(Array.isArray(results)).toBe(true);
    });

    it('handles very large limit', async () => {
      const results = await searchFTSFromLbug('user authentication', 100000);
      expect(results.length).toBeLessThanOrEqual(100000);
      expect(results.length).toBeGreaterThan(0);
    });
  });
}, {
  seed: SEARCH_SEED_DATA,
  ftsIndexes: SEARCH_FTS_INDEXES,
});
