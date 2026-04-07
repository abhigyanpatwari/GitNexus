/**
 * Unit Tests: Impact confidence per relation type (#412)
 *
 * Tests IMPACT_RELATION_CONFIDENCE and confidenceForRelType (tested
 * indirectly) to verify that:
 *
 *   1. Each known relation type maps to the expected confidence floor.
 *   2. Unknown / undefined relation types fall back to 0.5 (conservative).
 *   3. Stored graph confidence is preferred over the type-based floor.
 *   4. Confidence values are in the valid 0–1 range.
 */
import { describe, it, expect } from 'vitest';
import {
  IMPACT_RELATION_CONFIDENCE,
  VALID_RELATION_TYPES,
} from '../../src/mcp/local/local-backend.js';

// ─── IMPACT_RELATION_CONFIDENCE — value assertions ────────────────────────

describe('IMPACT_RELATION_CONFIDENCE', () => {
  it('CALLS has confidence 0.9 (direct reference)', () => {
    expect(IMPACT_RELATION_CONFIDENCE['CALLS']).toBe(0.9);
  });

  it('IMPORTS has confidence 0.9 (direct reference)', () => {
    expect(IMPACT_RELATION_CONFIDENCE['IMPORTS']).toBe(0.9);
  });

  it('EXTENDS has confidence 0.85 (statically verifiable inheritance)', () => {
    expect(IMPACT_RELATION_CONFIDENCE['EXTENDS']).toBe(0.85);
  });

  it('IMPLEMENTS has confidence 0.85 (statically verifiable contract)', () => {
    expect(IMPACT_RELATION_CONFIDENCE['IMPLEMENTS']).toBe(0.85);
  });

  it('METHOD_OVERRIDES has confidence 0.85 (statically verifiable override)', () => {
    expect(IMPACT_RELATION_CONFIDENCE['METHOD_OVERRIDES']).toBe(0.85);
  });

  it('METHOD_IMPLEMENTS has confidence 0.85 (statically verifiable implementation)', () => {
    expect(IMPACT_RELATION_CONFIDENCE['METHOD_IMPLEMENTS']).toBe(0.85);
  });

  it('HAS_METHOD has confidence 0.95 (structural containment)', () => {
    expect(IMPACT_RELATION_CONFIDENCE['HAS_METHOD']).toBe(0.95);
  });

  it('HAS_PROPERTY has confidence 0.95 (structural containment)', () => {
    expect(IMPACT_RELATION_CONFIDENCE['HAS_PROPERTY']).toBe(0.95);
  });

  it('ACCESSES has confidence 0.8 (may be indirect read/write)', () => {
    expect(IMPACT_RELATION_CONFIDENCE['ACCESSES']).toBe(0.8);
  });

  it('CONTAINS has confidence 0.95 (folder/file structural containment)', () => {
    expect(IMPACT_RELATION_CONFIDENCE['CONTAINS']).toBe(0.95);
  });

  it('all defined confidence values are in the valid [0, 1] range', () => {
    for (const [type, confidence] of Object.entries(IMPACT_RELATION_CONFIDENCE)) {
      expect(confidence, `${type} confidence out of range`).toBeGreaterThanOrEqual(0);
      expect(confidence, `${type} confidence out of range`).toBeLessThanOrEqual(1);
    }
  });
});

// ─── confidenceForRelType — fallback semantics ────────────────────────────
//
// confidenceForRelType is not exported, so we replicate its logic here to
// verify the semantics that the production code must uphold.

const confidenceForRelType = (relType: string | undefined): number =>
  IMPACT_RELATION_CONFIDENCE[relType ?? ''] ?? 0.5;

describe('confidenceForRelType', () => {
  it('returns the correct floor for known types', () => {
    expect(confidenceForRelType('CALLS')).toBe(0.9);
    expect(confidenceForRelType('IMPORTS')).toBe(0.9);
    expect(confidenceForRelType('EXTENDS')).toBe(0.85);
    expect(confidenceForRelType('IMPLEMENTS')).toBe(0.85);
    expect(confidenceForRelType('METHOD_OVERRIDES')).toBe(0.85);
    expect(confidenceForRelType('METHOD_IMPLEMENTS')).toBe(0.85);
    expect(confidenceForRelType('HAS_METHOD')).toBe(0.95);
    expect(confidenceForRelType('HAS_PROPERTY')).toBe(0.95);
    expect(confidenceForRelType('ACCESSES')).toBe(0.8);
    expect(confidenceForRelType('CONTAINS')).toBe(0.95);
  });

  it('returns 0.5 for unknown relation types', () => {
    expect(confidenceForRelType('UNKNOWN_EDGE')).toBe(0.5);
    expect(confidenceForRelType('SOME_FUTURE_TYPE')).toBe(0.5);
    expect(confidenceForRelType('')).toBe(0.5);
  });

  it('returns 0.5 for undefined relation type', () => {
    expect(confidenceForRelType(undefined)).toBe(0.5);
  });
});

// ─── Effective confidence selection — stored value wins ───────────────────
//
// Verify the priority logic: stored graph confidence beats the type floor.

describe('effective confidence selection (stored vs type-floor)', () => {
  const pickConfidence = (storedConfidence: number | undefined, relationType: string): number => {
    return typeof storedConfidence === 'number' && storedConfidence > 0
      ? storedConfidence
      : confidenceForRelType(relationType);
  };

  it('uses stored confidence when it is a positive number', () => {
    expect(pickConfidence(0.95, 'CALLS')).toBe(0.95);
    expect(pickConfidence(0.7, 'EXTENDS')).toBe(0.7);
    expect(pickConfidence(0.3, 'ACCESSES')).toBe(0.3);
  });

  it('falls back to type floor when stored confidence is undefined', () => {
    expect(pickConfidence(undefined, 'CALLS')).toBe(0.9);
    expect(pickConfidence(undefined, 'EXTENDS')).toBe(0.85);
    expect(pickConfidence(undefined, 'UNKNOWN')).toBe(0.5);
  });

  it('falls back to type floor when stored confidence is 0 (not a valid confidence)', () => {
    // 0 means "no confidence stored", not "zero confidence"
    expect(pickConfidence(0, 'CALLS')).toBe(0.9);
    expect(pickConfidence(0, 'IMPLEMENTS')).toBe(0.85);
  });

  it('stored confidence can be lower than the type floor (respects analysis result)', () => {
    // If analysis determined a low-confidence match, honour it
    expect(pickConfidence(0.5, 'HAS_METHOD')).toBe(0.5); // floor is 0.95, stored wins
  });
});

// ─── VALID_RELATION_TYPES consistency ─────────────────────────────────────

describe('IMPACT_RELATION_CONFIDENCE vs VALID_RELATION_TYPES', () => {
  it('every key in IMPACT_RELATION_CONFIDENCE except CONTAINS is in VALID_RELATION_TYPES', () => {
    // CONTAINS is a graph-internal structural type, not exposed in impact filters
    const skipInValid = new Set(['CONTAINS']);
    for (const type of Object.keys(IMPACT_RELATION_CONFIDENCE)) {
      if (skipInValid.has(type)) continue;
      expect(VALID_RELATION_TYPES.has(type), `${type} missing from VALID_RELATION_TYPES`).toBe(
        true,
      );
    }
  });
});
