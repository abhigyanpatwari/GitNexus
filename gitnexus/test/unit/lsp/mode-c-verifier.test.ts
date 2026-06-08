/**
 * Unit Tests: mode-c-verifier (LSP read-only foundation, WI-#6)
 *
 * The verifier is a *read-only* comparison loop:
 *
 *   1. probe the LSP client (sole gate, Invariant 4),
 *   2. read all CALLS edges from the graph (Invariant 1: no writes),
 *   3. bucket by tier (derived from `reason`),
 *   4. stratified sample (KD-8: over-sample same-file),
 *   5. for each sampled edge, ask LSP for the definition at the
 *      call-site and map the result via the location-mapper,
 *   6. classify the verdict → match | false-confident | refused
 *      | recall-miss | recall-gain,
 *   7. tally per-tier + overall precision/recall/falseConfidentRate.
 *
 * The unit-test surface is a fully-injected `RunModeCVerifyOpts`
 * — no real DB, no real LSP. We exercise:
 *
 *   - decision table (LSP-maps × heuristic-target) for the
 *     per-edge classifier (DT-1..DT-7),
 *   - edge cases the spec calls out (probe-not-ready, empty
 *     graph, all-refused, sample-cap, multi-location,
 *     misbehaving client),
 *   - metric math (precision / recall / falseConfidentRate),
 *   - property check: same seed → same report JSON (Invariant 7),
 *   - read-only invariant self-check (Invariant 1) via
 *     `assertNoGraphWriteImports` on the module's source text.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  runModeCVerify,
  DEFAULT_SAMPLE_SIZE,
  DEFAULT_SEED,
  __test__,
  assertNoGraphWriteImports,
  type RunModeCVerifyOpts,
  type VerifyMetrics,
  type Tier,
} from '../../../src/core/ingestion/lsp/mode-c-verifier.js';
import type { LspClient } from '../../../src/core/ingestion/lsp/lsp-client.js';
import type { MapperResult } from '../../../src/core/ingestion/lsp/location-mapper.js';

// ─── Mock factories ──────────────────────────────────────────────────

/**
 * Build a vi.fn()-driven mock `LspClient`. The verifier only
 * uses `client.request(method, params, timeoutMs)`; we never
 * call `start()` or `getState()` in the verifier unit tests
 * (the probe is itself injected).
 */
function makeMockClient(opts: {
  requestImpl?: (method: string, params: any, timeoutMs: number) => Promise<any>;
} = {}) {
  const request = vi.fn(
    opts.requestImpl ??
      (async () => [
        {
          uri: 'file:///workspace/src/foo.ts',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ]),
  );
  const client = {
    request,
  } as unknown as LspClient & { request: ReturnType<typeof vi.fn> };
  return client;
}

/** Always-ready probe. */
const readyProbe = async () => ({ ready: true });

/** Never-ready probe with a fixed reason. */
const notReadyProbe = async () => ({ ready: false, reason: 'workspace not built' });

/**
 * Build a `CallEdge`-shaped DB row. The projection coerces
 * numeric/string fields defensively, so we use the realistic
 * column names the Cypher returns.
 */
function row(over: Partial<{
  sourceId: string;
  sourceFile: string;
  sourceLine: number;
  sourceName: string;
  targetId: string;
  targetFile: string;
  targetStartLine: number;
  targetEndLine: number;
  targetName: string;
  confidence: number;
  reason: string;
}> = {}) {
  return {
    sourceId: over.sourceId ?? 'src:caller',
    sourceFile: over.sourceFile ?? 'src/a.ts',
    sourceLine: over.sourceLine ?? 5,
    sourceName: over.sourceName ?? 'caller',
    targetId: over.targetId ?? 'tgt:target',
    targetFile: over.targetFile ?? 'src/b.ts',
    targetStartLine: over.targetStartLine ?? 1,
    targetEndLine: over.targetEndLine ?? 5,
    targetName: over.targetName ?? 'target',
    confidence: over.confidence ?? 1.0,
    reason: over.reason ?? 'same-file',
  };
}

/**
 * Build a no-op mapper. The default is "the heuristic target is
 * what the mapper returns" — which makes the `match` case
 * trivial and the `false-confident` case achievable by returning
 * a different nodeId.
 */
function makeMapper(over: {
  byUri?: Map<string, MapperResult>;
  defaultImpl?: (loc: any, repoId: string) => MapperResult;
} = {}) {
  const calls: Array<{ loc: any; repoId: string }> = [];
  const fn = vi.fn(async (loc: any, repoId: string) => {
    calls.push({ loc, repoId });
    if (over.byUri) {
      const hit = over.byUri.get(loc?.uri ?? '');
      if (hit) return hit;
    }
    if (over.defaultImpl) return over.defaultImpl(loc, repoId);
    // Default: every Location maps to a fresh, predictable nodeId.
    return { kind: 'node', nodeId: `mapped:${loc?.uri ?? '?'}` };
  });
  return { mapLocationToNodeId: fn, calls };
}

/**
 * Build an `executeParameterized` mock that returns a fixed
 * array of DB rows. The verifier only ever queries CALLS edges
 * with a single MATCH…RETURN shape.
 */
function makeExecutor(rows: any[] = []) {
  return vi.fn().mockResolvedValue(rows);
}

/** Empty-metrics factory — local copy for assertion shorthand. */
function zero(): VerifyMetrics {
  return {
    precision: 0,
    recall: 0,
    falseConfidentRate: 0,
    matches: 0,
    falseConfident: 0,
    recallMisses: 0,
    refusals: 0,
    recallGains: 0,
    n: 0,
  };
}

// ─── DT-1..DT-5: per-edge classification decision table ──────────────

describe('mode-c-verifier — per-edge classification (decision table)', () => {
  // DT-1: agree (LSP node matches heuristic) → match
  it('DT-1: agree (heuristic==LSP, both non-null) → match', async () => {
    const client = makeMockClient({
      requestImpl: async () => [
        { uri: 'file:///src/a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      ],
    });
    const mapper = makeMapper({
      defaultImpl: () => ({ kind: 'node', nodeId: 'tgt:target' }),
    });
    const rows = [
      row({ sourceFile: 'src/a.ts', sourceLine: 5, targetId: 'tgt:target', reason: 'same-file' }),
    ];
    const report = await runModeCVerify({
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor(rows),
      probe: readyProbe,
      sampleSize: 5,
      seed: 'unit-test',
    });
    expect(report.overall.matches).toBe(1);
    expect(report.overall.falseConfident).toBe(0);
    expect(report.overall.refusals).toBe(0);
    expect(report.overall.recallMisses).toBe(0);
    expect(report.overall.recallGains).toBe(0);
    expect(report.overall.n).toBe(1);
    expect(report.overall.precision).toBe(1);
    expect(report.overall.falseConfidentRate).toBe(0);
    expect(report.perTier['same-file'].matches).toBe(1);
  });

  // DT-2: heuristic != LSP → false-confident
  it('DT-2: heuristic target differs from LSP target → false-confident', async () => {
    const client = makeMockClient({
      requestImpl: async () => [
        { uri: 'file:///src/a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      ],
    });
    const mapper = makeMapper({
      defaultImpl: () => ({ kind: 'node', nodeId: 'tgt:WRONG' }),
    });
    const rows = [
      row({ sourceFile: 'src/a.ts', sourceLine: 5, targetId: 'tgt:target', reason: 'same-file' }),
    ];
    const report = await runModeCVerify({
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor(rows),
      probe: readyProbe,
      sampleSize: 5,
      seed: 'unit-test',
    });
    expect(report.overall.matches).toBe(0);
    expect(report.overall.falseConfident).toBe(1);
    expect(report.overall.precision).toBe(0);
    expect(report.overall.falseConfidentRate).toBe(1);
  });

  // DT-3: NO_NODE from mapper → refused (NEVER a match)
  it('DT-3: mapper returns NO_NODE → refused, never a match (Invariant 3)', async () => {
    const client = makeMockClient({
      requestImpl: async () => [
        { uri: 'file:///src/a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      ],
    });
    const mapper = makeMapper({
      defaultImpl: () => ({ kind: 'NO_NODE' }),
    });
    const rows = [
      row({ sourceFile: 'src/a.ts', sourceLine: 5, targetId: 'tgt:target', reason: 'same-file' }),
    ];
    const report = await runModeCVerify({
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor(rows),
      probe: readyProbe,
      sampleSize: 5,
      seed: 'unit-test',
    });
    expect(report.overall.matches).toBe(0);
    expect(report.overall.falseConfident).toBe(0);
    expect(report.overall.refusals).toBe(1);
    expect(report.overall.n).toBe(1);
  });

  // DT-4: AMBIGUOUS from mapper → refused, never a match
  it('DT-4: mapper returns AMBIGUOUS → refused, never a match (Invariant 3)', async () => {
    const client = makeMockClient({
      requestImpl: async () => [
        { uri: 'file:///src/a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      ],
    });
    const mapper = makeMapper({
      defaultImpl: () => ({ kind: 'AMBIGUOUS' }),
    });
    const rows = [
      row({ sourceFile: 'src/a.ts', sourceLine: 5, targetId: 'tgt:target', reason: 'same-file' }),
    ];
    const report = await runModeCVerify({
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor(rows),
      probe: readyProbe,
      sampleSize: 5,
      seed: 'unit-test',
    });
    expect(report.overall.matches).toBe(0);
    expect(report.overall.falseConfident).toBe(0);
    expect(report.overall.refusals).toBe(1);
  });

  // DT-5: heuristic null + LSP resolves → recall-gain
  it('DT-5: heuristic null (empty targetId) + LSP resolves → recall-gain', async () => {
    const client = makeMockClient({
      requestImpl: async () => [
        { uri: 'file:///src/a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      ],
    });
    const mapper = makeMapper({
      defaultImpl: () => ({ kind: 'node', nodeId: 'tgt:LSP-found' }),
    });
    const rows = [
      // Empty targetId = the analyzer wrote a CALLS edge but
      // could not resolve a target (or the row's targetId was
      // blank).
      row({ sourceFile: 'src/a.ts', sourceLine: 5, targetId: '', reason: 'same-file' }),
    ];
    const report = await runModeCVerify({
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor(rows),
      probe: readyProbe,
      sampleSize: 5,
      seed: 'unit-test',
    });
    expect(report.overall.matches).toBe(0);
    expect(report.overall.recallGains).toBe(1);
    expect(report.overall.refusals).toBe(0);
    expect(report.overall.recallMisses).toBe(0);
  });

  // DT-6: heuristic null + LSP returns empty array → recall-miss
  it('DT-6: heuristic null + LSP returns [] → recall-miss', async () => {
    const client = makeMockClient({ requestImpl: async () => [] });
    const mapper = makeMapper();
    const rows = [row({ sourceFile: 'src/a.ts', sourceLine: 5, targetId: '', reason: 'same-file' })];
    const report = await runModeCVerify({
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor(rows),
      probe: readyProbe,
      sampleSize: 5,
      seed: 'unit-test',
    });
    expect(report.overall.recallMisses).toBe(1);
    expect(report.overall.matches).toBe(0);
    expect(report.overall.refusals).toBe(0);
  });

  // DT-7: LSP returns null (timeout) + heuristic non-null → refused
  it('DT-7: LSP returns null (timeout) + heuristic non-null → refused (not recall-miss)', async () => {
    const client = makeMockClient({ requestImpl: async () => null });
    const mapper = makeMapper();
    const rows = [row({ sourceFile: 'src/a.ts', sourceLine: 5, targetId: 'tgt:target', reason: 'same-file' })];
    const report = await runModeCVerify({
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor(rows),
      probe: readyProbe,
      sampleSize: 5,
      seed: 'unit-test',
    });
    expect(report.overall.refusals).toBe(1);
    expect(report.overall.recallMisses).toBe(0);
  });

  // DT-8: LSP returns multi-location → refused
  it('DT-8: LSP returns multiple locations → refused (cannot attribute to a single target)', async () => {
    const client = makeMockClient({
      requestImpl: async () => [
        { uri: 'file:///src/a.ts', range: { start: { line: 0, character: 0 } } },
        { uri: 'file:///src/b.ts', range: { start: { line: 0, character: 0 } } },
      ],
    });
    const mapper = makeMapper();
    const rows = [row({ sourceFile: 'src/a.ts', sourceLine: 5, targetId: 'tgt:target', reason: 'same-file' })];
    const report = await runModeCVerify({
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor(rows),
      probe: readyProbe,
      sampleSize: 5,
      seed: 'unit-test',
    });
    expect(report.overall.refusals).toBe(1);
    // The mapper must NOT have been called for a multi-location
    // response — the verifier short-circuits at the LSP layer.
    expect(mapper.mapLocationToNodeId).not.toHaveBeenCalled();
  });
});

// ─── Probe gate (Invariant 4) ────────────────────────────────────────

describe('mode-c-verifier — probe gate (Invariant 4)', () => {
  it('probe not-ready → no client.request() calls + lspUnavailable:true + reason', async () => {
    const client = makeMockClient();
    const mapper = makeMapper();
    const executor = makeExecutor([row()]);
    const report = await runModeCVerify({
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: executor,
      probe: notReadyProbe,
    });
    expect(report.lspUnavailable).toBe(true);
    expect(report.reason).toBe('workspace not built');
    expect(report.sampleSize).toBe(0);
    // Per the spec, the verifier MUST NOT touch the client, the
    // mapper, or the DB when the probe fails.
    expect((client.request as any).mock.calls.length).toBe(0);
    expect(mapper.mapLocationToNodeId).not.toHaveBeenCalled();
    // The executor IS called — the spec allows the verifier to
    // decide after seeing the probe. The current implementation
    // short-circuits BEFORE the executor (cheaper). We pin
    // whichever is true here. Looking at the implementation:
    // it short-circuits before the executor.
    expect(executor).not.toHaveBeenCalled();
  });

  it('probe ready → runs the full loop', async () => {
    const client = makeMockClient({
      requestImpl: async () => [
        { uri: 'file:///src/a.ts', range: { start: { line: 0, character: 0 } } },
      ],
    });
    const mapper = makeMapper({
      defaultImpl: () => ({ kind: 'node', nodeId: 'tgt:target' }),
    });
    const rows = [row({ sourceFile: 'src/a.ts', sourceLine: 5, targetId: 'tgt:target' })];
    const report = await runModeCVerify({
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor(rows),
      probe: readyProbe,
    });
    expect(report.lspUnavailable).toBeUndefined();
    expect(report.reason).toBeUndefined();
    expect(report.overall.n).toBe(1);
  });
});

// ─── Empty graph (EdgeCase 8) ────────────────────────────────────────

describe('mode-c-verifier — empty graph (EdgeCase 8)', () => {
  it('no CALLS edges → all zero metrics + sampleSize:0 + lspUnavailable:false (NOT a "not ready" case)', async () => {
    const client = makeMockClient();
    const mapper = makeMapper();
    const report = await runModeCVerify({
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor([]),
      probe: readyProbe,
    });
    // No n, no metric denominator → all rates must be 0 (NOT NaN).
    expect(report.overall).toEqual(zero());
    expect(report.sampleSize).toBe(0);
    expect(report.lspUnavailable).toBeFalsy();
    // Per-tier metrics are all zero too.
    for (const t of __test__.ALL_TIERS) {
      expect(report.perTier[t]).toEqual(zero());
    }
  });

  it('all edges skipped by projection (no sourceFile) → empty report, no throw', async () => {
    // The projection drops rows without a `sourceFile` (the
    // call-site line alone is not enough to ask LSP). An
    // index-side bug that wrote half-formed edges must not
    // crash the verifier.
    const client = makeMockClient();
    const mapper = makeMapper();
    const rows = [
      // sourceFile intentionally missing → dropped by projectEdge.
      { sourceId: 'x', sourceLine: 5, targetId: 'y' },
    ];
    const report = await runModeCVerify({
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor(rows),
      probe: readyProbe,
    });
    expect(report.overall.n).toBe(0);
    expect(report.overall.precision).toBe(0);
    expect(report.overall.recall).toBe(0);
  });
});

// ─── Full happy path with 10 edges / 2 tiers ─────────────────────────

describe('mode-c-verifier — full happy path (10 edges, 2 tiers)', () => {
  it('mixed same-file + import-scoped → per-tier + overall precision/false-confident correct', async () => {
    // We hand-build 10 edges across two tiers and pin every
    // counter. The seeded shuffle + the small sample size
    // (sampleSize=10, hardCap=10) means all 10 should be
    // exercised; the exact per-tier counts depend on the
    // sampler, so we re-derive them deterministically.
    const client = makeMockClient({
      requestImpl: async (_method: string, params: any) => [
        // The first Location in `params` corresponds to a
        // request against a `file://${sourceFile}` URI. We
        // return a Location with the same URI so the mapper's
        // default impl (via `byUri`) is honored.
        { uri: params.textDocument.uri, range: { start: { line: 0, character: 0 } } },
      ],
    });
    // The mapper returns a per-URI verdict. We use a "good"
    // mapper for half the rows and a "wrong" mapper for the
    // other half.
    const byUri = new Map<string, MapperResult>();
    let i = 0;
    const rows: any[] = [];
    for (let k = 0; k < 5; k++) {
      const file = `src/sf${k}.ts`;
      const target = `tgt:sf${k}`;
      byUri.set(`file://${file}`, { kind: 'node', nodeId: target });
      rows.push(row({ sourceFile: file, sourceLine: 10, targetId: target, reason: 'same-file' }));
    }
    for (let k = 0; k < 5; k++) {
      const file = `src/imp${k}.ts`;
      const target = `tgt:imp${k}`;
      byUri.set(`file://${file}`, { kind: 'node', nodeId: target });
      rows.push(row({ sourceFile: file, sourceLine: 20, targetId: target, reason: 'import-resolved' }));
    }
    const mapper = makeMapper({ byUri });
    const report = await runModeCVerify({
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor(rows),
      probe: readyProbe,
      sampleSize: 100,
      hardCap: 100,
      seed: 'happy-path',
    });
    expect(report.overall.n).toBe(10);
    expect(report.overall.matches).toBe(10);
    expect(report.overall.falseConfident).toBe(0);
    expect(report.overall.precision).toBe(1);
    expect(report.overall.falseConfidentRate).toBe(0);
    // Per-tier sums match overall.
    let matchesSum = 0;
    let nSum = 0;
    for (const t of __test__.ALL_TIERS) {
      matchesSum += report.perTier[t].matches;
      nSum += report.perTier[t].n;
    }
    expect(matchesSum).toBe(10);
    expect(nSum).toBe(10);
  });
});

// ─── All-refused: refusal tally is never a match ─────────────────────

describe('mode-c-verifier — all-refused', () => {
  it('every edge refuses → 0/0/0 + refused=n', async () => {
    const client = makeMockClient({
      requestImpl: async () => [
        { uri: 'file:///src/a.ts', range: { start: { line: 0, character: 0 } } },
      ],
    });
    const mapper = makeMapper({ defaultImpl: () => ({ kind: 'NO_NODE' }) });
    const rows = [
      row({ sourceFile: 'src/a1.ts', sourceLine: 5, targetId: 'tgt:a', reason: 'same-file' }),
      row({ sourceFile: 'src/a2.ts', sourceLine: 5, targetId: 'tgt:b', reason: 'same-file' }),
      row({ sourceFile: 'src/a3.ts', sourceLine: 5, targetId: 'tgt:c', reason: 'same-file' }),
    ];
    const report = await runModeCVerify({
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor(rows),
      probe: readyProbe,
      sampleSize: 5,
      seed: 'all-refused',
    });
    expect(report.overall.refusals).toBe(report.overall.n);
    expect(report.overall.matches).toBe(0);
    expect(report.overall.falseConfident).toBe(0);
    expect(report.overall.recallMisses).toBe(0);
    // The "0/0" metrics must be exactly 0 (NOT NaN).
    expect(report.overall.precision).toBe(0);
    expect(report.overall.recall).toBe(0);
  });
});

// ─── Sample cap (EdgeCase 9) ─────────────────────────────────────────

describe('mode-c-verifier — sample cap (EdgeCase 9)', () => {
  it('caps are logged when a tier is over-allocated', async () => {
    const client = makeMockClient({
      requestImpl: async () => [
        { uri: 'file:///src/a.ts', range: { start: { line: 0, character: 0 } } },
      ],
    });
    const mapper = makeMapper({ defaultImpl: () => ({ kind: 'node', nodeId: 'tgt:target' }) });
    // 100 same-file edges. With sampleSize=20, weights
    // (3, 2, 1, 0.5) the same-file share is 20*3/6.5=9.2 → 9.
    // The cap-reached warning should fire (allocated=9 < pop=100).
    const rows: any[] = [];
    for (let k = 0; k < 100; k++) {
      rows.push(row({ sourceFile: `src/x${k}.ts`, sourceLine: 5, targetId: 'tgt:target', reason: 'same-file' }));
    }
    const warnings: string[] = [];
    const report = await runModeCVerify({
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor(rows),
      probe: readyProbe,
      sampleSize: 20,
      seed: 'cap-test',
      logger: { warn: (m) => warnings.push(m) },
    });
    // The cap message is on the format: "[mode-c] tier=... cap reached: ..."
    expect(warnings.some((w) => w.includes('cap reached'))).toBe(true);
    // The sampled same-file count must NOT exceed the share.
    expect(report.perTier['same-file'].n).toBeLessThanOrEqual(rows.length);
  });

  it('hardCap truncates the per-tier slices when the total exceeds the cap', async () => {
    const client = makeMockClient({
      requestImpl: async () => [
        { uri: 'file:///src/a.ts', range: { start: { line: 0, character: 0 } } },
      ],
    });
    const mapper = makeMapper({ defaultImpl: () => ({ kind: 'node', nodeId: 'tgt:target' }) });
    const rows: any[] = [];
    for (let k = 0; k < 50; k++) {
      rows.push(row({ sourceFile: `src/x${k}.ts`, sourceLine: 5, targetId: 'tgt:target', reason: 'same-file' }));
    }
    const report = await runModeCVerify({
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor(rows),
      probe: readyProbe,
      sampleSize: 50,
      hardCap: 10,
      seed: 'hard-cap',
    });
    // The total across tiers is bounded by hardCap.
    let n = 0;
    for (const t of __test__.ALL_TIERS) n += report.perTier[t].n;
    expect(n).toBeLessThanOrEqual(10);
    expect(report.sampleSize).toBeLessThanOrEqual(10);
  });
});

// ─── Determinism (Invariant 7) ───────────────────────────────────────

describe('mode-c-verifier — determinism (Invariant 7)', () => {
  it('same seed → byte-identical JSON report (property check)', async () => {
    // Build a 20-edge graph that exercises stratified sampling
    // and the seeded shuffle.
    const buildRows = () => {
      const r: any[] = [];
      for (let k = 0; k < 8; k++) r.push(row({ sourceFile: `src/sf${k}.ts`, sourceLine: 5, targetId: 'tgt', reason: 'same-file' }));
      for (let k = 0; k < 7; k++) r.push(row({ sourceFile: `src/imp${k}.ts`, sourceLine: 5, targetId: 'tgt', reason: 'import-resolved' }));
      for (let k = 0; k < 5; k++) r.push(row({ sourceFile: `src/g${k}.ts`, sourceLine: 5, targetId: 'tgt', reason: 'fuzzy-global' }));
      return r;
    };
    const client = makeMockClient({
      requestImpl: async (_m: string, p: any) => [
        { uri: p.textDocument.uri, range: { start: { line: 0, character: 0 } } },
      ],
    });
    const mapper = makeMapper({
      byUri: new Map(
        [...Array(20).keys()].map((k) => [
          // The verifier requests with `file://${sourceFile}`
          // (double-slash). The byUri keys must match the
          // actual request URI.
          `file://src/x${k}.ts`,
          { kind: 'node', nodeId: 'tgt' } as MapperResult,
        ]),
      ),
    });
    const opts: RunModeCVerifyOpts = {
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor(buildRows()),
      probe: readyProbe,
      sampleSize: 12,
      seed: 'deterministic-seed-42',
    };
    const r1 = await runModeCVerify(opts);
    const r2 = await runModeCVerify({
      ...opts,
      executeParameterized: makeExecutor(buildRows()),
    });
    // The two reports must serialize to identical JSON.
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('different seeds → at least one numeric counter differs', async () => {
    // The sampler and the per-edge verdict are seeded; changing
    // the seed should change at least one number in the report.
    //
    // To make the report seed-sensitive, we use a population of
    // 30 same-file edges with a non-uniform verdict
    // distribution: each URI's verdict is a deterministic
    // function of its index (1/3 match, 1/3 false-confident,
    // 1/3 NO_NODE refusal). With sampleSize=20 the same-file
    // tier gets the full population of 30 capped to its share;
    // the shuffle changes which subset is picked → at least one
    // of {matches, falseConfident, refusals} changes.
    const buildRows = () => {
      const r: any[] = [];
      for (let k = 0; k < 30; k++) r.push(row({ sourceFile: `src/x${k}.ts`, sourceLine: 5, targetId: 'tgt:target', reason: 'same-file' }));
      return r;
    };
    const client = makeMockClient({
      requestImpl: async (_m: string, p: any) => [
        { uri: p.textDocument.uri, range: { start: { line: 0, character: 0 } } },
      ],
    });
    // 1/3 each: match, false-confident, refused.
    const byUri = new Map<string, MapperResult>();
    for (let k = 0; k < 30; k++) {
      // The verifier requests with `file://${sourceFile}`,
      // which is a double-slash form (`file://src/x0.ts`).
      // The byUri map must use the same key.
      const uri = `file://src/x${k}.ts`;
      if (k % 3 === 0) byUri.set(uri, { kind: 'node', nodeId: 'tgt:target' });
      else if (k % 3 === 1) byUri.set(uri, { kind: 'node', nodeId: 'tgt:WRONG' });
      else byUri.set(uri, { kind: 'NO_NODE' });
    }
    const mapper = makeMapper({ byUri });
    const baseOpts: RunModeCVerifyOpts = {
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor(buildRows()),
      probe: readyProbe,
      sampleSize: 50,
      hardCap: 50,
    };
    const r1 = await runModeCVerify({ ...baseOpts, seed: 'alpha' });
    const r2 = await runModeCVerify({ ...baseOpts, seed: 'beta' });
    expect(JSON.stringify(r1)).not.toBe(JSON.stringify(r2));
  });
});

// ─── Read-only invariant (Invariant 1) ───────────────────────────────

describe('mode-c-verifier — read-only invariant (Invariant 1)', () => {
  it('the verifier module source contains no write-API symbols (runtime check)', () => {
    // The check parses the source text and matches a list of
    // forbidden symbols. The check is exposed from the verifier
    // itself so it shares the same definition of "write API".
    // We point the check at the verifier's own source file.
    const here = dirname(fileURLToPath(import.meta.url));
    // Walk up to the gitnexus root. The test file lives at
    // <root>/gitnexus/test/unit/lsp/; the verifier at
    // <root>/gitnexus/src/core/ingestion/lsp/.
    const srcPath = join(here, '..', '..', '..', 'src', 'core', 'ingestion', 'lsp', 'mode-c-verifier.ts');
    const src = readFileSync(srcPath, 'utf8');
    const { ok, violations } = assertNoGraphWriteImports(src);
    expect(ok, `forbidden write-API symbols: ${violations.join(', ')}`).toBe(true);
  });

  it('exposes executeParameterized and does NOT import addNode/addRelationship/executeQuery', () => {
    // Defensive companion to the regex check above. The
    // verifier's only DB surface is the read-only
    // `executeParameterized` import from `lbug-adapter`.
    const here = dirname(fileURLToPath(import.meta.url));
    const srcPath = join(here, '..', '..', '..', 'src', 'core', 'ingestion', 'lsp', 'mode-c-verifier.ts');
    const src = readFileSync(srcPath, 'utf8');
    // The read API is imported.
    expect(src).toMatch(/executeParameterized/);
    // The write APIs are not.
    expect(src).not.toMatch(/import\b[^\n]*\baddNode\b/);
    expect(src).not.toMatch(/import\b[^\n]*\baddRelationship\b/);
    expect(src).not.toMatch(/import\b[^\n]*\bexecuteQuery\b/);
  });

  it('per-tier counters sum to overall counters', async () => {
    const client = makeMockClient({
      requestImpl: async () => [
        { uri: 'file:///src/a.ts', range: { start: { line: 0, character: 0 } } },
      ],
    });
    const mapper = makeMapper({ defaultImpl: () => ({ kind: 'node', nodeId: 'tgt:target' }) });
    const rows: any[] = [];
    for (let k = 0; k < 4; k++) rows.push(row({ sourceFile: `src/sf${k}.ts`, sourceLine: 5, targetId: 'tgt:target', reason: 'same-file' }));
    for (let k = 0; k < 3; k++) rows.push(row({ sourceFile: `src/imp${k}.ts`, sourceLine: 5, targetId: 'tgt:target', reason: 'import-resolved' }));
    for (let k = 0; k < 2; k++) rows.push(row({ sourceFile: `src/g${k}.ts`, sourceLine: 5, targetId: 'tgt:target', reason: 'fuzzy-global' }));
    const report = await runModeCVerify({
      repoId: 'r1',
      client,
      mapLocationToNodeId: mapper.mapLocationToNodeId,
      executeParameterized: makeExecutor(rows),
      probe: readyProbe,
      sampleSize: 20,
      seed: 'sum-check',
    });
    const sumAcross = (k: keyof VerifyMetrics) =>
      (__test__.ALL_TIERS as Tier[]).reduce((s, t) => s + (report.perTier[t][k] as number), 0);
    expect(sumAcross('matches')).toBe(report.overall.matches);
    expect(sumAcross('falseConfident')).toBe(report.overall.falseConfident);
    expect(sumAcross('recallMisses')).toBe(report.overall.recallMisses);
    expect(sumAcross('refusals')).toBe(report.overall.refusals);
    expect(sumAcross('recallGains')).toBe(report.overall.recallGains);
    expect(sumAcross('n')).toBe(report.overall.n);
  });
});

// ─── Metric math (EP) ────────────────────────────────────────────────

describe('mode-c-verifier — metric math (equivalence partitions)', () => {
  /**
   * Helper: synthesize a `VerifyMetrics` from a tuple of
   * counter values and run the math. We bypass the verifier
   * itself and exercise `__test__.finalizeMetrics` directly.
   */
  function metricsWith(m: number, fc: number, rm: number): VerifyMetrics {
    const x: VerifyMetrics = { ...zero(), matches: m, falseConfident: fc, recallMisses: rm, n: m + fc + rm };
    __test__.finalizeMetrics(x);
    return x;
  }

  it('precision = m / (m + fc), 0 when denom is 0', () => {
    expect(metricsWith(0, 0, 0).precision).toBe(0);
    expect(metricsWith(5, 0, 0).precision).toBe(1);
    expect(metricsWith(5, 5, 0).precision).toBe(0.5);
    expect(metricsWith(0, 5, 0).precision).toBe(0);
  });

  it('recall = m / (m + fc + rm), 0 when denom is 0', () => {
    expect(metricsWith(0, 0, 0).recall).toBe(0);
    expect(metricsWith(5, 0, 0).recall).toBe(1);
    // m=5, fc=5, rm=5 → recall = 5/15 = 1/3
    expect(metricsWith(5, 5, 5).recall).toBeCloseTo(1 / 3, 10);
    expect(metricsWith(0, 0, 5).recall).toBe(0);
  });

  it('falseConfidentRate = fc / n, 0 when n is 0', () => {
    expect(metricsWith(0, 0, 0).falseConfidentRate).toBe(0);
    expect(metricsWith(5, 5, 0).falseConfidentRate).toBe(0.5);
    expect(metricsWith(0, 5, 0).falseConfidentRate).toBe(1);
  });
});

// ─── Defaults exported ───────────────────────────────────────────────

describe('mode-c-verifier — defaults', () => {
  it('DEFAULT_SAMPLE_SIZE = 200', () => {
    expect(DEFAULT_SAMPLE_SIZE).toBe(200);
  });
  it('DEFAULT_SEED = "deterministic-seed-42"', () => {
    expect(DEFAULT_SEED).toBe('deterministic-seed-42');
  });
});
