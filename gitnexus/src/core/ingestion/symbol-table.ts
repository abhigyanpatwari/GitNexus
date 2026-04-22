import type { NodeLabel } from 'gitnexus-shared';

export const CLASS_TYPES = new Set(['Class', 'Struct', 'Interface', 'Enum', 'Record']);

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
  lookupMethodByOwner: (ownerNodeId: string, methodName: string) => SymbolDefinition | undefined;

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
   * Debugging: See how many symbols are tracked
   */
  getStats: () => { fileCount: number; globalSymbolCount: number };

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

  // 3. Lazy Callable Index — populated on first lookupFuzzyCallable call.
  // Structure: SymbolName -> [Callable Definitions]
  // Only Function, Method, Constructor symbols are indexed.
  let callableIndex: Map<string, SymbolDefinition[]> | null = null;

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

  const CALLABLE_TYPES = new Set(['Function', 'Method', 'Constructor']);

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

    // C2. Methods with ownerId go to methodByOwner index (in addition to globalIndex).
    if (type === 'Method' && metadata?.ownerId) {
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

    // D. Invalidate the lazy callable index only when adding callable types
    if (CALLABLE_TYPES.has(type)) {
      callableIndex = null;
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
    return globalIndex.get(name) || [];
  };

  const lookupFuzzyCallable = (name: string): SymbolDefinition[] => {
    if (!callableIndex) {
      // Build the callable index lazily on first use
      callableIndex = new Map();
      for (const [symName, defs] of globalIndex) {
        const callables = defs.filter((d) => CALLABLE_TYPES.has(d.type));
        if (callables.length > 0) callableIndex.set(symName, callables);
      }
    }
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
  ): SymbolDefinition | undefined => {
    const defs = methodByOwner.get(`${ownerNodeId}\0${methodName}`);
    if (!defs || defs.length === 0) return undefined;
    if (defs.length === 1) return defs[0];
    // Multiple overloads: return first if all share the same defined returnType (safe for chain resolution).
    // Return undefined if return types differ or are absent (truly ambiguous — can't determine which overload).
    const firstReturnType = defs[0].returnType;
    if (firstReturnType === undefined) return undefined;
    for (let i = 1; i < defs.length; i++) {
      if (defs[i].returnType !== firstReturnType) return undefined;
    }
    return defs[0];
  };

  const lookupClassByName = (name: string): SymbolDefinition[] => {
    return classByName.get(name) ?? [];
  };

  const lookupClassByQualifiedName = (qualifiedName: string): SymbolDefinition[] => {
    return classByQualifiedName.get(qualifiedName) ?? [];
  };

  const getStats = () => ({
    fileCount: fileIndex.size,
    globalSymbolCount: globalIndex.size,
  });

  const clear = () => {
    fileIndex.clear();
    globalIndex.clear();
    callableIndex = null;
    fieldByOwner.clear();
    methodByOwner.clear();
    classByName.clear();
    classByQualifiedName.clear();
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
    getStats,
    clear,
  };
};
