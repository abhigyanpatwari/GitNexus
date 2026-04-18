/**
 * `QualifiedNameIndex` — O(1) `qualifiedName → DefId[]` lookup across all kinds.
 *
 * Cross-kind fast path for qualified-name resolution
 * (`lookupQualified(qname, scope, params)` in RFC §4.5). Class, method,
 * field, and namespace defs all contribute to a single index here; consumers
 * filter the returned `DefId[]` by `p.acceptedKinds` at the call site.
 *
 * Returns `DefId[]` (not a single `DefId`) because multiple defs can legally
 * share a qualified name — partial classes in C#, method overloads, or
 * accidental cross-kind collisions. The lookup caller filters to the expected
 * kind(s) and ranks the survivors.
 *
 * Part of RFC #909 Ring 2 SHARED — #913.
 *
 * Consumed by: #917 (`Registry.lookup` qualified fast path, `resolveTypeRef`
 * dotted fallback via #916).
 */

import type { SymbolDefinition } from './symbol-definition.js';
import type { DefId } from './types.js';

export interface QualifiedNameIndex {
  readonly byQualifiedName: ReadonlyMap<string, readonly DefId[]>;
  readonly size: number;
  /** Returns all `DefId`s registered under this qualified name; empty frozen
   *  array on miss so callers can iterate without null checks. */
  get(qualifiedName: string): readonly DefId[];
  has(qualifiedName: string): boolean;
}

/**
 * Build a `QualifiedNameIndex` from a flat list of `SymbolDefinition` records.
 *
 * Only defs with a non-empty `qualifiedName` contribute; defs without one are
 * silently skipped (not every kind carries a qualified name — anonymous or
 * top-level symbols, dynamic-unresolved imports, etc.).
 *
 * **Duplicate policy: appended in input order.** Each unique `(qname, DefId)`
 * pair contributes at most once — repeated entries for the same pair are
 * deduplicated. Distinct `DefId`s sharing a `qname` accumulate in insertion
 * order (stable output for deterministic lookup ranking at the call site).
 *
 * Pure function — safe to call repeatedly; no side effects.
 */
export function buildQualifiedNameIndex(defs: readonly SymbolDefinition[]): QualifiedNameIndex {
  const byQualifiedName = new Map<string, DefId[]>();
  const seenPairs = new Set<string>();

  for (const def of defs) {
    const qname = def.qualifiedName;
    if (qname === undefined || qname.length === 0) continue;

    const pairKey = `${qname}\0${def.nodeId}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const bucket = byQualifiedName.get(qname);
    if (bucket === undefined) {
      byQualifiedName.set(qname, [def.nodeId]);
    } else {
      bucket.push(def.nodeId);
    }
  }

  // Freeze bucket arrays so consumers can't mutate the index.
  const frozen = new Map<string, readonly DefId[]>();
  for (const [k, v] of byQualifiedName) {
    frozen.set(k, Object.freeze(v.slice()));
  }

  return freezeIndex(frozen);
}

// ─── Internal ───────────────────────────────────────────────────────────────

const EMPTY: readonly DefId[] = Object.freeze([]);

function freezeIndex(byQualifiedName: Map<string, readonly DefId[]>): QualifiedNameIndex {
  return {
    byQualifiedName,
    get size() {
      return byQualifiedName.size;
    },
    get(qualifiedName: string): readonly DefId[] {
      return byQualifiedName.get(qualifiedName) ?? EMPTY;
    },
    has(qualifiedName: string): boolean {
      return byQualifiedName.has(qualifiedName);
    },
  };
}
