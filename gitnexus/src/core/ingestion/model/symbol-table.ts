/**
 * Symbol Table — file-indexed + callable-name symbol storage.
 *
 * This module is a PURE LEAF in the ingestion DAG. It owns two orthogonal
 * O(1) indexes:
 *
 *   1. fileIndex      — Map<filePath, Map<name, SymbolDefinition[]>>
 *                       for same-file lookups (Tier 1 resolution)
 *   2. callableByName — Map<name, SymbolDefinition[]>
 *                       for name-keyed callable lookups (Tier 3 widen)
 *
 * SymbolTable deliberately knows NOTHING about the owner-scoped registries
 * (types, methods, fields) that sit above it in the DAG. Those registries
 * live in `model/` and depend on SymbolTable, not the other way around.
 * {@link createSemanticModel} composes this pure SymbolTable with the
 * registries and wraps `add()` to fan out registrations into both layers.
 *
 * DAG direction (strictly enforced):
 *
 *     gitnexus-shared (NodeLabel)       — leaf type
 *          ↑
 *     symbol-table.ts                   — THIS FILE (pure storage)
 *          ↑
 *     model/type-registry.ts, method-registry.ts, field-registry.ts
 *          ↑
 *     model/registration-table.ts       — dispatch table factory
 *          ↑
 *     model/semantic-model.ts           — orchestrator, wraps add()
 *          ↑
 *     model/resolve.ts, call-processor.ts, resolution-context.ts, ...
 *
 * No arrow ever points downward from this file. If you are tempted to
 * import from `./model/` here, you are going the wrong way — move the
 * logic up the DAG instead.
 */

import type { NodeLabel } from 'gitnexus-shared';

/**
 * Class-like NodeLabels — used for qualifiedName fallback inside
 * `SymbolTable.add()` and (via import into `model/registration-table.ts`)
 * as the single source of truth for which labels route to classHook
 * in the dispatch table.
 *
 * Exported as a `readonly` tuple so that `typeof CLASS_TYPES_TUPLE[number]`
 * yields a precise literal union (`ClassLikeLabel`). The model layer
 * imports this tuple and uses `Record<ClassLikeLabel, 'dispatch'>` in a
 * `satisfies` intersection to enforce at COMPILE TIME that every label
 * listed here is also classified as dispatch in `LABEL_BEHAVIOR`. Adding
 * a new class-like label to this tuple without updating `LABEL_BEHAVIOR`
 * fails TypeScript.
 *
 * Traits are class-like for heritage resolution: PHP `use Trait;`, Rust
 * `impl Trait for Struct`, and Scala traits all contribute methods to the
 * hierarchy of their using/implementing type.
 */
export const CLASS_TYPES_TUPLE = [
  'Class',
  'Struct',
  'Interface',
  'Enum',
  'Record',
  'Trait',
] as const satisfies readonly NodeLabel[];

export type ClassLikeLabel = (typeof CLASS_TYPES_TUPLE)[number];

export const CLASS_TYPES: ReadonlySet<NodeLabel> = new Set(CLASS_TYPES_TUPLE);

/** Free-callable labels — single source of truth for "callables that have
 *  NO owner scope". Methods and constructors are owner-scoped and live in
 *  `MethodRegistry` — Tier 3 reaches them via
 *  `model.methods.lookupMethodByName`. See `resolution-context.ts` Tier 3
 *  for how both indexes are consulted together.
 *
 *  Exported as a `readonly` tuple so that `typeof FREE_CALLABLE_TUPLE[number]`
 *  yields a precise literal union (`FreeCallableLabel`). `registration-table.ts`
 *  imports this type and uses `Record<FreeCallableLabel, 'callable-only'>` in
 *  a `satisfies` intersection to enforce at COMPILE TIME that every label
 *  listed here is also classified as `callable-only` in `LABEL_BEHAVIOR`.
 *  Adding a label to this tuple without updating `LABEL_BEHAVIOR` fails
 *  TypeScript.
 *
 *  Partial-state caveat: Python/Rust/Kotlin class methods are emitted by
 *  the worker as `Function` + `ownerId` (not `Method`), so they still land
 *  here via the `Function` entry. Collapsing those three languages onto the
 *  `Method` label is pending a `def.type` preservation decision.
 */
export const FREE_CALLABLE_TUPLE = [
  'Function',
  'Macro', // C/C++
  'Delegate', // C#
] as const satisfies readonly NodeLabel[];

export type FreeCallableLabel = (typeof FREE_CALLABLE_TUPLE)[number];

export const FREE_CALLABLE_TYPES: ReadonlySet<NodeLabel> = new Set(FREE_CALLABLE_TUPLE);

/** Symbol types that can be the TARGET of a call in the resolver's kind
 *  filter — superset of {@link FREE_CALLABLE_TYPES} that also admits
 *  owner-scoped methods and constructors pulled in from `MethodRegistry`.
 *
 *  Why the split: `FREE_CALLABLE_TYPES` now has a narrow meaning (free
 *  callables indexed in `callableByName`), but call resolution still
 *  needs to accept Method and Constructor candidates once they have been
 *  unioned in from `model.methods.lookupMethodByName`. The resolver uses
 *  this constant for kind filtering in
 *  `filterCallableCandidates` / `countCallableCandidates`.
 */
export const CALL_TARGET_TYPES: ReadonlySet<NodeLabel> = new Set<NodeLabel>([
  ...FREE_CALLABLE_TYPES,
  'Method',
  'Constructor',
]);

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

/**
 * Optional metadata accepted by {@link SymbolTable.add}. Kept as a separate
 * type alias so callers and wrappers can share the same shape.
 */
export interface AddMetadata {
  parameterCount?: number;
  requiredParameterCount?: number;
  parameterTypes?: string[];
  returnType?: string;
  declaredType?: string;
  ownerId?: string;
  qualifiedName?: string;
}

/**
 * Pure read-only view over the file and callable indexes. Does NOT
 * include `add()` or `clear()`.
 *
 * Used by consumers that only query symbols (resolvers, type-env, field
 * extractors). The interface is strictly observational — holding a
 * `SymbolTableReader` cannot mutate the table in any way.
 *
 * For consumers that also need to register symbols, use
 * {@link SymbolTableWriter}, which extends this interface with `add()`.
 * Neither interface exposes `clear()` — that capability lives on the
 * internal factory return type and is reachable only inside
 * `SemanticModel` via `rawSymbols`.
 *
 * Segregating the observer contract from the mutation contract means
 * callers holding only a Reader can never desync the model.
 */
export interface SymbolTableReader {
  /**
   * High Confidence: Look for a symbol specifically inside a file.
   * Returns the Node ID if found.
   */
  lookupExact: (filePath: string, name: string) => string | undefined;

  /**
   * High Confidence: Look for a symbol in a specific file, returning full definition.
   * Returns first matching definition — use lookupExactAll for overloaded methods.
   */
  lookupExactFull: (filePath: string, name: string) => SymbolDefinition | undefined;

  /**
   * High Confidence: Look for ALL symbols with this name in a specific file.
   * Returns all definitions, including overloaded methods with the same name.
   * The returned array is a view into the live internal index — callers
   * MUST NOT mutate it. Use `readonly` to enforce this at the type level.
   */
  lookupExactAll: (filePath: string, name: string) => readonly SymbolDefinition[];

  /**
   * Look up callable symbols (Function, Macro, Delegate) by name.
   * O(1) via dedicated eagerly-populated index keyed by symbol name.
   * Returned array is a view into the live index — do not mutate.
   */
  lookupCallableByName: (name: string) => readonly SymbolDefinition[];

  /**
   * Iterate all indexed file paths.
   * Used by Tier 2b (package-scoped) resolution to walk files matching a
   * package directory suffix without a global name scan.
   */
  getFiles: () => IterableIterator<string>;

  /**
   * Debugging: See how many files are tracked.
   */
  getStats: () => {
    fileCount: number;
  };
}

/**
 * Writer view — reads + symbol registration. Does NOT include `clear()`.
 *
 * `MutableSemanticModel.symbols` is typed as this interface, so the
 * lifecycle owner can register symbols and query them. Full-model
 * resets flow through `model.clear()`.
 *
 * The cascading `clear()` capability lives exclusively on the internal
 * factory return type ({@link createSymbolTable}) — a private handle
 * held only by `SemanticModel` via `rawSymbols`.
 */
export interface SymbolTableWriter extends SymbolTableReader {
  /**
   * Register a symbol in the file and (if callable) name-keyed indexes.
   *
   * Returns the constructed {@link SymbolDefinition} so higher-layer
   * wrappers (e.g. `createSemanticModel`) can reuse it without rebuilding
   * the def. This keeps the fan-out in one allocation.
   */
  add: (
    filePath: string,
    name: string,
    nodeId: string,
    type: NodeLabel,
    metadata?: AddMetadata,
  ) => SymbolDefinition;
}

/**
 * Internal return type for {@link createSymbolTable} — extends the
 * writer with `clear()`. This capability is intentionally NOT exported
 * as a named interface; consumers should hold a `SymbolTableReader` or
 * `SymbolTableWriter` instead.
 *
 * `SemanticModel`'s constructor is the only caller of `createSymbolTable`,
 * and it retains the returned handle as the private `rawSymbols`
 * reference so `cascadeClear` can reach `clear()`. Every other consumer
 * receives the narrower `SymbolTableWriter` facade on `model.symbols`.
 */
interface InternalSymbolTable extends SymbolTableWriter {
  /**
   * Cleanup memory. Clears only the file and callable indexes owned here —
   * owner-scoped registries are cleared by their respective owners via
   * `model.clear()`.
   */
  clear: () => void;
}

export const createSymbolTable = (): InternalSymbolTable => {
  // 1. File-Specific Index — stores full SymbolDefinition(s) for O(1) lookup.
  // Structure: FilePath -> (SymbolName -> SymbolDefinition[])
  // Array allows overloaded methods (same name, different signatures) to coexist.
  const fileIndex = new Map<string, Map<string, SymbolDefinition[]>>();

  // 2. Eagerly-populated Callable Index — maintained on add().
  // Structure: SymbolName -> [Callable Definitions]
  // Only Function, Method, Constructor, Macro, Delegate symbols are indexed.
  const callableByName = new Map<string, SymbolDefinition[]>();

  const add = (
    filePath: string,
    name: string,
    nodeId: string,
    type: NodeLabel,
    metadata?: AddMetadata,
  ): SymbolDefinition => {
    const qualifiedName = CLASS_TYPES.has(type)
      ? (metadata?.qualifiedName ?? name)
      : metadata?.qualifiedName;
    const def: SymbolDefinition = {
      nodeId,
      filePath,
      type,
      ...(qualifiedName !== undefined ? { qualifiedName } : {}),
      ...(metadata?.parameterCount !== undefined
        ? { parameterCount: metadata.parameterCount }
        : {}),
      ...(metadata?.requiredParameterCount !== undefined
        ? { requiredParameterCount: metadata.requiredParameterCount }
        : {}),
      ...(metadata?.parameterTypes !== undefined
        ? { parameterTypes: metadata.parameterTypes }
        : {}),
      ...(metadata?.returnType !== undefined ? { returnType: metadata.returnType } : {}),
      ...(metadata?.declaredType !== undefined ? { declaredType: metadata.declaredType } : {}),
      ...(metadata?.ownerId !== undefined ? { ownerId: metadata.ownerId } : {}),
    };

    // A. File Index — unconditional.
    if (!fileIndex.has(filePath)) {
      fileIndex.set(filePath, new Map());
    }
    const fileMap = fileIndex.get(filePath)!;
    if (!fileMap.has(name)) {
      fileMap.set(name, [def]);
    } else {
      fileMap.get(name)!.push(def);
    }

    // B. Callable Index — gated by FREE_CALLABLE_TYPES.
    //    Note: Property is NOT in FREE_CALLABLE_TYPES, so it never lands here.
    //    This is the single source of truth for callable-index membership;
    //    the higher-layer dispatch table only decides owner-scoped routing.
    //
    //    Fallback: `Method` or `Constructor` without an `ownerId` is an
    //    extractor contract violation (AST-degraded parse, or a buggy
    //    language extractor). The owner-scoped dispatch hook silently
    //    skips such defs because it has no owner to key them under, so
    //    without this fallback they would be invisible at Tier 3 global
    //    resolution. Route them through `callableByName` so they remain
    //    reachable by name — matching pre-dispatch-table behavior.
    const isOrphanedOwnerScoped =
      (type === 'Method' || type === 'Constructor') && metadata?.ownerId === undefined;
    if (FREE_CALLABLE_TYPES.has(type) || isOrphanedOwnerScoped) {
      const existing = callableByName.get(name);
      if (existing) {
        existing.push(def);
      } else {
        callableByName.set(name, [def]);
      }
    }

    return def;
  };

  const lookupExact = (filePath: string, name: string): string | undefined => {
    const defs = fileIndex.get(filePath)?.get(name);
    return defs?.[0]?.nodeId;
  };

  const lookupExactFull = (filePath: string, name: string): SymbolDefinition | undefined => {
    const defs = fileIndex.get(filePath)?.get(name);
    return defs?.[0];
  };

  const lookupExactAll = (filePath: string, name: string): SymbolDefinition[] => {
    return fileIndex.get(filePath)?.get(name) ?? [];
  };

  const lookupCallableByName = (name: string): SymbolDefinition[] => {
    return callableByName.get(name) ?? [];
  };

  /** Returns a live iterator over all indexed file paths (fileIndex.keys()).
   *  The iterator is invalidated if add() changes fileIndex.size during
   *  iteration (ES2015 Map spec). Safe in the current pipeline because all
   *  symbols are added before resolution begins. */
  const getFiles = (): IterableIterator<string> => fileIndex.keys();

  const getStats = () => ({
    fileCount: fileIndex.size,
  });

  const clear = () => {
    fileIndex.clear();
    callableByName.clear();
  };

  return {
    add,
    lookupExact,
    lookupExactFull,
    lookupExactAll,
    lookupCallableByName,
    getFiles,
    getStats,
    clear,
  };
};
