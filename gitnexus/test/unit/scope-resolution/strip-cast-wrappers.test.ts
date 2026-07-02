/**
 * Unit tests for `stripCastWrappers` — the pure cast-peeling helper in
 * `compound-receiver.ts`, consumed by `resolveCompoundReceiverClass`
 * when a language opts in via `stripReceiverCastExpressions`.
 *
 * PR #2353 review F8: the peel loop rescans the working text for the
 * matching close paren on every iteration, so adversarial nested-paren
 * input (`((((…))))`) cost O(N²) with no iteration cap (the file's
 * `COMPOUND_RECEIVER_MAX_DEPTH` guard does not cover this loop). The
 * fix adds `MAX_CAST_PEEL`; exceeding it bails all-or-nothing with the
 * ORIGINAL text and the not-a-cast outcome. These are the helper's
 * first unit tests — they also pin the three-way cast classification
 * (KTD2: simple identifier captured / type-shaped-but-unparseable
 * reported / anything else untouched) that the Java integration
 * fixtures exercise only end-to-end.
 *
 * The helper is a pure text scan — no fixtures, no pipeline needed.
 */

import { describe, it, expect } from 'vitest';
import { stripCastWrappers } from '../../../src/core/ingestion/scope-resolution/passes/compound-receiver.js';

describe('stripCastWrappers — cast classification (KTD2)', () => {
  it.each([
    { input: '((Foo)x)', workingText: 'x', castType: 'Foo' },
    { input: '((Target)((Object)expr))', workingText: 'expr', castType: 'Target' },
    { input: '( Foo ) x', workingText: 'x', castType: 'Foo' },
  ])('captures the simple cast type in $input', ({ input, workingText, castType }) => {
    expect(stripCastWrappers(input)).toEqual({
      workingText,
      castType,
      unresolvableCast: false,
    });
  });

  it.each([
    { input: '(List<String>)obj' },
    { input: '(Foo[])obj' },
    { input: '(com.example.Foo)obj' },
    { input: '(  com.example.Foo  ) obj' },
  ])('reports the type-shaped but unparseable cast $input as unresolvable', ({ input }) => {
    expect(stripCastWrappers(input)).toEqual({
      workingText: input,
      castType: undefined,
      unresolvableCast: true,
    });
  });

  it('leaves a parenthesized non-cast expression untouched', () => {
    expect(stripCastWrappers('(a || b).field')).toEqual({
      workingText: '(a || b).field',
      castType: undefined,
      unresolvableCast: false,
    });
  });

  it('unwraps a plain parenthesized variable without capturing a cast type (KTD2 rule ii)', () => {
    // `(foo)` in receiver position (as in `(foo).bar()`) is a
    // redundant-paren unwrap of a VARIABLE — capturing `foo` as a cast
    // type here is exactly F1's wrong-edge shape.
    expect(stripCastWrappers('(foo)')).toEqual({
      workingText: 'foo',
      castType: undefined,
      unresolvableCast: false,
    });
  });

  it('keeps the captured type when a later cast group is unparseable (KTD2 rule iii)', () => {
    expect(stripCastWrappers('(Target)(List<String>)obj')).toEqual({
      workingText: 'obj',
      castType: 'Target',
      unresolvableCast: false,
    });
  });

  it('leaves a typeBinding-rawName-shaped input untouched', () => {
    // Case 3b / Case 4 pass-through shape (U5's known non-goal): the
    // stripper must be a structural no-op on rawName inputs.
    expect(stripCastWrappers('Factory.get_user()')).toEqual({
      workingText: 'Factory.get_user()',
      castType: undefined,
      unresolvableCast: false,
    });
  });
});

describe('stripCastWrappers — MAX_CAST_PEEL iteration cap (#2353 review F8)', () => {
  it('bails all-or-nothing with the original text when nesting exceeds the cap', () => {
    const input = '('.repeat(100) + 'Type' + ')'.repeat(100);
    expect(stripCastWrappers(input)).toEqual({
      workingText: input,
      castType: undefined,
      unresolvableCast: false,
    });
  });

  it('still unwraps nesting under the cap', () => {
    const input = '('.repeat(10) + 'Type' + ')'.repeat(10);
    expect(stripCastWrappers(input)).toEqual({
      workingText: 'Type',
      castType: undefined,
      unresolvableCast: false,
    });
  });

  it('terminates on unbalanced parens with the text untouched', () => {
    expect(stripCastWrappers('(((')).toEqual({
      workingText: '(((',
      castType: undefined,
      unresolvableCast: false,
    });
  });
});
