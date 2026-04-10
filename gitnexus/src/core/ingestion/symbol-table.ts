import type { NodeLabel } from 'gitnexus-shared';

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

export interface SymbolTable {
  /**
   * Register a new symbol definition
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
   * Low Confidence: Look for a symbol anywhere in the project
   * Used when imports are missing or for framework magic
   */
  lookupFuzzy: (name: string) => SymbolDefinition[];

  /**
   * Low Confidence: Look for callable symbols (Function/Method/Constructor) by name.
   * Faster than `lookupFuzzy` + filter — backed by a lazy callable-only index.
   * Used by ReturnTypeLookup to resolve callee → return type.
   */
  lookupFuzzyCallable: (name: string) => SymbolDefinition[];

  /**
   * Look up a field/property by its owning class nodeId and field name.
   * O(1) via dedicated eagerly-populated index keyed by `ownerNodeId\0fieldName`.
   * Returns undefined when no matching property exists or the owner is ambiguous.
   */
  lookupFieldByOwner: (ownerNodeId: string, fieldName: string) => SymbolDefinition | undefined;

  /**
   * Look up a method by its owning class nodeId and method name.
   * O(1) via dedicated eagerly-populated index keyed by `ownerNodeId\0methodName`.
   * For overloaded methods (same owner + name): returns the first match when all
   * overloads share the same returnType, undefined when return types differ (ambiguous).
   * Used by walkMixedChain for deterministic cross-class chain resolution.
   */
  /**
   * Lookup a method by owner class + name, optionally filtered by arity.
   *
   * When `argCount` is provided, overloads whose parameter count doesn't
   * accommodate the call's argument count are filtered out before the
   * returnType dedup runs. This lets D0 (`resolveMemberCall`) disambiguate
   * arity-differing overloads (e.g. C++ `greet()` vs `greet(string)`) that
   * would otherwise collide on the shared `ownerId + methodName` key.
   *
   * Same-arity, same-returnType overloads (e.g. `save(int)` vs `save(String)`,
   * both returning `void`) still collapse to the first match — callers must
   * gate D0 on overload concern before invoking this function for that case.
   */
  lookupMethodByOwner: (
    ownerNodeId: string,
    methodName: string,
    argCount?: number,
  ) => SymbolDefinition | undefined;

  /**
   * Look up class-like definitions (Class, Struct, Interface, Enum, Record) by name.
   * O(1) via dedicated eagerly-populated index keyed by symbol name.
   * Returns all matching definitions across files (e.g. partial classes).
   * Used by Phase 1 semantic-model tasks to replace filtered lookupFuzzy calls.
   */
  lookupClassByName: (name: string) => SymbolDefinition[];

  /**
   * Look up class-like definitions by canonical qualified name.
   * Qualified names are normalized to dot-separated scope segments across languages,
   * e.g. `App.Models.User`, `com.example.User`, or `Admin.User`.
   * Top-level class-like symbols with no explicit scope are indexed under their simple name.
   */
  lookupClassByQualifiedName: (qualifiedName: string) => SymbolDefinition[];

  /**
   * Look up Impl nodes by name.
   * O(1) via dedicated eagerly-populated index keyed by symbol name.
   * Used by Tier 3 resolution to include Rust impl blocks alongside
   * class-like candidates so method lookups on `impl User { fn save() }` work
   * correctly (Rust methods are indexed under the Impl nodeId, not the Struct).
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
    globalSymbolCount: number;
    fuzzyCallCount: number;
    fuzzyCallableCallCount: number;
  };

  /**
   * Cleanup memory
   */
  clear: () => void;
}

export const createSymbolTable = (): SymbolTable => {
  // 1. File-Specific Index — stores full SymbolDefinition(s) for O(1) lookup.
  // Structure: FilePath -> (SymbolName -> SymbolDefinition[])
  // Array allows overloaded methods (same name, different signatures) to coexist.
  const fileIndex = new Map<string, Map<string, SymbolDefinition[]>>();

  // 2. Global Reverse Index (The "Backup")
  // Structure: SymbolName -> [List of Definitions]
  const globalIndex = new Map<string, SymbolDefinition[]>();

  // 3. Eagerly-populated Callable Index — maintained on add().
  // Structure: SymbolName -> [Callable Definitions]
  // Only Function, Method, Constructor symbols are indexed.
  const callableIndex = new Map<string, SymbolDefinition[]>();

  // 4. Eagerly-populated Field/Property Index — keyed by "ownerNodeId\0fieldName".
  // Only Property symbols with ownerId and declaredType are indexed.
  const fieldByOwner = new Map<string, SymbolDefinition>();

  // 5. Eagerly-populated Method Index — keyed by "ownerNodeId\0methodName".
  // Method symbols with ownerId are indexed. Supports overloads (array values).
  const methodByOwner = new Map<string, SymbolDefinition[]>();

  // 6. Eagerly-populated Class-type Index — keyed by symbol name.
  // Only Class, Struct, Interface, Enum, Record symbols are indexed.
  const classByName = new Map<string, SymbolDefinition[]>();
  const classByQualifiedName = new Map<string, SymbolDefinition[]>();

  // 7. Eagerly-populated Impl Index — keyed by symbol name.
  // Rust impl blocks (type 'Impl') are stored here to keep them out of
  // classByName (which drives heritage resolution) while still being
  // reachable from Tier 3 resolution for method lookup.
  const implByName = new Map<string, SymbolDefinition[]>();
  let fuzzyCallCount = 0;

  let fuzzyCallableCallCount = 0;

  // Must match CALLABLE_SYMBOL_TYPES in call-processor.ts — Macro (C/C++)
  // and Delegate (C#) are callable targets that Tier 3 must surface.
  const CALLABLE_TYPES = new Set(['Function', 'Method', 'Constructor', 'Macro', 'Delegate']);

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

    // B. Properties go to fieldByOwner index only — skip globalIndex to prevent
    // namespace pollution for common names like 'id', 'name', 'type'.
    // Index ALL properties (even without declaredType) so write-access tracking
    // can resolve field ownership for dynamically-typed languages (Ruby, JS).
    if (type === 'Property' && metadata?.ownerId) {
      fieldByOwner.set(`${metadata.ownerId}\0${name}`, def);
      // Still add to fileIndex above (for lookupExact), but skip globalIndex
      return;
    }

    // C. Add to Global Index (same object reference)
    if (!globalIndex.has(name)) {
      globalIndex.set(name, []);
    }
    globalIndex.get(name)!.push(def);

    // C2. Methods, constructors, and ownerId-bound Functions go to
    // methodByOwner index (in addition to globalIndex).
    //
    // Some language extractors emit class methods as `Function` with an
    // `ownerId` — notably Python (`def method(self):` inside a class body),
    // Rust trait methods, and Kotlin object/companion methods. Treating
    // `Function` with ownerId the same as `Method` here makes D0
    // (`resolveMemberCall`) work uniformly across all supported languages
    // instead of silently falling through to D1-D4 fuzzy widening.
    if ((type === 'Method' || type === 'Constructor' || type === 'Function') && metadata?.ownerId) {
      const key = `${metadata.ownerId}\0${name}`;
      const existing = methodByOwner.get(key);
      if (existing) {
        existing.push(def);
      } else {
        methodByOwner.set(key, [def]);
      }
    }

    // C3. Class-like types go to classByName index (in addition to globalIndex).
    if (CLASS_TYPES.has(type)) {
      const existing = classByName.get(name);
      if (existing) {
        existing.push(def);
      } else {
        classByName.set(name, [def]);
      }

      const qualifiedKey = qualifiedName ?? name;
      const qualifiedMatches = classByQualifiedName.get(qualifiedKey);
      if (qualifiedMatches) {
        qualifiedMatches.push(def);
      } else {
        classByQualifiedName.set(qualifiedKey, [def]);
      }
    }

    // C4. Rust Impl blocks go to implByName (separate from classByName to avoid
    // polluting heritage resolution with Impl nodes as parent candidates).
    if (type === 'Impl') {
      const existing = implByName.get(name);
      if (existing) {
        existing.push(def);
      } else {
        implByName.set(name, [def]);
      }
    }

    // D. Eagerly maintain callable index (like classByName, implByName).
    if (CALLABLE_TYPES.has(type)) {
      const existing = callableIndex.get(name);
      if (existing) {
        existing.push(def);
      } else {
        callableIndex.set(name, [def]);
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

  const lookupFuzzy = (name: string): SymbolDefinition[] => {
    fuzzyCallCount++;
    return globalIndex.get(name) || [];
  };

  const lookupFuzzyCallable = (name: string): SymbolDefinition[] => {
    fuzzyCallableCallCount++;
    return callableIndex.get(name) ?? [];
  };

  const lookupFieldByOwner = (
    ownerNodeId: string,
    fieldName: string,
  ): SymbolDefinition | undefined => {
    return fieldByOwner.get(`${ownerNodeId}\0${fieldName}`);
  };

  const lookupMethodByOwner = (
    ownerNodeId: string,
    methodName: string,
    argCount?: number,
  ): SymbolDefinition | undefined => {
    const defs = methodByOwner.get(`${ownerNodeId}\0${methodName}`);
    if (!defs || defs.length === 0) return undefined;

    // Arity narrowing: when an argCount is provided and there are multiple
    // overloads, keep only those whose parameterCount can accommodate the
    // call. This resolves arity-differing overloads (e.g. C++ `greet()` vs
    // `greet(string)`) that share the same `ownerId + methodName` key.
    //
    // Candidates with `parameterCount === undefined` (extractor didn't
    // populate the count — typically variadic or unknown) are retained
    // conservatively so that legitimate variadic matches still resolve.
    let pool = defs;
    if (argCount !== undefined && defs.length > 1) {
      const arityMatched = defs.filter((d) => {
        if (d.parameterCount === undefined) return true;
        const min = d.requiredParameterCount ?? d.parameterCount;
        return argCount >= min && argCount <= d.parameterCount;
      });
      // Only adopt the arity-narrowed pool when it found matches; if arity
      // rules out every candidate, fall back to the unfiltered set so the
      // caller's fuzzy path still has something to work with.
      if (arityMatched.length > 0) pool = arityMatched;
    }

    if (pool.length === 1) return pool[0];
    // Multiple overloads after arity narrowing: return first if all share
    // the same defined returnType (safe for chain resolution), undefined if
    // return types differ (truly ambiguous — can't determine which overload).
    const firstReturnType = pool[0].returnType;
    if (firstReturnType === undefined) return undefined;
    for (let i = 1; i < pool.length; i++) {
      if (pool[i].returnType !== firstReturnType) return undefined;
    }
    return pool[0];
  };

  const lookupClassByName = (name: string): SymbolDefinition[] => {
    return classByName.get(name) ?? [];
  };

  const lookupClassByQualifiedName = (qualifiedName: string): SymbolDefinition[] => {
    return classByQualifiedName.get(qualifiedName) ?? [];
  };

  const lookupImplByName = (name: string): SymbolDefinition[] => {
    return implByName.get(name) ?? [];
  };

  /** Returns a live iterator over all indexed file paths (fileIndex.keys()).
   *  The iterator is invalidated if add() changes fileIndex.size during
   *  iteration (ES2015 Map spec). Safe in the current pipeline because all
   *  symbols are added before resolution begins. */
  const getFiles = (): IterableIterator<string> => fileIndex.keys();

  const getStats = () => ({
    fileCount: fileIndex.size,
    globalSymbolCount: globalIndex.size,
    fuzzyCallableCallCount: fuzzyCallableCallCount,
    fuzzyCallCount: fuzzyCallCount,
  });

  const clear = () => {
    fileIndex.clear();
    globalIndex.clear();
    callableIndex.clear();
    fieldByOwner.clear();
    methodByOwner.clear();
    classByName.clear();
    classByQualifiedName.clear();
    implByName.clear();
    fuzzyCallCount = 0;
    fuzzyCallableCallCount = 0;
  };

  return {
    add,
    lookupExact,
    lookupExactFull,
    lookupExactAll,
    lookupFuzzy,
    lookupFuzzyCallable,
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
