import type { Callsite, SymbolDefinition } from 'gitnexus-shared';

export function solidityArityCompatibility(
  def: SymbolDefinition,
  callsite: Callsite,
): 'compatible' | 'unknown' | 'incompatible' {
  const max = def.parameterCount;
  const min = def.requiredParameterCount;
  if (max === undefined && min === undefined) return 'unknown';

  const argCount = callsite.arity;
  if (argCount === undefined || !Number.isFinite(argCount) || argCount < 0) return 'unknown';

  if (min !== undefined && argCount < min) return 'incompatible';
  if (max !== undefined && argCount > max) return 'incompatible';
  return 'compatible';
}
