/**
 * TypeScript: a callable chosen by a value-selecting expression (#3354).
 *
 * `const sweep = env.__sweep ?? runSweep; await sweep(env)` is how the
 * reporter's Cloudflare worker made its sweep injectable in tests. The
 * callable-value flow only accepted a single designator on the right-hand
 * side, so the `??` produced no flow, `scheduled` never showed up as a caller
 * of `runSweep`, and `impact` answered with one caller fewer while still
 * claiming `epistemic: "exact"`. Each branch of `??`, `||`, and `?:` can be
 * the value that is later invoked, so each branch is a flow into the binding.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

/**
 * `&&` is not value-selecting for a callable, so #3354 leaves it on the single-
 * source path: whatever the pre-#3354 capture (one seed for the last operand,
 * qualified by the whole expression, byte-identical before and after this
 * change) resolved to must stay exactly that: no edge at all.
 */
const PRE_3354_LOGICAL_AND_EDGES: string[] = [];

describe('TypeScript callable chosen by ?? / || / ?:', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'typescript-callable-alternatives'),
      () => {},
    );
  }, 60000);

  const calls = () => edgeSet(getRelationships(result, 'CALLS'));

  it('control: a plain alias reaches its callee', () => {
    expect(calls()).toContain('aliasOnly → runAlias');
  });

  it('`a ?? fn` reaches fn', () => {
    expect(calls()).toContain('nullish → runSweep');
  });

  it('`a ?? fn` inside an object-literal method reaches fn (worker `scheduled`)', () => {
    expect(calls()).toContain('scheduled → runSweep');
  });

  it('`a || fn` reaches fn', () => {
    expect(calls()).toContain('logicalOr → runOr');
  });

  it('`c ? f : g` reaches both branches', () => {
    expect(calls()).toEqual(expect.arrayContaining(['ternary → runThen', 'ternary → runElse']));
  });

  it('a chain `a ?? b ?? fn` reaches fn', () => {
    expect(calls()).toContain('chained → runChained');
  });

  it('a parenthesized `(a ?? fn)` reaches fn', () => {
    expect(calls()).toContain('parenthesized → runParen');
  });

  it('a callable LEFT operand `fn ?? fallback` reaches fn', () => {
    expect(calls()).toContain('callableLeft → runLeft');
  });

  it('`&&` is not expanded: its left operand gains no edge', () => {
    const fromLogicalAnd = calls().filter((edge) => edge.startsWith('logicalAnd → '));
    expect(fromLogicalAnd).toEqual(PRE_3354_LOGICAL_AND_EDGES);
  });
});
