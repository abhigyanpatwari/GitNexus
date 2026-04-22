/**
 * C# shadowing precedence for the `mergeBindings` hook.
 *
 * Tier ranking (lower wins in shadowing):
 *
 *   - 0: `local` — a class member, method, local variable, or parameter
 *        declared in this scope.
 *   - 1: `import` / `namespace` / `reexport` — `using System;`,
 *        `using System.Collections.Generic;`, `using Alias = Foo;`.
 *        All three using flavors that introduce a name at this scope
 *        tier together; the compiler resolves ambiguity by requiring
 *        an explicit qualifier when two `using`s collide, but for
 *        receiver-typed dispatch we treat them as equivalent tiers.
 *   - 2: `wildcard` — `using static System.Math;` brings static
 *        members in; any local or `using` with the same simple name
 *        shadows.
 *
 * Explicit interface implementations (`void IFoo.Bar() { }`) bind under
 * the qualified name in the extractor layer, so they never collide with
 * a plain `Bar` at this layer.
 *
 * Within a surviving tier we de-dup by `DefId`, last-write-wins so a
 * `using` re-declared further down the file cleanly replaces the
 * earlier binding.
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

export function csharpMergeBindings(bindings: readonly BindingRef[]): readonly BindingRef[] {
  if (bindings.length === 0) return bindings;

  let bestTier = Number.POSITIVE_INFINITY;
  for (const b of bindings) bestTier = Math.min(bestTier, tierOf(b));
  const survivors = bindings.filter((b) => tierOf(b) === bestTier);

  const seen = new Map<string, BindingRef>();
  for (const b of survivors) seen.set(b.def.nodeId, b);
  return [...seen.values()];
}
