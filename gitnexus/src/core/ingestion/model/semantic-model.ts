/**
 * Semantic Model (SM-21 inversion)
 *
 * Top-level container for all resolution-time data. Owns the three
 * owner-scoped registries (types, methods, fields) AND the
 * file-indexed + callable-name SymbolTable. The ownership direction is:
 *
 *     SemanticModel                        ← top-level, passed everywhere
 *       ├── types   (TypeRegistry)
 *       ├── methods (MethodRegistry)
 *       ├── fields  (FieldRegistry)
 *       └── symbols (SymbolTable)          ← file/callable index, nested here
 *
 * Consumers receive the full `SemanticModel`; they reach into `.symbols`
 * for file-scoped or callable-name lookups, and into `.types` / `.methods`
 * / `.fields` directly for owner-scoped lookups. The SymbolTable's `add()`
 * feeds the registries via injected dependencies (see
 * {@link createSymbolTable}).
 */

import type { TypeRegistry, MutableTypeRegistry } from './type-registry.js';
import type { MethodRegistry, MutableMethodRegistry } from './method-registry.js';
import type { FieldRegistry, MutableFieldRegistry } from './field-registry.js';
import { createTypeRegistry } from './type-registry.js';
import { createMethodRegistry } from './method-registry.js';
import { createFieldRegistry } from './field-registry.js';
import type { SymbolTable } from '../symbol-table.js';
import { createSymbolTable } from '../symbol-table.js';

// Re-export the Mutable* registry types so symbol-table.ts can import them
// from the model/ module boundary without reaching into sibling files.
export type { MutableTypeRegistry, MutableMethodRegistry, MutableFieldRegistry };

// ---------------------------------------------------------------------------
// Public read-only interface
// ---------------------------------------------------------------------------

/**
 * Aggregated read-only view of the semantic registries + the nested
 * file/callable SymbolTable.
 *
 * SymbolTable exposes mutation (`add`, `clear`) — that's intentional,
 * because the ingestion pipeline is the sole writer and needs to feed
 * symbols as it walks files. External query-only callers should treat
 * SemanticModel as read-only and avoid calling `symbols.add` / `symbols.clear`.
 */
export interface SemanticModel {
  readonly types: TypeRegistry;
  readonly methods: MethodRegistry;
  readonly fields: FieldRegistry;
  readonly symbols: SymbolTable;
}

// ---------------------------------------------------------------------------
// Mutable interface (used by factory callers that need registry-level
// mutation beyond what SymbolTable.add provides)
// ---------------------------------------------------------------------------

/** Mutable variant — exposes the MutableX registries and a top-level clear. */
export interface MutableSemanticModel extends SemanticModel {
  readonly types: MutableTypeRegistry;
  readonly methods: MutableMethodRegistry;
  readonly fields: MutableFieldRegistry;
  /** Clear all registries AND the nested SymbolTable. */
  clear(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createSemanticModel = (): MutableSemanticModel => {
  const types = createTypeRegistry();
  const methods = createMethodRegistry();
  const fields = createFieldRegistry();
  // Inject the registries so SymbolTable.add() feeds them directly.
  const symbols = createSymbolTable({ types, methods, fields });

  return {
    types,
    methods,
    fields,
    symbols,
    clear() {
      types.clear();
      methods.clear();
      fields.clear();
      symbols.clear();
    },
  };
};
