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

/**
 * A 384d vector (matching the DIMS this file configures) whose values are exact
 * in float32 — the denominator is a power of two — so the `Float32Array`
 * round-trip through `httpEmbed` compares element-for-element with no epsilon.
 * `seed` distinguishes one vector from another.
 */
const vectorOf = (seed: number): number[] =>
  Array.from({ length: 384 }, (_, i) => (i + seed) / 512);

/**
 * A 200 whose *body* fails mid-read. undici wires the per-attempt signal
 * (`AbortSignal.any([caller, AbortSignal.timeout(...)])`) to the response's
 * `ReadableStream`, so a stalled body rejects `resp.json()` with the abort
 * reason — a real `DOMException`, not a parse error. Erroring the stream
 * reproduces that exactly, without a cast or a hand-rolled Response stub.
 */
const bodyThatFailsWith = (reason: unknown): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(reason);
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

function embeddingsBody(count: number): string {
  return JSON.stringify({
    data: Array.from({ length: count }, (_, i) => ({ embedding: vectorOf(i) })),
  });
}

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

  // ---------------------------------------------------------------------
  // A 200 carrying FEWER vectors than inputs is the same endpoint fault as a
  // truncated body — the JSON just happens to have survived the truncation.
  // `payload.data.every(isEmbeddingItem)` is vacuously true for `[]` and true
  // for any short array, so before the fix these bodies were classified
  // `success` (calling `breaker.recordSuccess()`, erasing the outage signal)
  // and only failed terminally in `httpEmbed`, after one attempt. #2790
  // ---------------------------------------------------------------------

  it.each([
    {
      label: 'an empty data array',
      vectors: 0,
      inputs: ['hello'],
      counts: '0 vectors for 1 texts',
    },
    {
      label: 'fewer vectors than inputs',
      vectors: 1,
      inputs: ['one', 'two', 'three'],
      counts: '1 vectors for 3 texts',
    },
  ])('retries a 200 carrying $label', async ({ vectors, inputs, counts }) => {
    configureEndpoint('short-body.example');
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response(embeddingsBody(vectors), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const { httpEmbed, isHttpEmbeddingError } =
      await import('../../src/core/embeddings/http-client.js');
    const err = await httpEmbed(inputs).catch((e: unknown) => e);
    expect(isHttpEmbeddingError(err)).toBe(true);
    // Its own message, naming both counts — distinct from the unparseable and
    // unexpected-shape wordings so the operator can tell the faults apart.
    expect(String(err)).toContain(counts);
    expect(String(err)).not.toContain('unparseable response');
    expect(String(err)).not.toContain('unexpected response shape');
    expect(calls).toBe(MAX_ATTEMPTS);
  });

  it('recovers when a short body is followed by a complete one', async () => {
    // Proves the short body is genuinely *retried*, not merely re-classified:
    // the second attempt's vectors are returned to the caller intact.
    configureEndpoint('short-then-whole.example');
    const scripted = [embeddingsBody(1), embeddingsBody(2)];
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      const body = scripted[calls] ?? embeddingsBody(2);
      calls += 1;
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const { httpEmbed } = await import('../../src/core/embeddings/http-client.js');
    const vectors = await httpEmbed(['one', 'two']);

    expect(calls).toBe(2);
    expect(vectors.map((v) => Array.from(v))).toEqual([vectorOf(0), vectorOf(1)]);
  });

  it('counts a persistently short 2xx as a breaker failure', async () => {
    // Same accounting shape as the HTML-body breaker case above: one attempt
    // per call, so three calls reach the default failureThreshold of 3 and the
    // fourth is refused without touching the network. A short body must not
    // reach `recordSuccess()` — that is what let a degraded endpoint keep the
    // breaker closed indefinitely.
    configureEndpoint('always-short.example');
    process.env.GITNEXUS_EMBEDDING_MAX_ATTEMPTS = '1';
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response(embeddingsBody(0), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const { httpEmbed, isHttpEmbeddingError } =
      await import('../../src/core/embeddings/http-client.js');
    await expect(httpEmbed(['one'])).rejects.toThrow(/0 vectors for 1 texts/u);
    await expect(httpEmbed(['two'])).rejects.toThrow(/0 vectors for 1 texts/u);
    await expect(httpEmbed(['three'])).rejects.toThrow(/0 vectors for 1 texts/u);
    expect(calls).toBe(3);

    const err = await httpEmbed(['four']).catch((e: unknown) => e);
    expect(isHttpEmbeddingError(err)).toBe(true);
    expect(String(err)).toContain('circuit open');
    expect(calls).toBe(3);
  });

  // ---------------------------------------------------------------------
  // Finding 7: the body read must not launder an abort into a retryable body
  // error. `resp.json()` rejects with the per-attempt signal's abort reason
  // when the body stalls, and wrapping that in the (plain-`Error`) sentinel
  // defeated `classifyOutcome`'s DOMException check — turning a
  // `terminal-network` outcome (1 attempt, `recordNeutral()`) into
  // `retryable-network` (MAX_ATTEMPTS, `recordFailure()`) reported to the
  // operator as "unparseable response". #2790
  // ---------------------------------------------------------------------

  it('does not retry a body-phase timeout, and reports it as a timeout', async () => {
    configureEndpoint('stalled-body.example');
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return bodyThatFailsWith(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      );
    });

    const { httpEmbed, isHttpEmbeddingError } =
      await import('../../src/core/embeddings/http-client.js');
    const err = await httpEmbed(['hello']).catch((e: unknown) => e);
    expect(isHttpEmbeddingError(err)).toBe(true);
    // Same error raised from `fetch()` itself already produced this call count
    // and this message; where it is raised must not change either.
    expect(calls).toBe(1);
    expect(String(err)).toContain('timed out');
    expect(String(err)).not.toContain('unparseable response');
  });

  it('reports a body-phase abort from the caller signal as a cancellation', async () => {
    // `AbortSignal.any` adopts the caller's reason, so a caller-driven cancel
    // surfaces as `AbortError` (not `TimeoutError`) even mid-body — and must
    // still reach the outer catch's "cancelled" branch, which the pipeline
    // keys on to tell a cancel apart from a tolerable sub-batch failure.
    configureEndpoint('cancelled-body.example');
    const controller = new AbortController();
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      controller.abort();
      return bodyThatFailsWith(new DOMException('This operation was aborted', 'AbortError'));
    });

    const { httpEmbed, isHttpEmbeddingError } =
      await import('../../src/core/embeddings/http-client.js');
    const err = await httpEmbed(['hello'], { signal: controller.signal }).catch((e: unknown) => e);
    expect(isHttpEmbeddingError(err)).toBe(true);
    expect(String(err)).toContain('cancelled');
    expect(String(err)).not.toContain('unparseable response');
    expect(calls).toBe(1);
  });

  // ---------------------------------------------------------------------
  // Security fence. The sentinel deliberately carries the operator-facing text
  // in `terminalMessage` and keeps the underlying parse error in `cause` only,
  // because undici's SyntaxError echoes a prefix of the raw body — text a
  // captive portal or a wrong service controls. Every other test here asserts
  // only what the message *contains*, so appending `err.message` (or the body)
  // to the sentinel message would pass them all while leaking to stderr.
  // ---------------------------------------------------------------------

  it.each([
    {
      label: 'an HTML error page',
      body: '<html><body>502 Bad Gateway</body></html>',
      // undici: `Unexpected token '<', "<html><bod"... is not valid JSON`.
      leaks: ['<html>', 'Bad Gateway'],
    },
    {
      label: 'truncated JSON',
      body: '{"data": [{"embedding": [0.1234567, 0.7654321',
      leaks: ['0.1234567', '"embedding"'],
    },
  ])('keeps the raw 200 body ($label) out of the error text', async ({ body, leaks }) => {
    configureEndpoint('leaky-body.example');
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const { httpEmbed } = await import('../../src/core/embeddings/http-client.js');
    const err = await httpEmbed(['hello']).catch((e: unknown) => e);
    expect(String(err)).toContain('unparseable response');
    expect(leaks.filter((leak) => String(err).includes(leak))).toEqual([]);
  });
});
