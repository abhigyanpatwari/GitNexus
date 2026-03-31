export interface SymbolDefinition {
  nodeId: string;
  filePath: string;
  type: string; // 'Function', 'Class', etc.
}

export interface SymbolTable {
  /**
   * Register a new symbol definition
   */
  add: (filePath: string, name: string, nodeId: string, type: string) => void;

  /**
   * High Confidence: Look for a symbol specifically inside a file
   * Returns the Node ID if found
   */
  lookupExact: (filePath: string, name: string) => string | undefined;

  /**
   * Low Confidence: Look for a symbol anywhere in the project
   * Used when imports are missing or for framework magic
   */
  lookupFuzzy: (name: string) => SymbolDefinition[];

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
  // 1. File-Specific Index (The "Good" one)
  // Structure: FilePath -> (SymbolName -> NodeID)
  const fileIndex = new Map<string, Map<string, string>>();

  // 2. Global Reverse Index (The "Backup")
  // Structure: SymbolName -> [List of Definitions]
  const globalIndex = new Map<string, SymbolDefinition[]>();

  const add = (
    filePath: string,
    name: string,
    nodeId: string,
    type: string,
  ) => {
    // A. Add to File Index
    if (!fileIndex.has(filePath)) {
      fileIndex.set(filePath, new Map());
    }
    fileIndex.get(filePath)!.set(name, nodeId);

    // B. Add to Global Index
    if (!globalIndex.has(name)) {
      globalIndex.set(name, []);
    }
    globalIndex.get(name)!.push({ nodeId, filePath, type });
  };

  const lookupExact = (filePath: string, name: string): string | undefined => {
    const fileSymbols = fileIndex.get(filePath);
    if (!fileSymbols) return undefined;
    return fileSymbols.get(name);
  };

  const lookupFuzzy = (name: string): SymbolDefinition[] => {
    return globalIndex.get(name) || [];
  };

  const getStats = () => ({
    fileCount: fileIndex.size,
    globalSymbolCount: globalIndex.size,
  });

  const clear = () => {
    fileIndex.clear();
    globalIndex.clear();
  };

  return { add, lookupExact, lookupFuzzy, getStats, clear };
};
