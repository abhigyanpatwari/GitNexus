/**
 * Semantic Model — public module surface.
 *
 * Barrel re-export for the `model/` module. Consumers outside `model/`
 * should import from this file rather than reaching into individual
 * registry files.
 *
 * The model is owner-scoped type/method/field knowledge layered above
 * `SymbolTable`. File-indexed and name-keyed callable lookups stay in
 * `SymbolTable` by design.
 */

// Unified semantic model (factory + interfaces). SemanticModel is the
// top-level container and owns the file/callable SymbolTable as a
// nested `symbols` field.
export {
  type SemanticModel,
  type MutableSemanticModel,
  createSemanticModel,
} from './semantic-model.js';

// SymbolTable is exclusively owned by SemanticModel. Re-exported here
// for the rare caller that needs the file/callable interface in
// isolation (e.g. tests).
export {
  type SymbolTableReader,
  type SymbolTableWriter,
  createSymbolTable,
} from './symbol-table.js';

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
// `MroStrategy` itself lives in `gitnexus-shared`; re-exported here for
// consumers that reach model behavior through the barrel.
export { lookupMethodByOwnerWithMRO } from './resolve.js';

// Named-import types and package-dir helper. Re-exported so barrel
// consumers don't need to reach into a specific model file.
export {
  type NamedImportBinding,
  type NamedImportMap,
  isFileInPackageDir,
} from './resolution-context.js';

// Heritage types. `buildHeritageMap` + `resolveExtendsType` are exported
// directly from `heritage-map.ts` and are not re-surfaced here to keep
// the barrel narrow.
export {
  type ExtractedHeritage,
  type HeritageResolutionStrategy,
  type HeritageStrategyLookup,
} from './heritage-map.js';

// Behavior-grouped dispatch table for SymbolTable.add() routing.
// See registration-table.ts module JSDoc for the behavior group taxonomy
// and "how to add a new NodeLabel" checklist.
// NOTE: createRegistrationTable, RegistrationHook, and RegistrationTableDeps
// are deliberately NOT re-exported here — they are factory internals of
// SemanticModel and should only be imported directly from registration-table.js
// by semantic-model.ts and the registration-table.test.ts file.
export {
  CALLABLE_ONLY_LABELS,
  INERT_LABELS,
  DISPATCH_LABELS,
  ALL_NODE_LABELS,
  type LabelBehavior,
} from './registration-table.js';
