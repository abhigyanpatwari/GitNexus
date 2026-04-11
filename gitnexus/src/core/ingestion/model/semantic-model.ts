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
import {
  createRegistrationTable,
  CALLABLE_ONLY_LABELS,
  INERT_LABELS,
  DISPATCH_LABELS,
} from './registration-table.js';

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
// Exhaustiveness guard
// ---------------------------------------------------------------------------

/**
 * Hardcoded mirror of the NodeLabel union in gitnexus-shared. Kept here
 * because the runtime JS has no introspection of the TypeScript union.
 * The shared tripwire test in `registration-table.test.ts` asserts that
 * this list matches the union exactly.
 */
export const ALL_NODE_LABELS: readonly NodeLabel[] = [
  'Project',
  'Package',
  'Module',
  'Folder',
  'File',
  'Class',
  'Function',
  'Method',
  'Variable',
  'Interface',
  'Enum',
  'Decorator',
  'Import',
  'Type',
  'CodeElement',
  'Community',
  'Process',
  'Struct',
  'Macro',
  'Typedef',
  'Union',
  'Namespace',
  'Trait',
  'Impl',
  'TypeAlias',
  'Const',
  'Static',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Constructor',
  'Template',
  'Section',
  'Route',
  'Tool',
];

/**
 * Dev-time check: each NodeLabel must appear in exactly one of the three
 * allowlists (DISPATCH_LABELS / CALLABLE_ONLY_LABELS / INERT_LABELS).
 * Runs once per createSemanticModel() call in non-production; zero
 * hot-path cost.
 *
 * Throws on drift (instead of warning) so that a missing allowlist entry
 * fails CI loudly rather than hiding in console output. The
 * `process.env.NODE_ENV !== 'production'` guard at the call site keeps
 * real users from ever seeing the throw — a label drift in production
 * still silently no-ops the routing, and any resulting graph gaps will
 * surface via the registration-table taxonomy test in CI.
 */
const runExhaustivenessGuard = (): void => {
  const drifted: string[] = [];
  for (const label of ALL_NODE_LABELS) {
    const inDispatch = DISPATCH_LABELS.has(label);
    const inCallableOnly = CALLABLE_ONLY_LABELS.has(label);
    const inInert = INERT_LABELS.has(label);
    const count = Number(inDispatch) + Number(inCallableOnly) + Number(inInert);
    if (count !== 1) {
      drifted.push(`'${label}' (in ${count} allowlists, expected 1)`);
    }
  }
  if (drifted.length > 0) {
    throw new Error(
      `[SemanticModel] NodeLabel taxonomy drift detected: ${drifted.join(', ')}. ` +
        `Check registration-table.ts DISPATCH_LABELS / CALLABLE_ONLY_LABELS / INERT_LABELS.`,
    );
  }
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createSemanticModel = (): MutableSemanticModel => {
  // 1. Create the pure, registry-unaware SymbolTable leaf.
  const rawSymbols = createSymbolTable();

  // 2. Create the three owner-scoped registries.
  const types = createTypeRegistry();
  const methods = createMethodRegistry();
  const fields = createFieldRegistry();

  // 3. Build the dispatch table, closed over THIS instance's registries.
  const dispatchTable = createRegistrationTable({ types, methods, fields });

  // 4. Dev-time exhaustiveness guard. Only in non-production builds.
  if (process.env.NODE_ENV !== 'production') {
    runExhaustivenessGuard();
  }

  // 5. Wrap rawSymbols so `add()` fans out into the registries via the
  //    dispatch table. Everything else (lookupExact, lookupCallableByName,
  //    getFiles, getStats, clear) passes through unchanged.
  const wrappedAdd = (
    filePath: string,
    name: string,
    nodeId: string,
    type: NodeLabel,
    metadata?: AddMetadata,
  ): SymbolDefinition => {
    // Step 1: write to the pure SymbolTable. It builds the def and
    // indexes it into fileIndex + callableByName. The built def is
    // returned so we can hand the exact same object to the dispatch
    // hook — zero duplicate allocations.
    const def = rawSymbols.add(filePath, name, nodeId, type, metadata);

    // Step 2: pre-dispatch normalization. Function-with-ownerId (Python
    // `def` inside a class body, Rust trait method, Kotlin companion
    // method) routes as Method. Keeps the dispatch table single-purpose.
    const dispatchKey: NodeLabel =
      type === 'Function' && metadata?.ownerId !== undefined ? 'Method' : type;

    // Step 3: dispatch — O(1) Map.get + hook invocation. The hook is a
    // closure captured over exactly the registry it writes (principle of
    // least authority — see registration-table.ts for details).
    // The callable-index gate stays inside `rawSymbols.add()` via
    // `CALLABLE_TYPES.has(type)`; the dispatch table only decides
    // owner-scoped routing.
    const routing = dispatchTable.get(dispatchKey);
    if (routing) {
      routing.hook(name, def);
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
