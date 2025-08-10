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

  constructor() {
    this.root = {
      children: new Map(),
      definitions: [],
      isEndOfWord: false
    };
    this.allDefinitions = new Map();
  }

  /**
   * Add a function definition to the trie
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
    
    // Also store in flat map for quick access
    this.allDefinitions.set(definition.nodeId, definition);
  }

  /**
   * Find all definitions that end with the given name
   * This is the key method for heuristic resolution
   * @param name The function name to search for
   * @returns Array of matching definitions
   */
  findEndingWith(name: string): FunctionDefinition[] {
    const results: FunctionDefinition[] = [];
    this._searchEndingWith(this.root, name, [], results);
    return results;
  }

  private _searchEndingWith(
    node: TrieNode, 
    targetName: string, 
    currentPath: string[], 
    results: FunctionDefinition[]
  ): void {
    // If this is the end of a word and matches our target
    if (node.isEndOfWord && currentPath[currentPath.length - 1] === targetName) {
      results.push(...node.definitions);
    }

    // Recursively search children
    for (const [part, childNode] of node.children) {
      this._searchEndingWith(childNode, targetName, [...currentPath, part], results);
    }
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
   * Find definitions in the same file
   * @param filePath The file path to search in
   * @param functionName The function name to find
   * @returns Array of matching definitions in the same file
   */
  findInSameFile(filePath: string, functionName: string): FunctionDefinition[] {
    return Array.from(this.allDefinitions.values()).filter(def => 
      def.filePath === filePath && def.functionName === functionName
    );
  }

  /**
   * Get all definitions for debugging/stats
   * @returns All stored definitions
   */
  getAllDefinitions(): FunctionDefinition[] {
    return Array.from(this.allDefinitions.values());
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
  }
}

export type { FunctionDefinition }; 