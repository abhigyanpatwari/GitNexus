import type { NodeLabel } from '../graph/types.js';

export interface SymbolDefinition {
  nodeId: string;
  filePath: string;
  type: NodeLabel;
  parameterCount?: number;
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
    metadata?: { parameterCount?: number; returnType?: string; declaredType?: string; ownerId?: string }
  ) => void;
  
  /**
   * High Confidence: Look for a symbol specifically inside a file
   * Returns the Node ID if found
   */
  lookupExact: (filePath: string, name: string) => string | undefined;
  
  /**
   * High Confidence: Look for a symbol in a specific file, returning full definition.
   * Includes type information needed for heritage resolution (Class vs Interface).
   */
  lookupExactFull: (filePath: string, name: string) => SymbolDefinition | undefined;

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
   * Debugging: See how many symbols are tracked
   */
  getStats: () => { fileCount: number; globalSymbolCount: number };
  
  /**
   * Cleanup memory
   */
  clear: () => void;
}

export const createSymbolTable = (): SymbolTable => {
  // 1. File-Specific Index — stores full SymbolDefinition for O(1) lookupExactFull
  // Structure: FilePath -> (SymbolName -> SymbolDefinition)
  const fileIndex = new Map<string, Map<string, SymbolDefinition>>();

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

  const CALLABLE_TYPES = new Set(['Function', 'Method', 'Constructor']);

  const add = (
    filePath: string,
    name: string,
    nodeId: string,
    type: NodeLabel,
    metadata?: { parameterCount?: number; returnType?: string; declaredType?: string; ownerId?: string }
  ) => {
    const def: SymbolDefinition = {
      nodeId,
      filePath,
      type,
      ...(metadata?.parameterCount !== undefined ? { parameterCount: metadata.parameterCount } : {}),
      ...(metadata?.returnType !== undefined ? { returnType: metadata.returnType } : {}),
      ...(metadata?.declaredType !== undefined ? { declaredType: metadata.declaredType } : {}),
      ...(metadata?.ownerId !== undefined ? { ownerId: metadata.ownerId } : {}),
    };

    // A. Add to File Index (shared reference — zero additional memory)
    if (!fileIndex.has(filePath)) {
      fileIndex.set(filePath, new Map());
    }
    fileIndex.get(filePath)!.set(name, def);

    // B. Properties go to fieldByOwner index only — skip globalIndex to prevent
    // namespace pollution for common names like 'id', 'name', 'type'.
    if (type === 'Property' && metadata?.ownerId) {
      if (metadata?.declaredType) {
        fieldByOwner.set(`${metadata.ownerId}\0${name}`, def);
      }
      // Still add to fileIndex above (for lookupExact), but skip globalIndex
      return;
    }

    // C. Add to Global Index (same object reference)
    if (!globalIndex.has(name)) {
      globalIndex.set(name, []);
    }
    globalIndex.get(name)!.push(def);

    // D. Invalidate the lazy callable index only when adding callable types
    if (CALLABLE_TYPES.has(type)) {
      callableIndex = null;
    }
  };

  const lookupExact = (filePath: string, name: string): string | undefined => {
    return fileIndex.get(filePath)?.get(name)?.nodeId;
  };

  const lookupExactFull = (filePath: string, name: string): SymbolDefinition | undefined => {
    return fileIndex.get(filePath)?.get(name);
  };

  const lookupFuzzy = (name: string): SymbolDefinition[] => {
    return globalIndex.get(name) || [];
  };

  const lookupFuzzyCallable = (name: string): SymbolDefinition[] => {
    if (!callableIndex) {
      // Build the callable index lazily on first use
      callableIndex = new Map();
      for (const [symName, defs] of globalIndex) {
        const callables = defs.filter(d => CALLABLE_TYPES.has(d.type));
        if (callables.length > 0) callableIndex.set(symName, callables);
      }
    }
    return callableIndex.get(name) ?? [];
  };

  const lookupFieldByOwner = (ownerNodeId: string, fieldName: string): SymbolDefinition | undefined => {
    return fieldByOwner.get(`${ownerNodeId}\0${fieldName}`);
  };

  const getStats = () => ({
    fileCount: fileIndex.size,
    globalSymbolCount: globalIndex.size
  });

  const clear = () => {
    fileIndex.clear();
    globalIndex.clear();
    callableIndex = null;
    fieldByOwner.clear();
  };

  return { add, lookupExact, lookupExactFull, lookupFuzzy, lookupFuzzyCallable, lookupFieldByOwner, getStats, clear };
};
