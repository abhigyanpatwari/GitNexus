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

  /**
   * Every precise (0.9) return-shape target emitted from ONE fixture file.
   *
   * Scoped by FILE rather than by reader name because the fixtures below turn
   * on two callables sharing a name: filtering by the name would report which
   * of the twins was typed, and the property under test is that NEITHER is.
   */
  const preciseTargetsInFile = (file: string): string[] =>
    getRelationships(result, 'ACCESSES')
      .filter(
        (e) =>
          e.targetLabel === 'Property' &&
          e.rel.confidence === 0.9 &&
          e.sourceFilePath.endsWith(file),
      )
      .map((e) => e.rel.targetId);

  it('keeps same-named callables in ONE file apart — free vs nested function', () => {
    // The declaring FILE separates `readSpike` from `other.js`'s twin, but not
    // a free `parse` from a `parse` nested inside `outer`: a `formal`'s owner is
    // a bare identifier, so both key parameter 0 identically. Last-write-wins
    // then gives `callParse`'s `makeSpike` to whichever formal was visited last
    // — an edge at the 0.9 PRECISE tier for a call that never happened.
    expect(preciseTargetsInFile('same-file-nested.js')).toEqual([]);
  });

  it('keeps same-named callables in ONE file apart — free function vs method', () => {
    // `Runner.apply` owns its formal under the bare name `apply`, so it
    // collides with the free `apply` exactly as the nested function does.
    expect(preciseTargetsInFile('same-file-method.js')).toEqual([]);
  });

  it('does not type a shadowing ARROW parameter from the enclosing formal', () => {
    // `items.map((spike) => spike.wickRatio)` inside `readShadowedArrow(spike, …)`.
    // The arrow rebinds `spike`; an anonymous arrow emits no `formal` site, so
    // its scope looks empty to a producer-only walk and the ARRAY ELEMENT gets
    // typed from the outer parameter's callers.
    expect(preciseTargetsInFile('shadow-arrow.js')).toEqual([]);
  });

  it('does not type a shadowing block-scoped CONST from the enclosing formal', () => {
    // `{ const item = rows[0]; return item.wickRatio }` inside
    // `readShadowedConst(item, rows)`. The block binds the name nearer than the
    // formal whose callers were measured. The initializer is a subscript
    // deliberately: `const item = rows` would bind `item` through the
    // type-binding alias channel and the pass would decline before the scope
    // walk ever ran, passing this test for the wrong reason.
    expect(preciseTargetsInFile('shadow-const.js')).toEqual([]);
  });

  it('still reaches the formal through a block that shadows nothing', () => {
    // The guard must stop at a scope binding THIS name, not at any binding
    // scope: `{ const label = 1; … spike.wickRatio }` still reads the formal.
    const targets = preciseTargetsInFile('nested-block.js');
    expect(targets).toHaveLength(1);
    expect(targets[0]).toContain('makeSpike.wickRatio');
  });
});
