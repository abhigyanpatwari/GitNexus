import type { Callsite, SymbolDefinition } from 'gitnexus-shared';

export function goArityCompatibility(
  def: SymbolDefinition,
  callsite: Callsite,
): 'compatible' | 'unknown' | 'incompatible' {
  const max = def.parameterCount;
  const min = def.requiredParameterCount;
  if (max === undefined && min === undefined) return 'unknown';
  if (!Number.isFinite(callsite.arity) || callsite.arity < 0) return 'unknown';

  const variadic = def.parameterTypes?.some((t) => t.startsWith('...')) ?? false;
  if (min !== undefined && callsite.arity < min) return 'incompatible';
  if (max !== undefined && callsite.arity > max && !variadic) return 'incompatible';
  return 'compatible';
}
