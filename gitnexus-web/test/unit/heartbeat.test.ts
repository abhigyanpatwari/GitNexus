/**
 * `connectHeartbeat` runs on `streamSSE` (fetch + ReadableStream), not
 * `EventSource`, because `EventSource` cannot send custom headers and every
 * `/api/*` request needs `Authorization: Bearer <token>` to clear the public
 * edge's token gate.
 *
 * These tests pin the behavior `EventSource` used to provide for free —
 * indefinite reconnect with capped backoff, one "reconnecting" notification per
 * outage, teardown on cleanup — plus the two things the migration exists for:
 * the token header, and a 401 that recovers instead of giving up.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connectHeartbeat, setAuthToken } from '../../src/services/backend-client';

/** A live fake SSE connection, closable from the test. */
interface FakeConnection {
  /** End the stream cleanly — the client sees a drop and reconnects. */
  drop: () => void;
}

let connections: FakeConnection[] = [];
/** HTTP statuses to answer with, in order. Exhausted → 200. */
let statusQueue: number[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

/** Let pending promises settle without advancing the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  connections = [];
  statusQueue = [];
  setAuthToken('');

  fetchMock = vi.fn(async () => {
    const status = statusQueue.shift() ?? 200;
    if (status !== 200) return new Response('nope', { status });

    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        streamController = c;
        // The server's initial ":ok" comment — proves comments are tolerated.
        c.enqueue(new TextEncoder().encode(':ok\n\n'));
      },
    });
    connections.push({ drop: () => streamController.close() });
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  });

  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setAuthToken('');
});

describe('connectHeartbeat', () => {
  it('calls onConnect once the stream is readable', async () => {
    const onConnect = vi.fn();
    const onReconnecting = vi.fn();
    const cleanup = connectHeartbeat(onConnect, onReconnecting);

    await flush();

    expect(onConnect).toHaveBeenCalledOnce();
    expect(onReconnecting).not.toHaveBeenCalled();
    cleanup();
  });

  it('sends the access token as an Authorization header', async () => {
    setAuthToken('deploy-token-abc123');
    const cleanup = connectHeartbeat(vi.fn(), vi.fn());

    await flush();

    const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('Authorization')).toBe('Bearer deploy-token-abc123');
    cleanup();
  });

  it('sends no Authorization header on an ungated deploy', async () => {
    const cleanup = connectHeartbeat(vi.fn(), vi.fn());

    await flush();

    const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(headers.has('Authorization')).toBe(false);
    cleanup();
  });

  it('calls onReconnecting on first drop, then retries', async () => {
    const onConnect = vi.fn();
    const onReconnecting = vi.fn();
    const cleanup = connectHeartbeat(onConnect, onReconnecting);
    await flush();

    connections[0].drop();
    await flush();

    expect(onReconnecting).toHaveBeenCalledOnce();

    // Advance past the first retry delay (1s)
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('fires onReconnecting only once per outage', async () => {
    const onReconnecting = vi.fn();
    const cleanup = connectHeartbeat(vi.fn(), onReconnecting);
    await flush();

    // Every reconnect attempt answers 401 — the stream never reopens, so the
    // banner must not re-fire on each attempt.
    statusQueue = [401, 401, 401];
    connections[0].drop();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
    expect(onReconnecting).toHaveBeenCalledOnce();
    cleanup();
  });

  it('retries indefinitely instead of giving up after 3 attempts', async () => {
    const cleanup = connectHeartbeat(vi.fn(), vi.fn());
    await flush();

    for (let i = 0; i < 10; i++) {
      connections[i].drop();
      // Advance past the max backoff (15s) so the next attempt always fires
      await vi.advanceTimersByTimeAsync(16_000);
    }

    // 1 initial connection + 10 reconnects
    expect(fetchMock).toHaveBeenCalledTimes(11);
    cleanup();
  });

  it('reconnects after a 401 so a token entered later recovers the stream', async () => {
    const onConnect = vi.fn();
    const onReconnecting = vi.fn();
    const cleanup = connectHeartbeat(onConnect, onReconnecting);
    await flush();
    expect(onConnect).toHaveBeenCalledOnce();

    // The gate starts rejecting (token cleared / never entered)…
    statusQueue = [401, 401];
    connections[0].drop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onConnect).toHaveBeenCalledOnce();
    expect(onReconnecting).toHaveBeenCalledOnce();

    // …and once a valid token is in place the next attempt succeeds on its own.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(onConnect).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('resets reconnecting state when the connection recovers', async () => {
    const onConnect = vi.fn();
    const onReconnecting = vi.fn();
    const cleanup = connectHeartbeat(onConnect, onReconnecting);
    await flush();

    connections[0].drop();
    await flush();
    expect(onReconnecting).toHaveBeenCalledOnce();

    // Retry succeeds
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onConnect).toHaveBeenCalledTimes(2);

    // Drop again — a fresh outage notifies again
    connections[1].drop();
    await flush();
    expect(onReconnecting).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('caps backoff at 15 seconds', async () => {
    const cleanup = connectHeartbeat(vi.fn(), vi.fn());
    await flush();

    // Every attempt 401s, so nothing reopens and the retry counter keeps
    // climbing — the doubling backoff would reach 16s on the 5th retry.
    statusQueue = Array.from({ length: 10 }, () => 401);
    connections[0].drop();
    await flush();

    // Walk the uncapped part of the schedule exactly: 1s, 2s, 4s, 8s.
    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);

    // The next delay doubles to 16s, so the cap is what makes this retry fire
    // at 15s. Not a millisecond sooner, and not at 16s.
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    cleanup();
  });

  it('stops retrying when cleanup is called', async () => {
    const cleanup = connectHeartbeat(vi.fn(), vi.fn());
    await flush();

    connections[0].drop();
    await flush();
    cleanup();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
