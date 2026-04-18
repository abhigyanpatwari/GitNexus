/**
 * `MethodDispatchIndex` — materialized view of class hierarchies keyed by
 * `DefId` (RFC §3.1; Ring 2 SHARED #914).
 *
 * Two O(1)-access maps used by `Registry.lookupMethod` and interface-
 * dispatch callers:
 *
 *   - `mroByOwnerDefId`       : owner class → full MRO ancestor chain
 *                               (excludes the owner itself, in per-language
 *                               strategy order).
 *   - `implsByInterfaceDefId` : interface/trait → classes that implement it.
 *
 * **Not an MRO implementation.** The build function is a pure aggregator: it
 * asks the caller (via `computeMro` and `implementsOf` callbacks) for the
 * per-language answers and materializes the two-way index. MRO strategies
 * live where they already do today (`model/resolve.ts § c3Linearize`,
 * `languages/ruby.ts § selectDispatch`, etc.) — this index does not
 * reimplement them.
 *
 * Why callbacks and not a shared strategy registry: the five strategies
 * (Python C3, Ruby kind-aware, Java/Kotlin linear, Rust qualified-syntax,
 * COBOL none) already exist in the CLI package and depend on the CLI's
 * `HeritageMap` + `SemanticModel`. Pulling them into `gitnexus-shared` would
 * require migrating both — out of scope for #914. Callbacks let the shared
 * build stay pure while honoring existing strategies verbatim.
 *
 * Consumed by: #917 (`Registry.lookupMethod` MRO fast path, interface
 * dispatch resolver).
 */

import type { DefId } from './types.js';

// ─── Public contracts ───────────────────────────────────────────────────────

export interface MethodDispatchIndex {
  /**
   * Full MRO ancestor chain per owner class (excludes the owner itself).
   * Order reflects the per-language strategy used by `computeMro`.
   */
  readonly mroByOwnerDefId: ReadonlyMap<DefId, readonly DefId[]>;
  /** Interfaces / traits → classes that implement them. */
  readonly implsByInterfaceDefId: ReadonlyMap<DefId, readonly DefId[]>;

  /** `mroByOwnerDefId.get`, with an empty frozen array on miss. */
  mroFor(ownerDefId: DefId): readonly DefId[];
  /** `implsByInterfaceDefId.get`, with an empty frozen array on miss. */
  implementorsOf(interfaceDefId: DefId): readonly DefId[];
}

export interface MethodDispatchInput {
  /**
   * Owner defs to index (classes, structs, traits, interfaces — any kind
   * that can appear on the owner side of a method-dispatch graph).
   */
  readonly owners: readonly DefId[];
  /**
   * Return the full MRO ancestor chain for `ownerDefId`, **excluding the
   * owner itself**, in the order dictated by the owner's language-specific
   * MRO strategy.
   *
   * Contract:
   *   - Pure (no side effects).
   *   - Deterministic per input.
   *   - `undefined` not allowed — return `[]` when the owner has no parents.
   */
  readonly computeMro: (ownerDefId: DefId) => readonly DefId[];
  /**
   * Return the set of interface/trait defs that `ownerDefId` implements.
   * Transitive inclusion (e.g., `implements` on a parent class) is the
   * caller's choice — the build function simply inverts whatever is
   * returned.
   *
   * Repeated IDs in the output are deduplicated automatically.
   */
  readonly implementsOf: (ownerDefId: DefId) => readonly DefId[];
}

// ─── Builder ────────────────────────────────────────────────────────────────

export function buildMethodDispatchIndex(input: MethodDispatchInput): MethodDispatchIndex {
  const mroByOwnerDefId = new Map<DefId, readonly DefId[]>();
  const implsBuilding = new Map<DefId, DefId[]>();
  const implsSeen = new Map<DefId, Set<DefId>>();

  for (const ownerId of input.owners) {
    // First-write-wins on duplicate owner ids: a stable policy consistent
    // with sibling indexes (#913 DefIndex / ModuleScopeIndex).
    if (!mroByOwnerDefId.has(ownerId)) {
      const chain = input.computeMro(ownerId);
      mroByOwnerDefId.set(ownerId, Object.freeze(chain.slice()));
    }

    for (const ifaceId of input.implementsOf(ownerId)) {
      let seen = implsSeen.get(ifaceId);
      if (seen === undefined) {
        seen = new Set<DefId>();
        implsSeen.set(ifaceId, seen);
      }
      if (seen.has(ownerId)) continue;
      seen.add(ownerId);

      let bucket = implsBuilding.get(ifaceId);
      if (bucket === undefined) {
        bucket = [];
        implsBuilding.set(ifaceId, bucket);
      }
      bucket.push(ownerId);
    }
  }

  const implsByInterfaceDefId = new Map<DefId, readonly DefId[]>();
  for (const [ifaceId, owners] of implsBuilding) {
    implsByInterfaceDefId.set(ifaceId, Object.freeze(owners.slice()));
  }

  return freezeIndex(mroByOwnerDefId, implsByInterfaceDefId);
}

// ─── Internal ───────────────────────────────────────────────────────────────

const EMPTY: readonly DefId[] = Object.freeze([]);

function freezeIndex(
  mroByOwnerDefId: Map<DefId, readonly DefId[]>,
  implsByInterfaceDefId: Map<DefId, readonly DefId[]>,
): MethodDispatchIndex {
  return {
    mroByOwnerDefId,
    implsByInterfaceDefId,
    mroFor(ownerDefId: DefId): readonly DefId[] {
      return mroByOwnerDefId.get(ownerDefId) ?? EMPTY;
    },
    implementorsOf(interfaceDefId: DefId): readonly DefId[] {
      return implsByInterfaceDefId.get(interfaceDefId) ?? EMPTY;
    },
  };
}
