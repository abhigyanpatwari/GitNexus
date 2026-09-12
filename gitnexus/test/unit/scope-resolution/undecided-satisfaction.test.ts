import { describe, expect, it } from 'vitest';
import {
  MAX_UNDECIDED_INTERFACES,
  summarizeUndecidedSatisfaction,
} from '../../../src/core/ingestion/scope-resolution/undecided-satisfaction.js';
import type { UndecidedSatisfaction } from '../../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';

function record(interfaceName: string, candidateNames: readonly string[]): UndecidedSatisfaction {
  return {
    interfaceDefId: `iface:${interfaceName}`,
    interfaceName,
    filePath: 'store/store.go',
    undecidedCandidates: candidateNames.length,
    candidateNames,
  };
}

describe('summarizeUndecidedSatisfaction', () => {
  // Absence has to stay distinguishable from a zeroed record: an index that
  // decided everything and an index written before this field existed both read
  // as absent, and neither is "we looked and found nothing to report".
  it('returns undefined when nothing was undecided', () => {
    expect(summarizeUndecidedSatisfaction([])).toBeUndefined();
  });

  it('records both sides of every undecided pair', () => {
    const summary = summarizeUndecidedSatisfaction([
      record('CtxStore', ['CtxStoreImpl', 'MemStore']),
      record('RetStore', ['CtxStoreImpl']),
    ]);

    expect(summary).toEqual({
      counts: { CtxStore: 2, RetStore: 1 },
      totalInterfaces: 2,
      totalCandidates: 3,
      // `CtxStoreImpl` was a candidate for BOTH interfaces — this is the key a
      // query on the implementation matches against, and the reason the
      // reported symptom (`impact` on the impl method) can be hedged at all.
      candidateCounts: { CtxStoreImpl: 2, MemStore: 1 },
    });
  });

  it('keeps the true totals when the map is capped', () => {
    const many = Array.from({ length: MAX_UNDECIDED_INTERFACES + 10 }, (_, i) =>
      record(`Iface${String(i).padStart(4, '0')}`, [`Impl${i}`]),
    );

    const summary = summarizeUndecidedSatisfaction(many)!;

    expect(Object.keys(summary.counts)).toHaveLength(MAX_UNDECIDED_INTERFACES);
    // The sample is visibly a sample: totals count everything, including what
    // the cap dropped, so a consumer can never mistake `counts` for the whole.
    expect(summary.totalInterfaces).toBe(MAX_UNDECIDED_INTERFACES + 10);
    expect(summary.totalCandidates).toBe(MAX_UNDECIDED_INTERFACES + 10);
    // No `omittedInterfaces`: it is exactly `totalInterfaces - keys(counts)`,
    // and one persisted field per fact is enough.
    expect(summary.omittedCandidates).toBe(10);
  });

  // The tiebreak decides WHICH entries survive the cap, so it has to be stable
  // across machines — a locale-sensitive compare would not be.
  it('ranks by count, then by name, deterministically', () => {
    const summary = summarizeUndecidedSatisfaction([
      record('Zebra', ['A']),
      record('Alpha', ['A']),
      record('Busy', ['A', 'B', 'C']),
    ])!;

    expect(Object.keys(summary.counts)).toEqual(['Busy', 'Alpha', 'Zebra']);
  });
});
