import type { Callsite, SymbolDefinition } from 'gitnexus-shared';

/**
 * C++ arity compatibility: supports overloading and default parameters.
 *
 * Unlike C (no overloading, exact match only), C++ has:
 *   - Overloaded functions (same name, different signatures)
 *   - Default parameters (requiredParameterCount < parameterCount)
 *   - Variadic functions (C-style `...`)
 *   - Parameter packs (V1: treated as variadic)
 *   - Templates: arity check on non-template params; SFINAE / `requires`
 *     constraints are filtered separately via `constraintCompatibility`
 *     (see `constraint-filter.ts` and issue #1579). Type-argument generic
 *     substitution (`List<T>` ≡ `List<U>`) remains out of V1 scope.
 *
 * Verdict:
 *   - 'compatible':    callsite.arity fits within [required, total] range
 *   - 'incompatible':  callsite.arity is outside the valid range
 *   - 'unknown':       insufficient metadata to determine
 */
export function cppArityCompatibility(
  def: SymbolDefinition,
  callsite: Callsite,
): 'compatible' | 'unknown' | 'incompatible' {
  const max = def.parameterCount;
  const min = def.requiredParameterCount;
  if (max === undefined && min === undefined) return 'unknown';
  if (!Number.isFinite(callsite.arity) || callsite.arity < 0) return 'unknown';

  const variadic = def.parameterTypes?.some((t) => t === '...') ?? false;

  // Too few arguments: less than the minimum required
  if (min !== undefined && callsite.arity < min) return 'incompatible';
  // Too many arguments: more than the maximum and not variadic
  if (max !== undefined && callsite.arity > max && !variadic) return 'incompatible';

  return 'compatible';
}
