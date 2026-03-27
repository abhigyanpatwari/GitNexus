import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  EMBEDDING_CACHE_VERSION,
  embeddingTextHash,
  createEmptyEmbeddingCache,
  loadEmbeddingCache,
  loadEmbeddingCacheMeta,
  validateEmbeddingCacheMeta,
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

  describe('loadEmbeddingCacheMeta', () => {
    it('returns null when no meta file', async () => {
      const meta = await loadEmbeddingCacheMeta(tmpDir);
      expect(meta).toBeNull();
    });

    it('returns null when version mismatches', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'embedding-cache-meta.json'),
        JSON.stringify({ version: -1, dimensions: 384, modelId: 'm' }),
        'utf-8',
      );
      expect(await loadEmbeddingCacheMeta(tmpDir)).toBeNull();
    });

    it('returns metadata when valid', async () => {
      const cache = createEmptyEmbeddingCache(384, 'model-a');
      cache.entries['h1'] = { embedding: [1, 2, 3] };
      await saveEmbeddingCache(tmpDir, cache);
      const meta = await loadEmbeddingCacheMeta(tmpDir);
      expect(meta).not.toBeNull();
      expect(meta!.dimensions).toBe(384);
      expect(meta!.modelId).toBe('model-a');
    });
  });

  describe('validateEmbeddingCacheMeta', () => {
    it('returns true for matching dimensions and model', () => {
      expect(validateEmbeddingCacheMeta(
        { version: EMBEDDING_CACHE_VERSION, dimensions: 384, modelId: 'a' },
        384, 'a',
      )).toBe(true);
    });

    it('returns false for mismatched dimensions', () => {
      expect(validateEmbeddingCacheMeta(
        { version: EMBEDDING_CACHE_VERSION, dimensions: 384, modelId: 'a' },
        768, 'a',
      )).toBe(false);
    });

    it('returns false for mismatched model', () => {
      expect(validateEmbeddingCacheMeta(
        { version: EMBEDDING_CACHE_VERSION, dimensions: 384, modelId: 'a' },
        384, 'b',
      )).toBe(false);
    });
  });

  describe('loadEmbeddingCache', () => {
    it('returns null when no files exist', async () => {
      const cache = await loadEmbeddingCache(tmpDir);
      expect(cache).toBeNull();
    });

    it('returns null when meta version mismatches', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'embedding-cache-meta.json'),
        JSON.stringify({ version: -1, dimensions: 384, modelId: 'm' }),
        'utf-8',
      );
      expect(await loadEmbeddingCache(tmpDir)).toBeNull();
    });

    it('loads valid cache', async () => {
      const cache: EmbeddingCache = {
        version: EMBEDDING_CACHE_VERSION,
        dimensions: 384,
        modelId: 'test-model',
        entries: { abc123: { embedding: [0.1, 0.2, 0.3] } },
      };
      await saveEmbeddingCache(tmpDir, cache);
      const loaded = await loadEmbeddingCache(tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.entries['abc123'].embedding).toEqual([0.1, 0.2, 0.3]);
      expect(loaded!.modelId).toBe('test-model');
      expect(loaded!.dimensions).toBe(384);
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

    it('writes meta and entries files', async () => {
      const cache: EmbeddingCache = {
        version: EMBEDDING_CACHE_VERSION,
        dimensions: 384,
        modelId: 'x',
        entries: { a1b2c3: { embedding: [1] } },
      };
      await saveEmbeddingCache(tmpDir, cache);
      const files = await fs.readdir(tmpDir);
      expect(files).toContain('embedding-cache-meta.json');
      expect(files).toContain('embedding-cache.json');
    });

    it('no temp files left behind', async () => {
      await saveEmbeddingCache(tmpDir, createEmptyEmbeddingCache(384, 'x'));
      const files = await fs.readdir(tmpDir);
      expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
    });
  });

  describe('deleteEmbeddingCache', () => {
    it('removes entries and meta files', async () => {
      await saveEmbeddingCache(tmpDir, createEmptyEmbeddingCache(384, 'x'));
      await deleteEmbeddingCache(tmpDir);
      const files = await fs.readdir(tmpDir);
      expect(files).not.toContain('embedding-cache.json');
      expect(files).not.toContain('embedding-cache-meta.json');
    });

    it('does not throw if nothing exists', async () => {
      await expect(deleteEmbeddingCache(tmpDir)).resolves.toBeUndefined();
    });
  });

  describe('model/dimension invalidation', () => {
    it('cache with different dimensions is treated as stale by validateEmbeddingCacheMeta', () => {
      const meta = { version: EMBEDDING_CACHE_VERSION, dimensions: 384, modelId: 'model-a' };
      expect(validateEmbeddingCacheMeta(meta, 768, 'model-a')).toBe(false);
    });

    it('cache with different model is treated as stale by validateEmbeddingCacheMeta', () => {
      const meta = { version: EMBEDDING_CACHE_VERSION, dimensions: 384, modelId: 'model-a' };
      expect(validateEmbeddingCacheMeta(meta, 384, 'model-b')).toBe(false);
    });

    it('cache with matching dimensions and model is valid', () => {
      const meta = { version: EMBEDDING_CACHE_VERSION, dimensions: 384, modelId: 'model-a' };
      expect(validateEmbeddingCacheMeta(meta, 384, 'model-a')).toBe(true);
    });
  });
});
