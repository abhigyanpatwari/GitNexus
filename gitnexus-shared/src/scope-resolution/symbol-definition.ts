/**
 * `SymbolDefinition` — the canonical shape of an indexed symbol record.
 *
 * Historically defined in `gitnexus/src/core/ingestion/model/symbol-table.ts`;
 * moved into `gitnexus-shared` as part of RFC #909 Ring 1 (#910) so the
 * scope-resolution types that reference it can live in the shared package
 * alongside their consumers (`gitnexus/` and `gitnexus-web/`).
 *
 * Shape is unchanged from the prior local definition.
 */

import type { NodeLabel } from '../graph/types.js';

export interface SymbolDefinition {
  nodeId: string;
  filePath: string;
  type: NodeLabel;
  /** Canonical dot-separated qualified type name for class-like symbols
   *  (e.g. `App.Models.User`). Falls back to the simple symbol name when no
   *  package/namespace/module scope exists or no explicit qualified metadata is provided. */
  qualifiedName?: string;
  parameterCount?: number;
  /** Number of required (non-optional, non-default) parameters.
   *  Enables range-based arity filtering: argCount >= requiredParameterCount && argCount <= parameterCount. */
  requiredParameterCount?: number;
  /** Per-parameter type names for overload disambiguation (e.g. ['int', 'String']).
   *  Populated when parameter types are resolvable from AST (any typed language). */
  parameterTypes?: string[];
  /** Raw return type text extracted from AST (e.g. 'User', 'Promise<User>') */
  returnType?: string;
  /** Declared type for non-callable symbols — fields/properties (e.g. 'Address', 'List<User>') */
  declaredType?: string;
  /** Links Method/Constructor/Property to owning Class/Struct/Trait nodeId */
  ownerId?: string;
}
