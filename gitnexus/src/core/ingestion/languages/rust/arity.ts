import type { Callsite, SymbolDefinition } from 'gitnexus-shared';

export function rustArityCompatibility(
  def: SymbolDefinition,
  callsite: Callsite,
): 'compatible' | 'unknown' | 'incompatible' {
  const max = def.parameterCount;
  const min = def.requiredParameterCount;
  if (max === undefined && min === undefined) return 'unknown';
  if (!Number.isFinite(callsite.arity) || callsite.arity < 0) return 'unknown';

  if (min !== undefined && callsite.arity < min) return 'incompatible';
  if (max !== undefined && callsite.arity > max) return 'incompatible';
  return 'compatible';
}
