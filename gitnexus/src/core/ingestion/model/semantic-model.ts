/**
 * Semantic Model
 *
 * Unified interface aggregating the three registries extracted from
 * SymbolTable (SM-20): TypeRegistry, MethodRegistry, and FieldRegistry.
 *
 * SymbolTable delegates to a SemanticModel instance for all registry
 * operations, keeping the SymbolTable responsible only for file-indexed
 * lookups and callable indexing.
 */

import type { TypeRegistry, MutableTypeRegistry } from './type-registry.js';
import type { MethodRegistry, MutableMethodRegistry } from './method-registry.js';
import type { FieldRegistry, MutableFieldRegistry } from './field-registry.js';
import { createTypeRegistry } from './type-registry.js';
import { createMethodRegistry } from './method-registry.js';
import { createFieldRegistry } from './field-registry.js';

// ---------------------------------------------------------------------------
// Public read-only interface
// ---------------------------------------------------------------------------

/** Aggregated read-only view of the semantic registries. */
export interface SemanticModel {
  readonly types: TypeRegistry;
  readonly methods: MethodRegistry;
  readonly fields: FieldRegistry;
}

// ---------------------------------------------------------------------------
// Mutable interface (used by SymbolTable internals)
// ---------------------------------------------------------------------------

/** Mutable variant with registration and lifecycle methods. */
export interface MutableSemanticModel extends SemanticModel {
  readonly types: MutableTypeRegistry;
  readonly methods: MutableMethodRegistry;
  readonly fields: MutableFieldRegistry;
  /** Clear all registries. */
  clear(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createSemanticModel = (): MutableSemanticModel => {
  const types = createTypeRegistry();
  const methods = createMethodRegistry();
  const fields = createFieldRegistry();

  return {
    types,
    methods,
    fields,
    clear() {
      types.clear();
      methods.clear();
      fields.clear();
    },
  };
};
