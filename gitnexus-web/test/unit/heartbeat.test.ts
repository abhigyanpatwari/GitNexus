import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connectHeartbeat } from '../../src/services/backend-client';

// Mock EventSource to simulate SSE behavior
class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  close() {
    this.closed = true;
  }
}

let lastEventSource: MockEventSource | null = null;

beforeEach(() => {
  lastEventSource = null;
  vi.stubGlobal(
    'EventSource',
    vi.fn().mockImplementation(() => {
      lastEventSource = new MockEventSource();
      return lastEventSource;
    }),
  );
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('connectHeartbeat', () => {
  it('calls onConnect when EventSource opens', () => {
    const onConnect = vi.fn();
    const onReconnecting = vi.fn();
    connectHeartbeat(onConnect, onReconnecting);

    lastEventSource!.onopen!();
    expect(onConnect).toHaveBeenCalledOnce();
    expect(onReconnecting).not.toHaveBeenCalled();
  });

  it('calls onReconnecting on first error, then retries', () => {
    const onConnect = vi.fn();
    const onReconnecting = vi.fn();
    connectHeartbeat(onConnect, onReconnecting);

    // Simulate connection drop
    lastEventSource!.onerror!();

    expect(onReconnecting).toHaveBeenCalledOnce();
    expect(lastEventSource!.closed).toBe(true);

    // Advance past first retry delay (1s)
    vi.advanceTimersByTime(1_000);

    // A new EventSource should have been created
    expect(EventSource).toHaveBeenCalledTimes(2);
  });

  it('fires onReconnecting only once per disconnect', () => {
    const onConnect = vi.fn();
    const onReconnecting = vi.fn();
    connectHeartbeat(onConnect, onReconnecting);

    // First error
    lastEventSource!.onerror!();
    expect(onReconnecting).toHaveBeenCalledOnce();

    // Second retry fires error again
    vi.advanceTimersByTime(1_000);
    lastEventSource!.onerror!();
    expect(onReconnecting).toHaveBeenCalledOnce(); // still 1

    // Third retry fires error
    vi.advanceTimersByTime(2_000);
    lastEventSource!.onerror!();
    expect(onReconnecting).toHaveBeenCalledOnce(); // still 1
  });

  it('retries indefinitely instead of giving up after 3 attempts', () => {
    const onConnect = vi.fn();
    const onReconnecting = vi.fn();
    connectHeartbeat(onConnect, onReconnecting);

    // Simulate 10 consecutive failures — should never stop retrying
    for (let i = 0; i < 10; i++) {
      lastEventSource!.onerror!();
      // Advance past the max backoff (15s) to ensure the next retry fires
      vi.advanceTimersByTime(16_000);
    }

    // Should have created 11 EventSources (1 initial + 10 retries)
    expect(EventSource).toHaveBeenCalledTimes(11);
  });

  it('resets reconnecting state when connection recovers', () => {
    const onConnect = vi.fn();
    const onReconnecting = vi.fn();
    connectHeartbeat(onConnect, onReconnecting);

    // Drop
    lastEventSource!.onerror!();
    expect(onReconnecting).toHaveBeenCalledOnce();

    // Retry succeeds
    vi.advanceTimersByTime(1_000);
    lastEventSource!.onopen!();
    expect(onConnect).toHaveBeenCalledOnce();

    // Drop again — should fire onReconnecting again (reset after recovery)
    lastEventSource!.onerror!();
    expect(onReconnecting).toHaveBeenCalledTimes(2);
  });

  it('caps backoff at 15 seconds', () => {
    const onConnect = vi.fn();
    const onReconnecting = vi.fn();
    connectHeartbeat(onConnect, onReconnecting);

    // Fail many times to push backoff past the cap
    for (let i = 0; i < 6; i++) {
      lastEventSource!.onerror!();
      // The delay for attempt i is min(1000 * 2^i, 15000)
      // i=0: 1s, i=1: 2s, i=2: 4s, i=3: 8s, i=4: 15s (capped), i=5: 15s (capped)
      vi.advanceTimersByTime(16_000);
    }

    // All retries should have fired — 7 EventSources total
    expect(EventSource).toHaveBeenCalledTimes(7);
  });

  it('stops retrying when cleanup is called', () => {
    const onConnect = vi.fn();
    const onReconnecting = vi.fn();
    const cleanup = connectHeartbeat(onConnect, onReconnecting);

    lastEventSource!.onerror!();
    cleanup();

    // Advance time — no new EventSource should be created
    vi.advanceTimersByTime(30_000);
    expect(EventSource).toHaveBeenCalledTimes(1);
  });
});
