// U12 — the per-file memoized reaching-defs solver must be a TRANSPARENT cache:
// byte-identical to computeReachingDefs, one solve per (cfg, limits) bucket, and
// the limits ARE part of the key (so the RD-emit bucket, which passes
// maxBlockVisits, never aliases the harvest/taint bucket, which does not).

import { describe, it, expect } from 'vitest';
import {
  computeReachingDefs,
  createMemoizedReachingDefs,
} from '../../../src/core/ingestion/cfg/reaching-defs.js';
import { cfgOf } from '../../helpers/ts-cfg-harness.js';

describe('createMemoizedReachingDefs (U12)', () => {
  it('caches by (cfg, limits) — a repeat call returns the same result, solved once', () => {
    const cfg = cfgOf(`function f(a: string) { const b = a; return b; }`);
    const solve = createMemoizedReachingDefs();
    const first = solve(cfg, { maxFacts: 100 });
    const second = solve(cfg, { maxFacts: 100 });
    expect(second).toBe(first);
  });

  it('matches computeReachingDefs byte-for-byte (transparent)', () => {
    const cfg = cfgOf(`function f(a: string, b: string) { const c = a; return c; }`);
    const solve = createMemoizedReachingDefs();
    expect(solve(cfg, { maxFacts: 100 })).toEqual(computeReachingDefs(cfg, { maxFacts: 100 }));
  });

  it('keys on limits — maxBlockVisits is a SEPARATE bucket (emit vs harvest split)', () => {
    const cfg = cfgOf(`function f(a: string) { return a; }`);
    const solve = createMemoizedReachingDefs();
    const withVisits = solve(cfg, { maxFacts: 100, maxBlockVisits: 64 });
    const withoutVisits = solve(cfg, { maxFacts: 100 });
    expect(solve(cfg, { maxFacts: 100, maxBlockVisits: 64 })).toBe(withVisits);
    expect(solve(cfg, { maxFacts: 100 })).toBe(withoutVisits);
  });
});
