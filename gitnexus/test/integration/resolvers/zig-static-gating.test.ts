/**
 * Zig: static-gated CALLS edges.
 *
 * Verifies that calls inside `if (CONST_FALSE)` branches (and trivial
 * boolean-and / boolean-or extensions) get tagged with
 * `staticGated: true` on the emitted CALLS edge, while calls outside
 * such branches keep `staticGated` falsy.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('Zig static-gated edges', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'zig-static-gating'),
      () => {},
    );
  }, 60000);

  function isGated(callee: string): boolean | undefined {
    const calls = getRelationships(result, 'CALLS').filter((e) => e.target === callee);
    if (calls.length === 0) return undefined;
    // If any caller-edge to `callee` carries staticGated, treat as gated.
    return calls.some((c) => c.rel.staticGated === true);
  }

  it('tags calls inside `if (UPGRADERS_ENABLED)` as staticGated', () => {
    expect(isGated('gated_simple')).toBe(true);
  });

  it('tags `if (FALSE and other)` as staticGated (and-left)', () => {
    expect(isGated('gated_and_left')).toBe(true);
  });

  it('tags `if (other and FALSE)` as staticGated (and-right)', () => {
    expect(isGated('gated_and_right')).toBe(true);
  });

  it('tags `if (FALSE or FALSE)` as staticGated', () => {
    expect(isGated('gated_or_both_false')).toBe(true);
  });

  it('does NOT tag unconditional calls', () => {
    expect(isGated('live_unconditional')).toBe(false);
  });

  it('does NOT tag calls under `if (TRUE_CONST)`', () => {
    expect(isGated('live_under_true_const')).toBe(false);
  });

  it('does NOT tag `if (FALSE or TRUE)` (disjunction is true)', () => {
    expect(isGated('live_or_one_true')).toBe(false);
  });

  it('does NOT tag calls under unknown / runtime conditions', () => {
    expect(isGated('live_under_unknown')).toBe(false);
  });

  it('does NOT tag calls under `if (var FOO = false)` (var is mutable global, not const)', () => {
    expect(isGated('live_under_var')).toBe(false);
  });

  it('tags `if (FOO == true)` when FOO is false', () => {
    expect(isGated('gated_eq_true')).toBe(true);
  });

  it('tags `if (FOO == false)` when FOO is true', () => {
    expect(isGated('gated_eq_false')).toBe(true);
  });

  it('tags `if (FOO != false)` when FOO is false', () => {
    expect(isGated('gated_neq_false')).toBe(true);
  });

  it('tags `if (FOO != true)` when FOO is true', () => {
    expect(isGated('gated_neq_true')).toBe(true);
  });

  it('does NOT tag `if (false == FOO)` when FOO is false (provably TRUE)', () => {
    expect(isGated('live_sym_eq')).toBe(false);
  });

  it('tags re-aliased const chain (1 hop)', () => {
    expect(isGated('gated_alias_one')).toBe(true);
  });

  it('tags re-aliased const chain (2 hops)', () => {
    expect(isGated('gated_alias_two')).toBe(true);
  });

  it('tags re-aliased const chain (3 hops)', () => {
    expect(isGated('gated_alias_three')).toBe(true);
  });

  it('does NOT tag alias chain that exits to unknown identifier', () => {
    expect(isGated('live_alias_to_unknown')).toBe(false);
  });

  it('does NOT tag (and does not infinite-loop on) alias cycles', () => {
    expect(isGated('live_alias_cycle')).toBe(false);
  });

  it('does NOT tag alias whose chain root is a `var` (not a const)', () => {
    expect(isGated('live_alias_to_var')).toBe(false);
  });

  it('tags `if (FALSE) { dead }` THEN branch as gated', () => {
    expect(isGated('gated_then_branch')).toBe(true);
  });

  it('does NOT tag the ELSE branch of `if (FALSE)` (it is live)', () => {
    expect(isGated('live_else_branch')).toBe(false);
  });

  it('does NOT tag the THEN branch of `if (TRUE)` (it is live)', () => {
    expect(isGated('live_then_branch')).toBe(false);
  });

  it('tags the ELSE branch of `if (TRUE)` as gated', () => {
    expect(isGated('gated_else_branch')).toBe(true);
  });

  it('tags `if (FALSE) { dead }` in else-if chain as gated', () => {
    expect(isGated('gated_outer_then')).toBe(true);
  });

  it('does NOT tag the live arm of an else-if chain', () => {
    expect(isGated('live_chain_mid')).toBe(false);
  });

  it('tags the trailing else of `else if (TRUE)` as gated', () => {
    expect(isGated('gated_chain_tail')).toBe(true);
  });

  it('tags `if (cfg.FOO)` cross-file when FOO is false in cfg.zig', () => {
    expect(isGated('gated_cross_file_foo')).toBe(true);
  });

  it('does NOT tag the THEN branch of `if (cfg.BAR)` when BAR is true', () => {
    expect(isGated('live_cross_file_bar')).toBe(false);
  });

  it('tags the ELSE branch of `if (cfg.BAR)` when BAR is true', () => {
    expect(isGated('gated_cross_file_else')).toBe(true);
  });

  it('does NOT tag `cfg.UNDEFINED_NAME` (member not found in imported file)', () => {
    expect(isGated('live_cross_file_undefined')).toBe(false);
  });

  it('does NOT tag `cfg.NOT_A_BOOL != 0` (imported decl is not a bool literal)', () => {
    expect(isGated('live_cross_file_not_bool')).toBe(false);
  });
});
