/**
 * Wrap a `DefId → ancestor DefId[]` MRO map in the shared
 * `MethodDispatchIndex` shape so it slots into
 * `ScopeResolutionIndexes.methodDispatch`.
 *
 * `finalizeScopeModel` builds an empty `MethodDispatchIndex` by design
 * (per the comment in `finalize-orchestrator.ts`). Per-language
 * providers compute MRO their own way (Python C3 walk, Java class
 * hierarchy, Ruby mixin chains, etc.) and use this bridge to plug the
 * result back into the shared index shape.
 *
 * Next-consumer contract: any language that computes its own MRO map
 * calls `buildPopulatedMethodDispatch(mroByOwnerDefId)` and assigns the
 * result to `indexes.methodDispatch`. Interface-implementer tracking
 * (`implsByInterfaceDefId`) stays empty in V1 — providers that need it
 * can extend the return shape without breaking existing consumers.
 */

import type { MethodDispatchIndex } from 'gitnexus-shared';

const EMPTY_DEFS: readonly string[] = Object.freeze([]);

export function buildPopulatedMethodDispatch(
  mroByDefId: ReadonlyMap<string, readonly string[]>,
): MethodDispatchIndex {
  return {
    mroByOwnerDefId: mroByDefId,
    implsByInterfaceDefId: new Map(),
    mroFor(ownerDefId) {
      return mroByDefId.get(ownerDefId) ?? EMPTY_DEFS;
    },
    implementorsOf() {
      return EMPTY_DEFS;
    },
  };
}
