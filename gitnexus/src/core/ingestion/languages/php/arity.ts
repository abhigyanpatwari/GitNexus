/**
 * PHP arity check, accommodating variadic (`...$args`) and default parameters.
 *
 * The `def` metadata synthesized by `arity-metadata.ts`:
 *   - `parameterCount`         — total formal parameters; `undefined` when
 *                                the method has a variadic `...$param`.
 *   - `requiredParameterCount` — min required (excludes defaulted params
 *                                and the variadic itself).
 *   - `parameterTypes`         — declared type strings; contains the
 *                                literal `'...'` when the method is variadic.
 *
 * Verdicts:
 *   - `'compatible'`   — `required <= argCount <= max`, OR the def has
 *                        variadic (any `argCount >= required`).
 *   - `'incompatible'` — argCount below required, or above max with no variadic.
 *   - `'unknown'`      — metadata absent / incomplete; named-args can satisfy
 *                        any arity so we return unknown when we detect them.
 *
 * PHP supports named arguments (PHP 8.0+): `save(force: true)`. Named-arg
 * call sites cannot be arity-checked statically without parsing arg names,
 * so we return `'unknown'` when the callsite carries named args (signalled
 * by a negative `arity` value per the shared Callsite contract).
 */

import type { Callsite, SymbolDefinition } from 'gitnexus-shared';

export function phpArityCompatibility(
  def: SymbolDefinition,
  callsite: Callsite,
): 'compatible' | 'unknown' | 'incompatible' {
  const max = def.parameterCount;
  const min = def.requiredParameterCount;
  if (max === undefined && min === undefined) return 'unknown';

  const argCount = callsite.arity;
  // Negative arity signals named-argument call sites — can't narrow statically.
  if (!Number.isFinite(argCount) || argCount < 0) return 'unknown';

  const hasVarArgs =
    def.parameterTypes !== undefined &&
    def.parameterTypes.some((t) => t === '...' || t.startsWith('...'));

  if (min !== undefined && argCount < min) return 'incompatible';
  if (max !== undefined && argCount > max && !hasVarArgs) return 'incompatible';

  return 'compatible';
}
