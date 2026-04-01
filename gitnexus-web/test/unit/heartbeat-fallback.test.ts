import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectHeartbeat } from '../../src/services/backend-client';

const realEventSource = globalThis.EventSource;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

class ThrowingEventSource {
  constructor() {
    throw new Error('EventSource is unavailable in this test mode');
  }
  onopen: ((this: EventSource, ev: Event) => any) | null = null;
  onerror: ((this: EventSource, ev: Event) => any) | null = null;
  onmessage: ((this: EventSource, ev: MessageEvent) => any) | null = null;
  readyState = 2;
  url = '';
  withCredentials = false;
  close() {}
  addEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
  removeEventListener(): void {}
}

describe('connectHeartbeat fallback probe', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.EventSource = realEventSource;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  });

  it('does not overlap probe requests during polling fallback', async () => {
    globalThis.EventSource = ThrowingEventSource as unknown as typeof EventSource;

    let activeProbeCount = 0;
    let maxActiveProbeCount = 0;
    const fetchMock = vi.fn(async () => {
      activeProbeCount += 1;
      maxActiveProbeCount = Math.max(maxActiveProbeCount, activeProbeCount);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeProbeCount -= 1;
      return new Response('{}', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const intervalCallbacks: Array<() => void> = [];
    globalThis.setInterval = ((cb: TimerHandler) => {
      intervalCallbacks.push(cb as () => void);
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = vi.fn() as unknown as typeof clearInterval;

    const onConnect = vi.fn();
    const onDisconnect = vi.fn();

    const cleanup = connectHeartbeat(onConnect, onDisconnect, {
      forcePollingFallback: true,
      maxProbeFailures: 99,
      probeIntervalMs: 1,
    });

    expect(onConnect).toHaveBeenCalledTimes(1);

    // Let immediate check start
    await new Promise((resolve) => setTimeout(resolve, 1));

    // Trigger multiple timer ticks while first probe is still in-flight
    intervalCallbacks.forEach((cb) => {
      cb();
      cb();
      cb();
    });

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(maxActiveProbeCount).toBe(1);
    cleanup();
  });

  it('disconnects after configured number of failed probes', async () => {
    globalThis.EventSource = ThrowingEventSource as unknown as typeof EventSource;

    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const intervalCallbacks: Array<() => void> = [];
    globalThis.setInterval = ((cb: TimerHandler) => {
      intervalCallbacks.push(cb as () => void);
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = vi.fn() as unknown as typeof clearInterval;

    const onConnect = vi.fn();
    const onDisconnect = vi.fn();

    const cleanup = connectHeartbeat(onConnect, onDisconnect, {
      forcePollingFallback: true,
      maxProbeFailures: 2,
      probeIntervalMs: 1,
    });

    expect(onConnect).toHaveBeenCalledTimes(1);

    // Wait for immediate failed probe
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(onDisconnect).toHaveBeenCalledTimes(0);

    // Second failed probe should trigger disconnect
    intervalCallbacks.forEach((cb) => cb());
    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
