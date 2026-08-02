/**
 * Regression tests for issue #2790 — a 2xx embedding response carrying a body
 * this client cannot use (truncated JSON, an HTML error page, a wrong-shaped
 * payload) is the same class of endpoint failure as a 5xx and must get the same
 * bounded retry loop. Before the fix the body was parsed *after* `resilientFetch`
 * returned, so a 503 got three attempts while a garbage 200 got exactly one —
 * and the garbage 200 also called the circuit breaker's `recordSuccess()`,
 * erasing accumulated failure counts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const ENV_KEYS = [
  'GITNEXUS_EMBEDDING_URL',
  'GITNEXUS_EMBEDDING_MODEL',
  'GITNEXUS_EMBEDDING_API_KEY',
  'GITNEXUS_EMBEDDING_DIMS',
  'GITNEXUS_EMBEDDING_MAX_ATTEMPTS',
  'GITNEXUS_EMBEDDING_RETRY_CAP_MS',
  'GITNEXUS_EMBEDDING_MIN_INTERVAL_MS',
] as const;

const MAX_ATTEMPTS = 3;

function configureEndpoint(host: string): void {
  process.env.GITNEXUS_EMBEDDING_URL = `https://${host}/v1`;
  process.env.GITNEXUS_EMBEDDING_MODEL = 'repro-model';
  process.env.GITNEXUS_EMBEDDING_API_KEY = 'repro-key';
  process.env.GITNEXUS_EMBEDDING_DIMS = '384';
  process.env.GITNEXUS_EMBEDDING_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
  process.env.GITNEXUS_EMBEDDING_RETRY_CAP_MS = '1';
  process.env.GITNEXUS_EMBEDDING_MIN_INTERVAL_MS = '0';
}

describe('issue #2790: an unusable 2xx body retries like a 5xx', () => {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    vi.unstubAllGlobals();
    // The distinct per-case hostnames do NOT isolate the circuit breaker:
    // http-client.ts passes an explicit `breakerKey: 'embeddings-http'`, which
    // overrides resilientFetch's host+path `defaultBreakerKey`, so every case
    // here shares one breaker identity. What actually isolates them is this
    // `vi.resetModules()` — gitnexus-shared is a linked workspace package that
    // Vite processes rather than externalizes, so resetting the module graph
    // re-instantiates the module-level breaker registry Map with fresh,
    // closed breakers.
    vi.resetModules();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('retries a 5xx MAX_ATTEMPTS times', async () => {
    configureEndpoint('five-hundred.example');
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response('upstream boom', { status: 503 });
    });

    const { httpEmbed } = await import('../../src/core/embeddings/http-client.js');
    await expect(httpEmbed(['hello'])).rejects.toThrow(/returned 503/u);
    expect(calls).toBe(MAX_ATTEMPTS);
  });

  it('retries a 200 whose body fails to parse', async () => {
    configureEndpoint('truncated.example');
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      // Truncated JSON — exactly the failure mode reported in #2790.
      return new Response('{"data": [{"embedding": [0.1, 0.2', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const { httpEmbed, isHttpEmbeddingError } =
      await import('../../src/core/embeddings/http-client.js');
    const err = await httpEmbed(['hello']).catch((e: unknown) => e);
    expect(isHttpEmbeddingError(err)).toBe(true);
    expect(String(err)).toContain('unparseable response');
    expect(calls).toBe(MAX_ATTEMPTS);
  });

  it('retries a 200 HTML body', async () => {
    configureEndpoint('captive-portal.example');
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    });

    const { httpEmbed, isHttpEmbeddingError } =
      await import('../../src/core/embeddings/http-client.js');
    const err = await httpEmbed(['hello']).catch((e: unknown) => e);
    expect(isHttpEmbeddingError(err)).toBe(true);
    expect(String(err)).toContain('unparseable response');
    expect(calls).toBe(MAX_ATTEMPTS);
  });

  // Parseable JSON that isn't an embeddings payload is the same endpoint fault
  // as an unparseable one — a wrong service answering 200 — so the shape check
  // moved inside the retried callback too.
  it.each([
    { label: 'a null item', body: '{"data": [null]}' },
    { label: 'a non-array data field', body: '{"data": "nope"}' },
  ])('retries a 200 with an unexpected response shape ($label)', async ({ body }) => {
    configureEndpoint('wrong-service.example');
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const { httpEmbed, isHttpEmbeddingError } =
      await import('../../src/core/embeddings/http-client.js');
    const err = await httpEmbed(['hello']).catch((e: unknown) => e);
    expect(isHttpEmbeddingError(err)).toBe(true);
    expect(String(err)).toContain('unexpected response shape');
    expect(calls).toBe(MAX_ATTEMPTS);
  });

  it('still returns a terminal 4xx unparsed after a single attempt', async () => {
    // Ordering guarantee: the body read sits behind an `!resp.ok` early return
    // inside `fetchImpl`, so 4xx classification is untouched — no parse attempt,
    // no retry, and the status (not the body) drives the message.
    configureEndpoint('wrong-path.example');
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response('{"error": "no such route"', {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const { httpEmbed, isHttpEmbeddingError } =
      await import('../../src/core/embeddings/http-client.js');
    const err = await httpEmbed(['hello']).catch((e: unknown) => e);
    expect(isHttpEmbeddingError(err)).toBe(true);
    expect(String(err)).toContain('returned 404');
    expect(String(err)).not.toContain('unparseable response');
    expect(calls).toBe(1);
  });

  it('counts an unusable 2xx as a breaker failure instead of erasing the outage signal', async () => {
    configureEndpoint('flapping.example');
    // One attempt per call, so each `httpEmbed` contributes exactly one
    // breaker outcome and the default failureThreshold of 3 is reached on the
    // third call. Previously the garbage 200 in the middle called
    // `recordSuccess()`, resetting the counter — an endpoint alternating 5xx
    // and garbage 200 could never trip the breaker.
    process.env.GITNEXUS_EMBEDDING_MAX_ATTEMPTS = '1';
    const scripted = [
      () => new Response('upstream boom', { status: 503 }),
      () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 200 }),
      () => new Response('upstream boom', { status: 503 }),
    ];
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      const make = scripted[calls] ?? (() => new Response('upstream boom', { status: 503 }));
      calls += 1;
      return make();
    });

    const { httpEmbed, isHttpEmbeddingError } =
      await import('../../src/core/embeddings/http-client.js');
    await expect(httpEmbed(['one'])).rejects.toThrow(/returned 503/u);
    await expect(httpEmbed(['two'])).rejects.toThrow(/unparseable response/u);
    await expect(httpEmbed(['three'])).rejects.toThrow(/returned 503/u);
    expect(calls).toBe(3);

    const err = await httpEmbed(['four']).catch((e: unknown) => e);
    expect(isHttpEmbeddingError(err)).toBe(true);
    expect(String(err)).toContain('circuit open');
    // The breaker refused the call before `fetch` ran.
    expect(calls).toBe(3);
  });
});
