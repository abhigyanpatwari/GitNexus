/**
 * Boundary tests for the incremental escalation gate (#2409, KTD8 of the
 * tri-review 4669518496 fix series).
 *
 * Pure predicate — no DB, no orchestration. Pins every corner of the
 * AND-gate so an `&&`→`||` (or `>`→`>=`) mutation cannot survive CI, which
 * closes the mutation-testing gap the review flagged without multi-minute
 * orchestration permutation runs. The valve's observable behavior stays
 * covered by the existing incremental-orchestration suite.
 */
import { describe, expect, it } from 'vitest';
import {
  INCREMENTAL_ESCALATION_MIN_FILES,
  INCREMENTAL_MAX_WRITE_FRACTION,
  shouldEscalateIncrementalWrite,
} from '../../src/core/incremental/escalation-gate.js';

describe('shouldEscalateIncrementalWrite (#2409 escalation valve gate)', () => {
  it('stays surgical below the delete floor even at a huge write fraction (49 deletes, 90%)', () => {
    expect(shouldEscalateIncrementalWrite(49, 90, 100)).toBe(false);
  });

  it('escalates at the delete floor once the fraction crosses the cap (50 deletes, 51%)', () => {
    expect(shouldEscalateIncrementalWrite(50, 51, 100)).toBe(true);
  });

  it('does NOT escalate at exactly the cap — the fraction comparison is strict > (50 deletes, 50%)', () => {
    expect(shouldEscalateIncrementalWrite(50, 50, 100)).toBe(false);
  });

  it('stays surgical below the fraction cap regardless of delete volume (5000 deletes, 49%)', () => {
    expect(shouldEscalateIncrementalWrite(5000, 4900, 10000)).toBe(false);
  });

  it('tolerates the population mismatch: a fraction above 1 escalates', () => {
    // The numerator may include now-deleted paths surfaced by the importer
    // BFS from the PRE-pipeline DB, so effectiveWriteCount can exceed the
    // current file list and the fraction can exceed 1 — documented on the
    // predicate's TSDoc; escalation is the safe direction for such inputs.
    expect(shouldEscalateIncrementalWrite(60, 120, 100)).toBe(true);
  });

  it('exports the thresholds unchanged from the pre-extraction valve (#2409)', () => {
    expect(INCREMENTAL_ESCALATION_MIN_FILES).toBe(50);
    expect(INCREMENTAL_MAX_WRITE_FRACTION).toBe(0.5);
  });
});
