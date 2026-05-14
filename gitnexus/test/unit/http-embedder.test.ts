import { describe, it, expect, vi, afterEach } from 'vitest';
import { getEmbeddingDims, isEmbedderReady } from '../../src/mcp/core/embedder.js';

const ENV_KEYS = [
  'GITNEXUS_EMBEDDING_URL',
  'GITNEXUS_EMBEDDING_MODEL',
  'GITNEXUS_EMBEDDING_API_KEY',
  'GITNEXUS_EMBEDDING_DIMS',
] as const;

/** 384d mock vector matching the default schema dimensions. */
const mockVec = Array.from({ length: 384 }, (_, i) => i / 384);

describe('HTTP embedding backend', () => {
  // Save original env state before any test mutates it
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    // Restore env vars to pre-test state so a mid-test throw can't leak
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  describe('MCP embedder', () => {
    it('returns 384 dimensions by default', () => {
      expect(getEmbeddingDims()).toBe(384);
    });

    it('returns false before initialization', () => {
      expect(isEmbedderReady()).toBe(false);
    });

    it('returns true when HTTP environment variables are set', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://localhost:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      const mod = await import('../../src/mcp/core/embedder.js');
      expect(mod.isEmbedderReady()).toBe(true);
    });

    it('reads custom dimensions from environment', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://localhost:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env.GITNEXUS_EMBEDDING_DIMS = '1024';
      const mod = await import('../../src/mcp/core/embedder.js');
      expect(mod.getEmbeddingDims()).toBe(1024);
    });

    it('retries query on transient server error', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';

      const ok = { ok: true, json: async () => ({ data: [{ embedding: mockVec }] }) };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce(ok),
      );

      const mod = await import('../../src/mcp/core/embedder.js');
      const result = await mod.embedQuery('test query');

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result).toEqual(mockVec);
    });
  });

  describe('core embedder HTTP path', () => {
    it('sends correct request payload', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env.GITNEXUS_EMBEDDING_API_KEY = 'test-key';

      const mockEmbedding = Array.from({ length: 384 }, (_, i) => i * 0.001);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: [{ embedding: mockEmbedding }] }),
        }),
      );

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      const result = await embedText('test text');

      expect(fetch).toHaveBeenCalledOnce();
      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body.model).toBe('test-model');
      expect(body.input).toEqual(['test text']);
      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(384);
    });

    it('omits dimensions from request body when GITNEXUS_EMBEDDING_DIMS is unset', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      // GITNEXUS_EMBEDDING_DIMS intentionally unset

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: [{ embedding: mockVec }] }),
        }),
      );

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      await embedText('test text');

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      // Backends that reject unknown fields must see the pre-existing
      // request shape. The field must be absent, not `undefined`.
      expect('dimensions' in body).toBe(false);
    });

    it('forwards GITNEXUS_EMBEDDING_DIMS as dimensions in request body', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'text-embedding-3-large';
      process.env.GITNEXUS_EMBEDDING_DIMS = '1024';

      const vec1024 = Array.from({ length: 1024 }, (_, i) => i / 1024);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: [{ embedding: vec1024 }] }),
        }),
      );

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      const result = await embedText('test text');

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body.dimensions).toBe(1024);
      expect(body.model).toBe('text-embedding-3-large');
      expect(result.length).toBe(1024);
    });

    it('forwards dimensions on the single-query path', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'text-embedding-3-large';
      process.env.GITNEXUS_EMBEDDING_DIMS = '512';

      const vec512 = Array.from({ length: 512 }, (_, i) => i / 512);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: [{ embedding: vec512 }] }),
        }),
      );

      const mod = await import('../../src/mcp/core/embedder.js');
      const result = await mod.embedQuery('query text');

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body.dimensions).toBe(512);
      expect(result.length).toBe(512);
    });

    it('retries on server error', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';

      const ok = { ok: true, json: async () => ({ data: [{ embedding: mockVec }] }) };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce(ok),
      );

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      await embedText('test');
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('retries on rate limit', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';

      const ok = { ok: true, json: async () => ({ data: [{ embedding: mockVec }] }) };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({ ok: false, status: 429 }).mockResolvedValueOnce(ok),
      );

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      await embedText('test');
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('throws when all retries are exhausted', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      await expect(embedText('test')).rejects.toThrow('500');
    });

    it('excludes API key from error messages', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env.GITNEXUS_EMBEDDING_API_KEY = 'secret-key-12345';

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      try {
        await embedText('test');
      } catch (e: any) {
        expect(e.message).not.toContain('secret-key-12345');
        expect(e.message).not.toContain('Authorization');
      }
    });

    it('includes abort signal for timeout', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: [{ embedding: mockVec }] }),
        }),
      );

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      await embedText('test');

      const opts = (fetch as any).mock.calls[0][1];
      expect(opts.signal).toBeDefined();
    });

    it('splits large inputs into batches', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';

      const makeResp = (n: number) => ({
        ok: true,
        json: async () => ({ data: Array.from({ length: n }, () => ({ embedding: mockVec })) }),
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(makeResp(64)).mockResolvedValueOnce(makeResp(6)),
      );

      const { embedBatch } = await import('../../src/core/embeddings/embedder.js');
      const results = await embedBatch(Array.from({ length: 70 }, (_, i) => `text ${i}`));

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(70);
    });

    it('forwards dimensions in every batch when splitting large inputs', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env.GITNEXUS_EMBEDDING_DIMS = '512';

      const vec512 = Array.from({ length: 512 }, (_, i) => i / 512);
      const makeResp = (n: number) => ({
        ok: true,
        json: async () => ({ data: Array.from({ length: n }, () => ({ embedding: vec512 })) }),
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(makeResp(64)).mockResolvedValueOnce(makeResp(6)),
      );

      const { embedBatch } = await import('../../src/core/embeddings/embedder.js');
      const results = await embedBatch(Array.from({ length: 70 }, (_, i) => `text ${i}`));

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(70);

      // Verify dimensions is sent in BOTH batch requests
      const body0 = JSON.parse((fetch as any).mock.calls[0][1].body);
      const body1 = JSON.parse((fetch as any).mock.calls[1][1].body);
      expect(body0.dimensions).toBe(512);
      expect(body1.dimensions).toBe(512);
    });

    it('rejects non-numeric GITNEXUS_EMBEDDING_DIMS values', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env.GITNEXUS_EMBEDDING_DIMS = '1024abc';

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: [{ embedding: mockVec }] }),
        }),
      );

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      await expect(embedText('test')).rejects.toThrow('must be a positive integer');
    });

    it('rejects initEmbedder when using HTTP backend', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';

      const { initEmbedder } = await import('../../src/core/embeddings/embedder.js');
      await expect(initEmbedder()).rejects.toThrow('HTTP mode');
    });

    it('rejects getEmbedder when using HTTP backend', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';

      const { getEmbedder } = await import('../../src/core/embeddings/embedder.js');
      expect(() => getEmbedder()).toThrow('HTTP embedding mode');
    });

    it('throws on empty response from endpoint', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: [] }),
        }),
      );

      const mod = await import('../../src/mcp/core/embedder.js');
      await expect(mod.embedQuery('test')).rejects.toThrow('empty response');
    });

    it('throws when endpoint returns fewer embeddings than texts', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: [{ embedding: mockVec }] }),
        }),
      );

      const { embedBatch } = await import('../../src/core/embeddings/embedder.js');
      await expect(embedBatch(['text1', 'text2', 'text3'])).rejects.toThrow(
        '1 vectors for 3 texts',
      );
    });

    it('throws on dimension mismatch when GITNEXUS_EMBEDDING_DIMS is set', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env.GITNEXUS_EMBEDDING_DIMS = '512';

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
        }),
      );

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      await expect(embedText('test')).rejects.toThrow('Embedding dimension mismatch');
    });
  });

  describe('schema dimensions', () => {
    it('defaults to 384 dimensions', async () => {
      const { EMBEDDING_DIMS } = await import('../../src/core/lbug/schema.js');
      expect(EMBEDDING_DIMS).toBe(384);
    });

    it('reads dimensions from environment variable', async () => {
      process.env.GITNEXUS_EMBEDDING_DIMS = '1024';
      const { EMBEDDING_DIMS } = await import('../../src/core/lbug/schema.js');
      expect(EMBEDDING_DIMS).toBe(1024);
    });
  });

  describe('timeout and network error handling', () => {
    it('does not retry on timeout', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';

      const timeoutErr = new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      );
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutErr));

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      await expect(embedText('test')).rejects.toThrow('timed out');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('retries on network error then succeeds', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';

      const ok = { ok: true, json: async () => ({ data: [{ embedding: mockVec }] }) };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(ok),
      );

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      const result = await embedText('test');
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result).toBeInstanceOf(Float32Array);
    });
  });

  describe('dimension mismatch on query path', () => {
    it('throws on explicit dim mismatch in embedQuery', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env.GITNEXUS_EMBEDDING_DIMS = '512';

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: [{ embedding: mockVec }] }),
        }),
      );

      const mod = await import('../../src/mcp/core/embedder.js');
      await expect(mod.embedQuery('test')).rejects.toThrow('dimension mismatch');
    });

    it('throws with Set hint when GITNEXUS_EMBEDDING_DIMS is unset', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';

      const vec768 = Array.from({ length: 768 }, (_, i) => i / 768);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: [{ embedding: vec768 }] }),
        }),
      );

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      await expect(embedText('test')).rejects.toThrow('Set GITNEXUS_EMBEDDING_DIMS=768');
    });
  });
});
