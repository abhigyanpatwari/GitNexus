/**
 * Deploy access token plumbing in backend-client.
 *
 * The public edge (`docker-server.mjs`) gates every `/api/*` request behind
 * `Authorization: Bearer <token>` and answers 401 with `{ code: 'unauthorized' }`
 * otherwise. These tests pin the three things that make the browser half work:
 * the header reaches every request path, an absent token sends no header at all,
 * and the token never lands anywhere but sessionStorage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetBreakerRegistry__ } from 'gitnexus-shared/test-helpers';
import {
  BackendError,
  fetchRepos,
  getAuthToken,
  probeBackendStatus,
  runQuery,
  setAuthToken,
  setBackendUrl,
  streamSSE,
} from '../../src/services/backend-client';
import { AUTH_TOKEN_STORAGE_KEY } from '../../src/config/ui-constants';

const BASE = 'http://localhost:4747';
const TOKEN = 'deploy-token-abc123';

/** Headers of the nth fetch call, normalized to a `Headers` instance. */
const headersOf = (fetchMock: ReturnType<typeof vi.fn>, call = 0): Headers =>
  new Headers((fetchMock.mock.calls[call]?.[1] as RequestInit | undefined)?.headers);

const jsonOk = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('backend-client access token', () => {
  beforeEach(() => {
    __resetBreakerRegistry__();
    setBackendUrl(BASE);
    setAuthToken('');
  });

  afterEach(() => {
    setAuthToken('');
    vi.unstubAllGlobals();
  });

  it('sends Authorization: Bearer <token> when a token is set', async () => {
    const fetchMock = vi.fn(async () => jsonOk([]));
    vi.stubGlobal('fetch', fetchMock);
    setAuthToken(TOKEN);

    await fetchRepos();

    expect(headersOf(fetchMock).get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('sends no Authorization header at all when no token is set', async () => {
    const fetchMock = vi.fn(async () => jsonOk([]));
    vi.stubGlobal('fetch', fetchMock);

    await fetchRepos();

    // Absent, not empty — an empty credential is malformed, not missing.
    expect(headersOf(fetchMock).has('Authorization')).toBe(false);
  });

  it('trims the token and treats a whitespace-only token as absent', async () => {
    const fetchMock = vi.fn(async () => jsonOk([]));
    vi.stubGlobal('fetch', fetchMock);

    setAuthToken(`  ${TOKEN}  `);
    await fetchRepos();
    expect(headersOf(fetchMock).get('Authorization')).toBe(`Bearer ${TOKEN}`);

    setAuthToken('   ');
    await fetchRepos();
    expect(headersOf(fetchMock, 1).has('Authorization')).toBe(false);
  });

  it("preserves a caller's own headers alongside Authorization", async () => {
    const fetchMock = vi.fn(async () => jsonOk({ result: [] }));
    vi.stubGlobal('fetch', fetchMock);
    setAuthToken(TOKEN);

    // runQuery passes `Content-Type: application/json` of its own — the
    // `Headers` merge has to keep both, which an object spread would not.
    await runQuery('MATCH (n) RETURN n');

    const headers = headersOf(fetchMock);
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('surfaces a 401 with code "unauthorized" as BackendError.code === "unauthorized"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'unauthorized', code: 'unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },
          }),
      ),
    );

    const error = await fetchRepos().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).code).toBe('unauthorized');
    expect((error as BackendError).status).toBe(401);
  });

  it('keeps a 401 without the discriminator as a generic client error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 })),
    );

    const error = await fetchRepos().catch((e: unknown) => e);
    expect((error as BackendError).code).toBe('client');
  });

  it('stores the token in sessionStorage and never in localStorage', () => {
    setAuthToken(TOKEN);

    expect(sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe(TOKEN);
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(getAuthToken()).toBe(TOKEN);

    setAuthToken('');
    expect(sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(getAuthToken()).toBe('');
  });

  describe('probeBackendStatus', () => {
    it('reports a 401 as unauthorized rather than plain unreachability', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 401 })),
      );

      await expect(probeBackendStatus()).resolves.toBe('unauthorized');
    });

    it('reports a genuinely absent backend as unreachable, not gated', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('fetch failed');
        }),
      );

      await expect(probeBackendStatus()).resolves.toBe('unreachable');
    });

    it('reports a 200 as ok', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonOk([])),
      );

      await expect(probeBackendStatus()).resolves.toBe('ok');
    });
  });

  describe('streamSSE', () => {
    /** A response body that emits `chunks` then closes the stream. */
    const sseResponse = (chunks: string[]) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            const encoder = new TextEncoder();
            for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
            c.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );

    it('sends the token, and keeps it alongside Last-Event-ID on reconnect', async () => {
      // First connection ends after one identified event, so the retry carries
      // `Last-Event-ID`. Both headers must be present on that second attempt.
      const fetchMock = vi.fn(async () => sseResponse(['id: 42\ndata: {"percent":10}\n\n']));
      vi.stubGlobal('fetch', fetchMock);
      setAuthToken(TOKEN);

      const controller = streamSSE(`${BASE}/api/analyze/j1/progress`, {}, { baseDelayMs: 0 });
      await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
      controller.abort();

      expect(headersOf(fetchMock).get('Authorization')).toBe(`Bearer ${TOKEN}`);
      expect(headersOf(fetchMock).has('Last-Event-ID')).toBe(false);

      const retryHeaders = headersOf(fetchMock, 1);
      expect(retryHeaders.get('Authorization')).toBe(`Bearer ${TOKEN}`);
      expect(retryHeaders.get('Last-Event-ID')).toBe('42');
    });

    it('sends no Authorization header when no token is set', async () => {
      const fetchMock = vi.fn(async () => sseResponse(['data: {"percent":10}\n\n']));
      vi.stubGlobal('fetch', fetchMock);

      const controller = streamSSE(`${BASE}/api/analyze/j1/progress`, {}, { maxRetries: 0 });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      controller.abort();

      expect(headersOf(fetchMock).has('Authorization')).toBe(false);
    });

    it('reports a non-OK response as an error and does not retry by default', async () => {
      const fetchMock = vi.fn(async () => new Response('nope', { status: 401 }));
      vi.stubGlobal('fetch', fetchMock);
      const onError = vi.fn();

      streamSSE(`${BASE}/api/analyze/j1/progress`, { onError }, { baseDelayMs: 0 });
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('Server returned 401'));
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('retries a non-OK response when retryOnHttpError is set', async () => {
      const fetchMock = vi.fn(async () => new Response('nope', { status: 401 }));
      vi.stubGlobal('fetch', fetchMock);
      const onError = vi.fn();

      const controller = streamSSE(
        `${BASE}/api/heartbeat`,
        { onError },
        { baseDelayMs: 0, maxRetries: 2, retryOnHttpError: true },
      );
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      controller.abort();

      // Budget spent → the caller finally hears about it.
      expect(onError).toHaveBeenCalledWith('Server returned 401');
    });
  });
});
