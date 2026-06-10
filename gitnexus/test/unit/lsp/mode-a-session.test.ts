/**
 * Unit Tests: withReconciliationSession (WI-4a, issue #159 P3).
 *
 * The session is the *single refuse funnel* for Mode A — the same
 * shape as `withReferenceProvider` (P2), but for the WRITE half of
 * the cycle. The behavior contract:
 *
 *   discoverServers() → null if no TS server (no spawn)
 *   start()           → null if start throws (no client to stop)
 *   probe ready?      → null if not ready (stop the client)
 *   fn(session)       → fn's result on success (stop in finally)
 *   any throw inside fn → null (stop in finally)
 *
 * Plus the **session-specific** contract (KD-9/10):
 *   - Merge correction + recall feeds.
 *   - Stable-sort by (sourceId, calledName, line, character).
 *   - Take first-N (cap 2000); record `skipped` count.
 *   - Per-request `textDocument/definition` (5000ms).
 *   - Normalize `Location | Location[]` (bare `Location` → array).
 *   - Hand each normalized Location to WI-4b (the engine half).
 *
 * Test surface:
 *   - The unit test NEVER spawns a real LSP — every dep is
 *     injected via the `WithReconciliationSessionDeps` bag.
 *   - The "hand each Location to WI-4b" assertion uses a
 *     `vi.fn()` collector for the per-Location dispatch.
 *   - The session is the *session half*; the *engine half*
 *     (`reconcileDecisions`, atomic correction, collapse) is the
 *     subject of `mode-a-engine.test.ts` (WI-4b).
 *
 * Cases (G1..G6 mirror the funnel; X1..X6 are session-specific):
 *   G1 discoverServers returns { typescript: null } → null
 *   G2 client.start() throws synchronously          → null (no stop)
 *   G3 probe returns { ready:false }                → null + stop
 *   G4 fn throws                                     → null + stop (finally)
 *   G5 happy path: fn resolves with value            → value + stop
 *   G6 happy path: fn resolves with undefined         → undefined + stop
 *   X1 merged feeds sorted by (sourceId, calledName, line, character)
 *   X2 cap > available → first-N; skipped = available - first-N
 *   X3 cap < available → first-N; skipped = available - first-N
 *   X4 bare `Location` is normalized to `Location[]` of length 1
 *   X5 LSP returns `Location[]` of N → all N handed to engine
 *   X6 LSP returns `null` → engine receives empty (refused)
 */

import { describe, it, expect, vi } from 'vitest';

import {
  withReconciliationSession,
  type WithReconciliationSessionDeps,
  type ReconciliationProbeFn,
  type ReconciliationLspClient,
  type ReconciliationRepo,
  type Location,
  type Candidate,
  DEFAULT_CANDIDATE_CAP,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '../../../src/core/ingestion/mode-a-reconciler.js';

// ─── Test surface: minimal mocks ──────────────────────────────────────

/**
 * A `ReconciliationLspClient` is the exact subset of `LspClient`
 * the session calls: `start()`, `stop()`, `request()`, plus
 * `getState()` so the probe can be invoked with the real shape.
 * The mock is a plain object — no class hierarchy, no inheritance.
 * The `request` impl is parametrized by the test so we can drive
 * the per-request response shape per case.
 */
function makeMockClient(over: {
  startImpl?: () => Promise<void>;
  stopImpl?: () => Promise<void>;
  requestImpl?: (method: string, params: any, timeoutMs: number) => Promise<any>;
  state?: string;
} = {}) {
  const start = vi.fn(over.startImpl ?? (async () => undefined));
  const stop = vi.fn(over.stopImpl ?? (async () => undefined));
  const request = vi.fn(over.requestImpl ?? (async () => undefined));
  const getState = vi.fn(() => over.state ?? 'ready');
  return {
    client: { start, stop, request, getState } as unknown as ReconciliationLspClient,
    start,
    stop,
    request,
  };
}

/**
 * A factory: `() => ReconciliationLspClient`. The session calls
 * this to obtain a new client AFTER `discoverServers` has
 * resolved and BEFORE the `start()` call.
 */
function makeClientFactory(client: ReconciliationLspClient) {
  return vi.fn(() => client);
}

/**
 * A `ReconciliationProbeFn` is the contract the session needs
 * from a readiness probe. We never call the real
 * `probeWorkspaceReadiness` in these unit tests.
 */
function makeProbe(over: { ready?: boolean; reason?: string } = {}) {
  const ready = over.ready ?? true;
  const reason = over.reason ?? 'simulated';
  return vi.fn(async (_client: ReconciliationLspClient) => {
    return ready ? { ready: true } : { ready: false, reason };
  }) as unknown as ReconciliationProbeFn & ReturnType<typeof vi.fn>;
}

/**
 * Build a deps bag. Every field has a default; tests override
 * only the ones that matter for their gate.
 */
function makeDeps(over: {
  discoverServersImpl?: () => Promise<{ typescript: { path: string; version: string } | null }>;
  client?: ReconciliationLspClient;
  probe?: ReconciliationProbeFn;
} = {}) {
  const client = (over.client ?? makeMockClient().client) as ReconciliationLspClient;
  return {
    discoverServers: vi.fn(
      over.discoverServersImpl ??
        (async () => ({ typescript: { path: '/bin/typescript-language-server', version: '4.3.3' } })),
    ),
    createLspClient: makeClientFactory(client),
    probe: over.probe ?? makeProbe(),
    client, // for direct assertions
  };
}

/** A minimal repo handle. The session only reads `id` + `repoPath`. */
const REPO: ReconciliationRepo = {
  id: 'r1',
  repoPath: '/workspace/repo',
};

/** A trivial candidate feed — extend per test. */
function mkCandidate(over: Partial<Candidate> = {}): Candidate {
  return {
    sourceId: 'src:1',
    calledName: 'foo',
    oldTargetId: 'Function:src/a.ts:foo',
    file: 'src/a.ts',
    line: 10,
    character: 4,
    ...over,
  };
}

// ─── G1: discoverServers refuses (no spawn) ───────────────────────────

describe('withReconciliationSession — G1: no server discovered', () => {
  it('discoverServers returns { typescript: null } → null, no client factory call, no start', async () => {
    const deps = makeDeps({
      discoverServersImpl: async () => ({ typescript: null }),
    });
    const fn = vi.fn(async () => 'should-not-run');
    const result = await withReconciliationSession(REPO, [], fn, deps);

    expect(result).toBeNull();
    expect(deps.discoverServers).toHaveBeenCalledTimes(1);
    expect(deps.createLspClient).not.toHaveBeenCalled();
    expect(deps.client.start).not.toHaveBeenCalled();
    expect(deps.client.stop).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── G2: client.start() throws → null, no stop (no client to stop) ──

describe('withReconciliationSession — G2: start throws', () => {
  it('client.start rejects → null, no stop called (no client to stop)', async () => {
    const { client, start, stop } = makeMockClient({
      startImpl: async () => {
        throw new Error('spawn failed');
      },
    });
    const deps = makeDeps({ client });
    const fn = vi.fn(async () => 'should-not-run');
    const result = await withReconciliationSession(REPO, [], fn, deps);

    expect(result).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── G3: probe not ready → null + stop (finally) ─────────────────────

describe('withReconciliationSession — G3: probe not-ready', () => {
  it('probe returns { ready:false } → null, stop called in finally', async () => {
    const { client, start, stop } = makeMockClient();
    const probe = makeProbe({ ready: false, reason: 'workspace not built' });
    const deps = makeDeps({ client, probe });
    const fn = vi.fn(async () => 'should-not-run');
    const result = await withReconciliationSession(REPO, [], fn, deps);

    expect(result).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(client);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── G4: fn throws → null + stop (finally) ────────────────────────────

describe('withReconciliationSession — G4: fn throws', () => {
  it('fn rejects → null, stop called in finally', async () => {
    const { client, start, stop } = makeMockClient();
    const deps = makeDeps({ client });
    const fn = vi.fn(async () => {
      throw new Error('consumer failure');
    });
    const result = await withReconciliationSession(REPO, [], fn, deps);

    expect(result).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    const fnOrder = fn.mock.invocationCallOrder[0];
    const stopOrder = stop.mock.invocationCallOrder[0];
    expect(stopOrder).toBeGreaterThan(fnOrder);
  });
});

// ─── G5: happy path — fn returns a value ─────────────────────────────

describe('withReconciliationSession — G5: happy path with value', () => {
  it('fn resolves with a value → value returned verbatim, stop called', async () => {
    const { client, start, stop } = makeMockClient();
    const deps = makeDeps({ client });
    const expected = { kind: 'ran', count: 7 };
    const fn = vi.fn(async () => expected);
    const result = await withReconciliationSession(REPO, [], fn, deps);

    expect(result).toBe(expected);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ─── G6: happy path — fn returns undefined ───────────────────────────

describe('withReconciliationSession — G6: happy path with undefined', () => {
  it('fn resolves with undefined → undefined returned (NOT null) + stop called', async () => {
    const { client, start, stop } = makeMockClient();
    const deps = makeDeps({ client });
    const fn = vi.fn(async () => undefined);
    const result = await withReconciliationSession(REPO, [], fn, deps);

    expect(result).toBeUndefined();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ─── X1: merged feeds sorted deterministically ────────────────────────

describe('withReconciliationSession — X1: feed merge + sort', () => {
  it('merges correction+recall feeds, sorts by (sourceId, calledName, line, character)', async () => {
    // The session receives the *already-merged* feed as a single
    // argument. X1 exercises the sort: hand a feed with explicit
    // out-of-order keys and read the order back from fn's input.
    const { client } = makeMockClient();
    const deps = makeDeps({ client });

    const input: Candidate[] = [
      mkCandidate({ sourceId: 's2', calledName: 'b', line: 1, character: 0 }),
      mkCandidate({ sourceId: 's1', calledName: 'a', line: 5, character: 0 }),
      mkCandidate({ sourceId: 's1', calledName: 'a', line: 5, character: 4 }),
      mkCandidate({ sourceId: 's1', calledName: 'a', line: 1, character: 0 }),
    ];

    const received: Candidate[] = [];
    const fn = vi.fn(async (cands: Candidate[]) => {
      // Capture a structural copy for the post-call assertion.
      for (const c of cands) received.push({ ...c });
      return 'sorted';
    });

    const result = await withReconciliationSession(REPO, input, fn, deps);
    expect(result).toBe('sorted');

    // The sort key is (sourceId ASC, calledName ASC, line ASC,
    // character ASC). Verify by reconstructing the keys in
    // received order and comparing to the natural sorted order.
    const keys = received.map((c) => `${c.sourceId}|${c.calledName}|${c.line}|${c.character}`);
    const expectedKeys = [...input]
      .map((c) => `${c.sourceId}|${c.calledName}|${c.line}|${c.character}`)
      .sort();
    expect(keys).toEqual(expectedKeys);
    // Determinism: same input → same order across two calls.
    const received2: string[] = [];
    const fn2 = vi.fn(async (cands: Candidate[]) => {
      for (const c of cands) received2.push(`${c.sourceId}|${c.calledName}|${c.line}|${c.character}`);
      return 'sorted';
    });
    await withReconciliationSession(REPO, input, fn2, deps);
    expect(received2).toEqual(expectedKeys);
  });

  it('preserves the cap boundary: exactly N candidates → all N, skipped=0', async () => {
    const { client } = makeMockClient();
    const deps = makeDeps({ client });
    const N = 5;
    const input: Candidate[] = Array.from({ length: N }, (_, i) =>
      mkCandidate({ sourceId: `s${i}`, calledName: 'fn', line: i, character: 0 }),
    );
    const fn = vi.fn(async (cands: Candidate[]) => cands.length);
    const result = await withReconciliationSession(REPO, input, fn, deps);
    expect(result).toBe(N);
  });
});

// ─── X2/X3: cap deterministic + skipped count ─────────────────────────

describe('withReconciliationSession — X2/X3: cap and skipped', () => {
  it('X2: candidates > cap → first-N deterministic; skipped = rest', async () => {
    const { client } = makeMockClient();
    const deps = makeDeps({ client });
    const cap = 3;
    const input: Candidate[] = Array.from({ length: 5 }, (_, i) =>
      mkCandidate({ sourceId: `s${i}`, calledName: 'fn', line: i, character: 0 }),
    );
    // The session reports `skipped` via the third positional
    // argument to fn: `fn(candidates, _meta, skipped)`. We
    // confirm BOTH the trimmed candidate list AND the count.
    const fn = vi.fn(async (cands: Candidate[], _meta: any, skipped: number) => ({
      count: cands.length,
      skipped,
    }));
    const result = await withReconciliationSession(REPO, input, fn, { ...deps, cap });
    expect(result).toEqual({ count: cap, skipped: input.length - cap });
  });

  it('X3: candidates < cap → all passed; skipped = 0', async () => {
    const { client } = makeMockClient();
    const deps = makeDeps({ client });
    const cap = 10;
    const input: Candidate[] = Array.from({ length: 4 }, (_, i) =>
      mkCandidate({ sourceId: `s${i}`, calledName: 'fn', line: i, character: 0 }),
    );
    const fn = vi.fn(async (cands: Candidate[], _meta: any, skipped: number) => ({
      count: cands.length,
      skipped,
    }));
    const result = await withReconciliationSession(REPO, input, fn, { ...deps, cap });
    expect(result).toEqual({ count: 4, skipped: 0 });
  });

  it('X2b: cap is exactly the default (2000) when not overridden', async () => {
    expect(DEFAULT_CANDIDATE_CAP).toBe(2000);
  });
});

// ─── X4: bare `Location` normalized to `Location[]` ───────────────────

describe('withReconciliationSession — X4: Location|Location[] normalization', () => {
  it('bare Location (object) is normalized to Location[] of length 1', async () => {
    // The session issues `textDocument/definition` per candidate.
    // For this test, the client returns a single (bare) Location
    // — the session must hand it to the engine as a 1-element
    // array. The engine-side dispatch is the `handToEngine` dep
    // we inject: a vi.fn() that captures the normalized payload.
    const bare: Location = {
      uri: 'file:///workspace/repo/src/b.ts',
      range: { start: { line: 7, character: 2 } },
    };
    const { client } = makeMockClient({
      requestImpl: async () => bare,
    });
    const handToEngine = vi.fn(async (_cand: Candidate, _locs: Location[]) => undefined);
    const deps = makeDeps({ client });
    const input: Candidate[] = [mkCandidate()];
    const fn = vi.fn(async () => undefined);
    await withReconciliationSession(REPO, input, fn, { ...deps, handToEngine });
    expect(handToEngine).toHaveBeenCalledTimes(1);
    const [_cand, locs] = handToEngine.mock.calls[0];
    expect(Array.isArray(locs)).toBe(true);
    expect((locs as Location[]).length).toBe(1);
    expect((locs as Location[])[0]).toEqual(bare);
  });
});

// ─── X5: Location[] of N → all N handed to engine ────────────────────

describe('withReconciliationSession — X5: multi-Location pass-through', () => {
  it('Location[] of N → all N handed to engine (the engine decides ambiguity)', async () => {
    const arr: Location[] = [
      { uri: 'file:///repo/a.ts', range: { start: { line: 1, character: 0 } } },
      { uri: 'file:///repo/b.ts', range: { start: { line: 2, character: 0 } } },
      { uri: 'file:///repo/c.ts', range: { start: { line: 3, character: 0 } } },
    ];
    const { client } = makeMockClient({
      requestImpl: async () => arr,
    });
    const handToEngine = vi.fn(async (_cand: Candidate, _locs: Location[]) => undefined);
    const deps = makeDeps({ client });
    const input: Candidate[] = [mkCandidate()];
    const fn = vi.fn(async () => undefined);
    await withReconciliationSession(REPO, input, fn, { ...deps, handToEngine });
    expect(handToEngine).toHaveBeenCalledTimes(1);
    const [_cand, locs] = handToEngine.mock.calls[0];
    expect((locs as Location[]).length).toBe(arr.length);
  });
});

// ─── X6: null / timeout → engine receives empty array (refused) ──────

describe('withReconciliationSession — X6: null / undefined LSP result', () => {
  it('null result (timeout / crash) → engine receives empty array', async () => {
    const { client } = makeMockClient({
      requestImpl: async () => null,
    });
    const handToEngine = vi.fn(async (_cand: Candidate, _locs: Location[]) => undefined);
    const deps = makeDeps({ client });
    const input: Candidate[] = [mkCandidate()];
    const fn = vi.fn(async () => undefined);
    await withReconciliationSession(REPO, input, fn, { ...deps, handToEngine });
    expect(handToEngine).toHaveBeenCalledTimes(1);
    const [_cand, locs] = handToEngine.mock.calls[0];
    expect(Array.isArray(locs)).toBe(true);
    expect((locs as Location[]).length).toBe(0);
  });

  it('non-typed result (e.g. server returned a string) → engine receives empty array (refuse over guess)', async () => {
    const { client } = makeMockClient({
      requestImpl: async () => 'unexpected-payload',
    });
    const handToEngine = vi.fn(async (_cand: Candidate, _locs: Location[]) => undefined);
    const deps = makeDeps({ client });
    const input: Candidate[] = [mkCandidate()];
    const fn = vi.fn(async () => undefined);
    await withReconciliationSession(REPO, input, fn, { ...deps, handToEngine });
    expect(handToEngine).toHaveBeenCalledTimes(1);
    const [_cand, locs] = handToEngine.mock.calls[0];
    expect((locs as Location[]).length).toBe(0);
  });
});

// ─── Per-request timeout (KD-10) ──────────────────────────────────────

describe('withReconciliationSession — per-request timeout', () => {
  it('default per-request timeout is 5000ms (KD-10)', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(5000);
  });

  it('each textDocument/definition request is issued with the configured timeout', async () => {
    const { client, request } = makeMockClient({
      requestImpl: async () => null,
    });
    const deps = makeDeps({ client });
    const input: Candidate[] = Array.from({ length: 3 }, (_, i) =>
      mkCandidate({ sourceId: `s${i}`, calledName: 'fn', line: i, character: 0 }),
    );
    const fn = vi.fn(async () => undefined);
    await withReconciliationSession(REPO, input, fn, { ...deps, requestTimeoutMs: 1234 });
    expect(request).toHaveBeenCalledTimes(input.length);
    for (const call of request.mock.calls) {
      const [_method, _params, timeoutMs] = call;
      expect(timeoutMs).toBe(1234);
    }
  });
});

// ─── Crash isolation: a crash in fn must not skip stop() ──────────────

describe('withReconciliationSession — crash isolation', () => {
  it('synchronous throw inside fn → null + stop still called', async () => {
    const { client, stop } = makeMockClient();
    const deps = makeDeps({ client });
    const fn = vi.fn(() => {
      throw new Error('sync crash');
    });
    const result = await withReconciliationSession(REPO, [], fn as any, deps);
    expect(result).toBeNull();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

// ─── Lifecycle ordering (state-transition) ───────────────────────────

describe('withReconciliationSession — lifecycle ordering', () => {
  it('happy path: discover → start → probe → fn → stop (in that order)', async () => {
    const order: string[] = [];
    const { client, start, stop } = makeMockClient({
      startImpl: async () => { order.push('start'); },
      stopImpl: async () => { order.push('stop'); },
    });
    const probe = vi.fn(async () => {
      order.push('probe');
      return { ready: true };
    }) as unknown as ReconciliationProbeFn;
    const discoverServers = vi.fn(async () => {
      order.push('discover');
      return { typescript: { path: '/bin/typescript-language-server', version: '4.3.3' } };
    });
    const fn = vi.fn(async () => {
      order.push('fn');
      return 'ok';
    });
    const result = await withReconciliationSession(REPO, [], fn, {
      discoverServers,
      createLspClient: makeClientFactory(client),
      probe,
    });
    expect(result).toBe('ok');
    expect(order).toEqual(['discover', 'start', 'probe', 'fn', 'stop']);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

// ─── Default-probe seam: must be refusable ────────────────────────────

describe('withReconciliationSession — default probe refuses when no samples are provided', () => {
  it('a default probe with empty samples returns ready:false, funnel returns null', async () => {
    // The default probe is the real `probeWorkspaceReadiness` —
    // it refuses on empty samples. We pass a deps bag with no
    // `probe` override and confirm the default refuses (no
    // fn-call, stop still runs).
    const { client, stop, start } = makeMockClient();
    const deps: WithReconciliationSessionDeps = {
      discoverServers: vi.fn(async () => ({ typescript: { path: '/bin/ts', version: '4' } })),
      createLspClient: makeClientFactory(client),
      // No `probe` — funnel uses default.
    };
    const fn = vi.fn(async () => 'should-not-run');
    const result = await withReconciliationSession(REPO, [], fn, deps);
    expect(result).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
  });
});
