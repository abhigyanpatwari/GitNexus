/**
 * #2744 — the summary `impact()`/`context()` read to decide exact vs
 * lower-bound. Keyed by member name because a dropped site's callee is
 * unknown; see the module doc for why per-target attribution is impossible.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_UNRESOLVED_RECEIVER_MEMBERS,
  lookupUnresolvedCallCount,
  summarizeUnresolvedReceivers,
} from '../../../src/core/ingestion/scope-resolution/unresolved-receivers.js';
import type { ResolutionOutcome } from '../../../src/core/ingestion/scope-resolution/resolution-outcome.js';

const range = { startLine: 1, startCol: 0, endLine: 1, endCol: 1 };

function dropped(name: string, siteKind: 'call' | 'read' | 'write' = 'call'): ResolutionOutcome {
  return {
    kind: 'suppressed',
    reason: 'receiver-unresolved',
    candidateIds: [],
    phase: 'receiver-bound-calls',
    filePath: 'a.py',
    name,
    range,
    siteKind,
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

  it('counts CALL sites only — a property read or write is not a dropped call', () => {
    // Case 0's recorder gates on the receiver's punctuation, not on what the
    // reference IS, so reads and writes land in the same bucket as lost calls
    // (25 of 124 on the fixture corpus). Counting them made the consumer's
    // "N call sites invoking X were dropped" literally false.
    const summary = summarizeUnresolvedReceivers([
      dropped('save', 'call'),
      dropped('name', 'write'),
      dropped('kind', 'read'),
    ]);
    expect(summary).toMatchObject({ counts: { save: 1 }, totalSites: 1 });
    expect(summary?.counts).not.toHaveProperty('name');
    expect(summary?.counts).not.toHaveProperty('kind');
  });

  it('returns undefined when every drop is a property access', () => {
    expect(summarizeUnresolvedReceivers([dropped('name', 'write')])).toBeUndefined();
  });

  it('does not leak Object.prototype members through the counts lookup', () => {
    // `counts` is revived from JSON and carries `Object.prototype`, so a bare
    // `counts[symName]` returns a FUNCTION for these names — and `NaN <= 0` is
    // false, so a `<= 0` guard lets it through. `impact({target:"constructor"})`
    // then reported `epistemic: 'lower-bound'` and interpolated
    // `function Object() { [native code] }` as the call count.
    const summary = summarizeUnresolvedReceivers([dropped('save')]);
    for (const polluted of [
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString',
      '__proto__',
    ]) {
      expect(lookupUnresolvedCallCount(summary, polluted)).toBeUndefined();
    }
    // A genuinely recorded name still reads back.
    expect(lookupUnresolvedCallCount(summary, 'save')).toBe(1);
    expect(lookupUnresolvedCallCount(summary, 'neverRecorded')).toBeUndefined();
    expect(lookupUnresolvedCallCount(undefined, 'save')).toBeUndefined();
  });
});
