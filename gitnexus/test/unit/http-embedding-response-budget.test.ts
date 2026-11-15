import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function client() {
  vi.stubEnv('GITNEXUS_EMBEDDING_URL', 'https://budget.example/v1');
  vi.stubEnv('GITNEXUS_EMBEDDING_MODEL', 'test-model');
  vi.stubEnv('GITNEXUS_EMBEDDING_DIMS', '4');
  vi.stubEnv('GITNEXUS_EMBEDDING_MAX_ATTEMPTS', '1');
  return (await import('../../src/core/embeddings/http-client.js')).httpEmbed;
}

describe('bounded HTTP embedding responses', () => {
  it('preserves vectors when the JSON arrives across one-byte UTF-8 chunks', async () => {
    const embed = await client();
    const body = Buffer.from(
      JSON.stringify({ data: [{ embedding: [0.25, 0.5, 0.75, 1] }], model: '漢😀' }),
    );
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of body) controller.enqueue(new Uint8Array([byte]));
              controller.close();
            },
          }),
        ),
    );
    const result = await embed(['text'], { maxResponseBytes: body.byteLength });
    expect(Array.from(result[0])).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it.each([undefined, '1'])(
    'cancels an oversized stream with content-length %s',
    async (length) => {
      const embed = await client();
      const cancel = vi.fn();
      let pulls = 0;
      vi.stubGlobal(
        'fetch',
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                pulls++;
                controller.enqueue(new Uint8Array(32));
              },
              cancel,
            }),
            { headers: length === undefined ? {} : { 'content-length': length } },
          ),
      );
      await expect(embed(['text'], { maxResponseBytes: 64 })).rejects.toThrow(
        '64-byte response budget',
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(pulls).toBeLessThanOrEqual(4);
    },
  );

  it('refuses an oversized declared body before reading or decoding it', async () => {
    const embed = await client();
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { 'content-length': '1000000000' },
        }),
    );
    await expect(embed(['text'], { maxResponseBytes: 64 })).rejects.toThrow(
      '64-byte response budget',
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not retry a deterministic response-budget violation', async () => {
    const embed = await client();
    vi.stubEnv('GITNEXUS_EMBEDDING_MAX_ATTEMPTS', '3');
    const fetch = vi.fn(
      async () => new Response('x'.repeat(100), { headers: { 'content-length': '100' } }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(embed(['text'], { maxResponseBytes: 64 })).rejects.toThrow(
      '64-byte response budget',
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('retains the existing body retry behavior under the byte limit', async () => {
    const embed = await client();
    vi.stubEnv('GITNEXUS_EMBEDDING_MAX_ATTEMPTS', '2');
    vi.stubEnv('GITNEXUS_EMBEDDING_RETRY_CAP_MS', '1');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"data":'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] })));
    vi.stubGlobal('fetch', fetch);
    expect(Array.from((await embed(['text'], { maxResponseBytes: 1024 }))[0])).toEqual([
      1, 0, 0, 0,
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, NaN, Infinity, 1.5])(
    'rejects invalid budget %s before fetching',
    async (maximum) => {
      const embed = await client();
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await expect(embed(['text'], { maxResponseBytes: maximum })).rejects.toThrow(
        'Invalid embedding response',
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
