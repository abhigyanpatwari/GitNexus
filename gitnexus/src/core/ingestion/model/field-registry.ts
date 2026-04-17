/**
 * Field Registry
 *
 * Owner-scoped field/property index extracted from SymbolTable.
 * Stores Property symbols keyed by `ownerNodeId\0fieldName` for O(1) lookup.
 */

import type { SymbolDefinition } from './symbol-table.js';

// ---------------------------------------------------------------------------
// Public read-only interface
// ---------------------------------------------------------------------------

export interface FieldRegistry {
  /** Look up a field/property by its owning class nodeId and field name. */
  lookupFieldByOwner(ownerNodeId: string, fieldName: string): SymbolDefinition | undefined;
}

// ---------------------------------------------------------------------------
// Mutable interface (used internally by SymbolTable.add / clear)
// ---------------------------------------------------------------------------

export interface MutableFieldRegistry extends FieldRegistry {
  /** Register a field/property under its owner. */
  register(ownerNodeId: string, fieldName: string, def: SymbolDefinition): void;
  /** Clear all entries. */
  clear(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createFieldRegistry = (): MutableFieldRegistry => {
  const fieldByOwner = new Map<string, SymbolDefinition>();

  const lookupFieldByOwner = (
    ownerNodeId: string,
    fieldName: string,
  ): SymbolDefinition | undefined => {
    return fieldByOwner.get(`${ownerNodeId}\0${fieldName}`);
  };

  const register = (ownerNodeId: string, fieldName: string, def: SymbolDefinition): void => {
    fieldByOwner.set(`${ownerNodeId}\0${fieldName}`, def);
  };

  const clear = (): void => {
    fieldByOwner.clear();
  };

  return { lookupFieldByOwner, register, clear };
};
