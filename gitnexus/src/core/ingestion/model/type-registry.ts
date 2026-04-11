/**
 * Type Registry
 *
 * Class/struct/interface index extracted from SymbolTable.
 * Eagerly-populated indexes keyed by symbol name and qualified name.
 * Also includes a separate index for Rust Impl blocks.
 */

import type { SymbolDefinition } from './symbol-table.js';

// ---------------------------------------------------------------------------
// Public read-only interface
// ---------------------------------------------------------------------------

export interface TypeRegistry {
  /**
   * Look up class-like definitions (Class, Struct, Interface, Enum, Record, Trait)
   * by simple name. Returns all matching definitions across files
   * (e.g. partial classes). Returned array is a view into the live
   * internal index — do not mutate.
   */
  lookupClassByName(name: string): readonly SymbolDefinition[];

  /**
   * Look up class-like definitions by canonical qualified name.
   * Qualified names are normalized to dot-separated scope segments across languages,
   * e.g. `App.Models.User`, `com.example.User`, or `Admin.User`.
   * Returned array is a view into the live index — do not mutate.
   */
  lookupClassByQualifiedName(qualifiedName: string): readonly SymbolDefinition[];

  /**
   * Look up Impl nodes by name. Used by Tier 3 resolution to include Rust
   * impl blocks alongside class-like candidates.
   * Returned array is a view into the live index — do not mutate.
   */
  lookupImplByName(name: string): readonly SymbolDefinition[];
}

// ---------------------------------------------------------------------------
// Mutable interface (used internally by SymbolTable.add / clear)
// ---------------------------------------------------------------------------

export interface MutableTypeRegistry extends TypeRegistry {
  /** Register a class-like type by name and qualified name. */
  registerClass(name: string, qualifiedName: string, def: SymbolDefinition): void;
  /** Register a Rust Impl block by name. */
  registerImpl(name: string, def: SymbolDefinition): void;
  /** Clear all entries. */
  clear(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createTypeRegistry = (): MutableTypeRegistry => {
  const classByName = new Map<string, SymbolDefinition[]>();
  const classByQualifiedName = new Map<string, SymbolDefinition[]>();
  const implByName = new Map<string, SymbolDefinition[]>();

  const lookupClassByName = (name: string): SymbolDefinition[] => {
    return classByName.get(name) ?? [];
  };

  const lookupClassByQualifiedName = (qualifiedName: string): SymbolDefinition[] => {
    return classByQualifiedName.get(qualifiedName) ?? [];
  };

  const lookupImplByName = (name: string): SymbolDefinition[] => {
    return implByName.get(name) ?? [];
  };

  const registerClass = (name: string, qualifiedName: string, def: SymbolDefinition): void => {
    const existing = classByName.get(name);
    if (existing) {
      existing.push(def);
    } else {
      classByName.set(name, [def]);
    }

    const qualifiedMatches = classByQualifiedName.get(qualifiedName);
    if (qualifiedMatches) {
      qualifiedMatches.push(def);
    } else {
      classByQualifiedName.set(qualifiedName, [def]);
    }
  };

  const registerImpl = (name: string, def: SymbolDefinition): void => {
    const existing = implByName.get(name);
    if (existing) {
      existing.push(def);
    } else {
      implByName.set(name, [def]);
    }
  };

  const clear = (): void => {
    classByName.clear();
    classByQualifiedName.clear();
    implByName.clear();
  };

  return {
    lookupClassByName,
    lookupClassByQualifiedName,
    lookupImplByName,
    registerClass,
    registerImpl,
    clear,
  };
};
