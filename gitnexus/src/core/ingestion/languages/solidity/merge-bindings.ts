import type { BindingRef } from 'gitnexus-shared';

const TIER_LOCAL = 0;
const TIER_IMPORT = 1;
const TIER_WILDCARD = 2;
const TIER_UNKNOWN = 3;

function tierOf(b: BindingRef): number {
  switch (b.origin) {
    case 'local':
      return TIER_LOCAL;
    case 'import':
    case 'namespace':
    case 'reexport':
      return TIER_IMPORT;
    case 'wildcard':
      return TIER_WILDCARD;
    default:
      return TIER_UNKNOWN;
  }
}

export function solidityMergeBindings(bindings: readonly BindingRef[]): readonly BindingRef[] {
  if (bindings.length === 0) return bindings;

  let bestTier = Number.POSITIVE_INFINITY;
  for (const b of bindings) bestTier = Math.min(bestTier, tierOf(b));

  const survivors = bindings.filter((b) => tierOf(b) === bestTier);
  const seen = new Map<string, BindingRef>();
  for (const b of survivors) seen.set(b.def.nodeId, b);
  return [...seen.values()];
}
