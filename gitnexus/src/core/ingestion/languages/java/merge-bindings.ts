/**
 * Java shadowing precedence for the `mergeBindings` hook.
 *
 * Tier ranking (lower wins):
 *   - 0: `local` — class member, method, local variable, parameter
 *   - 1: `import` / `namespace` / `reexport` — explicit imports
 *   - 2: `wildcard` — wildcard imports (`import x.y.*`)
 *
 * Within a surviving tier: de-dup by DefId, last-write-wins.
 */

import type { BindingRef } from 'gitnexus-shared';

const TIER_LOCAL = 0;
const TIER_IMPORT = 1;
const TIER_WILDCARD = 2;
const TIER_UNKNOWN = 3;

function tierOf(b: BindingRef): number {
  switch (b.origin) {
    case 'local':
      return TIER_LOCAL;
    case 'reexport':
    case 'import':
    case 'namespace':
      return TIER_IMPORT;
    case 'wildcard':
      return TIER_WILDCARD;
    default:
      return TIER_UNKNOWN;
  }
}

export function javaMergeBindings(bindings: readonly BindingRef[]): readonly BindingRef[] {
  if (bindings.length === 0) return bindings;

  let bestTier = Number.POSITIVE_INFINITY;
  for (const b of bindings) bestTier = Math.min(bestTier, tierOf(b));
  const survivors = bindings.filter((b) => tierOf(b) === bestTier);

  const seen = new Map<string, BindingRef>();
  for (const b of survivors) seen.set(b.def.nodeId, b);
  return [...seen.values()];
}
