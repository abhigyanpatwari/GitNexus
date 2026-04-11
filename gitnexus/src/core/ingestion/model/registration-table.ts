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
 *
 * ## Design provenance
 *
 * The behavior-grouped dispatch-table pattern is drawn from three industrial
 * precedents, confirmed via deep research in the SM-22 plan:
 *
 * - **rust-analyzer `PerNs<T>` + `push_res_with_import`** — one router,
 *   typed data, no per-kind strategies. The "dispatch by lookup dimension,
 *   not by symbol kind" insight comes from here.
 *   https://github.com/rust-lang/rust-analyzer/blob/master/crates/hir-def/src/item_scope.rs
 *
 * - **TypeScript compiler `declareSymbol(includes, excludes)`** — single
 *   function, bitwise fan-out, composable conflict detection. The "skip
 *   callable index as data, not control flow" flag is the same principle.
 *   https://github.com/basarat/typescript-book/blob/master/docs/compiler/binder-symbolflags.md
 *
 * - **Fowler — Replace Conditional with Polymorphism** — applicable
 *   precisely because `add()` governs more than 2–3 distinct behaviors
 *   per kind (Kerievsky's rule). Both research agents flagged that
 *   Strategy-per-kind *without* behavior grouping is the
 *   "registry-of-handlers disguised switch" antipattern; grouping by
 *   behavior (5 hooks) instead of by kind (30 labels) avoids it.
 *   https://refactoring.com/catalog/replaceConditionalWithPolymorphism.html
 */

import type { NodeLabel } from 'gitnexus-shared';
import type { SymbolDefinition } from '../symbol-table.js';
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
export type RegistrationHook = (name: string, def: SymbolDefinition) => void;

/**
 * Routing decision for one NodeLabel. `hook` performs the specialized
 * registry write into the appropriate owner-scoped registry. The
 * callable-index gate lives inside `SymbolTable.add()` via the
 * `CALLABLE_TYPES` allowlist — the dispatch table does not participate
 * in that decision.
 */
export interface RoutingDecision {
  readonly hook: RegistrationHook;
}

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
// Known-kind allowlists (used by the exhaustiveness guard)
// ---------------------------------------------------------------------------

/**
 * NodeLabel values that are free callables — they have NO owner-scoped
 * specialized registry but DO appear in `callableByName`. The dispatch
 * table has no entry for these; `add()`'s callable-index append step
 * handles them via the existing `CALLABLE_TYPES` set.
 *
 * `Function` has a twist: `Function`-with-`ownerId` (Python `def` in a
 * class body, Rust trait method, Kotlin companion method) is
 * pre-normalized to `Method` before the table lookup, so only free
 * functions actually flow through the callable-only path.
 */
export const CALLABLE_ONLY_LABELS: ReadonlySet<NodeLabel> = new Set([
  'Function',
  'Macro',
  'Delegate',
]);

/**
 * NodeLabel values that touch only the file index — no specialized
 * registry, no callable index. These are metadata or structural nodes
 * that resolution never looks up by owner, class name, or callable name.
 *
 * NOTE: `Type` and `CodeElement` are wrappers for language features that
 * don't have a dedicated registry yet (typedefs, synthesized dynamic
 * calls). If future work needs owner-scoped lookup for them, promote
 * them into a behavior group — do not special-case them inside `add()`.
 */
export const INERT_LABELS: ReadonlySet<NodeLabel> = new Set([
  'Project',
  'Package',
  'Module',
  'Folder',
  'File',
  'Variable',
  'Decorator',
  'Import',
  'Type',
  'CodeElement',
  'Community',
  'Process',
  'Typedef',
  'Union',
  'Namespace',
  'TypeAlias',
  'Const',
  'Static',
  'Annotation',
  'Template',
  'Section',
  'Route',
  'Tool',
]);

/**
 * NodeLabel values that have a dispatch table entry. Exported for the
 * exhaustiveness guard in `symbol-table.ts`, which verifies that every
 * `NodeLabel` appears in exactly one of DISPATCH_LABELS /
 * CALLABLE_ONLY_LABELS / INERT_LABELS. Drift here is a warning, not a
 * crash — production ingestion continues but the gap is surfaced.
 */
export const DISPATCH_LABELS: ReadonlySet<NodeLabel> = new Set([
  'Class',
  'Struct',
  'Interface',
  'Enum',
  'Record',
  'Trait',
  'Method',
  'Constructor',
  'Property',
  'Impl',
]);

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
): Map<NodeLabel, RoutingDecision> => {
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
  // Property is not in `CALLABLE_TYPES`, so `SymbolTable.add()` already
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

  return new Map<NodeLabel, RoutingDecision>([
    // class-like
    ['Class', { hook: classHook }],
    ['Struct', { hook: classHook }],
    ['Interface', { hook: classHook }],
    ['Enum', { hook: classHook }],
    ['Record', { hook: classHook }],
    ['Trait', { hook: classHook }],
    // method-like
    ['Method', { hook: methodHook }],
    ['Constructor', { hook: methodHook }],
    // property — callable-index exclusion is enforced by SymbolTable.add()
    ['Property', { hook: propertyHook }],
    // impl-block
    ['Impl', { hook: implHook }],
  ]);
};
