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

export interface ParameterTypeClass {
  /** Normalized base type, matching the coarse `parameterTypes` vocabulary when known. */
  base: string;
  /** Top-level cv signal preserved from the original C++ parameter spelling. */
  cv: 'none' | 'const' | 'volatile' | 'const volatile' | 'unknown';
  /** Coarse value/reference/pointer shape. */
  indirection: 'value' | 'lvalue-ref' | 'rvalue-ref' | 'pointer' | 'unknown';
  /** Number of pointer markers when indirection is `pointer`; otherwise 0. */
  pointerDepth: number;
  /** Normalized top-level template arguments, when a language preserves them. */
  templateArguments?: string[];
}

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
  /** Additive per-parameter type shape sidecar for languages that need cv/ref/pointer distinctions.
   *  Does not participate in graph node identity unless a resolver explicitly opts in. */
  parameterTypeClasses?: ParameterTypeClass[];
  /** Raw return type text extracted from AST (e.g. 'User', 'Promise<User>') */
  returnType?: string;
  /** Declared type for non-callable symbols — fields/properties (e.g. 'Address', 'List<User>') */
  declaredType?: string;
  /** Generic/template specialization arguments for class-like symbols (e.g. ['User'], ['T*']). */
  templateArguments?: string[];
  /** Per-language constraint payload for template / generic overloads
   *  (e.g. C++ `enable_if_t<P, T>` predicate trees, C++20 `requires` clauses).
   *  Opaque to shared code — the producing language adapter owns the shape
   *  and is the only consumer. Read via the optional
   *  `ScopeResolver.constraintCompatibility` hook during overload narrowing.
   *  Absent for symbols that have no constraints (the common case). */
  templateConstraints?: unknown;
  /** True when the producing language marked this callable as explicit.
   *  Currently used by C++ overload ranking to exclude explicit constructors
   *  from implicit user-defined conversion candidates. */
  isExplicit?: boolean;
  /** True when the callable is declared unavailable (for example C++ `= delete`).
   *  Unavailable callables still participate in overload selection, but a
   *  selected unavailable target must suppress edge emission. */
  isDeleted?: boolean;
  /** Links Method/Constructor/Property to owning Class/Struct/Trait nodeId */
  ownerId?: string;
  /** #1982/#1993: bridge-held enclosing-namespace path (e.g. `NS1`, `Outer.Inner`)
   *  tagged during the C++ resolution phase. Lets the graph bridge retry a
   *  namespace-prefixed node-lookup key and lets the qualified-base resolver
   *  break same-tail cross-namespace inheritance ties. A deliberate sidecar,
   *  separate from `qualifiedName`: it does NOT participate in graph node
   *  identity (node keys derive from filePath/type/qualifiedName) and leaves the
   *  qualifiedName-keyed resolution index untouched. Absent for the common case
   *  (non-namespace-nested defs and all non-C++ languages). */
  namespacePrefix?: string;
}
