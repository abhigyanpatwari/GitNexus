/**
 * PHP shadowing precedence for the `mergeBindings` hook.
 *
 * Tier ranking (lower wins in shadowing):
 *
 *   - 0: `local` — a class member, method, local variable, or parameter
 *        declared in this scope.
 *   - 1: `import` / `namespace` / `reexport` — `use Foo\Bar;`,
 *        `use Foo\Bar as Baz;`, `use function`, `use const`.
 *        All use-statement flavors that introduce a name sit at this tier.
 *   - 2: `wildcard` — grouped uses / wildcard imports (deferred; mapped
 *        here for completeness).
 *
 * Within a surviving tier we de-dup by `DefId`, last-write-wins so a
 * `use` re-declared further down the file cleanly replaces the earlier
 * binding.
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

export function phpMergeBindings(bindings: readonly BindingRef[]): readonly BindingRef[] {
  if (bindings.length === 0) return bindings;

  let bestTier = Number.POSITIVE_INFINITY;
  for (const b of bindings) bestTier = Math.min(bestTier, tierOf(b));
  const survivors = bindings.filter((b) => tierOf(b) === bestTier);

  const seen = new Map<string, BindingRef>();
  for (const b of survivors) seen.set(b.def.nodeId, b);
  return [...seen.values()];
}
