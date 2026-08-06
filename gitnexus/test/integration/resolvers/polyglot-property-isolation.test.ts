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
});
