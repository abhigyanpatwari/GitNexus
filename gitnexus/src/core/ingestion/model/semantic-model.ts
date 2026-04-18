/**
 * Semantic Model
 *
 * Top-level orchestrator for all resolution-time data. Owns:
 *
 *   - Three owner-scoped registries (types, methods, fields)
 *   - A nested SymbolTable (file + callable name indexes) wrapped so
 *     that `add()` fans out into the registries via the dispatch table
 *
 * ## Dependency direction
 *
 *     gitnexus-shared (NodeLabel)             — leaf
 *          ↑
 *     symbol-table.ts                         — pure file/callable index
 *          ↑
 *     model/type-registry / method-registry / field-registry
 *          ↑
 *     model/registration-table.ts             — dispatch table factory
 *          ↑
 *     model/semantic-model.ts                 — THIS FILE (orchestrator)
 *          ↑
 *     resolve.ts, call-processor.ts, resolution-context.ts, ...
 *
 * `symbol-table.ts` is a leaf — it never imports from `./model/`. This
 * file (semantic-model.ts) is the ONLY place where SymbolTable and the
 * owner-scoped registries are composed. Upstream consumers pass around
 * the `SemanticModel` interface and reach into `.symbols` for file-scoped
 * operations or `.types` / `.methods` / `.fields` for owner-scoped ones.
 *
 * ## Fan-out via wrapped add()
 *
 * `createSemanticModel()` creates a pure SymbolTable, creates the three
 * registries, builds a dispatch table via `createRegistrationTable`, and
 * exposes a SymbolTable-shaped façade whose `add()`:
 *
 *   1. Calls `rawSymbols.add()` — writes the fileIndex + callable index
 *      and returns the fully-built `SymbolDefinition`.
 *   2. Runs pre-dispatch normalization (`Function`-with-`ownerId` routes
 *      as `Method`).
 *   3. Looks up the dispatch table and invokes the hook, which writes to
 *      the appropriate owner-scoped registry.
 *
 * The wrapper is the only place where the two layers are combined. A
 * direct `createSymbolTable()` caller (e.g. an isolated unit test) gets
 * the pure, registry-free behavior — no surprises, no hidden side
 * effects.
 */

import type { NodeLabel } from 'gitnexus-shared';
import type { TypeRegistry, MutableTypeRegistry } from './type-registry.js';
import type { MethodRegistry, MutableMethodRegistry } from './method-registry.js';
import type { FieldRegistry, MutableFieldRegistry } from './field-registry.js';
import { createTypeRegistry } from './type-registry.js';
import { createMethodRegistry } from './method-registry.js';
import { createFieldRegistry } from './field-registry.js';
import type { SymbolDefinition } from 'gitnexus-shared';
import type { SymbolTableReader, SymbolTableWriter, AddMetadata } from './symbol-table.js';
import { createSymbolTable } from './symbol-table.js';
import { createRegistrationTable } from './registration-table.js';
import type { ScopeResolutionIndexes } from './scope-resolution-indexes.js';

// ---------------------------------------------------------------------------
// Public read-only interface
// ---------------------------------------------------------------------------

/**
 * Aggregated read-only view of the semantic registries plus the nested
 * file/callable SymbolTable.
 *
 * `symbols` is typed as {@link SymbolTableReader} — consumers can query
 * symbols but cannot register new ones or trigger a reset. Callers that
 * need to register symbols or reset state must hold a
 * {@link MutableSemanticModel} reference instead, which widens
 * `symbols` back to {@link SymbolTableWriter} and adds `clear()` on the
 * model itself.
 *
 * This segregation is the runtime half of the principle of least
 * authority: a resolver that receives `SemanticModel` physically cannot
 * mutate the index, so it cannot desync the leaf from the owner-scoped
 * registries even accidentally.
 */
export interface SemanticModel {
  readonly types: TypeRegistry;
  readonly methods: MethodRegistry;
  readonly fields: FieldRegistry;
  readonly symbols: SymbolTableReader;
  /**
   * Materialized scope-resolution indexes from RFC #909 Ring 2 PKG #921.
   *
   * `undefined` until the finalize-orchestrator attaches them. While
   * `undefined`, the legacy DAG is the sole resolution surface; once set,
   * resolvers whose language has `REGISTRY_PRIMARY_<LANG>=true` consult
   * these indexes instead.
   *
   * The attach is a one-shot write (see `MutableSemanticModel`). Callers
   * holding a read-only `SemanticModel` handle see either `undefined` or
   * the final frozen bundle — never a half-populated view.
   */
  readonly scopes?: ScopeResolutionIndexes;
}

// ---------------------------------------------------------------------------
// Mutable interface
// ---------------------------------------------------------------------------

/** Mutable variant — exposes the MutableX registries, a Writer-typed
 *  `symbols` facade, and a full-cascade reset. This is the interface
 *  held by the lifecycle owner (pipeline, resolution-context); resolvers
 *  that only query should hold the narrower {@link SemanticModel}. */
export interface MutableSemanticModel extends SemanticModel {
  readonly types: MutableTypeRegistry;
  readonly methods: MutableMethodRegistry;
  readonly fields: MutableFieldRegistry;
  readonly symbols: SymbolTableWriter;
  /** Clear all registries AND the nested SymbolTable. */
  clear(): void;
  /**
   * Stamp the finalize-orchestrator's output onto this model.
   *
   * **One-shot write.** Throws when called a second time — the indexes are
   * meant to be materialized once per ingestion run. `Object.freeze` is
   * applied to the attached bundle so consumers cannot mutate after attach.
   *
   * `clear()` resets the attached bundle back to `undefined`, enabling a
   * fresh re-ingestion to attach a new bundle.
   */
  attachScopeIndexes(indexes: ScopeResolutionIndexes): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
//
// NodeLabel taxonomy drift detection lives in `registration-table.ts` as a
// pure compile-time check — the `LABEL_BEHAVIOR` map is
// `Record<NodeLabel, LabelBehavior>` with `as const satisfies`, which proves
// coverage, uniqueness, and no-extra-keys at build time. No runtime guard
// is needed because drift is structurally impossible in the source.

export const createSemanticModel = (): MutableSemanticModel => {
  // 1. Create the pure, registry-unaware SymbolTable leaf.
  // rawSymbols is the only handle in the codebase whose type (the
  // internal createSymbolTable return) includes `.clear()`. cascadeClear
  // below reaches it here; no external caller receives this variable.
  const rawSymbols = createSymbolTable();

  // 2. Create the three owner-scoped registries.
  const types = createTypeRegistry();
  const methods = createMethodRegistry();
  const fields = createFieldRegistry();

  // 3. Build the dispatch table, closed over THIS instance's registries.
  const dispatchTable = createRegistrationTable({ types, methods, fields });

  // 4. Wrap rawSymbols so `add()` fans out into the registries via the
  //    dispatch table. See module JSDoc for the three-step contract.
  const wrappedAdd = (
    filePath: string,
    name: string,
    nodeId: string,
    type: NodeLabel,
    metadata?: AddMetadata,
  ): SymbolDefinition => {
    const def = rawSymbols.add(filePath, name, nodeId, type, metadata);

    // Function-with-ownerId (Python `def` in a class body, Rust trait
    // method, Kotlin companion method) routes as Method. Keeps the
    // dispatch table single-purpose.
    const dispatchKey: NodeLabel =
      type === 'Function' && metadata?.ownerId !== undefined ? 'Method' : type;

    const hook = dispatchTable.get(dispatchKey);
    if (hook) {
      hook(name, def);
    }

    return def;
  };

  // Scope-resolution bundle slot. Starts `undefined`; populated by a
  // one-shot `attachScopeIndexes(...)` from the finalize-orchestrator.
  // Held inside the factory closure so the returned `SemanticModel`
  // surface exposes it as a plain `readonly` property without a setter.
  let attachedScopes: ScopeResolutionIndexes | undefined;

  const attachScopeIndexes = (indexes: ScopeResolutionIndexes): void => {
    if (attachedScopes !== undefined) {
      throw new Error(
        'SemanticModel: scope indexes already attached. ' + 'Call `clear()` before re-attaching.',
      );
    }
    attachedScopes = Object.freeze(indexes);
  };

  // Cascade clear: single source of truth for "reset the entire model".
  // Wired into both `model.clear()` AND `model.symbols.clear()` so that a
  // caller holding only a SymbolTable reference can't leave the
  // owner-scoped registries populated while the file/callable indexes go
  // empty (the phantom-resolution failure mode).
  const cascadeClear = (): void => {
    types.clear();
    methods.clear();
    fields.clear();
    rawSymbols.clear();
    attachedScopes = undefined;
  };

  // Writer-typed facade: exposes reads + add, but NO `clear` field.
  // Callers holding a `SemanticModel.symbols` reference cannot desync
  // the leaf indexes from the owner-scoped registries. Consumers that
  // only query should widen their annotation to SymbolTableReader for
  // least-authority clarity.
  const symbols: SymbolTableWriter = {
    add: wrappedAdd,
    lookupExact: rawSymbols.lookupExact,
    lookupExactFull: rawSymbols.lookupExactFull,
    lookupExactAll: rawSymbols.lookupExactAll,
    lookupCallableByName: rawSymbols.lookupCallableByName,
    getFiles: rawSymbols.getFiles,
    getStats: rawSymbols.getStats,
  };

  return {
    types,
    methods,
    fields,
    symbols,
    get scopes() {
      return attachedScopes;
    },
    clear: cascadeClear,
    attachScopeIndexes,
  };
};
