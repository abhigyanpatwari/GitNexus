import { describe, it, expect } from 'vitest';
import { getEmbeddingDims, isEmbedderReady } from '../../src/mcp/core/embedder.js';

describe('embedder', () => {
  describe('getEmbeddingDims', () => {
    it('returns 384 (MiniLM default)', () => {
      expect(getEmbeddingDims()).toBe(384);
    });
  });

  describe('isEmbedderReady', () => {
    it('returns false before initialization', () => {
      expect(isEmbedderReady()).toBe(false);
    });
  });
});
