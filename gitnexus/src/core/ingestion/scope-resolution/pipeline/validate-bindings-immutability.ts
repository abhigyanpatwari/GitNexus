/**
 * Dev-mode runtime validator for the two-channel binding lifecycle
 * (Contract Invariant I8 in `contract/scope-resolver.ts`).
 *
 * The two channels:
 *   - `indexes.bindings` — finalize-output channel. After
 *     `finalizeScopeModel` returns, every inner `BindingRef[]` array
 *     here is deep-frozen by `materializeBindings`. NO post-finalize
 *     hook should ever mutate this map's inner arrays — drift here
 *     manifests at runtime as the `Cannot add property N, object is
 *     not extensible` crash (issue #1066) or, more insidiously, as
 *     a hook silently mutating one of the frozen arrays (a no-op in
 *     production where freezes can be elided, a `TypeError` in dev).
 *
 *   - `indexes.bindingAugmentations` — post-finalize append-only
 *     channel. Inner arrays here are NEVER frozen; hooks like
 *     `populateNamespaceSiblings` `push()` directly. Walkers consult
 *     both channels via `lookupBindingsAt`.
 *
 * This validator runs after every post-finalize hook has executed
 * (so the dev-mode envelope captures the FULL surface area visible
 * to `resolveReferenceSites`) and asserts:
 *
 *   1. Every inner `BindingRef[]` array in `indexes.bindings` is
 *      `Object.isFrozen` — i.e. finalize produced a frozen bucket
 *      AND no hook accidentally `set()`-back a mutable replacement.
 *
 *   2. Every inner `BindingRef[]` array in
 *      `indexes.bindingAugmentations` is NOT frozen — i.e. the
 *      hook used the augmentation channel as designed (mutable
 *      `push()`) and didn't accidentally freeze its own scratch
 *      arrays. Self-documenting; mostly a sanity net.
 *
 * Mirrors `validateOwnershipParity` (#909): warns via `onWarn`,
 * never throws, no-op in production. Gated on
 *   `NODE_ENV !== 'production' && VALIDATE_SEMANTIC_MODEL !== '0'`.
 */

import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';

export function validateBindingsImmutability(
  indexes: ScopeResolutionIndexes,
  onWarn: (message: string) => void,
): number {
  if (process.env.NODE_ENV === 'production') return 0;
  if (process.env.VALIDATE_SEMANTIC_MODEL === '0') return 0;

  let violations = 0;

  for (const [scopeId, bucketMap] of indexes.bindings) {
    for (const [name, bucket] of bucketMap) {
      if (!Object.isFrozen(bucket)) {
        onWarn(
          `binding-immutability: indexes.bindings[${scopeId}][${name}] is NOT frozen — ` +
            `finalize produced a mutable bucket OR a post-finalize hook replaced a frozen ` +
            `bucket with a mutable one. Hooks must write to indexes.bindingAugmentations ` +
            `instead. See ScopeResolver Invariant I8.`,
        );
        violations++;
      }
    }
  }

  for (const [scopeId, bucketMap] of indexes.bindingAugmentations) {
    for (const [name, bucket] of bucketMap) {
      if (Object.isFrozen(bucket)) {
        onWarn(
          `binding-immutability: indexes.bindingAugmentations[${scopeId}][${name}] is FROZEN — ` +
            `the augmentation channel is mutable by contract; freezing it defeats the ` +
            `append-only purpose. See ScopeResolver Invariant I8.`,
        );
        violations++;
      }
    }
  }

  return violations;
}
