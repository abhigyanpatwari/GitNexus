/**
 * Binding-merge precedence for JavaScript.
 *
 * JavaScript has no TypeScript declaration-merging (no `interface + class`
 * coexisting in the same scope, no `namespace + class` dual-space declarations).
 * However, `typescriptMergeBindings` handles these by falling back to
 * `['value']` for any `NodeLabel` not explicitly mapped to multiple spaces —
 * which is what every JavaScript declaration produces. The result is pure
 * LEGB precedence without any cross-space logic, which is exactly what
 * JavaScript needs.
 *
 * Reuse rather than reimplementing to keep the single source of truth for
 * the tier (local 0 / import-namespace-reexport 1 / wildcard 2) ordering.
 */

import type { BindingRef } from 'gitnexus-shared';
import { typescriptMergeBindings } from '../typescript/merge-bindings.js';

export function jsMergeBindings(bindings: readonly BindingRef[]): readonly BindingRef[] {
  return typescriptMergeBindings(bindings);
}
