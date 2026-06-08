/**
 * Unit Tests: withReferenceProvider (WI-2, issue #159 P2).
 *
 * The lifecycle funnel is the *single refuse path* for both
 * `rename(precision:'lsp')` (WI-4) and `impact(precision:'lsp')`
 * (WI-5). It is the bridge between the read-only LSP foundation
 * (P0+P1, verified) and the new Mode B wirings.
 *
 * Funnel contract (mirrors the design doc `## Contracts`):
 *   discoverServers() → null if no TS server (no spawn)
 *   start()          → null if start throws (no client to stop)
 *   probe ready?     → null if not ready (stop the client)
 *   fn(provider)     → return fn's result on success (stop in finally)
 *   any throw inside fn → null (stop in finally)
 *
 * The lifecycle shape mirrors `runModeCVerify` (mode-c-verifier.ts):
 *   "raise gate, do work, tear down in finally". The unit-test
 *   surface is a fully-injected deps bag — no real `LspClient`,
 *   no real `discoverServers`, no real probe.
 *
 * Methodology:
 *   - decision table: each gate → null
 *   - state transition: lifecycle order
 *   - state-transition: stop-in-finally (the load-bearing Inv-5)
 *
 * Cases (G1..G6):
 *   G1 discoverServers returns { typescript: null } → null
 *   G2 client.start() throws synchronously           → null (no stop)
 *   G3 probe returns { ready:false }                 → null + stop
 *   G4 fn throws                                      → null + stop (finally)
 *   G5 happy path: fn resolves with value             → value + stop
 *   G6 happy path: fn resolves with undefined         → undefined + stop
 */

import { describe, it, expect, vi } from 'vitest';

import {
  withReferenceProvider,
  type WithReferenceProviderDeps,
  type ProbeFn,
  type LspClientLike,
} from '../../../src/core/ingestion/lsp/reference-provider.js';

// ─── Test surface: minimal mocks ──────────────────────────────────────

/**
 * A `LspClientLike` is the exact subset of `LspClient` the funnel
 * calls: `start()`, `stop()`. The mock is a plain object — no class
 * hierarchy, no inheritance. This is the load-bearing seam that
 * keeps these tests free of subprocess spawning.
 *
 * F7: the funnel now asserts that the client also exposes the
 * provider-facing surface (`request`, `didOpen`). Existing happy-
 * path tests need both methods on the fake so the seam-assert
 * passes; the F7 test specifically strips them to exercise the
 * refuse path.
 */
function makeMockClient(over: {
  startImpl?: () => Promise<void>;
  stopImpl?: () => Promise<void>;
} = {}) {
  const start = vi.fn(over.startImpl ?? (async () => undefined));
  const stop = vi.fn(over.stopImpl ?? (async () => undefined));
  const request = vi.fn(async () => undefined);
  const didOpen = vi.fn(async () => undefined);
  return {
    client: { start, stop, request, didOpen } as LspClientLike,
    start,
    stop,
  };
}

/**
 * A factory: `() => LspClientLike`. The funnel calls this to obtain
 * a new client AFTER `discoverServers` has resolved and BEFORE the
 * `start()` call. The mock is just a vi.fn() that hands out the
 * test's prepared client.
 */
function makeClientFactory(client: LspClientLike) {
  return vi.fn(() => client);
}

/**
 * A `ProbeFn` is the contract the funnel needs from a readiness
 * probe. We never call the real `probeWorkspaceReadiness` in these
 * unit tests — the funnel takes a `probe` function as a dep.
 */
function makeProbe(over: {
  ready?: boolean;
  reason?: string;
} = {}) {
  const ready = over.ready ?? true;
  const reason = over.reason ?? 'simulated';
  return vi.fn(async (_client: LspClientLike) => {
    return ready ? { ready: true } : { ready: false, reason };
  }) as unknown as ProbeFn & ReturnType<typeof vi.fn>;
}

/**
 * Build a deps bag. Every field has a default; tests override only
 * the ones that matter for their gate.
 */
function makeDeps(over: {
  discoverServersImpl?: () => Promise<{ typescript: { path: string; version: string } | null }>;
  client?: LspClientLike;
  probe?: ProbeFn;
} = {}) {
  const client = over.client ?? makeMockClient().client;
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

/** A minimal repo handle. The funnel only reads `id` + `repoPath`. */
const REPO = {
  id: 'r1',
  repoPath: '/workspace/repo',
  name: 'r1',
  storagePath: '/workspace/.gitnexus/r1',
  lbugPath: '/workspace/.gitnexus/r1.lbug',
  indexedAt: '2026-01-01T00:00:00Z',
  lastCommit: 'abc123',
};

/** The file URI the funnel hands to `new ReferenceProvider(client, uri)`. */
const FILE_URI = 'file:///workspace/repo/src/foo.ts';

// ─── G1: discoverServers refuses (no spawn) ───────────────────────────

describe('withReferenceProvider — G1: no server discovered', () => {
  it('discoverServers returns { typescript: null } → null, no client factory call, no start', async () => {
    const deps = makeDeps({
      discoverServersImpl: async () => ({ typescript: null }),
    });
    const fn = vi.fn(async () => 'should-not-run');
    const result = await withReferenceProvider(REPO, FILE_URI, fn, deps);

    expect(result).toBeNull();
    expect(deps.discoverServers).toHaveBeenCalledTimes(1);
    // No client was created → no start, no stop.
    expect(deps.createLspClient).not.toHaveBeenCalled();
    expect(deps.client.start).not.toHaveBeenCalled();
    expect(deps.client.stop).not.toHaveBeenCalled();
    // fn must not have been called.
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── G2: client.start() throws → null, no stop (no client to stop) ──

describe('withReferenceProvider — G2: start throws', () => {
  it('client.start rejects → null, no stop called (no client to stop)', async () => {
    const { client, start, stop } = makeMockClient({
      startImpl: async () => {
        throw new Error('spawn failed');
      },
    });
    const deps = makeDeps({ client });
    const fn = vi.fn(async () => 'should-not-run');
    const result = await withReferenceProvider(REPO, FILE_URI, fn, deps);

    expect(result).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    // No client to stop — we never reached the finally.
    expect(stop).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── G3: probe not ready → null + stop (finally) ─────────────────────

describe('withReferenceProvider — G3: probe not-ready', () => {
  it('probe returns { ready:false } → null, stop called in finally', async () => {
    const { client, start, stop } = makeMockClient();
    const probe = makeProbe({ ready: false, reason: 'workspace not built' });
    const deps = makeDeps({ client, probe });
    const fn = vi.fn(async () => 'should-not-run');
    const result = await withReferenceProvider(REPO, FILE_URI, fn, deps);

    expect(result).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(client);
    // The probe ran with the SAME client instance the factory returned.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── G4: fn throws → null + stop (finally) ───────────────────────────

describe('withReferenceProvider — G4: fn throws', () => {
  it('fn rejects → null, stop called in finally (Inv-5)', async () => {
    const { client, start, stop } = makeMockClient();
    const deps = makeDeps({ client });
    const fn = vi.fn(async () => {
      throw new Error('provider failure');
    });
    const result = await withReferenceProvider(REPO, FILE_URI, fn, deps);

    expect(result).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    // The stop ran EVEN THOUGH fn threw — the finally ran.
    // We assert this by ordering: stop is called AFTER fn was called.
    const fnOrder = fn.mock.invocationCallOrder[0];
    const stopOrder = stop.mock.invocationCallOrder[0];
    expect(stopOrder).toBeGreaterThan(fnOrder);
  });
});

// ─── G5: happy path — fn returns a value ─────────────────────────────

describe('withReferenceProvider — G5: happy path with value', () => {
  it('fn resolves with a value → value returned verbatim, stop called', async () => {
    const { client, start, stop } = makeMockClient();
    const deps = makeDeps({ client });
    const expected = { kind: 'lsp', edits: [{ line: 5 }] };
    const fn = vi.fn(async () => expected);
    const result = await withReferenceProvider(REPO, FILE_URI, fn, deps);

    expect(result).toBe(expected);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    // fn received a ReferenceProvider-shaped object.
    expect(fn).toHaveBeenCalledTimes(1);
    const provider = fn.mock.calls[0][0];
    expect(provider).toBeDefined();
    expect(typeof provider.resolveSymbol).toBe('function');
    expect(typeof provider.references).toBe('function');
    expect(typeof provider.rename).toBe('function');
  });

  // (S-27) The second G5 test ("passes the client + fileUri
  // into a new ReferenceProvider for fn") was deleted. It
  // asserted nothing meaningful beyond "the provider object is
  // defined" — the assertion was vacuous (every object is
  // defined), and the contract is already exercised by the
  // first G5 test (the provider's method surface check at the
  // end). A second, redundant test of the same shape was noise.
});

// ─── G6: happy path — fn returns undefined ───────────────────────────

describe('withReferenceProvider — G6: fn returns undefined', () => {
  it('fn resolves with undefined → undefined returned (NOT null) + stop called', async () => {
    const { client, start, stop } = makeMockClient();
    const deps = makeDeps({ client });
    const fn = vi.fn(async () => undefined);
    const result = await withReferenceProvider(REPO, FILE_URI, fn, deps);

    // Spec: "G6 fn→undefined→undefined+stop" — the funnel MUST
    // preserve the return type. `undefined` is a real answer
    // ("provider was used, found no work"), distinct from "refuse"
    // which is `null`. This distinction matters for callers that
    // want to distinguish "ran, nothing to do" from "refused".
    expect(result).toBeUndefined();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ─── Defaults: when deps are not provided ────────────────────────────

describe('withReferenceProvider — defaults', () => {
  it('accepts a deps bag with only the discoverable fields (uses defaults for the rest)', async () => {
    // We construct a deps bag that does NOT override `createLspClient`
    // or `probe` — the funnel must use sensible defaults. The point
    // of this test is to confirm the *seam* exists (caller can
    // inject); we don't try to actually start a real client.
    //
    // Because the default `createLspClient` IS the real LspClient
    // (which would attempt to spawn), we override discoverServers
    // to refuse — G1 short-circuits before the factory runs.
    const deps: WithReferenceProviderDeps = {
      discoverServers: vi.fn(async () => ({ typescript: null })),
    };
    const result = await withReferenceProvider(REPO, FILE_URI, async () => 'x', deps);
    expect(result).toBeNull();
    // Defaults were honored — discoverServers was called, no factory.
    expect(deps.discoverServers).toHaveBeenCalledTimes(1);
  });
});

// ─── Lifecycle ordering (state-transition) ───────────────────────────

describe('withReferenceProvider — lifecycle ordering', () => {
  it('happy path: discover → start → probe → fn → stop (in that order)', async () => {
    const order: string[] = [];
    const { client, start, stop } = makeMockClient({
      startImpl: async () => {
        order.push('start');
      },
      stopImpl: async () => {
        order.push('stop');
      },
    });
    const probe = vi.fn(async () => {
      order.push('probe');
      return { ready: true };
    }) as unknown as ProbeFn;
    const discoverServers = vi.fn(async () => {
      order.push('discover');
      return { typescript: { path: '/bin/typescript-language-server', version: '4.3.3' } };
    });
    const fn = vi.fn(async () => {
      order.push('fn');
      return 'ok';
    });
    const result = await withReferenceProvider(
      REPO,
      FILE_URI,
      fn,
      {
        discoverServers,
        createLspClient: makeClientFactory(client),
        probe,
      },
    );
    expect(result).toBe('ok');
    expect(order).toEqual(['discover', 'start', 'probe', 'fn', 'stop']);
  });
});

// ─── F7: structural-fake seam assert (refuse early, not deep) ────────
//
// A `LspClientLike` fake that exposes `start`/`stop` but is missing
// the `request` / `didOpen` surface used by `ReferenceProvider` would
// otherwise crash opaquely INSIDE the provider after `start()`
// succeeds. The funnel seam must assert the surface right after
// `start()` resolves so a structural mismatch is refused at the
// gate (null + still stop the client).

describe('withReferenceProvider — F7: structural-fake seam assert', () => {
  it('F7.1: client missing request/didOpen → null + stop still called', async () => {
    // A fake that quacks as `LspClientLike` (start/stop) but lacks
    // the request/didOpen the provider needs. The funnel must
    // refuse BEFORE handing the client to the provider.
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const fakeClient = { start, stop } as unknown as LspClientLike;
    const deps: WithReferenceProviderDeps = {
      discoverServers: vi.fn(async () => ({
        typescript: { path: '/bin/typescript-language-server', version: '4.3.3' },
      })),
      createLspClient: vi.fn(() => fakeClient),
      probe: makeProbe({ ready: true }),
    };
    const fn = vi.fn(async () => 'should-not-run');
    const result = await withReferenceProvider(REPO, FILE_URI, fn, deps);

    // The funnel refused at the seam, returning null.
    expect(result).toBeNull();
    // start() was called (the gate only refuses AFTER start succeeds).
    expect(start).toHaveBeenCalledTimes(1);
    // The client was STILL stopped in finally (Inv-5: stop in
    // finally on every post-start exit, including seam-refuse).
    expect(stop).toHaveBeenCalledTimes(1);
    // The fn was NEVER called — the refuse happened before fn dispatch.
    expect(fn).not.toHaveBeenCalled();
  });
});
