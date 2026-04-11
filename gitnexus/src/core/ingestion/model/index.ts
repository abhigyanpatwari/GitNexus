/**
 * Semantic Model — public module surface (SM-20).
 *
 * Barrel re-export for the `model/` module. Consumers outside `model/`
 * should import from this file rather than reaching into individual
 * registry files, so future refactors have a single import site to
 * redirect.
 *
 * The model is owner-scoped type/method/field knowledge extracted from
 * `SymbolTable` in SM-20. File-indexed and name-keyed callable lookups
 * stay in `SymbolTable` by design.
 */

// Unified semantic model (factory + interfaces). Post-SM-21 inversion,
// SemanticModel is the top-level container and owns the file/callable
// SymbolTable as a nested `symbols` field.
export {
  type SemanticModel,
  type MutableSemanticModel,
  createSemanticModel,
} from './semantic-model.js';

// SymbolTable lives at the parent of `model/` but is now exclusively
// owned by SemanticModel. Re-exported here for the rare caller that
// needs the file/callable interface in isolation (e.g. tests).
export { type SymbolTable, createSymbolTable } from '../symbol-table.js';

// Type registry (classes, structs, interfaces, enums, records, impls)
export {
  type TypeRegistry,
  type MutableTypeRegistry,
  createTypeRegistry,
} from './type-registry.js';

// Method registry (owner-scoped methods with arity-aware overload lookup)
export {
  type MethodRegistry,
  type MutableMethodRegistry,
  createMethodRegistry,
} from './method-registry.js';

// Field registry (owner-scoped fields/properties)
export {
  type FieldRegistry,
  type MutableFieldRegistry,
  createFieldRegistry,
} from './field-registry.js';

// MRO-aware method resolution (C3, first-wins, leftmost-base, implements-split,
// qualified-syntax). Pure function that depends only on the model + HeritageMap.
export { lookupMethodByOwnerWithMRO } from './resolve.js';

// SM-22: behavior-grouped dispatch table for SymbolTable.add() routing.
// See registration-table.ts module JSDoc for the behavior group taxonomy
// and "how to add a new NodeLabel" checklist.
export {
  type RegistrationHook,
  type RoutingDecision,
  type RegistrationTableDeps,
  createRegistrationTable,
  CALLABLE_ONLY_LABELS,
  INERT_LABELS,
  DISPATCH_LABELS,
} from './registration-table.js';

// Facade re-exports from parent module. These are not model implementations —
// they live in the parent directory and are surfaced here so consumers can
// import the full resolution-time data shape from a single module boundary.
export {
  BindingAccumulator,
  type BindingEntry,
  type EnrichmentGraphNode,
  type EnrichmentGraphLookup,
  enrichExportedTypeMap,
} from './binding-accumulator.js';

export { type HeritageMap, buildHeritageMap } from './heritage-map.js';
