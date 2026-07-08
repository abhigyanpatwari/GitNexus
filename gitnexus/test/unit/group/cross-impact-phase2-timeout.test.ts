/**
 * Phase-2 fanout timeout regression test.
 *
 * Codex adversarial review on PR #1331 surfaced that `validateGroupImpactParams`
 * clamps `timeoutMs` and `safeLocalImpact` enforces it on the local leg, but
 * the Phase-2 cross-repo fanout (`cross-impact.ts:521-526`) awaits each
 * `port.impactByUid(...)` call without a per-call timeout. A single hung
 * neighbor pins the request indefinitely; multiple slow neighbors compound
 * past the clamped budget because each starts before `Date.now() > deadline`.
 *
 * This test pins the contract of the mitigation: a `safeNeighborImpact`
 * helper that races `port.impactByUid` against a remaining-budget timer
 * and returns `{ value: null, timedOut: true }` when the call cannot
 * complete in time.
 *
 * Direct import + named symbol so this is a real regression net — no
 * `??`-fallback or dynamic-import dance (the U8 false-green pattern).
 */
import { describe, expect, it } from 'vitest';
import { safeNeighborImpact } from '../../../src/core/group/cross-impact.js';
import type { GroupToolPort } from '../../../src/core/group/service.js';

const minimalOpts = {
  maxDepth: 3,
  relationTypes: [] as string[],
  minConfidence: 0,
  includeTests: false,
};

function makePort(impactByUid: GroupToolPort['impactByUid']): GroupToolPort {
  return {
    resolveRepo: async () => {
      throw new Error('not used');
    },
    impact: async () => {
      throw new Error('not used');
    },
    query: async () => {
      throw new Error('not used');
    },
    context: async () => {
      throw new Error('not used');
    },
    impactByUid,
  };
}

describe('safeNeighborImpact — Phase-2 fanout per-call timeout', () => {
  it('returns timedOut=true when impactByUid never resolves, within ~remainingMs', async () => {
    // Hung neighbor: the promise never resolves. Without the timeout wrap
    // this would hang the test runner.
    const port = makePort(() => new Promise(() => {}));
    const start = performance.now();
    const result = await safeNeighborImpact(port, 'repo-id', 'uid:1', 'upstream', minimalOpts, 150);
    const elapsedMs = performance.now() - start;
    expect(result.timedOut).toBe(true);
    expect(result.value).toBeNull();
    // Allow generous slack for slow CI; the contract is "bounded", not
    // "exactly remainingMs". A regression that drops the timeout entirely
    // would hang far past 1500ms; a regression that uses the wrong unit
    // (seconds vs ms) would fire much faster.
    expect(elapsedMs).toBeGreaterThanOrEqual(140);
    expect(elapsedMs).toBeLessThan(1500);
  });

  it('returns the resolved value and timedOut=false on a fast happy path', async () => {
    const fakeFan = { byDepth: { 1: [{ id: 'u1' }] } };
    const port = makePort(async () => fakeFan);
    const result = await safeNeighborImpact(
      port,
      'repo-id',
      'uid:1',
      'upstream',
      minimalOpts,
      1000,
    );
    expect(result.timedOut).toBe(false);
    expect(result.value).toBe(fakeFan);
  });

  it('returns timedOut=true immediately when remainingMs is 0 and the call still hangs', async () => {
    // Defensive: even if the caller passes 0, the helper must not block.
    const port = makePort(() => new Promise(() => {}));
    const start = performance.now();
    const result = await safeNeighborImpact(port, 'repo-id', 'uid:1', 'upstream', minimalOpts, 0);
    const elapsedMs = performance.now() - start;
    expect(result.timedOut).toBe(true);
    expect(result.value).toBeNull();
    // 0ms timeout fires on the next tick — should be well under 50ms even on slow CI.
    expect(elapsedMs).toBeLessThan(50);
  });

  it('does not compound across calls — two hung neighbors complete within ~2× remainingMs total', async () => {
    // The contract is per-call timeout. Two sequential hung calls should
    // total ~2× remainingMs, not (numNeighbors × remainingMs² / 2) or
    // anything compounding. A regression that shares one timer across
    // calls would pass the first test but fail this one.
    const port = makePort(() => new Promise(() => {}));
    const start = performance.now();
    const r1 = await safeNeighborImpact(port, 'repo', 'u1', 'upstream', minimalOpts, 100);
    const r2 = await safeNeighborImpact(port, 'repo', 'u2', 'upstream', minimalOpts, 100);
    const elapsedMs = performance.now() - start;
    expect(r1.timedOut).toBe(true);
    expect(r2.timedOut).toBe(true);
    expect(elapsedMs).toBeGreaterThanOrEqual(180);
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('propagates an immediate rejection from impactByUid as timedOut=false with null value', async () => {
    // If the port itself rejects (rather than hangs), the helper should
    // surface that as a non-timeout failure — the existing fanout block
    // already handles `if (fan == null)` truncation, so returning null
    // here keeps that path intact.
    const port = makePort(async () => {
      throw new Error('connection refused');
    });
    const result = await safeNeighborImpact(port, 'repo', 'u1', 'upstream', minimalOpts, 1000);
    expect(result.timedOut).toBe(false);
    expect(result.value).toBeNull();
  });
});
