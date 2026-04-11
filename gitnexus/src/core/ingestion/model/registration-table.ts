/**
 * Registration Dispatch Table (SM-22)
 *
 * Behavior-grouped O(1) dispatch table for routing `SymbolTable.add()`
 * registrations into the semantic registries. Replaces the cascading
 * `if/else` ladder in `symbol-table.ts` with a `Map<NodeLabel, RoutingDecision>`
 * whose entries point to closure-captured hooks.
 *
 * ## Ownership diagram
 *
 *     SemanticModel
 *       ├── types   (TypeRegistry)    ← classHook / implHook write here
 *       ├── methods (MethodRegistry)  ← methodHook writes here
 *       ├── fields  (FieldRegistry)   ← propertyHook writes here
 *       └── symbols (SymbolTable)     ← owns fileIndex + callableByName,
 *                                       calls dispatch() in add()
 *
 * ## Behavior groups (5 hooks, 13 table entries)
 *
 * | Group         | NodeLabel values                                  | Hook         | Skip callable? |
 * |---------------|---------------------------------------------------|--------------|----------------|
 * | class-like    | Class, Struct, Interface, Enum, Record, Trait     | classHook    | no             |
 * | method-like   | Method, Constructor                               | methodHook   | no             |
 * | property      | Property                                          | propertyHook | YES            |
 * | impl-block    | Impl                                              | implHook     | no             |
 * | callable-only | Function, Macro, Delegate                         | (no entry)   | no             |
 *
 * Every other `NodeLabel` is "inert" — reached by `fileIndex` only. No
 * specialized registry, no callable index append.
 *
 * ## How to add a new NodeLabel
 *
 * 1. Add the variant to the `NodeLabel` union in `gitnexus-shared/src/graph/types.ts`.
 * 2. Decide which behavior group it belongs to by asking "which lookups must
 *    return this symbol?" (not "what language feature is it?"). A new Swift
 *    `Extension` is class-like if you want owner-scoped method lookup on it;
 *    a new Kotlin `Object` is class-like for the same reason.
 * 3. Either:
 *    - Add a table entry here pointing at one of the existing hooks, OR
 *    - Add it to `CALLABLE_ONLY_LABELS` if it is a free callable, OR
 *    - Add it to `INERT_LABELS` if it's metadata-only (File, Folder, Decorator,
 *      etc.) — never queried via owner/class lookups.
 * 4. If none of the above fit — the new kind needs a brand-new registry —
 *    design the registry first in `model/`, then add a new hook closure
 *    and table entries. Update `DISPATCH_LABELS` / the exhaustiveness guard
 *    accordingly.
 *
 * The runtime exhaustiveness guard in `symbol-table.ts` will warn if a
 * `NodeLabel` is missing from all three sets.
 */

import type { NodeLabel } from 'gitnexus-shared';
import type { SymbolDefinition, ClassLikeLabel } from './symbol-table.js';
import { CLASS_TYPES_TUPLE } from './symbol-table.js';
import type { MutableTypeRegistry } from './type-registry.js';
import type { MutableMethodRegistry } from './method-registry.js';
import type { MutableFieldRegistry } from './field-registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A registration hook is a pure side-effectful function closed over a
 * specific registry. The hook receives the symbol's simple name and its
 * pre-built definition; it does not receive raw metadata.
 *
 * Closure capture is the isolation mechanism: `propertyHook` literally
 * cannot call `types.registerClass` because its closure does not hold
 * a reference to `types`. This is the runtime half of the principle of
 * least authority — the compile-time half is enforced by TypeScript.
 */
/**
 * Registration hook — a pure side-effectful function closed over a
 * specific registry. Performs the specialized registry write into the
 * appropriate owner-scoped registry for one NodeLabel. The
 * callable-index gate lives inside `SymbolTable.add()` via the
 * `FREE_CALLABLE_TYPES` allowlist — the dispatch table does not participate
 * in that decision.
 */
export type RegistrationHook = (name: string, def: SymbolDefinition) => void;

/**
 * Dependencies required to build the dispatch table. Matches the shape
 * that `createSemanticModel()` already passes into `createSymbolTable()`.
 */
export interface RegistrationTableDeps {
  readonly types: MutableTypeRegistry;
  readonly methods: MutableMethodRegistry;
  readonly fields: MutableFieldRegistry;
}

// ---------------------------------------------------------------------------
// Single source of truth: NodeLabel → behavior category
// ---------------------------------------------------------------------------

/**
 * Behavior category for a NodeLabel during ingestion. Determines which
 * registry (if any) receives the symbol write during `SymbolTable.add()`:
 *
 *   - `dispatch`     — owner-scoped registry write via the dispatch table
 *                      (Class/Struct/Interface/Enum/Record/Trait → types.registerClass,
 *                       Method/Constructor → methods.register,
 *                       Property → fields.register,
 *                       Impl → types.registerImpl)
 *   - `callable-only` — no specialized registry; symbol appears in
 *                      `callableByName` via `SymbolTable.add()`'s
 *                      FREE_CALLABLE_TYPES gate (Function/Macro/Delegate)
 *   - `inert`        — no registry, no callable index; file-index only
 *                      (metadata / structural nodes like Project, Module,
 *                      Import, Decorator, etc.)
 *
 * `Function` has a twist: `Function`-with-`ownerId` (Python `def` in a
 * class body, Rust trait method, Kotlin companion method) is pre-normalized
 * to `Method` in `createSemanticModel`'s `wrappedAdd` before dispatch lookup,
 * so only free functions actually flow through the callable-only path.
 */
export type LabelBehavior = 'dispatch' | 'callable-only' | 'inert';

/**
 * **Single source of truth** for NodeLabel classification. Every NodeLabel
 * has exactly one behavior category — enforced at compile time by the
 * `as const satisfies Record<NodeLabel, LabelBehavior>` combo:
 *
 *   - **Completeness** — `Record<NodeLabel, LabelBehavior>` requires every
 *     NodeLabel to be a key. Missing a label fails to compile with
 *     "Property 'X' is missing in type ..." naming the drifted label.
 *   - **No extras** — `satisfies` performs excess-property checking on
 *     object literals, so a non-NodeLabel string key fails to compile.
 *   - **No duplicates** — object keys are unique by construction. A label
 *     cannot be classified into two categories by accident.
 *   - **Valid values** — `LabelBehavior` is a narrow union, so a typo in
 *     the category name fails to compile.
 *
 * Adding a new NodeLabel to `gitnexus-shared`: TypeScript will flag this
 * file as incomplete. Add the new label with its behavior category and
 * the three `*_LABELS` Sets + `ALL_NODE_LABELS` array below are derived
 * automatically — no separate list to update, no runtime drift detection
 * needed.
 *
 * NOTE: `Type` and `CodeElement` are inert wrappers for language features
 * that don't yet have a dedicated registry (typedefs, synthesized dynamic
 * calls). If future work needs owner-scoped lookup for them, change their
 * category to `'dispatch'` and add a hook in `createRegistrationTable`.
 * Do not special-case them inside `SymbolTable.add()`.
 */
const LABEL_BEHAVIOR = {
  // dispatch — owner-scoped registry writes
  Class: 'dispatch',
  Struct: 'dispatch',
  Interface: 'dispatch',
  Enum: 'dispatch',
  Record: 'dispatch',
  Trait: 'dispatch',
  Method: 'dispatch',
  Constructor: 'dispatch',
  Property: 'dispatch',
  Impl: 'dispatch',

  // callable-only — file index + callableByName, no owner scope
  Function: 'callable-only',
  Macro: 'callable-only',
  Delegate: 'callable-only',

  // inert — file index only
  Project: 'inert',
  Package: 'inert',
  Module: 'inert',
  Folder: 'inert',
  File: 'inert',
  Variable: 'inert',
  Decorator: 'inert',
  Import: 'inert',
  Type: 'inert',
  CodeElement: 'inert',
  Community: 'inert',
  Process: 'inert',
  Typedef: 'inert',
  Union: 'inert',
  Namespace: 'inert',
  TypeAlias: 'inert',
  Const: 'inert',
  Static: 'inert',
  Annotation: 'inert',
  Template: 'inert',
  Section: 'inert',
  Route: 'inert',
  Tool: 'inert',
} as const satisfies Record<NodeLabel, LabelBehavior> &
  // Cross-invariant with SymbolTable's CLASS_TYPES: every class-like label
  // (the labels that participate in qualifiedName fallback in
  // `SymbolTable.add()`) MUST be classified as 'dispatch' here. Narrowing
  // the intersection to `Record<ClassLikeLabel, 'dispatch'>` makes a drift
  // impossible — adding a label to `CLASS_TYPES_TUPLE` without classifying
  // it as 'dispatch' fails this `satisfies` check with a type error naming
  // the drifted label.
  Record<ClassLikeLabel, 'dispatch'>;

// ---------------------------------------------------------------------------
// Derived runtime collections — all keyed off LABEL_BEHAVIOR
// ---------------------------------------------------------------------------

/**
 * All known NodeLabels, derived from the keys of `LABEL_BEHAVIOR`. The
 * `satisfies Record<NodeLabel, LabelBehavior>` bijection above proves
 * that `Object.keys(LABEL_BEHAVIOR)` is exactly the NodeLabel set —
 * the cast to `NodeLabel[]` is sound, not a type-system bypass.
 *
 * Consumers (e.g., the semantic-model barrel re-export for tests) can
 * rely on this list being complete by construction. No runtime drift
 * check is needed or possible — the type system is the proof.
 */
export const ALL_NODE_LABELS: readonly NodeLabel[] = Object.keys(LABEL_BEHAVIOR) as NodeLabel[];

const labelsWithBehavior = (behavior: LabelBehavior): NodeLabel[] =>
  ALL_NODE_LABELS.filter((label) => LABEL_BEHAVIOR[label] === behavior);

/**
 * NodeLabel values that are free callables — appear in `callableByName`
 * but have no owner-scoped specialized registry. Used by the
 * callable-index gate in `SymbolTable.add()`.
 */
export const CALLABLE_ONLY_LABELS: ReadonlySet<NodeLabel> = new Set(
  labelsWithBehavior('callable-only'),
);

/**
 * NodeLabel values that touch only the file index — no specialized
 * registry, no callable index.
 */
export const INERT_LABELS: ReadonlySet<NodeLabel> = new Set(labelsWithBehavior('inert'));

/**
 * NodeLabel values that have a dispatch table entry. `createRegistrationTable`
 * below must provide a hook for exactly this set — the test file's behavior-
 * group tests and the integration tests pin the hook↔label correspondence.
 */
export const DISPATCH_LABELS: ReadonlySet<NodeLabel> = new Set(labelsWithBehavior('dispatch'));

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the dispatch table. Must be called once per `createSymbolTable`
 * invocation so each hook closes over that SymbolTable's injected
 * registries. Reusing a single module-level instance would cause hooks
 * to write into the wrong SemanticModel.
 */
export const createRegistrationTable = (
  deps: RegistrationTableDeps,
): Map<NodeLabel, RegistrationHook> => {
  const { types, methods, fields } = deps;

  // Hook 1: class-like — Class, Struct, Interface, Enum, Record, Trait.
  // Shared reference — six table entries point at this one closure.
  const classHook: RegistrationHook = (name, def) => {
    const qualifiedKey = def.qualifiedName ?? name;
    types.registerClass(name, qualifiedKey, def);
  };

  // Hook 2: method-like — Method, Constructor. Silently skipped if the
  // caller did not provide an ownerId (matches the pre-refactor gate in
  // `add()` — Property without ownerId is treated the same way).
  const methodHook: RegistrationHook = (name, def) => {
    if (def.ownerId) {
      methods.register(def.ownerId, name, def);
    }
  };

  // Hook 3: property — Property. Silently skipped without ownerId.
  // Property is not in `FREE_CALLABLE_TYPES`, so `SymbolTable.add()` already
  // excludes it from `callableByName`; common property names like
  // `id` / `name` / `type` never pollute the callable index.
  const propertyHook: RegistrationHook = (name, def) => {
    if (def.ownerId) {
      fields.register(def.ownerId, name, def);
    }
  };

  // Hook 4: impl-block — Rust `impl` blocks. Kept separate from classHook
  // because heritage resolution must not treat Impls as class candidates
  // (an Impl is not a parent type, it's an ancillary dispatch table).
  const implHook: RegistrationHook = (name, def) => {
    types.registerImpl(name, def);
  };

  const table = new Map<NodeLabel, RegistrationHook>();

  // class-like entries — iterate `CLASS_TYPES_TUPLE` (imported from
  // symbol-table.ts, the single source of truth for class-like labels).
  // Adding a new class-like label to that tuple automatically wires it
  // to `classHook` here; the `Record<ClassLikeLabel, 'dispatch'>`
  // intersection on `LABEL_BEHAVIOR` above forces the new label to also
  // be classified as dispatch.
  for (const label of CLASS_TYPES_TUPLE) {
    table.set(label, classHook);
  }

  // method-like
  table.set('Method', methodHook);
  table.set('Constructor', methodHook);

  // property — callable-index exclusion is enforced by SymbolTable.add()
  table.set('Property', propertyHook);

  // impl-block
  table.set('Impl', implHook);

  return table;
};
