/**
 * Unit Tests: analyze embeddings auto-preserve (#109)
 *
 * `gitnexus analyze` previously dropped any existing embeddings when run
 * without `--embeddings`, which is the default for every agent-initiated
 * and post-commit-hook-initiated re-index. This suite covers the
 * preservation-predicate helper that gates the cache loader.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldPreserveExistingEmbeddings,
  shouldCacheEmbeddings,
} from '../../src/cli/analyze.js';

describe('analyze embeddings auto-preserve (#109)', () => {
  describe('shouldPreserveExistingEmbeddings', () => {
    it('preserves when existing meta has embeddings and no --force', () => {
      expect(
        shouldPreserveExistingEmbeddings(
          { stats: { embeddings: 50 } },
          { force: false },
        ),
      ).toBe(true);
    });

    it('preserves when --force is absent and --embeddings is absent', () => {
      // The headline case: silent re-index carries embeddings over.
      expect(
        shouldPreserveExistingEmbeddings(
          { stats: { embeddings: 1 } },
          {},
        ),
      ).toBe(true);
    });

    it('does NOT preserve when --force is set (explicit data-loss signal)', () => {
      expect(
        shouldPreserveExistingEmbeddings(
          { stats: { embeddings: 50 } },
          { force: true },
        ),
      ).toBe(false);
    });

    it('does NOT preserve when existing meta has zero embeddings', () => {
      // First-time index, no embeddings to preserve.
      expect(
        shouldPreserveExistingEmbeddings(
          { stats: { embeddings: 0 } },
          {},
        ),
      ).toBe(false);
    });

    it('does NOT preserve when existing meta is null', () => {
      expect(shouldPreserveExistingEmbeddings(null, {})).toBe(false);
    });

    it('does NOT preserve when existing meta is undefined', () => {
      expect(shouldPreserveExistingEmbeddings(undefined, {})).toBe(false);
    });

    it('does NOT preserve when stats.embeddings is undefined', () => {
      // Defensive: meta.json could be a partial object.
      expect(shouldPreserveExistingEmbeddings({ stats: {} }, {})).toBe(false);
    });

    it('does NOT preserve when stats is missing entirely', () => {
      expect(shouldPreserveExistingEmbeddings({}, {})).toBe(false);
    });

    it('does NOT crash when options is undefined', () => {
      expect(
        shouldPreserveExistingEmbeddings(
          { stats: { embeddings: 5 } },
          undefined,
        ),
      ).toBe(true);
    });
  });

  describe('shouldCacheEmbeddings', () => {
    it('returns true when user passes --embeddings (even with no existing)', () => {
      expect(shouldCacheEmbeddings(null, { embeddings: true })).toBe(true);
    });

    it('returns true when auto-preserve kicks in', () => {
      expect(
        shouldCacheEmbeddings(
          { stats: { embeddings: 5 } },
          {},
        ),
      ).toBe(true);
    });

    it('returns false when no existing embeddings and no --embeddings', () => {
      // Cold start: nothing to cache, nothing to load.
      expect(shouldCacheEmbeddings({ stats: { embeddings: 0 } }, {})).toBe(false);
    });

    it('returns false when --force drops existing and no --embeddings', () => {
      expect(
        shouldCacheEmbeddings(
          { stats: { embeddings: 50 } },
          { force: true },
        ),
      ).toBe(false);
    });

    it('returns true when --force AND --embeddings are both set', () => {
      // User wants a full rebuild with fresh embeddings.
      expect(
        shouldCacheEmbeddings(
          { stats: { embeddings: 50 } },
          { force: true, embeddings: true },
        ),
      ).toBe(true);
    });
  });
});
