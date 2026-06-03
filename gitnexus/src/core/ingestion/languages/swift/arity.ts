/**
 * Swift arity check, accommodating variadic and default parameters.
 *
 * Per the migration decision (count-primary, labels soft): we narrow on
 * arity only. Swift's argument labels are a soft signal — a label
 * mismatch is NOT treated as incompatible here, mirroring how the other
 * migrated languages narrow and aligning with RFC §4 soft-penalty
 * semantics. Label-precise dispatch is left to the registry's
 * type-binding layer.
 *
 * The `def` metadata we care about (synthesized by `arity-metadata.ts`):
 *   - `parameterCount`         — total formal parameters; `undefined`
 *                                when the method has a variadic param.
 *   - `requiredParameterCount` — min required (excludes defaulted params
 *                                and the variadic).
 *   - `parameterTypes`         — declared type strings; contains the
 *                                literal `'variadic'` when variadic.
 *
 * Verdicts:
 *   - `'compatible'`   — `requiredParameterCount <= argCount <= parameterCount`,
 *                        OR the def is variadic (then any `argCount >= required`).
 *   - `'incompatible'` — argCount below required, OR above max with no variadic.
 *   - `'unknown'`      — metadata absent / incomplete.
 *
 * `'incompatible'` is a soft signal in `Registry.lookup` (penalized but
 * still considered when no compatible candidate exists), per RFC §4.
 */

import type { Callsite, SymbolDefinition } from 'gitnexus-shared';

export function swiftArityCompatibility(
  def: SymbolDefinition,
  callsite: Callsite,
): 'compatible' | 'unknown' | 'incompatible' {
  const max = def.parameterCount;
  const min = def.requiredParameterCount;
  if (max === undefined && min === undefined) return 'unknown';

  const argCount = callsite.arity;
  if (!Number.isFinite(argCount) || argCount < 0) return 'unknown';

  const hasVarArgs =
    def.parameterTypes !== undefined && def.parameterTypes.some((t) => t === 'variadic');

  if (min !== undefined && argCount < min) return 'incompatible';
  if (max !== undefined && argCount > max && !hasVarArgs) return 'incompatible';

  return 'compatible';
}
