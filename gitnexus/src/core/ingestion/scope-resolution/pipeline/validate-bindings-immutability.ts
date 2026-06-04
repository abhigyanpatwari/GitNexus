/**
 * Dev-mode runtime validator for the post-finalize binding-channel
 * lifecycle (Contract Invariant I8 in `contract/scope-resolver.ts`).
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
 * never throws, and is opt-in outside development. Gated by
 * `isSemanticModelValidatorEnabled()` (`utils/env.ts`).
 */

import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { isSemanticModelValidatorEnabled } from '../../utils/env.js';

export function validateBindingsImmutability(
  indexes: ScopeResolutionIndexes,
  onWarn: (message: string) => void,
): number {
  if (!isSemanticModelValidatorEnabled()) return 0;

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

  // Third channel: `workspaceFqnBindings` (scope-independent, shared map
  // populated by language namespace-sibling hooks — PHP FQN keys, C#
  // global-namespace simple names). Like bindingAugmentations its inner
  // arrays are mutable by contract (hooks `push()` directly), so freezing
  // one is the same defect as freezing an augmentation bucket.
  for (const [name, bucket] of indexes.workspaceFqnBindings) {
    if (Object.isFrozen(bucket)) {
      onWarn(
        `binding-immutability: indexes.workspaceFqnBindings[${name}] is FROZEN — ` +
          `the workspace channel is mutable by contract; freezing it defeats the ` +
          `append-only purpose. See ScopeResolver Invariant I8.`,
      );
      violations++;
    }
  }

  // Fourth channel: `workspaceTypeBindings` (scope-independent global typeBindings,
  // #1954). TypeRef-valued (no inner arrays), populated once by the hook then read
  // through the walker fallback — assert the map itself stays mutable so the hook
  // can populate it, mirroring the other shared channels.
  if (Object.isFrozen(indexes.workspaceTypeBindings)) {
    onWarn(
      `binding-immutability: indexes.workspaceTypeBindings is FROZEN — ` +
        `the workspace type channel is populated post-finalize and must stay mutable. ` +
        `See ScopeResolver Invariant I8.`,
    );
    violations++;
  }

  // Fifth/sixth channels: the per-namespace shared maps (#1871 named-namespace
  // generalization). `namespaceFqnBindings` carries mutable BindingRef[] buckets
  // (hooks `push()`); `namespaceTypeBindings` carries TypeRef values. Both are
  // populated post-finalize; freezing an inner bucket/map defeats that.
  for (const [ns, inner] of indexes.namespaceFqnBindings) {
    for (const [name, bucket] of inner) {
      if (Object.isFrozen(bucket)) {
        onWarn(
          `binding-immutability: indexes.namespaceFqnBindings[${ns}][${name}] is FROZEN — ` +
            `per-namespace buckets are mutable by contract. See ScopeResolver Invariant I8.`,
        );
        violations++;
      }
    }
  }
  for (const [ns, inner] of indexes.namespaceTypeBindings) {
    if (Object.isFrozen(inner)) {
      onWarn(
        `binding-immutability: indexes.namespaceTypeBindings[${ns}] is FROZEN — ` +
          `per-namespace type maps are populated post-finalize and must stay mutable. ` +
          `See ScopeResolver Invariant I8.`,
      );
      violations++;
    }
  }

  return violations;
}
