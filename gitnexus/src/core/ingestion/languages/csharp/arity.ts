/**
 * C# arity check, accommodating `params` variadic and default parameters.
 *
 * The `def` metadata we care about (synthesized by `arity-metadata.ts`):
 *   - `parameterCount`         — total formal parameters; `undefined`
 *                                when the method has `params T[]` variadic.
 *   - `requiredParameterCount` — min required (excludes defaulted params
 *                                and `params` variadic).
 *   - `parameterTypes`         — declared type strings; contains the
 *                                literal `'params'` when the method is
 *                                variadic.
 *
 * Verdicts:
 *   - `'compatible'`   — `requiredParameterCount <= argCount <= parameterCount`,
 *                        OR the def takes `params` (then any `argCount >= required`).
 *   - `'incompatible'` — argCount is below required, OR above max with no variadic.
 *   - `'unknown'`      — metadata is absent / incomplete.
 *
 * `'incompatible'` is a soft signal in `Registry.lookup` (penalized but
 * still considered when no compatible candidate exists), per RFC §4.
 */

import type { Callsite, SymbolDefinition } from 'gitnexus-shared';

export function csharpArityCompatibility(
  def: SymbolDefinition,
  callsite: Callsite,
): 'compatible' | 'unknown' | 'incompatible' {
  const max = def.parameterCount;
  const min = def.requiredParameterCount;
  if (max === undefined && min === undefined) return 'unknown';

  const argCount = callsite.arity;
  if (!Number.isFinite(argCount) || argCount < 0) return 'unknown';

  const hasVarArgs =
    def.parameterTypes !== undefined &&
    def.parameterTypes.some((t) => t === 'params' || t.startsWith('params '));

  if (min !== undefined && argCount < min) return 'incompatible';
  if (max !== undefined && argCount > max && !hasVarArgs) return 'incompatible';

  return 'compatible';
}
