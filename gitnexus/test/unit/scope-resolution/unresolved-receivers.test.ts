/**
 * #2744 — the summary `impact()`/`context()` read to decide exact vs
 * lower-bound. Keyed by member name because a dropped site's callee is
 * unknown; see the module doc for why per-target attribution is impossible.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_UNRESOLVED_RECEIVER_MEMBERS,
  summarizeUnresolvedReceivers,
} from '../../../src/core/ingestion/scope-resolution/unresolved-receivers.js';
import type { ResolutionOutcome } from '../../../src/core/ingestion/scope-resolution/resolution-outcome.js';

const range = { startLine: 1, startCol: 0, endLine: 1, endCol: 1 };

function dropped(name: string): ResolutionOutcome {
  return {
    kind: 'suppressed',
    reason: 'receiver-unresolved',
    candidateIds: [],
    phase: 'receiver-bound-calls',
    filePath: 'a.py',
    name,
    range,
  };
}

describe('summarizeUnresolvedReceivers', () => {
  it('returns undefined when nothing was dropped, so a clean repo stores no key', () => {
    expect(summarizeUnresolvedReceivers([])).toBeUndefined();
  });

  it('ignores suppressions that are not receiver-unresolved', () => {
    const ambiguous: ResolutionOutcome = {
      kind: 'suppressed',
      reason: 'member-lookup-ambiguous',
      candidateIds: ['a', 'b'],
      phase: 'receiver-bound-calls',
      filePath: 'a.py',
      name: 'save',
      range,
    };
    const resolved: ResolutionOutcome = {
      kind: 'resolved',
      targetId: 't',
      phase: 'receiver-bound-calls',
      filePath: 'a.py',
      name: 'save',
      range,
    };
    expect(summarizeUnresolvedReceivers([ambiguous, resolved])).toBeUndefined();
  });

  it('counts dropped sites per member name', () => {
    expect(
      summarizeUnresolvedReceivers([dropped('save'), dropped('save'), dropped('run')]),
    ).toMatchObject({
      counts: { save: 2, run: 1 },
      totalSites: 3,
    });
  });

  it('caps the map, keeps the highest counts, and reports what it omitted', () => {
    const outcomes: ResolutionOutcome[] = [];
    // One name well past the cap that must survive on count alone.
    for (let i = 0; i < 5; i++) outcomes.push(dropped('zzz_hottest'));
    for (let i = 0; i < MAX_UNRESOLVED_RECEIVER_MEMBERS + 10; i++) {
      outcomes.push(dropped(`member${i}`));
    }
    const summary = summarizeUnresolvedReceivers(outcomes);
    expect(Object.keys(summary!.counts)).toHaveLength(MAX_UNRESOLVED_RECEIVER_MEMBERS);
    expect(summary!.counts.zzz_hottest).toBe(5);
    // The true total always reflects every drop, not just the kept sample.
    expect(summary!.totalSites).toBe(MAX_UNRESOLVED_RECEIVER_MEMBERS + 15);
    expect(summary!.omittedNames).toBe(11);
  });

  it('orders deterministically so the persisted metadata does not churn', () => {
    const a = summarizeUnresolvedReceivers([dropped('b'), dropped('a'), dropped('c')]);
    const b = summarizeUnresolvedReceivers([dropped('c'), dropped('b'), dropped('a')]);
    expect(Object.keys(a!.counts)).toEqual(Object.keys(b!.counts));
  });
});
