import { describe, it, expect, vi, afterEach } from 'vitest';
import { getEmbeddingDims, isEmbedderReady } from '../../src/mcp/core/embedder.js';

const ENV_KEYS = [
  'GITNEXUS_EMBEDDING_URL',
  'GITNEXUS_EMBEDDING_MODEL',
  'GITNEXUS_EMBEDDING_API_KEY',
  'GITNEXUS_EMBEDDING_DIMS',
  'GITNEXUS_EMBEDDING_MAX_ATTEMPTS',
  'GITNEXUS_EMBEDDING_RETRY_CAP_MS',
  'GITNEXUS_EMBEDDING_MIN_INTERVAL_MS',
] as const;

/** 384d mock vector matching the default schema dimensions. */
const mockVec = Array.from({ length: 384 }, (_, i) => i / 384);

describe('HTTP embedding backend', () => {
  // Save original env state before any test mutates it
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    vi.useRealTimers();
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

  it('fingerprints HTTP provider identity without confusing a model-only env with HTTP mode', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'https://user:secret@first.example/v1?token=hidden';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'shared-model-name';
    process.env.GITNEXUS_EMBEDDING_DIMS = '384';
    const { resolveEmbeddingIdentity } =
      await import('../../src/core/embeddings/embedding-identity.js');

    const first = resolveEmbeddingIdentity();
    process.env.GITNEXUS_EMBEDDING_URL = 'https://second.example/v1';
    const second = resolveEmbeddingIdentity();
    delete process.env.GITNEXUS_EMBEDDING_URL;
    const local = resolveEmbeddingIdentity();

    expect(first.provider).toMatch(/^http:[0-9a-f]{64}$/u);
    expect(first.provider).not.toContain('secret');
    expect(first.provider).not.toContain('hidden');
    expect(second.provider).not.toBe(first.provider);
    expect(local.provider).toBe('local');
    expect(local.model).not.toBe('shared-model-name');
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
      const { isHttpEmbeddingError } = await import('../../src/core/embeddings/http-client.js');
      const err = await embedText('test').catch((e: unknown) => e);
      expect(String(err)).toContain('500');
      // Type-completeness fence: a non-OK-status failure must stay classifiable
      // so the CLI routes it to the endpoint branch, not the HF branch (#2385).
      expect(isHttpEmbeddingError(err)).toBe(true);
    });

    it('classifies a terminal 4xx (404) as a typed endpoint error without retrying (#2385)', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      // The most common --embedding-base-url misconfiguration: wrong path -> 404,
      // bad key -> 401/403. resilientFetch returns a terminal 4xx (other than 429)
      // without retrying, so httpEmbedBatch's !resp.ok branch is the sole
      // classifier — distinct from 500 (ResilientFetchExhaustedError) and 429/503.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      const { isHttpEmbeddingError } = await import('../../src/core/embeddings/http-client.js');
      const err = await embedText('test').catch((e: unknown) => e);
      expect(String(err)).toContain('404');
      expect(isHttpEmbeddingError(err)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('classifies a reachable endpoint that returns a non-JSON 200 body', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      // A captive portal / wrong service answers 200 with HTML — resp.json() throws.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON at position 0');
          },
        }),
      );

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      const { isHttpEmbeddingError } = await import('../../src/core/embeddings/http-client.js');
      const err = await embedText('test').catch((e: unknown) => e);
      expect(isHttpEmbeddingError(err)).toBe(true);
      expect(String(err)).toContain('unparseable response');
    });

    it('surfaces a connection failure as a typed HttpEmbeddingError (the #2385 case)', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://127.0.0.1:1/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      // Node's undici throws `TypeError: fetch failed` on a terminal connect error.
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      const { isHttpEmbeddingError } = await import('../../src/core/embeddings/http-client.js');

      const err = await embedText('test').catch((e: unknown) => e);
      // The endpoint failure carries the type — no message-text matching needed.
      expect(isHttpEmbeddingError(err)).toBe(true);
      // The masked URL is preserved for the CLI message; no HuggingFace text.
      expect(String(err)).toContain('127.0.0.1:1');
      expect(String(err)).not.toMatch(/huggingface/i);
    });

    // A reachable-but-wrong endpoint can answer 200 with a well-formed outer array
    // whose items are malformed. The outer Array.isArray(data.data) guard passes;
    // without per-item validation these crash at new Float32Array(item.embedding)
    // (batch) / items[0].embedding (query) with a raw TypeError that escapes the
    // typed boundary — the exact #2385 stack-dump class. (#2385)
    it.each([
      { label: 'a null item', body: { data: [null] } },
      { label: 'an item with no embedding', body: { data: [{}] } },
      { label: 'an item whose embedding is not an array', body: { data: [{ embedding: 'nope' }] } },
    ])('types a malformed response item ($label) on the batch path', async ({ body }) => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      const { isHttpEmbeddingError } = await import('../../src/core/embeddings/http-client.js');
      const err = await embedText('test').catch((e: unknown) => e);
      expect(isHttpEmbeddingError(err)).toBe(true);
      expect(String(err)).toContain('unexpected response shape');
    });

    it('types a null item on the query path (httpEmbedQuery, #2385)', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [null] }) }),
      );

      const { httpEmbedQuery, isHttpEmbeddingError } =
        await import('../../src/core/embeddings/http-client.js');
      const err = await httpEmbedQuery('test').catch((e: unknown) => e);
      expect(isHttpEmbeddingError(err)).toBe(true);
      expect(String(err)).toContain('unexpected response shape');
    });

    it('excludes API key from error messages', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      const redactionProbeKey = 'test-api-key-redaction-check';
      process.env.GITNEXUS_EMBEDDING_API_KEY = redactionProbeKey;

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      try {
        await embedText('test');
      } catch (e: any) {
        expect(e.message).not.toContain(redactionProbeKey);
        expect(e.message).not.toContain('Authorization');
      }
    });

    it('scrubs credentials embedded in the endpoint URL from the error message (#2385)', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'https://user:secret@host.example/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      // undici rejects a credential-bearing URL at Request construction, echoing
      // the full URL (incl. user:secret) verbatim in err.message.
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockRejectedValue(
            new TypeError(
              'Request cannot be constructed from a URL that includes credentials: ' +
                'https://user:secret@host.example/v1/embeddings',
            ),
          ),
      );

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      const { isHttpEmbeddingError } = await import('../../src/core/embeddings/http-client.js');
      const err = await embedText('test').catch((e: unknown) => e);
      expect(isHttpEmbeddingError(err)).toBe(true);
      // The secret is gone; the masked host is retained so the message stays useful.
      expect(String(err)).not.toContain('secret');
      expect(String((err as Error & { cause?: unknown }).cause)).not.toContain('secret');
      expect(String(err)).toContain('host.example');
    });

    it('redacts the API key from both the message and diagnostic cause', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'https://host.example/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env.GITNEXUS_EMBEDDING_API_KEY = 'super-secret-key';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new TypeError('transport rejected super-secret-key')),
      );

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      const err = await embedText('test').catch((error: unknown) => error);
      expect(String(err)).not.toContain('super-secret-key');
      expect(String((err as Error & { cause?: unknown }).cause)).not.toContain('super-secret-key');
    });

    it('leaves a non-credential reason unchanged (no over-scrubbing)', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      const err = await embedText('test').catch((e: unknown) => e);
      expect(String(err)).toContain('fetch failed');
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
      const { isHttpEmbeddingError } = await import('../../src/core/embeddings/http-client.js');
      const err = await mod.embedQuery('test').catch((e: unknown) => e);
      expect(String(err)).toContain('empty response');
      // Type-completeness fence: this conversion must stay typed so the CLI
      // routes it to the endpoint branch, not the HF branch (#2385).
      expect(isHttpEmbeddingError(err)).toBe(true);
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
      const { isHttpEmbeddingError } = await import('../../src/core/embeddings/http-client.js');
      const err = await embedBatch(['text1', 'text2', 'text3']).catch((e: unknown) => e);
      expect(String(err)).toContain('1 vectors for 3 texts');
      // Type-completeness fence (#2385).
      expect(isHttpEmbeddingError(err)).toBe(true);
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
      const { isHttpEmbeddingError } = await import('../../src/core/embeddings/http-client.js');
      const err = await embedText('test').catch((e: unknown) => e);
      expect(String(err)).toContain('Embedding dimension mismatch');
      // Type-completeness fence (#2385).
      expect(isHttpEmbeddingError(err)).toBe(true);
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
      const { isHttpEmbeddingError } = await import('../../src/core/embeddings/http-client.js');
      const err = await embedText('test').catch((e: unknown) => e);
      expect(String(err)).toContain('timed out');
      // Type-completeness fence: a timeout must stay classifiable (#2385).
      expect(isHttpEmbeddingError(err)).toBe(true);
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

    it('honors the configured total attempt bound', async () => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env.GITNEXUS_EMBEDDING_MAX_ATTEMPTS = '1';
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      await expect(embedText('test')).rejects.toThrow('503');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('caps Retry-After with the configured retry cap', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env.GITNEXUS_EMBEDDING_MAX_ATTEMPTS = '2';
      process.env.GITNEXUS_EMBEDDING_RETRY_CAP_MS = '2500';
      const ok = { ok: true, json: async () => ({ data: [{ embedding: mockVec }] }) };
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(
            new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }),
          )
          .mockResolvedValueOnce(ok),
      );

      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      const promise = embedText('test');
      await vi.advanceTimersByTimeAsync(2499);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toBeInstanceOf(Float32Array);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('paces retries and successful batches through one minimum-interval queue', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env.GITNEXUS_EMBEDDING_MAX_ATTEMPTS = '2';
      process.env.GITNEXUS_EMBEDDING_RETRY_CAP_MS = '1';
      process.env.GITNEXUS_EMBEDDING_MIN_INTERVAL_MS = '1000';
      const makeResp = (count: number) => ({
        ok: true,
        json: async () => ({ data: Array.from({ length: count }, () => ({ embedding: mockVec })) }),
      });
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({ ok: false, status: 503 })
          .mockResolvedValueOnce(makeResp(64))
          .mockResolvedValueOnce(makeResp(6)),
      );

      const { embedBatch } = await import('../../src/core/embeddings/embedder.js');
      const promise = embedBatch(Array.from({ length: 70 }, (_, i) => `text ${i}`));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toHaveLength(70);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('cancels promptly while waiting for retry backoff', async () => {
      vi.useFakeTimers();
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env.GITNEXUS_EMBEDDING_MAX_ATTEMPTS = '3';
      process.env.GITNEXUS_EMBEDDING_RETRY_CAP_MS = '60000';
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '60' } })),
      );
      const controller = new AbortController();

      const { embedBatch } = await import('../../src/core/embeddings/embedder.js');
      const promise = embedBatch(['test'], { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(1);
      controller.abort();
      await expect(promise).rejects.toThrow(/cancelled/i);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['GITNEXUS_EMBEDDING_MAX_ATTEMPTS', '0'],
      ['GITNEXUS_EMBEDDING_RETRY_CAP_MS', '-1'],
      ['GITNEXUS_EMBEDDING_MIN_INTERVAL_MS', 'nope'],
    ])('rejects malformed resilience config %s=%s', async (key, value) => {
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env[key] = value;
      const { embedText } = await import('../../src/core/embeddings/embedder.js');
      await expect(embedText('test')).rejects.toThrow(key);
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
      const { isHttpEmbeddingError } = await import('../../src/core/embeddings/http-client.js');
      const err = await mod.embedQuery('test').catch((e: unknown) => e);
      expect(String(err)).toContain('dimension mismatch');
      // Type-completeness fence: the query-path conversion must stay typed (#2385).
      expect(isHttpEmbeddingError(err)).toBe(true);
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

describe('HttpEmbeddingError classification', () => {
  it('recognises an HttpEmbeddingError instance', async () => {
    const { HttpEmbeddingError, isHttpEmbeddingError } =
      await import('../../src/core/embeddings/http-client.js');
    expect(isHttpEmbeddingError(new HttpEmbeddingError('anything at all'))).toBe(true);
  });

  it('recognises a cross-realm error by name even when instanceof fails', async () => {
    const { isHttpEmbeddingError } = await import('../../src/core/embeddings/http-client.js');
    // Simulates an error that crossed a module boundary and lost its prototype
    // chain: instanceof would be false, but the stable `name` still identifies it.
    const crossRealm = new Error('endpoint down');
    crossRealm.name = 'HttpEmbeddingError';
    expect(isHttpEmbeddingError(crossRealm)).toBe(true);
  });

  it.each([
    new Error('TypeError: fetch failed'),
    new Error('Failed to download embedding model'),
    new Error('connect ECONNREFUSED 127.0.0.1:443'),
    'not even an error',
    undefined,
  ])('does not claim non-endpoint value: %s', async (value) => {
    const { isHttpEmbeddingError } = await import('../../src/core/embeddings/http-client.js');
    expect(isHttpEmbeddingError(value)).toBe(false);
  });
});

describe('HTTP mode config probe (#2385)', () => {
  const ENV_KEYS = [
    'GITNEXUS_EMBEDDING_URL',
    'GITNEXUS_EMBEDDING_MODEL',
    'GITNEXUS_EMBEDDING_DIMS',
  ] as const;
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('isHttpMode() is a presence probe that does NOT throw on a malformed DIMS', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
    process.env.GITNEXUS_EMBEDDING_DIMS = '1024abc';

    const { isHttpMode } = await import('../../src/core/embeddings/http-client.js');
    // Root-cause fix: the mode probe must not validate DIMS, so ~13 unguarded
    // call sites (analyze:1109, doctor, run-analyze, embedder, mcp) don't crash.
    expect(isHttpMode()).toBe(true);
  });

  it('surfaces a malformed DIMS as a recognizable plain config error, not an endpoint error', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
    process.env.GITNEXUS_EMBEDDING_DIMS = '1024abc';

    const { embedText } = await import('../../src/core/embeddings/embedder.js');
    const { isHttpEmbeddingDimsError, isHttpEmbeddingError } =
      await import('../../src/core/embeddings/http-client.js');
    const err = await embedText('test').catch((e: unknown) => e);
    // Validated where it's used (readConfig in httpEmbed) and recognizable...
    expect(isHttpEmbeddingDimsError(String(err))).toBe(true);
    // ...as a plain config Error, NOT an HttpEmbeddingError endpoint failure.
    expect(isHttpEmbeddingError(err)).toBe(false);
  });
});
