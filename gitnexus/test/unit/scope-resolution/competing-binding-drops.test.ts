/**
 * The summary `impact()`/`context()` read to report a lower bound when a
 * competing-binding barrier dropped a free call. Keyed by name, like the
 * unresolved-receiver summary, and counted separately from it.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_COMPETING_BINDING_NAMES,
  lookupCompetingBindingDropCount,
  summarizeCompetingBindingDrops,
} from '../../../src/core/ingestion/scope-resolution/competing-binding-drops.js';
import type { ResolutionOutcome } from '../../../src/core/ingestion/scope-resolution/resolution-outcome.js';

let nextLine = 1;

function dropped(
  name: string,
  reason: 'competing-binding-barrier' | 'receiver-unresolved' = 'competing-binding-barrier',
  siteKind: 'call' | 'read' = 'call',
  line = nextLine++,
): ResolutionOutcome {
  return {
    kind: 'suppressed',
    reason,
    candidateIds: [],
    phase: 'free-call-fallback',
    filePath: 'app.py',
    name,
    range: { startLine: line, startCol: 0, endLine: line, endCol: 1 },
    siteKind,
  };
}

describe('summarizeCompetingBindingDrops', () => {
  it('stores no key when no barrier dropped a call', () => {
    expect(summarizeCompetingBindingDrops([])).toBeUndefined();
    expect(summarizeCompetingBindingDrops([dropped('speedy', 'receiver-unresolved')])).toBe(
      undefined,
    );
  });

  it('counts only call sites dropped at the barrier', () => {
    const summary = summarizeCompetingBindingDrops([
      dropped('speedy'),
      dropped('speedy'),
      dropped('slow'),
      dropped('speedy', 'receiver-unresolved'),
      dropped('speedy', 'competing-binding-barrier', 'read'),
    ]);
    expect(summary).toEqual({ counts: { speedy: 2, slow: 1 }, totalSites: 3 });
  });

  it('counts a site recorded under an alias and its source name once', () => {
    const summary = summarizeCompetingBindingDrops([
      dropped('fast_impl', 'competing-binding-barrier', 'call', 900),
      dropped('speedy', 'competing-binding-barrier', 'call', 900),
    ]);
    expect(summary).toEqual({ counts: { fast_impl: 1, speedy: 1 }, totalSites: 1 });
  });

  it('caps distinct names and reports the truncation', () => {
    const outcomes = Array.from({ length: MAX_COMPETING_BINDING_NAMES + 1 }, (_, i) =>
      dropped(`name${i}`),
    );
    const summary = summarizeCompetingBindingDrops(outcomes)!;
    expect(Object.keys(summary.counts)).toHaveLength(MAX_COMPETING_BINDING_NAMES);
    expect(summary.totalSites).toBe(MAX_COMPETING_BINDING_NAMES + 1);
    expect(summary.omittedNames).toBe(1);
  });

  it('looks names up prototype-safely after a JSON round-trip', () => {
    const summary = JSON.parse(JSON.stringify(summarizeCompetingBindingDrops([dropped('speedy')])));
    expect(lookupCompetingBindingDropCount(summary, 'speedy')).toBe(1);
    expect(lookupCompetingBindingDropCount(summary, 'constructor')).toBeUndefined();
    expect(lookupCompetingBindingDropCount(undefined, 'speedy')).toBeUndefined();
  });
});
