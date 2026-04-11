import type { NodeLabel } from 'gitnexus-shared';
import type {
  MutableTypeRegistry,
  MutableMethodRegistry,
  MutableFieldRegistry,
} from './model/semantic-model.js';
import { createTypeRegistry } from './model/type-registry.js';
import { createMethodRegistry } from './model/method-registry.js';
import { createFieldRegistry } from './model/field-registry.js';

export const CLASS_TYPES = new Set([
  'Class',
  'Struct',
  'Interface',
  'Enum',
  'Record',
  // Traits are class-like for heritage resolution: PHP `use Trait;`, Rust
  // `impl Trait for Struct`, and Scala traits all contribute methods to the
  // hierarchy of their using/implementing type. Including Trait here lets
  // buildHeritageMap resolve `h.parentName` to a Trait nodeId so the MRO
  // walker can visit the trait and find its methods.
  'Trait',
]);

/** Callable symbol types indexed in callableByName for Tier 3 resolution
 *  and D2 widen in call-processor.ts. Single source of truth — do not
 *  duplicate this set elsewhere. */
export const CALLABLE_TYPES = new Set([
  'Function',
  'Method',
  'Constructor',
  'Macro', // C/C++
  'Delegate', // C#
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
   *  Populated when parameter types are resolvable from AST (any typed language).
   *  Used for disambiguation in overloading languages (Java, Kotlin, C#, C++). */
  parameterTypes?: string[];
  /** Raw return type text extracted from AST (e.g. 'User', 'Promise<User>') */
  returnType?: string;
  /** Declared type for non-callable symbols — fields/properties (e.g. 'Address', 'List<User>') */
  declaredType?: string;
  /** Links Method/Constructor/Property to owning Class/Struct/Trait nodeId */
  ownerId?: string;
}

/**
 * File-scoped + callable-name-scoped symbol index (SM-21).
 *
 * Post-inversion, SymbolTable holds ONLY the file-indexed and
 * name-keyed callable indexes — the things that are orthogonal to
 * owner-scoped type/method/field knowledge. The type/method/field
 * registries live on {@link SemanticModel} and are injected into
 * SymbolTable's `add()` as a dependency. `SymbolTable` itself is
 * nested under `SemanticModel.symbols`, so the ownership direction is:
 *
 *     SemanticModel (top-level)
 *       ├── types / methods / fields     (owner-scoped registries)
 *       └── symbols: SymbolTable         (file-indexed + callable-name index)
 *
 * Consumers should receive `SemanticModel` and reach into `.symbols`
 * only when they need file-scoped or callable-name lookups; owner-scoped
 * lookups go through `.types` / `.methods` / `.fields` directly.
 */
export interface SymbolTable {
  /**
   * Register a new symbol definition. Routes Property/Method/Constructor/
   * class-like/Impl registrations into the injected semantic registries,
   * and always populates the file index + callable index as appropriate.
   */
  add: (
    filePath: string,
    name: string,
    nodeId: string,
    type: NodeLabel,
    metadata?: {
      parameterCount?: number;
      requiredParameterCount?: number;
      parameterTypes?: string[];
      returnType?: string;
      declaredType?: string;
      ownerId?: string;
      qualifiedName?: string;
    },
  ) => void;

  /**
   * High Confidence: Look for a symbol specifically inside a file
   * Returns the Node ID if found
   */
  lookupExact: (filePath: string, name: string) => string | undefined;

  /**
   * High Confidence: Look for a symbol in a specific file, returning full definition.
   * Includes type information needed for heritage resolution (Class vs Interface).
   * Returns first matching definition — use lookupExactAll for overloaded methods.
   */
  lookupExactFull: (filePath: string, name: string) => SymbolDefinition | undefined;

  /**
   * High Confidence: Look for ALL symbols with this name in a specific file.
   * Returns all definitions, including overloaded methods with the same name.
   * Used by resolution-context to pass all same-file overloads to candidate filtering.
   */
  lookupExactAll: (filePath: string, name: string) => SymbolDefinition[];

  /**
   * Look up callable symbols (Function, Method, Constructor, Macro, Delegate) by name.
   * O(1) via dedicated eagerly-populated index keyed by symbol name.
   * Used by Tier 3 resolution and ReturnTypeLookup to resolve callee → return type.
   */
  lookupCallableByName: (name: string) => SymbolDefinition[];

  // ---------------------------------------------------------------------
  // Registry convenience delegates
  //
  // SymbolTable does not *own* the type/method/field registries — they
  // live on the parent {@link SemanticModel}. These delegates forward to
  // the injected registries so standalone SymbolTable consumers (chiefly
  // tests that build a SymbolTable without a SemanticModel wrapper) keep
  // a flat, ergonomic lookup API. Production code should prefer
  // `model.types.*`, `model.methods.*`, and `model.fields.*` directly.
  // ---------------------------------------------------------------------

  /**
   * Look up a field/property by its owning class nodeId and field name.
   * Delegates to the injected {@link FieldRegistry}.
   */
  lookupFieldByOwner: (ownerNodeId: string, fieldName: string) => SymbolDefinition | undefined;

  /**
   * Lookup a method by owner class + name, optionally filtered by arity.
   * Delegates to the injected {@link MethodRegistry}. See the registry
   * documentation for overload disambiguation semantics.
   */
  lookupMethodByOwner: (
    ownerNodeId: string,
    methodName: string,
    argCount?: number,
  ) => SymbolDefinition | undefined;

  /**
   * Look up class-like definitions (Class, Struct, Interface, Enum, Record,
   * Trait) by name. Delegates to the injected {@link TypeRegistry}.
   */
  lookupClassByName: (name: string) => SymbolDefinition[];

  /**
   * Look up class-like definitions by canonical qualified name.
   * Delegates to the injected {@link TypeRegistry}.
   */
  lookupClassByQualifiedName: (qualifiedName: string) => SymbolDefinition[];

  /**
   * Look up Rust `Impl` blocks by name. Delegates to the injected
   * {@link TypeRegistry}.
   */
  lookupImplByName: (name: string) => SymbolDefinition[];

  /**
   * Iterate all indexed file paths.
   * Used by Tier 2b (package-scoped) resolution to walk files matching a
   * package directory suffix without a global name scan.
   */
  getFiles: () => IterableIterator<string>;

  /**
   * Debugging: See how many symbols are tracked
   */
  getStats: () => {
    fileCount: number;
  };

  /**
   * Cleanup memory (only the file index + callable index owned here —
   * the caller is responsible for clearing the injected registries).
   */
  clear: () => void;
}

/**
 * Dependencies injected by {@link createSemanticModel}. Passing the
 * mutable variants lets `add()` register type/method/field symbols
 * without knowing the parent SemanticModel.
 */
export interface SymbolTableDeps {
  types: MutableTypeRegistry;
  methods: MutableMethodRegistry;
  fields: MutableFieldRegistry;
}

export const createSymbolTable = (deps?: SymbolTableDeps): SymbolTable => {
  // Production path: SemanticModel injects its registries so the feed is
  // shared with the top-level model.
  //
  // Test/standalone path: when no deps are passed, create standalone
  // registries locally. Used by tests that only exercise file/callable
  // lookups and don't need the parent SemanticModel container. Callers
  // can reach the standalone registries via the returned symbol table's
  // `add` (which still routes into them) — they are not otherwise
  // reachable from the returned SymbolTable, matching the pre-SM-21
  // public surface.
  // When deps is undefined, this SymbolTable is standalone — it owns the
  // registries and must clear them in `clear()`. When deps is injected by
  // {@link createSemanticModel}, the parent model owns them and clears
  // them from its own `clear()` method, so this SymbolTable must NOT clear
  // the injected registries to avoid a double-clear race.
  const ownsRegistries = deps === undefined;
  const types = deps?.types ?? createTypeRegistry();
  const methods = deps?.methods ?? createMethodRegistry();
  const fields = deps?.fields ?? createFieldRegistry();

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
    metadata?: {
      parameterCount?: number;
      requiredParameterCount?: number;
      parameterTypes?: string[];
      returnType?: string;
      declaredType?: string;
      ownerId?: string;
      qualifiedName?: string;
    },
  ) => {
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

    // A. Add to File Index (shared reference — zero additional memory)
    if (!fileIndex.has(filePath)) {
      fileIndex.set(filePath, new Map());
    }
    const fileMap = fileIndex.get(filePath)!;
    if (!fileMap.has(name)) {
      fileMap.set(name, [def]);
    } else {
      fileMap.get(name)!.push(def);
    }

    // B. Properties go to the fields registry only — skip other indexes to
    // prevent namespace pollution for common names like 'id', 'name', 'type'.
    // Index ALL properties (even without declaredType) so write-access tracking
    // can resolve field ownership for dynamically-typed languages (Ruby, JS).
    if (type === 'Property' && metadata?.ownerId) {
      fields.register(metadata.ownerId, name, def);
      // Still added to fileIndex above (for lookupExact); skip other indexes.
      return;
    }

    // C. Methods, constructors, and ownerId-bound Functions go to the
    // methods registry.
    //
    // Some language extractors emit class methods as `Function` with an
    // `ownerId` — notably Python (`def method(self):` inside a class body),
    // Rust trait methods, and Kotlin object/companion methods. Treating
    // `Function` with ownerId the same as `Method` here makes owner-scoped
    // method resolution work uniformly across all supported languages
    // instead of silently falling through to name-only widening.
    if ((type === 'Method' || type === 'Constructor' || type === 'Function') && metadata?.ownerId) {
      methods.register(metadata.ownerId, name, def);
    }

    // C2. Class-like types go to the types registry.
    if (CLASS_TYPES.has(type)) {
      const qualifiedKey = qualifiedName ?? name;
      types.registerClass(name, qualifiedKey, def);
    }

    // C3. Rust Impl blocks go to implByName on the types registry
    // (separate from classByName to avoid polluting heritage resolution with
    // Impl nodes as parent candidates).
    if (type === 'Impl') {
      types.registerImpl(name, def);
    }

    // D. Eagerly maintain callable index (like types/methods/fields above).
    if (CALLABLE_TYPES.has(type)) {
      const existing = callableByName.get(name);
      if (existing) {
        existing.push(def);
      } else {
        callableByName.set(name, [def]);
      }
    }
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

  // Registry convenience delegates — forward to the injected registries.
  const lookupFieldByOwner = (
    ownerNodeId: string,
    fieldName: string,
  ): SymbolDefinition | undefined => fields.lookupFieldByOwner(ownerNodeId, fieldName);

  const lookupMethodByOwner = (
    ownerNodeId: string,
    methodName: string,
    argCount?: number,
  ): SymbolDefinition | undefined => methods.lookupMethodByOwner(ownerNodeId, methodName, argCount);

  const lookupClassByName = (name: string): SymbolDefinition[] => types.lookupClassByName(name);

  const lookupClassByQualifiedName = (qualifiedName: string): SymbolDefinition[] =>
    types.lookupClassByQualifiedName(qualifiedName);

  const lookupImplByName = (name: string): SymbolDefinition[] => types.lookupImplByName(name);

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
    // Only clear registries we own. When SemanticModel injected them,
    // the parent model handles clearing to avoid double-clearing them
    // when both table.clear() and model.clear() are called in sequence.
    if (ownsRegistries) {
      types.clear();
      methods.clear();
      fields.clear();
    }
  };

  return {
    add,
    lookupExact,
    lookupExactFull,
    lookupExactAll,
    lookupCallableByName,
    lookupFieldByOwner,
    lookupMethodByOwner,
    lookupClassByName,
    lookupClassByQualifiedName,
    lookupImplByName,
    getFiles,
    getStats,
    clear,
  };
};
