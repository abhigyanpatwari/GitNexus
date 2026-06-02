/**
 * Shadowing precedence for the Dart `mergeBindings` hook. Three tiers:
 * 0 local, 1 import/namespace/reexport, 2 wildcard. Keeps only the best
 * (lowest) tier present, then de-dups survivors by `def.nodeId`
 * (last-write-wins). Mirror of `languages/swift/merge-bindings.ts` — Dart
 * imports bring a whole library namespace into scope (wildcard-leaf), so
 * local declarations always shadow imported names.
 */

import type { BindingRef } from 'gitnexus-shared';

// Named tiers (lower = stronger), matching `languages/swift/merge-bindings.ts`.
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

export function dartMergeBindings(bindings: readonly BindingRef[]): readonly BindingRef[] {
  if (bindings.length === 0) return bindings;

  let bestTier = Number.POSITIVE_INFINITY;
  for (const b of bindings) bestTier = Math.min(bestTier, tierOf(b));

  const survivors = bindings.filter((b) => tierOf(b) === bestTier);

  const seen = new Map<string, BindingRef>();
  for (const b of survivors) seen.set(b.def.nodeId, b);
  return [...seen.values()];
}
