/**
 * Field Registry
 *
 * Owner-scoped field/property index extracted from SymbolTable.
 * Stores Property / Variable / Const / Static symbols keyed by
 * `ownerNodeId\0fieldName` for O(1) lookup. Supports multiple defs
 * under the same (owner, name) — e.g. legacy Property plus a
 * scope-resolution Variable reconciliation entry.
 */

import type { SymbolDefinition } from 'gitnexus-shared';

const EMPTY: readonly SymbolDefinition[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// Public read-only interface
// ---------------------------------------------------------------------------

export interface FieldRegistry {
  /**
   * First field registered under `(ownerNodeId, fieldName)`, if any.
   * Registration order is first-wins: when a Property and a Variable share
   * an `(owner, simpleName)` key, the earlier `register(...)` call's def is
   * returned. Prefer `lookupAllByOwner` when overloads or duplicate-kind
   * entries under the same name must all be visible.
   */
  lookupFieldByOwner(ownerNodeId: string, fieldName: string): SymbolDefinition | undefined;

  /**
   * Every field registered under `(ownerNodeId, fieldName)` in registration
   * order. Returns `[]` on miss.
   */
  lookupAllByOwner(ownerNodeId: string, fieldName: string): readonly SymbolDefinition[];
}

// ---------------------------------------------------------------------------
// Mutable interface (used internally by SymbolTable.add / clear)
// ---------------------------------------------------------------------------

export interface MutableFieldRegistry extends FieldRegistry {
  /** Register a field under its owner. Appends when the key already exists. */
  register(ownerNodeId: string, fieldName: string, def: SymbolDefinition): void;
  /** Clear all entries. */
  clear(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createFieldRegistry = (): MutableFieldRegistry => {
  const fieldByOwner = new Map<string, SymbolDefinition[]>();

  const lookupAllByOwner = (
    ownerNodeId: string,
    fieldName: string,
  ): readonly SymbolDefinition[] => {
    return fieldByOwner.get(`${ownerNodeId}\0${fieldName}`) ?? EMPTY;
  };

  const lookupFieldByOwner = (
    ownerNodeId: string,
    fieldName: string,
  ): SymbolDefinition | undefined => {
    const pool = lookupAllByOwner(ownerNodeId, fieldName);
    return pool.length === 0 ? undefined : pool[0];
  };

  const register = (ownerNodeId: string, fieldName: string, def: SymbolDefinition): void => {
    const key = `${ownerNodeId}\0${fieldName}`;
    const existing = fieldByOwner.get(key);
    if (existing) {
      existing.push(def);
    } else {
      fieldByOwner.set(key, [def]);
    }
  };

  const clear = (): void => {
    fieldByOwner.clear();
  };

  return { lookupFieldByOwner, lookupAllByOwner, register, clear };
};
