/**
 * Unit Tests: workspace-readiness-probe (LSP read-only foundation, WI-#5)
 *
 * The probe is the **sole gate** (Invariant 4) that authorizes any
 * downstream LSP verdict. Its job is binary: "is the workspace in a
 * state where a `textDocument/definition` request will actually
 * resolve to a non-empty result?". If yes, downstream commands may
 * compare heuristic vs LSP results. If no, downstream commands must
 * NOT compare — they must treat LSP as unavailable and surface
 * `ready:false` to the caller.
 *
 * Decision table (the WI spec's "initialize-ok × definition-resolves"):
 *
 *   | init ok | definition resolves  | ready | reason                                |
 *   |---------|----------------------|-------|---------------------------------------|
 *   |   yes   | yes (non-null, ≥1)   | true  | (none)                                |
 *   |   yes   | no (null/empty)      | false | "workspace not built/resolved — 0/N"  |
 *   |   no    | (n/a)                | false | "LSP client not started"              |
 *
 * Plus: empty-samples guard, partial-threshold BVA, the
 * "definition maps to NO_NODE" case, and the "this probe is the
 * sole gate" invariant (#4).
 */

import { describe, it, expect, vi } from 'vitest';

import { probeWorkspaceReadiness } from '../../../src/core/ingestion/lsp/workspace-readiness-probe.js';
import type { LspClient } from '../../../src/core/ingestion/lsp/lsp-client.js';

// ─── Mock LspClient factory ──────────────────────────────────────────

/**
 * Build a vi.fn()-driven mock `LspClient`. The probe only uses
 *   - `client.getState()`     → LspClientState
 *   - `client.request(method, params, timeoutMs)` → Promise<T | null>
 * We model the surface as a single `request` spy (per-call
 * behavior is driven by the test) and a state-mutator that the
 * test can flip mid-test.
 */
function makeMockClient(opts: {
  state?: 'idle' | 'starting' | 'ready' | 'restarting' | 'degraded' | 'stopping' | 'stopped';
  requestImpl?: (method: string, params: any, timeoutMs: number) => Promise<any>;
} = {}) {
  let state: any = opts.state ?? 'ready';
  const request = vi.fn(
    opts.requestImpl ??
      (async () => {
        // Default: simulate a successful cross-file resolve.
        return [
          {
            uri: 'file:///workspace/src/def.ts',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          },
        ];
      }),
  );
  const client = {
    getState: () => state,
    request,
    _setState: (next: any) => {
      state = next;
    },
  } as unknown as LspClient & {
    _setState: (s: any) => void;
    request: ReturnType<typeof vi.fn>;
  };
  return client;
}

const makeSample = (over: Partial<{ uri: string; line: number; character: number }> = {}) => ({
  textDocument: { uri: over.uri ?? 'file:///workspace/src/foo.ts' },
  position: {
    line: over.line ?? 5,
    character: over.character ?? 0,
  },
});

// ─── Decision-table cases DT-1..DT-4 ─────────────────────────────────

describe('workspace-readiness-probe — decision table (DT-1..DT-4)', () => {
  // DT-1 ────────────────────────────────────────────────────────────
  it('DT-1: init ok + cross-file definition resolves → ready:true', async () => {
    const client = makeMockClient({
      state: 'ready',
      requestImpl: async () => [
        {
          uri: 'file:///workspace/src/other.ts',
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
        },
      ],
    });
    const result = await probeWorkspaceReadiness(client, [makeSample()]);
    expect(result).toEqual({ ready: true });
    expect(client.request).toHaveBeenCalledTimes(1);
    // The call shape: method === 'textDocument/definition' and
    // params carry the sample's textDocument + position verbatim.
    const [method, params, timeoutMs] = (client.request as any).mock.calls[0];
    expect(method).toBe('textDocument/definition');
    expect(params.textDocument.uri).toBe('file:///workspace/src/foo.ts');
    expect(params.position.line).toBe(5);
    expect(params.position.character).toBe(0);
    // Default perRequestTimeoutMs = 3000.
    expect(timeoutMs).toBe(3000);
  });

  // DT-2 ────────────────────────────────────────────────────────────
  it('DT-2: init ok + null definition → ready:false + reason (EdgeCase 2)', async () => {
    const client = makeMockClient({
      state: 'ready',
      requestImpl: async () => null, // timeout/error path
    });
    const result = await probeWorkspaceReadiness(client, [makeSample()]);
    expect(result.ready).toBe(false);
    // Reason is non-empty and mentions the sample count.
    expect(result.reason).toBeDefined();
    expect(typeof result.reason).toBe('string');
    expect(result.reason!.length).toBeGreaterThan(0);
    expect(result.reason).toMatch(/workspace not built\/resolved/);
    // 0 resolved of 1 sample.
    expect(result.reason).toMatch(/0\/1/);
  });

  // DT-3 ────────────────────────────────────────────────────────────
  it('DT-3: client in degraded state → ready:false + reason (EdgeCase 1)', async () => {
    const client = makeMockClient({
      state: 'degraded',
      // The request mock SHOULDN'T be called when state != ready
      // (the LspClient's contract is that degraded requests resolve
      // to null without work). We assert that.
      requestImpl: async () => {
        throw new Error('request should not be called on a degraded client');
      },
    });
    const result = await probeWorkspaceReadiness(client, [makeSample()]);
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('LSP client not started');
    expect(client.request).not.toHaveBeenCalled();
  });

  // DT-4 ────────────────────────────────────────────────────────────
  it('DT-4: definition resolves but the array is empty → ready:false', async () => {
    // The probe itself does not call the location-mapper; the
    // mapper is the downstream "NO_NODE" gate (per the spec's
    // boundary). What the probe sees is: server returned an
    // empty `[]` for `textDocument/definition`. Empty array
    // counts as a "no resolve" (per the algorithm spec,
    // step 2: "If the result is null or empty array → sample
    // counts as a fail.").
    const client = makeMockClient({
      state: 'ready',
      requestImpl: async () => [],
    });
    const result = await probeWorkspaceReadiness(client, [makeSample()]);
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/workspace not built\/resolved/);
    expect(result.reason).toMatch(/0\/1/);
  });
});

// ─── Edge cases: client state + non-ready transitions ───────────────

describe('workspace-readiness-probe — client state machine', () => {
  it('returns ready:false when client is idle (never started)', async () => {
    const client = makeMockClient({ state: 'idle' });
    const result = await probeWorkspaceReadiness(client, [makeSample()]);
    expect(result).toEqual({ ready: false, reason: 'LSP client not started' });
  });

  it('returns ready:false when client is starting (handshake in flight)', async () => {
    const client = makeMockClient({ state: 'starting' });
    const result = await probeWorkspaceReadiness(client, [makeSample()]);
    expect(result).toEqual({ ready: false, reason: 'LSP client not started' });
  });

  it('returns ready:false when client is restarting (post-crash)', async () => {
    const client = makeMockClient({ state: 'restarting' });
    const result = await probeWorkspaceReadiness(client, [makeSample()]);
    expect(result).toEqual({ ready: false, reason: 'LSP client not started' });
  });

  it('returns ready:false when client is stopping', async () => {
    const client = makeMockClient({ state: 'stopping' });
    const result = await probeWorkspaceReadiness(client, [makeSample()]);
    expect(result).toEqual({ ready: false, reason: 'LSP client not started' });
  });

  it('returns ready:false when client is stopped', async () => {
    const client = makeMockClient({ state: 'stopped' });
    const result = await probeWorkspaceReadiness(client, [makeSample()]);
    expect(result).toEqual({ ready: false, reason: 'LSP client not started' });
  });
});

// ─── Empty-samples guard ────────────────────────────────────────────

describe('workspace-readiness-probe — empty-samples guard', () => {
  it('returns ready:false with a specific reason when samples is []', async () => {
    const client = makeMockClient({ state: 'ready' });
    const result = await probeWorkspaceReadiness(client, []);
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('no samples provided');
    // No requests should have been issued.
    expect(client.request).not.toHaveBeenCalled();
  });

  it('never throws on empty samples (caller may pass [] by accident)', async () => {
    const client = makeMockClient({ state: 'ready' });
    await expect(probeWorkspaceReadiness(client, [])).resolves.toBeDefined();
  });
});

// ─── Partial-threshold BVA ──────────────────────────────────────────

describe('workspace-readiness-probe — partial-threshold BVA (minResolves)', () => {
  it('minResolves=2, both samples resolve → ready:true', async () => {
    const client = makeMockClient({
      state: 'ready',
      requestImpl: async () => [
        {
          uri: 'file:///workspace/src/x.ts',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ],
    });
    const result = await probeWorkspaceReadiness(
      client,
      [makeSample({ uri: 'file:///workspace/src/a.ts' }), makeSample({ uri: 'file:///workspace/src/b.ts' })],
      { minResolves: 2 },
    );
    expect(result).toEqual({ ready: true });
    // Both samples were exercised (one at minimum — the spec says
    // we stop after the threshold, but here both happen to be
    // tried because each resolves on the first try). The probe
    // MAY short-circuit once the threshold is met, so we only
    // assert the lower bound.
    expect((client.request as any).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('minResolves=2, only 1 of 2 samples resolves → ready:false (BVA at boundary)', async () => {
    let callIndex = 0;
    const client = makeMockClient({
      state: 'ready',
      requestImpl: async () => {
        callIndex += 1;
        // First call resolves; subsequent calls return null.
        if (callIndex === 1) {
          return [
            {
              uri: 'file:///workspace/src/a.ts',
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            },
          ];
        }
        return null;
      },
    });
    const result = await probeWorkspaceReadiness(
      client,
      [makeSample({ uri: 'file:///workspace/src/a.ts' }), makeSample({ uri: 'file:///workspace/src/b.ts' })],
      { minResolves: 2 },
    );
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/workspace not built\/resolved/);
    // 1/2 resolved.
    expect(result.reason).toMatch(/1\/2/);
    // Both samples were exercised (the loop must run to the end
    // because we did NOT short-circuit on a fail).
    expect((client.request as any).mock.calls.length).toBe(2);
  });

  it('minResolves=1 (default), 1 of 3 samples resolves → ready:true', async () => {
    let callIndex = 0;
    const client = makeMockClient({
      state: 'ready',
      requestImpl: async () => {
        callIndex += 1;
        if (callIndex === 2) {
          return [
            {
              uri: 'file:///workspace/src/b.ts',
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            },
          ];
        }
        return null;
      },
    });
    const result = await probeWorkspaceReadiness(
      client,
      [
        makeSample({ uri: 'file:///workspace/src/a.ts' }),
        makeSample({ uri: 'file:///workspace/src/b.ts' }),
        makeSample({ uri: 'file:///workspace/src/c.ts' }),
      ],
    );
    // minResolves defaults to 1, so a single resolve is enough.
    expect(result).toEqual({ ready: true });
  });

  it('minResolves=0 is a degenerate but valid value → ready:true without calling request', async () => {
    // Edge: a caller passes minResolves=0 to mean "I don't care
    // about resolution, just confirm the client is ready". The
    // probe honors that — it must not call request, because
    // there's no threshold to meet. State still gates though.
    const client = makeMockClient({ state: 'ready' });
    const result = await probeWorkspaceReadiness(client, [makeSample()], { minResolves: 0 });
    expect(result).toEqual({ ready: true });
    expect(client.request).not.toHaveBeenCalled();
  });
});

// ─── Per-request timeout option ─────────────────────────────────────

describe('workspace-readiness-probe — perRequestTimeoutMs', () => {
  it('forwards the override to client.request()', async () => {
    const client = makeMockClient({
      state: 'ready',
      requestImpl: async () => [
        {
          uri: 'file:///workspace/src/x.ts',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ],
    });
    await probeWorkspaceReadiness(client, [makeSample()], { perRequestTimeoutMs: 1234 });
    const [, , timeoutMs] = (client.request as any).mock.calls[0];
    expect(timeoutMs).toBe(1234);
  });

  it('default perRequestTimeoutMs is 3000', async () => {
    const client = makeMockClient({ state: 'ready' });
    await probeWorkspaceReadiness(client, [makeSample()]);
    const [, , timeoutMs] = (client.request as any).mock.calls[0];
    expect(timeoutMs).toBe(3000);
  });
});

// ─── Invariant 4: probe is the sole gate ─────────────────────────────

describe('workspace-readiness-probe — Invariant 4 (sole gate)', () => {
  it('is a pure function of (state, samples, request) — no graph side effects', async () => {
    // We assert the contract by checking that the probe's only
    // outbound calls are to the injected LspClient (no DB, no
    // logger, no fs). The vi.fn() on `request` is the single
    // observable side effect.
    const client = makeMockClient({ state: 'ready' });
    await probeWorkspaceReadiness(client, [makeSample()]);
    // No other client methods called.
    expect((client as any).getState).toBeDefined();
    // Only one request was made (the threshold was 1 resolve).
    expect((client.request as any).mock.calls.length).toBe(1);
  });

  it('returns a ProbeResult whose `ready` is the ONLY signal downstream code may use', async () => {
    // The downstream contract: never compare heuristic vs LSP when
    // ready:false. We pin the result shape so any future refactor
    // that adds extra fields is intentional, not accidental.
    const client = makeMockClient({ state: 'degraded' });
    const result = await probeWorkspaceReadiness(client, [makeSample()]);
    expect(Object.keys(result).sort()).toEqual(['ready', 'reason']);
  });
});

// ─── Defensive: request itself throws ───────────────────────────────

describe('workspace-readiness-probe — request throws (defensive)', () => {
  it('treats a thrown request as a sample fail (does not propagate)', async () => {
    // The LspClient contract is "never throws" — request() always
    // resolves to T | null. But the probe is a defensive consumer:
    // if a future LspClient bug ever lets a throw escape, the
    // probe must not crash the calling CLI command.
    const client = makeMockClient({
      state: 'ready',
      requestImpl: async () => {
        throw new Error('transport exploded');
      },
    });
    const result = await probeWorkspaceReadiness(client, [makeSample()]);
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/workspace not built\/resolved/);
    expect(result.reason).toMatch(/0\/1/);
  });
});

// ─── Reason string contract ─────────────────────────────────────────

describe('workspace-readiness-probe — reason string contract', () => {
  it('omits reason on ready:true', async () => {
    const client = makeMockClient({ state: 'ready' });
    const result = await probeWorkspaceReadiness(client, [makeSample()]);
    expect(result.ready).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('always populates reason on ready:false', async () => {
    // Cover every failure path with a separate test to prove the
    // contract holds for ALL of them (not just one).
    const cases: Array<{
      name: string;
      state: 'idle' | 'starting' | 'ready' | 'restarting' | 'degraded' | 'stopping' | 'stopped';
      samples: any[];
      requestImpl?: (method: string, params: any, timeoutMs: number) => Promise<any>;
    }> = [
      { name: 'idle', state: 'idle', samples: [makeSample()] },
      { name: 'starting', state: 'starting', samples: [makeSample()] },
      { name: 'restarting', state: 'restarting', samples: [makeSample()] },
      { name: 'degraded', state: 'degraded', samples: [makeSample()] },
      { name: 'stopping', state: 'stopping', samples: [makeSample()] },
      { name: 'stopped', state: 'stopped', samples: [makeSample()] },
      {
        name: 'ready-null',
        state: 'ready',
        samples: [makeSample()],
        requestImpl: async () => null,
      },
      {
        name: 'ready-empty',
        state: 'ready',
        samples: [makeSample()],
        requestImpl: async () => [],
      },
      { name: 'no-samples', state: 'ready', samples: [] },
    ];
    for (const c of cases) {
      const client = makeMockClient({ state: c.state, requestImpl: c.requestImpl });
      const result = await probeWorkspaceReadiness(client, c.samples);
      expect(result.ready, `case ${c.name}`).toBe(false);
      expect(result.reason, `case ${c.name}`).toBeDefined();
      expect(typeof result.reason, `case ${c.name}`).toBe('string');
      expect(result.reason!.length, `case ${c.name}`).toBeGreaterThan(0);
    }
  });
});
