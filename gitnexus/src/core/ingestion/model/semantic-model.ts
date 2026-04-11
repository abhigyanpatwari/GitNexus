/**
 * Semantic Model (SM-23 DAG rearchitecture)
 *
 * Top-level orchestrator for all resolution-time data. Owns:
 *
 *   - Three owner-scoped registries (types, methods, fields)
 *   - A nested SymbolTable (file + callable name indexes) wrapped so
 *     that `add()` fans out into the registries via the dispatch table
 *
 * ## DAG direction
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
import type { SymbolTable, SymbolDefinition, AddMetadata } from '../symbol-table.js';
import { createSymbolTable } from '../symbol-table.js';
import { createRegistrationTable } from './registration-table.js';

// ---------------------------------------------------------------------------
// Public read-only interface
// ---------------------------------------------------------------------------

/**
 * Aggregated read-only view of the semantic registries plus the nested
 * file/callable SymbolTable.
 *
 * SymbolTable exposes mutation (`add`, `clear`) because the ingestion
 * pipeline is the sole writer and needs to feed symbols as it walks
 * files. Query-only callers should treat the model as read-only.
 */
export interface SemanticModel {
  readonly types: TypeRegistry;
  readonly methods: MethodRegistry;
  readonly fields: FieldRegistry;
  readonly symbols: SymbolTable;
}

// ---------------------------------------------------------------------------
// Mutable interface
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
//
// NodeLabel taxonomy drift detection lives in `registration-table.ts` as a
// pure compile-time check — the `LABEL_BEHAVIOR` map is
// `Record<NodeLabel, LabelBehavior>` with `as const satisfies`, which proves
// coverage, uniqueness, and no-extra-keys at build time. No runtime guard
// is needed because drift is structurally impossible in the source.

export const createSemanticModel = (): MutableSemanticModel => {
  // 1. Create the pure, registry-unaware SymbolTable leaf.
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
  };

  const symbols: SymbolTable = {
    add: wrappedAdd,
    lookupExact: rawSymbols.lookupExact,
    lookupExactFull: rawSymbols.lookupExactFull,
    lookupExactAll: rawSymbols.lookupExactAll,
    lookupCallableByName: rawSymbols.lookupCallableByName,
    getFiles: rawSymbols.getFiles,
    getStats: rawSymbols.getStats,
    clear: cascadeClear,
  };

  return {
    types,
    methods,
    fields,
    symbols,
    clear: cascadeClear,
  };
};
