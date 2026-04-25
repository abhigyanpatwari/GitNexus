/**
 * Parity guard for the cross-phase tree cache (PHM Unit 5).
 *
 * `emitPythonScopeCaptures(src, path)` re-parses internally;
 * `emitPythonScopeCaptures(src, path, cachedTree)` skips the parse. The
 * two paths MUST return identical `CaptureMatch[]`. A future change
 * that (a) mutates Trees before caching, (b) conditionally branches
 * the capture query on cached vs fresh Trees, or (c) leaks state
 * through module-level caches would break this — and no other test
 * today asserts the equivalence.
 *
 * Keeps the wins from the cache-hit path honest.
 */
import { describe, it, expect } from 'vitest';
import {
  emitPythonScopeCaptures,
  resetPythonCaptureCacheStats,
  getPythonCaptureCacheStats,
} from '../../../../src/core/ingestion/languages/python/index.js';
import { getPythonParser } from '../../../../src/core/ingestion/languages/python/query.js';

const FIXTURE = `
from typing import List

class Base:
    def greet(self) -> str:
        return "hi"

class Child(Base):
    def shout(self, items: List[str]) -> None:
        for item in items:
            print(item.upper())

def top(c: Child) -> None:
    c.greet()
    c.shout([])
`;

function normalizeCaptures(caps: readonly Record<string, unknown>[]): unknown[] {
  // CaptureMatch is a Record<tag, Capture>. Compare by structural JSON
  // so Node references don't create false negatives.
  return caps.map((m) => {
    const out: Record<string, unknown> = {};
    for (const [tag, cap] of Object.entries(m)) {
      const c = cap as { range?: unknown; text?: unknown };
      out[tag] = { range: c.range, text: c.text };
    }
    return out;
  });
}

describe('emitPythonScopeCaptures cache-hit parity', () => {
  it('returns identical captures whether cachedTree is supplied or not', () => {
    const fresh = emitPythonScopeCaptures(FIXTURE, 'fixture.py');
    const tree = getPythonParser().parse(FIXTURE);
    const cached = emitPythonScopeCaptures(FIXTURE, 'fixture.py', tree);

    expect(cached).toHaveLength(fresh.length);
    expect(normalizeCaptures(cached)).toEqual(normalizeCaptures(fresh));
  });

  it('counters stay at zero baseline after reset regardless of whether PROF is active', () => {
    // The PROF gate is evaluated at module load, so we can't toggle
    // counters on mid-test. What we CAN assert deterministically is
    // that reset zeros the counters and repeated reads yield the same
    // zeroed snapshot (counter API shape invariant).
    resetPythonCaptureCacheStats();
    expect(getPythonCaptureCacheStats()).toEqual({ hits: 0, misses: 0 });
    // Running the emit path should not mutate the counters unless PROF
    // was on at module load. Whichever state, calling reset again must
    // return to zero.
    const tree = getPythonParser().parse(FIXTURE);
    emitPythonScopeCaptures(FIXTURE, 'fixture.py', tree);
    emitPythonScopeCaptures(FIXTURE, 'fixture.py');
    resetPythonCaptureCacheStats();
    expect(getPythonCaptureCacheStats()).toEqual({ hits: 0, misses: 0 });
  });
});
