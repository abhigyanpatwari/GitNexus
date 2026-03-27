import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  EMBEDDING_CACHE_VERSION,
  embeddingTextHash,
  createEmptyEmbeddingCache,
  loadEmbeddingCache,
  saveEmbeddingCache,
  deleteEmbeddingCache,
  type EmbeddingCache,
} from '../../src/storage/embedding-cache.js';

describe('embedding-cache', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-emb-cache-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('embeddingTextHash', () => {
    it('is deterministic', () => {
      expect(embeddingTextHash('Function: foo\nFile: bar.ts')).toBe(
        embeddingTextHash('Function: foo\nFile: bar.ts'),
      );
    });

    it('differs for different text', () => {
      expect(embeddingTextHash('Function: foo')).not.toBe(embeddingTextHash('Function: bar'));
    });

    it('returns a 64-char hex string', () => {
      expect(embeddingTextHash('test')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('createEmptyEmbeddingCache', () => {
    it('has correct version, dimensions, and modelId', () => {
      const cache = createEmptyEmbeddingCache(384, 'test-model');
      expect(cache.version).toBe(EMBEDDING_CACHE_VERSION);
      expect(cache.dimensions).toBe(384);
      expect(cache.modelId).toBe('test-model');
      expect(Object.keys(cache.entries)).toHaveLength(0);
    });
  });

  describe('loadEmbeddingCache', () => {
    it('returns null when file missing', async () => {
      const cache = await loadEmbeddingCache(tmpDir);
      expect(cache).toBeNull();
    });

    it('returns null when JSON is corrupt', async () => {
      await fs.writeFile(path.join(tmpDir, 'embedding-cache.json'), 'not json', 'utf-8');
      const cache = await loadEmbeddingCache(tmpDir);
      expect(cache).toBeNull();
    });

    it('returns null when version mismatches', async () => {
      const stale = { version: -1, dimensions: 384, modelId: 'm', entries: {} };
      await fs.writeFile(path.join(tmpDir, 'embedding-cache.json'), JSON.stringify(stale), 'utf-8');
      const cache = await loadEmbeddingCache(tmpDir);
      expect(cache).toBeNull();
    });

    it('loads valid cache', async () => {
      const valid: EmbeddingCache = {
        version: EMBEDDING_CACHE_VERSION,
        dimensions: 384,
        modelId: 'test-model',
        entries: { abc123: { embedding: [0.1, 0.2, 0.3] } },
      };
      await fs.writeFile(path.join(tmpDir, 'embedding-cache.json'), JSON.stringify(valid), 'utf-8');
      const cache = await loadEmbeddingCache(tmpDir);
      expect(cache).not.toBeNull();
      expect(cache!.entries['abc123'].embedding).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe('saveEmbeddingCache', () => {
    it('writes and loads back correctly', async () => {
      const cache: EmbeddingCache = {
        version: EMBEDDING_CACHE_VERSION,
        dimensions: 384,
        modelId: 'model-a',
        entries: { h1: { embedding: [1, 2, 3] } },
      };
      await saveEmbeddingCache(tmpDir, cache);
      const loaded = await loadEmbeddingCache(tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.modelId).toBe('model-a');
      expect(loaded!.entries['h1'].embedding).toEqual([1, 2, 3]);
    });

    it('creates directory if missing', async () => {
      const nested = path.join(tmpDir, 'deep', 'path');
      const cache = createEmptyEmbeddingCache(384, 'x');
      await saveEmbeddingCache(nested, cache);
      const loaded = await loadEmbeddingCache(nested);
      expect(loaded).not.toBeNull();
    });

    it('no temp file left behind', async () => {
      await saveEmbeddingCache(tmpDir, createEmptyEmbeddingCache(384, 'x'));
      const files = await fs.readdir(tmpDir);
      expect(files).not.toContain('embedding-cache.json.tmp');
      expect(files).toContain('embedding-cache.json');
    });
  });

  describe('deleteEmbeddingCache', () => {
    it('removes cache file', async () => {
      await saveEmbeddingCache(tmpDir, createEmptyEmbeddingCache(384, 'x'));
      await deleteEmbeddingCache(tmpDir);
      const files = await fs.readdir(tmpDir);
      expect(files).not.toContain('embedding-cache.json');
    });

    it('does not throw if file missing', async () => {
      await expect(deleteEmbeddingCache(tmpDir)).resolves.toBeUndefined();
    });
  });

  describe('model/dimension invalidation', () => {
    it('cache with different dimensions is treated as stale by caller', () => {
      const cache = createEmptyEmbeddingCache(384, 'model-a');
      cache.entries['h1'] = { embedding: [1, 2, 3] };

      // Simulate what analyze.ts does: check dimensions + modelId match
      const newDims = 768;
      const isValid = cache.dimensions === newDims && cache.modelId === 'model-a';
      expect(isValid).toBe(false);
    });

    it('cache with different model is treated as stale by caller', () => {
      const cache = createEmptyEmbeddingCache(384, 'model-a');
      cache.entries['h1'] = { embedding: [1, 2, 3] };

      const isValid = cache.dimensions === 384 && cache.modelId === 'model-b';
      expect(isValid).toBe(false);
    });

    it('cache with matching dimensions and model is valid', () => {
      const cache = createEmptyEmbeddingCache(384, 'model-a');
      cache.entries['h1'] = { embedding: [1, 2, 3] };

      const isValid = cache.dimensions === 384 && cache.modelId === 'model-a';
      expect(isValid).toBe(true);
    });
  });
});
