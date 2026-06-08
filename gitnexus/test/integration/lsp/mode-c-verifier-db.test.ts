/**
 * Integration Tests: mode-c-verifier (LSP read-only foundation, WI-#6)
 *
 * Drives `runModeCVerify` against a REAL seeded LadybugDB. The
 * `withTestLbugDB` helper opens the pool adapter, the verifier's
 * default `executeParameterized` dep hits that pool, and the
 * seed data is the `LOCAL_BACKEND_SEED_DATA` used by other
 * integration tests in the suite — Functions, Classes, Methods
 * and CALLS edges at known filePath/line ranges.
 *
 * The single Invariant-1 contract from the WI is the merge gate:
 *
 *   > IT: real seeded CALLS edges + read-only Cypher + mock
 *   > LspClient + mock mapper → produces a deterministic
 *   > VerifyReport whose per-tier sums equal its overall
 *   > counters (Invariant 7) and whose `executeParameterized`
 *   > is the only DB surface touched.
 *
 * Note on tier derivation: the schema stores `reason` (a STRING
 * column on the CodeRelation row), NOT a `tier` column. The
 * verifier derives tier from reason via `reasonToTier`. The
 * LOCAL_BACKEND_SEED_DATA writes CALLS edges with two reasons:
 * `'direct'` (not a known tier reason — bucketed to 'global')
 * and `'import-resolved'` (bucketed to 'import-scoped'). The
 * seed thus exercises both the default-defensive path and the
 * named-reason path of `reasonToTier`.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  runModeCVerify,
  type RunModeCVerifyOpts,
  type VerifyReport,
  __test__,
} from '../../../src/core/ingestion/lsp/mode-c-verifier.js';
import { mapLocationToNodeId, type MapperResult } from '../../../src/core/ingestion/lsp/location-mapper.js';
import type { LspClient } from '../../../src/core/ingestion/lsp/lsp-client.js';
import { withTestLbugDB } from '../../helpers/test-indexed-db.js';
import { LOCAL_BACKEND_SEED_DATA } from '../../fixtures/local-backend-seed.js';

// ─── Mock LspClient + probe factories ─────────────────────────────────

/**
 * Build a vi.fn()-driven mock `LspClient`. The verifier only
 * uses `client.request(method, params, timeoutMs)`. We never
 * call `start()` or `getState()` in the integration test — the
 * probe is also injected.
 *
 * `byUri` lets the test pin the LSP response per-URI. The
 * default is a "successful cross-file resolve" (one Location
 * pointing at the request's own URI).
 */
function makeMockClient(opts: {
  byUri?: Map<string, any[]>;
  defaultImpl?: (method: string, params: any, timeoutMs: number) => Promise<any>;
} = {}) {
  const request = vi.fn(async (method: string, params: any, _timeoutMs: number) => {
    if (opts.defaultImpl) return opts.defaultImpl(method, params, _timeoutMs);
    const uri = params?.textDocument?.uri ?? '';
    if (opts.byUri?.has(uri)) {
      return opts.byUri.get(uri);
    }
    // Default: one Location, with the same URI as the request.
    return [
      {
        uri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      },
    ];
  });
  return { request } as unknown as LspClient & { request: ReturnType<typeof vi.fn> };
}

const readyProbe = async () => ({ ready: true });

/**
 * The default mapper: the production `mapLocationToNodeId` is
 * real-DB-backed and works against the seeded data. Tests can
 * override this to inject specific verdicts.
 */
const realMapper = mapLocationToNodeId;

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Compute the sum of a single counter across the four tiers.
 * Used to assert "per-tier sums == overall" (Invariant 7
 * bookkeeping).
 */
function sumAcross(report: VerifyReport, key: keyof (typeof report.overall)): number {
  return (__test__.ALL_TIERS).reduce(
    (s, t) => s + (report.perTier[t][key] as number),
    0,
  );
}

// ─── Real-seeded tests ────────────────────────────────────────────────

withTestLbugDB('mode-c-verifier', (handle) => {
  describe('real seeded DB — happy path', () => {
    it('reads the seeded CALLS edges and produces a per-tier report', async () => {
      // The default LSP mock returns the same URI as the
      // request, so the production mapper will look up the
      // source file itself and (in the absence of a Function
      // at the call-site line) return NO_NODE.
      //
      // This test pins the read-only flow: the verifier MUST
      // only call `executeParameterized` once (the bulk CALLS
      // read) plus the mapper's own per-Location queries. The
      // mapper does additional reads internally, so we only
      // assert the verifier's own bulk call happened once.
      const client = makeMockClient();
      const executor = vi.fn().mockImplementation(
        // Use the real adapter for the verifier's bulk CALLS read.
        async (repoId: string, cypher: string, params: Record<string, any>) => {
          const realAdapter = await import('../../../src/mcp/core/lbug-adapter.js');
          return realAdapter.executeParameterized(repoId, cypher, params);
        },
      );
      const opts: RunModeCVerifyOpts = {
        repoId: handle.repoId,
        client,
        mapLocationToNodeId: realMapper,
        executeParameterized: executor as any,
        probe: readyProbe,
        sampleSize: 10,
        seed: 'integration-seed',
      };
      const report = await runModeCVerify(opts);

      // The seed wrote exactly 2 CALLS edges. We expect n >= 1
      // (sampleSize is large enough to take all 2; the sampling
      // math gives `import-scoped` (reason='import-resolved')
      // 10 * 2/6.5 = 3, capped at popCount=1 → 1, and `global`
      // (reason='direct' — defensive default) 10 * 1/6.5 = 1,
      // capped at popCount=1 → 1. So we expect n=2.
      expect(report.overall.n).toBeGreaterThanOrEqual(1);
      // The sum across tiers equals the overall n (Invariant 7
      // bookkeeping).
      expect(sumAcross(report, 'n')).toBe(report.overall.n);
      // The verifier's own executor was called at least once
      // (the bulk CALLS read).
      expect(executor).toHaveBeenCalled();
    });
  });

  describe('real seeded DB — metric invariants', () => {
    it('per-tier counters always sum to overall counters (Inv 7)', async () => {
      // This is the structural integrity property: the report
      // is a sum, not a separate set of numbers. The check
      // runs across all the counters the verifier maintains.
      const client = makeMockClient();
      const realAdapter = await import('../../../src/mcp/core/lbug-adapter.js');
      const report = await runModeCVerify({
        repoId: handle.repoId,
        client,
        mapLocationToNodeId: realMapper,
        executeParameterized: (repoId, cypher, params) =>
          realAdapter.executeParameterized(repoId, cypher, params),
        probe: readyProbe,
        sampleSize: 5,
        seed: 'integrity-1',
      });
      expect(sumAcross(report, 'matches')).toBe(report.overall.matches);
      expect(sumAcross(report, 'falseConfident')).toBe(report.overall.falseConfident);
      expect(sumAcross(report, 'recallMisses')).toBe(report.overall.recallMisses);
      expect(sumAcross(report, 'refusals')).toBe(report.overall.refusals);
      expect(sumAcross(report, 'recallGains')).toBe(report.overall.recallGains);
      expect(sumAcross(report, 'n')).toBe(report.overall.n);
    });

    it('all derived metrics are well-formed (no NaN, no negative numbers)', async () => {
      const client = makeMockClient();
      const realAdapter = await import('../../../src/mcp/core/lbug-adapter.js');
      const report = await runModeCVerify({
        repoId: handle.repoId,
        client,
        mapLocationToNodeId: realMapper,
        executeParameterized: (repoId, cypher, params) =>
          realAdapter.executeParameterized(repoId, cypher, params),
        probe: readyProbe,
        sampleSize: 5,
        seed: 'wellformed-1',
      });
      // Numbers are not NaN and not negative.
      for (const k of ['precision', 'recall', 'falseConfidentRate'] as const) {
        expect(Number.isFinite(report.overall[k]), `overall.${k} not finite`).toBe(true);
        expect(report.overall[k]).toBeGreaterThanOrEqual(0);
        expect(report.overall[k]).toBeLessThanOrEqual(1);
      }
      for (const t of __test__.ALL_TIERS) {
        for (const k of ['precision', 'recall', 'falseConfidentRate'] as const) {
          expect(Number.isFinite(report.perTier[t][k]), `perTier[${t}].${k} not finite`).toBe(true);
          expect(report.perTier[t][k]).toBeGreaterThanOrEqual(0);
          expect(report.perTier[t][k]).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  describe('real seeded DB — read-only invariant (Inv 1)', () => {
    it('the verifier only issues read Cypher (no write verbs)', async () => {
      // Hook into `executeParameterized` and record every
      // Cypher string the verifier sends. The bulk CALLS read
      // is a single MATCH…RETURN with no write verb. The
      // mapper's internal queries are also read-only (the
      // location-mapper is already vetted for this). The
      // invariant under test is: the verifier itself never
      // issues a CREATE, MERGE, SET, or DELETE.
      const observedCypher: string[] = [];
      const client = makeMockClient();
      const realAdapter = await import('../../../src/mcp/core/lbug-adapter.js');
      const wrappedExecutor = vi.fn(async (repoId: string, cypher: string, params: Record<string, any>) => {
        observedCypher.push(cypher);
        return realAdapter.executeParameterized(repoId, cypher, params);
      });
      await runModeCVerify({
        repoId: handle.repoId,
        client,
        mapLocationToNodeId: realMapper,
        executeParameterized: wrappedExecutor as any,
        probe: readyProbe,
        sampleSize: 5,
        seed: 'read-only-1',
      });
      // No CREATE / MERGE / SET / DELETE in any verifier-issued
      // Cypher. (The mapper may issue reads too; the assertion
      // is on the verifier's own Cypher, not the mapper's.
      // The mapper is already verified read-only by
      // WI-#4's tests.)
      const writeVerbs = /\b(CREATE|MERGE|SET|DELETE|DETACH\s+DELETE)\b/i;
      for (const q of observedCypher) {
        expect(writeVerbs.test(q), `verifier issued write cypher: ${q}`).toBe(false);
      }
      // The verifier's own Cypher is the bulk CALLS read —
      // MATCH…RETURN. We expect at least one such query.
      expect(observedCypher.some((q) => /MATCH.*:CodeRelation.*RETURN/is.test(q))).toBe(true);
    });
  });

  describe('real seeded DB — determinism (Inv 7)', () => {
    it('same seed + same DB → byte-identical report (Inv 7 property)', async () => {
      // Two runs of runModeCVerify with the same seed and the
      // same DB must produce identical JSON. This is the
      // "deterministic report" contract the fitness function
      // relies on.
      const client = makeMockClient();
      const realAdapter = await import('../../../src/mcp/core/lbug-adapter.js');
      const opts: RunModeCVerifyOpts = {
        repoId: handle.repoId,
        client,
        mapLocationToNodeId: realMapper,
        executeParameterized: (repoId, cypher, params) =>
          realAdapter.executeParameterized(repoId, cypher, params),
        probe: readyProbe,
        sampleSize: 5,
        seed: 'deterministic-seed-42',
      };
      const r1 = await runModeCVerify(opts);
      const r2 = await runModeCVerify(opts);
      expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    });
  });

  describe('real seeded DB — tier derivation from `reason`', () => {
    it("buckets 'import-resolved' as 'import-scoped' (the named-reason path)", async () => {
      // The seed has a CALLS edge func:login→func:hash with
      // reason='import-resolved'. That edge MUST land in the
      // import-scoped bucket (not the global defensive default).
      // We assert this by counting >0 in the import-scoped
      // tier whenever the import-resolved edge is included in
      // the sample.
      const client = makeMockClient();
      const realAdapter = await import('../../../src/mcp/core/lbug-adapter.js');
      const report = await runModeCVerify({
        repoId: handle.repoId,
        client,
        mapLocationToNodeId: realMapper,
        executeParameterized: (repoId, cypher, params) =>
          realAdapter.executeParameterized(repoId, cypher, params),
        probe: readyProbe,
        // Push sampleSize above 30 so every edge in the
        // population is sampled.
        sampleSize: 200,
        hardCap: 200,
        seed: 'tier-import',
      });
      // The import-resolved edge is in the seed. With
      // sampleSize=200 and the seed having only 2 CALLS edges
      // total, both should be picked.
      expect(report.perTier['import-scoped'].n).toBeGreaterThan(0);
    });

    it("unknown reasons (e.g. 'direct') fall through to the 'global' defensive default", () => {
      // Pure unit check: the `reasonToTier` helper is what the
      // verifier calls to bucket the seeded edge with
      // reason='direct'. We pin the bucket here so a future
      // refactor that adds 'direct' as a tier doesn't
      // accidentally change the report shape.
      expect(__test__.reasonToTier('direct')).toBe('global');
      expect(__test__.reasonToTier('')).toBe('global');
      expect(__test__.reasonToTier('unknown-reason')).toBe('global');
      // The three canonical reasons are pinned to the expected
      // tiers — this is the "tier encoding" the analyzer uses
      // (call-processor.ts:733).
      expect(__test__.reasonToTier(__test__.REASON_SAME_FILE)).toBe('same-file');
      expect(__test__.reasonToTier(__test__.REASON_IMPORT_RESOLVED)).toBe('import-scoped');
      expect(__test__.reasonToTier(__test__.REASON_FUZZY_GLOBAL)).toBe('global');
    });
  });

  describe('real seeded DB — custom mapper verdicts', () => {
    it('mapper returning the heuristic target → counts as match (real DB path)', async () => {
      // The CALLS edges in the seed have targetId='func:validate'
      // and 'func:hash'. A mapper that always returns
      // { kind: 'node', nodeId: 'func:validate' } matches the
      // first edge and false-confidents the second.
      //
      // The intent here is to exercise the production
      // executor + a custom mapper together — confirming that
      // the read-Cypher reaches the real DB and the per-edge
      // verdict flow runs end-to-end.
      const target = 'func:validate';
      const customMapper = vi.fn(async (_loc: any, _repoId: string): Promise<MapperResult> => {
        return { kind: 'node', nodeId: target };
      });
      const client = makeMockClient();
      const realAdapter = await import('../../../src/mcp/core/lbug-adapter.js');
      const report = await runModeCVerify({
        repoId: handle.repoId,
        client,
        mapLocationToNodeId: customMapper,
        executeParameterized: (repoId, cypher, params) =>
          realAdapter.executeParameterized(repoId, cypher, params),
        probe: readyProbe,
        sampleSize: 200,
        hardCap: 200,
        seed: 'custom-mapper',
      });
      // Total: 2 edges. The mapper says both are 'func:validate'.
      // The first edge (func:login→func:validate) matches; the
      // second (func:login→func:hash) is false-confident.
      // We assert the per-edge totals without pinning the
      // exact per-tier breakdown (the tier mix depends on the
      // `reason` values, which are 'direct' and
      // 'import-resolved' respectively).
      expect(report.overall.n).toBe(2);
      expect(report.overall.matches + report.overall.falseConfident).toBe(2);
      expect(report.overall.matches).toBeGreaterThanOrEqual(1);
      expect(report.overall.falseConfident).toBeGreaterThanOrEqual(1);
    });
  });
}, {
  seed: LOCAL_BACKEND_SEED_DATA,
  poolAdapter: true,
});
