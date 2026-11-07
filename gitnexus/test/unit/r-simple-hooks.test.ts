/**
 * `rArityCompatibility`, the R scope resolver's arity hook. R declarations carry no arity
 * metadata today, so in practice the hook answers 'unknown'; the bounds check is there for the
 * day they do, and is pinned here so that it cannot be wrong in the meantime.
 */
import { describe, expect, it } from 'vitest';
import type { Callsite, SymbolDefinition } from 'gitnexus-shared';
import { rArityCompatibility } from '../../src/core/ingestion/languages/r/simple-hooks.js';
import { rScopeResolver } from '../../src/core/ingestion/languages/r/scope-resolver.js';

const def = (parameterCount?: number, requiredParameterCount?: number): SymbolDefinition =>
  ({
    nodeId: 'Function:R/a.R:f',
    filePath: 'R/a.R',
    type: 'Function',
    parameterCount,
    requiredParameterCount,
  }) as SymbolDefinition;

const call = (arity?: number): Callsite => ({ arity });

describe('rArityCompatibility', () => {
  it('is the hook the R scope resolver registers', () => {
    expect(rScopeResolver.arityCompatibility).toBe(rArityCompatibility);
  });

  it('answers unknown when the definition carries no arity metadata', () => {
    expect(rArityCompatibility(call(0), def())).toBe('unknown');
    expect(rArityCompatibility(call(5), def())).toBe('unknown');
  });

  it.each([undefined, NaN, Infinity, -1])(
    'answers unknown for a call-site arity of %s',
    (arity) => {
      expect(rArityCompatibility(call(arity), def(2, 1))).toBe('unknown');
    },
  );

  it.each([
    [0, 'incompatible'],
    [1, 'compatible'],
    [2, 'compatible'],
    [3, 'incompatible'],
  ] as const)(
    'with 1 required and 2 declared parameters, %i arguments are %s',
    (arity, verdict) => {
      expect(rArityCompatibility(call(arity), def(2, 1))).toBe(verdict);
    },
  );

  it('checks only the upper bound when only the parameter count is known', () => {
    expect(rArityCompatibility(call(0), def(2, undefined))).toBe('compatible');
    expect(rArityCompatibility(call(2), def(2, undefined))).toBe('compatible');
    expect(rArityCompatibility(call(3), def(2, undefined))).toBe('incompatible');
  });

  it('checks only the lower bound when only the required count is known', () => {
    expect(rArityCompatibility(call(0), def(undefined, 1))).toBe('incompatible');
    expect(rArityCompatibility(call(1), def(undefined, 1))).toBe('compatible');
    expect(rArityCompatibility(call(9), def(undefined, 1))).toBe('compatible');
  });

  it('accepts zero arguments for a function that declares none', () => {
    expect(rArityCompatibility(call(0), def(0, 0))).toBe('compatible');
    expect(rArityCompatibility(call(1), def(0, 0))).toBe('incompatible');
  });
});
