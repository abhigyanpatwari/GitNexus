interface TrieNode {
  children: Map<string, TrieNode>;
  definitions: FunctionDefinition[];
  isEndOfWord: boolean;
}

interface FunctionDefinition {
  nodeId: string;
  qualifiedName: string;
  filePath: string;
  functionName: string;
  type: 'function' | 'method' | 'class' | 'interface' | 'enum';
  startLine?: number;
  endLine?: number;
}

export class FunctionRegistryTrie {
  private root: TrieNode;
  private allDefinitions: Map<string, FunctionDefinition>;
  // Performance optimization: Index for fast lookups
  private functionNameIndex: Map<string, FunctionDefinition[]>;
  private filePathIndex: Map<string, FunctionDefinition[]>;

  constructor() {
    this.root = {
      children: new Map(),
      definitions: [],
      isEndOfWord: false
    };
    this.allDefinitions = new Map();
    this.functionNameIndex = new Map();
    this.filePathIndex = new Map();
  }

  /**
   * Add a function definition to the trie with optimized indexing
   * @param definition The function definition to add
   */
  addDefinition(definition: FunctionDefinition): void {
    const parts = definition.qualifiedName.split('.');
    let currentNode = this.root;

    // Build the trie path
    for (const part of parts) {
      if (!currentNode.children.has(part)) {
        currentNode.children.set(part, {
          children: new Map(),
          definitions: [],
          isEndOfWord: false
        });
      }
      currentNode = currentNode.children.get(part)!;
    }

    // Mark end of word and store definition
    currentNode.isEndOfWord = true;
    currentNode.definitions.push(definition);
    
    // Store in flat map for quick access
    this.allDefinitions.set(definition.nodeId, definition);
    
    // Update indexes for performance
    this.updateIndexes(definition);
  }

  /**
   * Update performance indexes when adding definitions
   */
  private updateIndexes(definition: FunctionDefinition): void {
    // Function name index
    if (!this.functionNameIndex.has(definition.functionName)) {
      this.functionNameIndex.set(definition.functionName, []);
    }
    this.functionNameIndex.get(definition.functionName)!.push(definition);
    
    // File path index
    if (!this.filePathIndex.has(definition.filePath)) {
      this.filePathIndex.set(definition.filePath, []);
    }
    this.filePathIndex.get(definition.filePath)!.push(definition);
  }

  /**
   * Find all definitions that end with the given name (OPTIMIZED)
   * This is the key method for heuristic resolution
   * @param name The function name to search for
   * @returns Array of matching definitions
   */
  findEndingWith(name: string): FunctionDefinition[] {
    // Use index for O(1) lookup instead of O(n) tree traversal
    return this.functionNameIndex.get(name) || [];
  }

  /**
   * Get exact definition by qualified name
   * @param qualifiedName The full qualified name
   * @returns The definition if found
   */
  getExactMatch(qualifiedName: string): FunctionDefinition[] {
    const parts = qualifiedName.split('.');
    let currentNode = this.root;

    for (const part of parts) {
      if (!currentNode.children.has(part)) {
        return [];
      }
      currentNode = currentNode.children.get(part)!;
    }

    return currentNode.isEndOfWord ? currentNode.definitions : [];
  }

  /**
   * Find definitions in the same file (OPTIMIZED)
   * @param filePath The file path to search in
   * @param functionName The function name to find
   * @returns Array of matching definitions in the same file
   */
  findInSameFile(filePath: string, functionName: string): FunctionDefinition[] {
    // Use file path index for faster lookup
    const fileDefinitions = this.filePathIndex.get(filePath) || [];
    return fileDefinitions.filter(def => def.functionName === functionName);
  }

  /**
   * Get all definitions in a specific file (NEW - OPTIMIZED)
   * @param filePath The file path to search in
   * @returns Array of all definitions in the file
   */
  getDefinitionsInFile(filePath: string): FunctionDefinition[] {
    return this.filePathIndex.get(filePath) || [];
  }

  /**
   * Find definitions by type (NEW - OPTIMIZED)
   * @param type The definition type to search for
   * @returns Array of matching definitions
   */
  findByType(type: FunctionDefinition['type']): FunctionDefinition[] {
    return Array.from(this.allDefinitions.values()).filter(def => def.type === type);
  }

  /**
   * Get all definitions for debugging/stats
   * @returns All stored definitions
   */
  getAllDefinitions(): FunctionDefinition[] {
    return Array.from(this.allDefinitions.values());
  }

  /**
   * Get statistics about the trie (NEW)
   * @returns Trie statistics
   */
  getStatistics(): {
    totalDefinitions: number;
    definitionsByType: Record<string, number>;
    fileCount: number;
    uniqueFunctionNames: number;
  } {
    const definitionsByType: Record<string, number> = {};
    
    for (const definition of this.allDefinitions.values()) {
      definitionsByType[definition.type] = (definitionsByType[definition.type] || 0) + 1;
    }
    
    return {
      totalDefinitions: this.allDefinitions.size,
      definitionsByType,
      fileCount: this.filePathIndex.size,
      uniqueFunctionNames: this.functionNameIndex.size
    };
  }

  /**
   * Calculate import distance between two file paths
   * Lower score = closer/better match
   * @param callerPath Path of the calling file
   * @param candidatePath Path of the candidate definition file
   * @returns Distance score (lower is better)
   */
  static calculateImportDistance(callerPath: string, candidatePath: string): number {
    const callerParts = callerPath.split('/').filter(p => p !== '');
    const candidateParts = candidatePath.split('/').filter(p => p !== '');

    // Find common prefix length
    let commonPrefixLength = 0;
    const minLength = Math.min(callerParts.length, candidateParts.length);
    
    for (let i = 0; i < minLength; i++) {
      if (callerParts[i] === candidateParts[i]) {
        commonPrefixLength++;
      } else {
        break;
      }
    }

    // Calculate base distance
    const maxLength = Math.max(callerParts.length, candidateParts.length);
    let distance = maxLength - commonPrefixLength;

    // Bonus for sibling modules (same parent directory)
    if (commonPrefixLength === Math.min(callerParts.length, candidateParts.length) - 1) {
      distance -= 1; // Sibling bonus
    }

    return distance;
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.root = {
      children: new Map(),
      definitions: [],
      isEndOfWord: false
    };
    this.allDefinitions.clear();
    this.functionNameIndex.clear();
    this.filePathIndex.clear();
  }

  /**
   * Remove definitions from a specific file (NEW - for incremental updates)
   * @param filePath The file path to remove definitions for
   */
  removeFileDefinitions(filePath: string): void {
    const definitions = this.filePathIndex.get(filePath);
    if (!definitions) return;

    // Remove from all indexes
    for (const definition of definitions) {
      this.allDefinitions.delete(definition.nodeId);
      
      // Remove from function name index
      const functionDefs = this.functionNameIndex.get(definition.functionName);
      if (functionDefs) {
        const index = functionDefs.indexOf(definition);
        if (index > -1) {
          functionDefs.splice(index, 1);
        }
        if (functionDefs.length === 0) {
          this.functionNameIndex.delete(definition.functionName);
        }
      }
    }

    // Remove from file path index
    this.filePathIndex.delete(filePath);

    // TODO: Clean up the trie structure (complex operation, can be done later)
    // For now, we'll leave empty nodes in the trie for performance
  }
}

export type { FunctionDefinition };
