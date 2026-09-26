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
 * `a && b` can only yield a callable through `b`, so only `b` flows.
 * A branch that is itself a comparison or arithmetic expression yields a
 * computed value, so it flows nothing (compare.ts).
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

describe('TypeScript callable chosen by ?? / || / ?: / &&', () => {
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

  it('`a && fn` reaches fn and never the left operand', () => {
    const fromLogicalAnd = calls().filter((edge) => edge.startsWith('logicalAnd → '));
    expect(fromLogicalAnd).toEqual(['logicalAnd → runAndRight']);
  });

  // `x.kind === Handlers.run` emitted as its own source becomes a seed whose
  // qualified text slices to receiver `Handlers` and member `run`.
  it('a comparison branch never reaches the static member it compares against', () => {
    const fromComparisons = calls().filter(
      (edge) => edge.startsWith('comparisonBranch → ') || edge.startsWith('staticComparison → '),
    );
    expect(fromComparisons).toEqual([]);
  });

  it('a comparison or arithmetic branch never reaches a same-named method of `this`', () => {
    const fromOperators = calls().filter(
      (edge) =>
        edge.startsWith('bareComparison → ') ||
        edge.startsWith('arithmeticBranch → ') ||
        edge.startsWith('thisComparison → ') ||
        edge.startsWith('ternaryComparison → '),
    );
    expect(fromOperators).toEqual([]);
  });
});
