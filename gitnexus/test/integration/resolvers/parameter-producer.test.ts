/**
 * CALLER-DERIVED PARAMETER TYPES (W2-2).
 *
 * `function f(spike) { return spike.wickRatio }` had nothing to type `spike`
 * from, so the read fell through to the 0.5 name tier. That is the standing
 * limit of R3-5 and, measured on the reporting repo, by far the largest one:
 * 11,012 of 13,672 property edges (81%) rest on that name guess.
 *
 * The two facts needed were already extracted for the callable-value-flow
 * solver — a `formal` site naming a function's parameter by index, and an
 * `argument` site naming what reaches that index at a call. Joining them types
 * the parameter from its callers with no new capture and no parse-time change.
 *
 * Two producers here share `wickRatio` ON PURPOSE. That is precisely the shape
 * name inference must refuse, so an edge to the RIGHT one is only meaningful
 * while the wrong one is also a candidate.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('caller-derived parameter types (W2-2)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'parameter-producer'), () => {});
  }, 60000);

  /**
   * Precise (0.9) return-shape targets for one reader.
   *
   * `inFile` is not decoration: the fixture deliberately declares TWO functions
   * named `readSpike`, so filtering on the name alone would merge two different
   * symbols' edges and report a passing count for the wrong reason.
   */
  const preciseTargetsOf = (reader: string, inFile?: string): string[] =>
    getRelationships(result, 'ACCESSES')
      .filter(
        (e) =>
          e.source === reader &&
          e.targetLabel === 'Property' &&
          e.rel.confidence === 0.9 &&
          (inFile === undefined || e.sourceFilePath.endsWith(inFile)),
      )
      .map((e) => e.rel.targetId);

  it('types a bare parameter from its single caller', () => {
    const targets = preciseTargetsOf('readSpike', 'consumer.js');
    expect(targets).toHaveLength(1);
    expect(targets[0]).toContain('makeSpike.wickRatio');
  });

  it('does not reach the OTHER producer of the same field name', () => {
    // `makeCandle.wickRatio` exists and is a candidate for any name-based join.
    expect(preciseTargetsOf('readSpike', 'consumer.js')[0]).not.toContain('makeCandle');
  });

  it('claims nothing when two callers pass DIFFERENT producers', () => {
    // Which shape `thing` holds depends on the call. Picking one would fabricate
    // at the 0.9 precise tier, which no `minConfidence` floor can filter out.
    expect(preciseTargetsOf('readEither')).toEqual([]);
  });

  it('claims nothing for a parameter no caller types', () => {
    expect(preciseTargetsOf('readUncalled')).toEqual([]);
  });
  it('matches the formal by PARAMETER INDEX, not merely by callee', () => {
    // `readSecond(first, second)` is called as `readSecond(1, c)`. Only index 1
    // carries a producer; a rule that ignored the index would type `first`.
    const targets = preciseTargetsOf('readSecond');
    expect(targets).toHaveLength(1);
    expect(targets[0]).toContain('makeCandle.wickRatio');
  });

  it('keeps same-named functions in different files apart', () => {
    // `other.js` declares its own `readSpike`, called with a DIFFERENT producer.
    // Keyed without the declaring file, the two formals collide and both
    // parameters go ambiguous — so both readers would silently lose their edge.
    const here = preciseTargetsOf('readSpike', 'consumer.js');
    const there = preciseTargetsOf('readSpike', 'other.js');
    expect(here).toHaveLength(1);
    expect(here[0]).toContain('makeSpike.wickRatio');
    // The other file's twin is typed from ITS caller, not from this one's.
    expect(there).toHaveLength(1);
    expect(there[0]).toContain('makeCandle.source');
  });
});
