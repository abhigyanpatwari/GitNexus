/**
 * TypeScript declaration-merging + LEGB precedence for the `mergeBindings`
 * hook.
 *
 * TypeScript has a unique wrinkle that Python / C# don't: **declaration
 * merging**. The same name can legally coexist in several "declaration
 * spaces" simultaneously:
 *
 *   - **value** space — `class X`, `function X`, `const X`, `var X`,
 *     `let X`, `enum X`, `namespace X` (adds runtime object)
 *   - **type**  space — `interface X`, `type X`, `class X`, `enum X`
 *   - **namespace** space — `namespace X`, `class X` (static-accessed
 *     members are reachable via dotted name)
 *
 * Classes and enums are unique in that each declaration occupies both
 * the value AND type spaces. This lets:
 *
 *     class Foo {}
 *     interface Foo { bar: number; }   // merges additional type members
 *     namespace Foo { export const X = 1; } // adds static-like value
 *
 * all coexist for the same name.
 *
 * ## Algorithm
 *
 * For each declaration space independently:
 *   1. Tier bindings by origin (lower wins):
 *        0 — `local`
 *        1 — `import` / `namespace` / `reexport`
 *        2 — `wildcard` (`export * from …`)
 *   2. Keep only bindings at the best (lowest) tier in that space.
 *
 * Then union survivors across spaces and dedupe by `DefId`.
 *
 * ## Shadowing examples
 *
 *   - `class Foo {}` + `function Foo() {}` in same scope → COMPILE ERROR
 *     in TS source, but if both reach us with distinct DefIds we keep
 *     both (value space has two locals at tier 0 — de-dup by nodeId
 *     preserves both). No worse than C#-style merge.
 *   - `class Foo {}` (local, value+type) + `import type { Foo } from './a'`
 *     (tier-1, type-only) → local wins in both type AND value spaces;
 *     the import is not kept.
 *   - `interface Foo {}` (local, type-only) + `import { Foo } from './a'`
 *     (tier-1, value+type) → local wins in type space; import wins in
 *     value space (local doesn't occupy it). Both kept.
 *   - `namespace Foo {}` (local, namespace+value) + `class Foo {}` (local,
 *     value+type) → both at tier 0 in their respective spaces, kept.
 *
 * ## Limitations
 *
 *   - We classify imports by their `def.type` just like locals. Without
 *     a space-annotation on `ParsedImport`, `import type { Foo }` looks
 *     the same as `import { Foo }` at this layer — the parse phase
 *     decomposer marks type-only imports so the extractor CAN annotate
 *     `def.type = 'Type'` downstream if desired. Today it doesn't, so
 *     `import type` imports and value imports fall in the same bucket
 *     per their target def's NodeLabel. Parity with legacy behavior
 *     (which also doesn't track type-only separately) is preserved.
 */

import type { BindingRef, NodeLabel } from 'gitnexus-shared';

/** Declaration spaces a TypeScript binding can occupy. */
type Space = 'value' | 'type' | 'namespace';

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

/**
 * Map a `SymbolDefinition.type` (`NodeLabel`) to the set of TypeScript
 * declaration spaces the binding occupies.
 *
 * Unknown / unused labels default to `['value']` — the permissive choice,
 * matching legacy behavior where everything lives in a single flat bucket.
 */
function spacesOf(type: NodeLabel): readonly Space[] {
  switch (type) {
    // value-only
    case 'Function':
    case 'Method':
    case 'Variable':
    case 'Const':
    case 'Static':
    case 'Property':
    case 'Constructor':
    case 'Macro':
      return ['value'];

    // type-only
    case 'Interface':
    case 'Type':
    case 'TypeAlias':
    case 'Typedef':
    case 'Trait':
    case 'Annotation':
    case 'Decorator':
      return ['type'];

    // dual: value AND type
    case 'Class':
    case 'Enum':
    case 'Struct':
    case 'Record':
    case 'Union':
      return ['value', 'type'];

    // namespace AND value (namespaces introduce a runtime object AND a
    // named scope for static-style access)
    case 'Namespace':
    case 'Module':
      return ['namespace', 'value'];

    // catch-all — treat as value to match legacy permissive behavior
    default:
      return ['value'];
  }
}

export function typescriptMergeBindings(bindings: readonly BindingRef[]): readonly BindingRef[] {
  if (bindings.length === 0) return bindings;

  // Partition bindings by space. A single binding occupying two spaces
  // (e.g. a class) is duplicated into both partitions; the final dedupe
  // by nodeId collapses it back.
  const perSpace = new Map<Space, BindingRef[]>();
  for (const b of bindings) {
    const spaces = spacesOf(b.def.type);
    for (const s of spaces) {
      const list = perSpace.get(s);
      if (list === undefined) perSpace.set(s, [b]);
      else list.push(b);
    }
  }

  // Within each space, keep only the best-tier bindings.
  const survivorsSet = new Set<BindingRef>();
  for (const list of perSpace.values()) {
    let bestTier = Number.POSITIVE_INFINITY;
    for (const b of list) bestTier = Math.min(bestTier, tierOf(b));
    for (const b of list) {
      if (tierOf(b) === bestTier) survivorsSet.add(b);
    }
  }

  // Dedupe by def.nodeId. If the same binding survived in multiple
  // spaces (e.g. a class in both value + type) we keep a single entry.
  const seen = new Map<string, BindingRef>();
  for (const b of survivorsSet) seen.set(b.def.nodeId, b);
  return [...seen.values()];
}
