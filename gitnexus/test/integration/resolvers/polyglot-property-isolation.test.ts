/**
 * RV-5 — unique-name property inference must not cross a language boundary.
 *
 * The pass indexed `Property` nodes from the whole shared graph. Per-language
 * gating (`fieldFallbackOnMethodLookup`) decides whether the pass RUNS for a
 * language; it never restricted which nodes could be TARGETS. So the only
 * carrier of a name might be in another language entirely, and a read here
 * resolved to it on name uniqueness alone — no owner, no file, no call path.
 *
 * Confidence does not mitigate it: `minConfidence` defaults to 0, so a consumer
 * gets the edge unless it opts out explicitly.
 *
 * Every other fixture is single-language, so this could not be caught by
 * construction anywhere in the suite.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('cross-language property inference (RV-5)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'polyglot-property-isolation'),
      () => {},
    );
  }, 60000);

  const readersOf = (field: string): string[] =>
    getRelationships(result, 'ACCESSES')
      .filter((e) => e.target === field)
      .map((e) => e.source);

  it('does not link a JS read to a Java field of the same name', () => {
    expect(readersOf('loyaltyPointsBalance')).not.toContain('renderLoyalty');
  });

  // The other half: restricting by language must not disable the pass.
  it('still resolves a same-language unique name', () => {
    expect(readersOf('jsOnlyThreshold')).toContain('readsJsOnly');
  });

  // R3-1. Declining is correct; being SILENT about declining is not. An empty
  // result here is byte-identical to "this field is unused", and the difference
  // matters enormously — one says look elsewhere, the other says delete it.
  // Reported out-of-sample: six fields in the reporting repo whose only
  // definitions are TypeScript answered 0 for every backend read.
  describe('reports the cross-language anchor (R3-1)', () => {
    // NO `if (undefined) return` escape here. An earlier version of these
    // assertions read the fact off a `scopeResolution` field that does not
    // exist on PipelineResult, so every one of them bailed at that guard and
    // passed with the production code deleted. The field is now published, and
    // asserting it is present is the first thing these check.
    const inference = (): NonNullable<PipelineResult['propertyInference']> => {
      const v = result.propertyInference;
      expect(v).toBeDefined();
      return v!;
    };

    it('counts the sites it declined for language reasons', () => {
      expect(inference().crossLanguage).toBeGreaterThan(0);
    });

    it('names the field and the language its anchor actually lives in', () => {
      const hit = inference().crossLanguageNames.find((e) => e.name === 'loyaltyPointsBalance');
      expect(hit).toBeDefined();
      // The actionable half: not just "we declined" but "look in Java".
      expect(hit?.languages).toContain('java');
    });

    // Ambiguity and cross-language are different failures with different
    // remedies — better receiver typing versus an anchor in this language — so
    // collapsing them would tell a reader the wrong thing to do.
    it('does not count a cross-language decline as an ambiguity', () => {
      expect(inference().ambiguousNames).not.toContain('loyaltyPointsBalance');
    });
  });
});
