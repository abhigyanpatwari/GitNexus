/**
 * Java arity check, accommodating varargs (`...`).
 *
 * Verdicts:
 *   - `'compatible'`   — argCount matches parameterCount, OR varargs present.
 *   - `'incompatible'` — argCount mismatches with no varargs.
 *   - `'unknown'`      — metadata absent / incomplete.
 */

import type { Callsite, SymbolDefinition } from 'gitnexus-shared';

export function javaArityCompatibility(
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
    def.parameterTypes.some((t) => t === 'varargs' || t.includes('...'));

  if (min !== undefined && argCount < min) return 'incompatible';
  if (max !== undefined && argCount > max && !hasVarArgs) return 'incompatible';

  return 'compatible';
}
