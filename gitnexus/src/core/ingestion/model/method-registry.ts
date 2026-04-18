/**
 * Method Registry
 *
 * Owner-scoped method index extracted from SymbolTable.
 * Stores Method/Constructor/Function-with-ownerId symbols keyed by
 * `ownerNodeId\0methodName` for O(1) lookup. Supports overloads
 * (array values) and arity-based filtering.
 */

import type { SymbolDefinition } from 'gitnexus-shared';

// ---------------------------------------------------------------------------
// Public read-only interface
// ---------------------------------------------------------------------------

export interface MethodRegistry {
  /**
   * Look up a method by owner class + name, optionally filtered by arity.
   *
   * When `argCount` is provided, overloads whose parameter count doesn't
   * accommodate the call's argument count are filtered out before the
   * returnType dedup runs. This lets D0 (`resolveMemberCall`) disambiguate
   * arity-differing overloads (e.g. C++ `greet()` vs `greet(string)`) that
   * would otherwise collide on the shared `ownerId + methodName` key.
   *
   * Same-arity, same-returnType overloads (e.g. `save(int)` vs `save(String)`,
   * both returning `void`) still collapse to the first match — callers must
   * gate D0 on overload concern before invoking this function for that case.
   */
  lookupMethodByOwner(
    ownerNodeId: string,
    methodName: string,
    argCount?: number,
  ): SymbolDefinition | undefined;

  /**
   * Flat-by-name lookup across all owners. Returns every method registered
   * with the given unqualified name, in registration order, accumulated
   * across owners and overloads.
   *
   * Required by Tier 3 global resolution: Method and Constructor do not
   * land in `SymbolTable.callableByName`, so Tier 3 reaches them through
   * this flat index instead. Returns `[]` on miss — never `undefined` —
   * so callers can concatenate without null checks.
   *
   * Reference identity: each returned def is the same object reference
   * stored under `lookupMethodByOwner`, so a method symbol occupies one
   * allocation reachable from two indexes.
   */
  lookupMethodByName(name: string): readonly SymbolDefinition[];

  /**
   * True iff at least one registered def has `type === 'Function'` — i.e.,
   * a Python/Rust/Kotlin class method emitted by the worker as
   * `Function + ownerId` rather than as a strict `Method` label. Such defs
   * are double-indexed: they land in `SymbolTable.callableByName` (via the
   * Function callable-index gate) AND in this registry (via the
   * dispatch-key normalization in `wrappedAdd`). Tier 3 resolution must
   * then dedup the two indexes by nodeId.
   *
   * When this flag is false, the callable and method indexes are
   * guaranteed disjoint and Tier 3 can skip the dedup pass entirely.
   * The flag is monotonic (false→true once, never back) for the lifetime
   * of the MethodRegistry.
   */
  readonly hasFunctionMethods: boolean;
}

// ---------------------------------------------------------------------------
// Mutable interface (used internally by SymbolTable.add / clear)
// ---------------------------------------------------------------------------

export interface MutableMethodRegistry extends MethodRegistry {
  /** Register a method under its owner. Supports multiple overloads. */
  register(ownerNodeId: string, methodName: string, def: SymbolDefinition): void;
  /** Clear all entries. */
  clear(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createMethodRegistry = (): MutableMethodRegistry => {
  const methodByOwner = new Map<string, SymbolDefinition[]>();
  // Secondary flat-by-name index. Values are the SAME SymbolDefinition
  // references stored under `methodByOwner` — no copy, just a second key.
  // Populated in lockstep by `register()` and emptied by `clear()`.
  const methodsByName = new Map<string, SymbolDefinition[]>();
  const EMPTY: readonly SymbolDefinition[] = Object.freeze([]);
  // Set once when a Function+ownerId def lands here, powers the Tier 3
  // dedup fast-path. Monotonic: never unset except on `clear()`.
  let hasFunctionMethodsFlag = false;

  const lookupMethodByOwner = (
    ownerNodeId: string,
    methodName: string,
    argCount?: number,
  ): SymbolDefinition | undefined => {
    const defs = methodByOwner.get(`${ownerNodeId}\0${methodName}`);
    if (!defs || defs.length === 0) return undefined;

    // Arity narrowing: when an argCount is provided and there are multiple
    // overloads, keep only those whose parameterCount can accommodate the
    // call. This resolves arity-differing overloads (e.g. C++ `greet()` vs
    // `greet(string)`) that share the same `ownerId + methodName` key.
    //
    // Candidates with `parameterCount === undefined` (extractor didn't
    // populate the count — typically variadic or unknown) are retained
    // conservatively so that legitimate variadic matches still resolve.
    //
    // Streaming loop avoids allocating a filtered array on the common
    // "arity selects 0 or 1 match" path. We scan once, count arity
    // matches, and only materialize a narrowed array if at least one
    // match was found and at least one non-match exists. If arity rules
    // out every candidate, fall back to the unfiltered set so the
    // caller's fuzzy path still has something to work with.
    let pool: readonly SymbolDefinition[] = defs;
    if (argCount !== undefined && defs.length > 1) {
      let matchedCount = 0;
      let rejectedCount = 0;
      for (const d of defs) {
        if (d.parameterCount === undefined) {
          matchedCount++;
          continue;
        }
        const min = d.requiredParameterCount ?? d.parameterCount;
        if (argCount >= min && argCount <= d.parameterCount) matchedCount++;
        else rejectedCount++;
      }
      // Only narrow when the filter actually discriminates: at least one
      // match AND at least one rejection. Pure-match and pure-reject
      // paths both keep the unfiltered pool (the latter because fallback
      // semantics demand it).
      if (matchedCount > 0 && rejectedCount > 0) {
        const arityMatched: SymbolDefinition[] = [];
        for (const d of defs) {
          if (d.parameterCount === undefined) {
            arityMatched.push(d);
            continue;
          }
          const min = d.requiredParameterCount ?? d.parameterCount;
          if (argCount >= min && argCount <= d.parameterCount) arityMatched.push(d);
        }
        pool = arityMatched;
      }
    }

    if (pool.length === 1) return pool[0];
    // Multiple overloads after arity narrowing: return first if all share
    // the same defined returnType (safe for chain resolution), undefined if
    // return types differ (truly ambiguous — can't determine which overload).
    const firstReturnType = pool[0].returnType;
    if (firstReturnType === undefined) return undefined;
    for (let i = 1; i < pool.length; i++) {
      if (pool[i].returnType !== firstReturnType) return undefined;
    }
    return pool[0];
  };

  const lookupMethodByName = (name: string): readonly SymbolDefinition[] => {
    return methodsByName.get(name) ?? EMPTY;
  };

  const register = (ownerNodeId: string, methodName: string, def: SymbolDefinition): void => {
    const key = `${ownerNodeId}\0${methodName}`;
    const existing = methodByOwner.get(key);
    if (existing) {
      existing.push(def);
    } else {
      methodByOwner.set(key, [def]);
    }
    const byName = methodsByName.get(methodName);
    if (byName) {
      byName.push(def);
    } else {
      methodsByName.set(methodName, [def]);
    }
    // A `Function`-typed def reaching MethodRegistry means the worker
    // emitted a Python/Rust/Kotlin class method as `Function + ownerId`.
    // It was already written into `SymbolTable.callableByName` by the
    // upstream Function callable-index gate, so the two indexes are no
    // longer disjoint for this registry's lifetime — Tier 3 must dedup.
    if (!hasFunctionMethodsFlag && def.type === 'Function') {
      hasFunctionMethodsFlag = true;
    }
  };

  const clear = (): void => {
    methodByOwner.clear();
    methodsByName.clear();
    hasFunctionMethodsFlag = false;
  };

  return {
    lookupMethodByOwner,
    lookupMethodByName,
    register,
    clear,
    get hasFunctionMethods() {
      return hasFunctionMethodsFlag;
    },
  };
};
