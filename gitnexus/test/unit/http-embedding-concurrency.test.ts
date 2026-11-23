import { afterEach, expect, it, vi } from 'vitest';
import { getBreaker } from 'gitnexus-shared';
import { __resetBreakerRegistry__ } from 'gitnexus-shared/test-helpers';
import { httpEmbed, httpEmbeddingConcurrency } from '../../src/core/embeddings/http-client.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  __resetBreakerRegistry__();
});

it.each([
  [undefined, 4],
  ['', 4],
  ['1', 1],
  ['4', 4],
  ['64', 64],
])('parses HTTP concurrency %s as %i', (value, expected) => {
  vi.stubEnv('GITNEXUS_EMBEDDING_CONCURRENCY', value);
  expect(httpEmbeddingConcurrency()).toBe(expected);
});

it.each(['0', '65', 'abc', '-1', '1.5', ' 4', '9007199254740992'])(
  'rejects invalid HTTP concurrency %s',
  (value) => {
    vi.stubEnv('GITNEXUS_EMBEDDING_CONCURRENCY', value);
    expect(httpEmbeddingConcurrency).toThrow('GITNEXUS_EMBEDDING_CONCURRENCY');
  },
);

it('waits for the half-open probe before admitting concurrent HTTP peers', async () => {
  vi.useFakeTimers();
  vi.stubEnv('GITNEXUS_EMBEDDING_URL', 'http://embedding.test/v1');
  vi.stubEnv('GITNEXUS_EMBEDDING_MODEL', 'fixture');
  vi.stubEnv('GITNEXUS_EMBEDDING_DIMS', '1');
  let now = 0;
  const breaker = getBreaker('embeddings-http', { now: () => now });
  for (let i = 0; i < 3; i++) breaker.recordFailure();
  now = 31_000;
  let release!: () => void;
  const probe = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = vi.fn(async () => {
    await probe;
    return new Response(JSON.stringify({ data: [{ embedding: [1] }] }));
  });
  vi.stubGlobal('fetch', fetch);
  const requests = Array.from({ length: 4 }, () => httpEmbed(['input']));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await Promise.all(requests)).toEqual(
    Array.from({ length: 4 }, () => [Float32Array.of(1)]),
  );
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(breaker.getState()).toBe('closed');
});

it('cancels a peer waiting for the half-open probe without sending HTTP work', async () => {
  vi.useFakeTimers();
  vi.stubEnv('GITNEXUS_EMBEDDING_URL', 'http://embedding.test/v1');
  vi.stubEnv('GITNEXUS_EMBEDDING_MODEL', 'fixture');
  let now = 0;
  const breaker = getBreaker('embeddings-http', { now: () => now });
  for (let i = 0; i < 3; i++) breaker.recordFailure();
  now = 31_000;
  breaker.check();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  const request = httpEmbed(['input'], { signal: controller.signal });
  const rejected = expect(request).rejects.toThrow('cancelled');
  controller.abort();
  await rejected;
  expect(fetch).not.toHaveBeenCalled();
  expect(breaker.isProbeInFlight()).toBe(true);
});
