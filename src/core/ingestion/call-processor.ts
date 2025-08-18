import type { KnowledgeGraph, GraphRelationship } from '../graph/types.ts';
import type { ParsedAST } from './parsing-processor.ts';
import type { ImportMap } from './import-processor.ts';
import { FunctionRegistryTrie } from '../graph/trie.ts';
import { generateId } from '../../lib/utils.ts';
import Parser from 'web-tree-sitter';

// Simple path utilities for browser compatibility
const pathUtils = {
  extname: (filePath: string): string => {
    const lastDot = filePath.lastIndexOf('.');
    return lastDot === -1 ? '' : filePath.substring(lastDot);
  },
  dirname: (filePath: string): string => {
    const lastSlash = filePath.lastIndexOf('/');
    return lastSlash === -1 ? '' : filePath.substring(0, lastSlash);
  }
};

interface CallInfo {
  callerFile: string;
  callerFunction?: string;
  functionName: string;
  startLine: number;
  endLine: number;
  callType: 'function_call' | 'method_call' | 'constructor_call';
}

interface ResolutionResult {
  success: boolean;
  targetNodeId?: string;
  stage: 'exact' | 'same_file' | 'heuristic' | 'failed';
  confidence: 'high' | 'medium' | 'low';
  distance?: number;
}

export class CallProcessor {
  private importMap: ImportMap = {};
  private functionTrie: FunctionRegistryTrie;
  private astMap: Map<string, ParsedAST> = new Map();
  
  // Statistics
  private stats = {
    totalCalls: 0,
    exactMatches: 0,
    sameFileMatches: 0,
    heuristicMatches: 0,
    failed: 0,
    callTypes: {} as Record<string, number>
  };

  constructor(functionTrie: FunctionRegistryTrie) {
    this.functionTrie = functionTrie;
  }

  /**
   * Process function calls using the 3-stage resolution strategy
   * This runs AFTER ImportProcessor has built the complete import map
   */
  async process(
    graph: KnowledgeGraph,
    astMap: Map<string, ParsedAST>,
    importMap: ImportMap
  ): Promise<KnowledgeGraph> {
    console.log('CallProcessor: Starting call resolution with 3-stage strategy...');
    
    this.importMap = importMap;
    this.astMap = astMap;
    this.resetStats();

    // Process calls for each file
    for (const [filePath, ast] of astMap) {
      if (ast.tree) {
        await this.processFileCalls(filePath, ast, graph);
      }
    }

    this.logStats();
    return graph;
  }

  /**
   * Process function calls in a single file
   */
  private async processFileCalls(
    filePath: string,
    ast: ParsedAST,
    graph: KnowledgeGraph
  ): Promise<void> {
    const calls = this.extractFunctionCalls(ast.tree!.rootNode, filePath);
    
    if (calls.length === 0) {
      // Only log for source files that should have function calls
      if (this.isSourceFile(filePath)) {
        console.log(`⚠️ CallProcessor: No function calls found in source file: ${filePath}`);
        
        // Debug: Check if this file has any 'call' nodes at all
        if (filePath.endsWith('.py')) {
          const callNodeCount = this.countNodeType(ast.tree!.rootNode, 'call');
          const definitionCount = graph.nodes.filter(n => 
            (n.label === 'Function' || n.label === 'Class' || n.label === 'Method') && 
            n.properties.filePath === filePath
          ).length;
          
          console.log(`  📊 Debug: ${filePath.split('/').pop()} has ${callNodeCount} call nodes, ${definitionCount} definitions`);
          
          // If we have definitions but no calls, that's suspicious
          if (definitionCount > 0 && callNodeCount === 0) {
            console.log(`  🚨 Suspicious: File has definitions but no call nodes - possible AST parsing issue`);
          }
        }
      }
    } else {
      console.log(`CallProcessor: Found ${calls.length} function calls in ${filePath}`);
    }
    
    for (const call of calls) {
      this.stats.totalCalls++;
      this.stats.callTypes[call.callType] = (this.stats.callTypes[call.callType] || 0) + 1;
      
      const resolution = await this.resolveCall(call);
      
      if (resolution.success && resolution.targetNodeId) {
        this.createCallRelationship(graph, call, resolution.targetNodeId);
        
        // Update statistics
        switch (resolution.stage) {
          case 'exact':
            this.stats.exactMatches++;
            break;
          case 'same_file':
            this.stats.sameFileMatches++;
            break;
          case 'heuristic':
            this.stats.heuristicMatches++;
            break;
        }
      } else {
        this.stats.failed++;
        console.log(`❌ Failed to resolve call: ${call.functionName} in ${call.callerFile}:${call.startLine}`);
      }
    }
  }

  /**
   * Count nodes of a specific type in the AST (for debugging)
   */
  private countNodeType(node: Parser.SyntaxNode, nodeType: string): number {
    let count = 0;
    
    if (node.type === nodeType) {
      count++;
    }
    
    // Recursively count in children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        count += this.countNodeType(child, nodeType);
      }
    }
    
    return count;
  }

  /**
   * 3-Stage Call Resolution Strategy
   */
  private async resolveCall(call: CallInfo): Promise<ResolutionResult> {
    // Stage 1: Exact Match using ImportMap
    const exactResult = this.stageExactMatch(call);
    if (exactResult.success) {
      return exactResult;
    }

    // Stage 2: Same-Module Match
    const sameFileResult = this.stageSameFileMatch(call);
    if (sameFileResult.success) {
      return sameFileResult;
    }

    // Stage 3: Heuristic Fallback
    const heuristicResult = this.stageHeuristicMatch(call);
    return heuristicResult;
  }

  /**
   * Stage 1: Exact Match using ImportMap (High Confidence)
   */
  private stageExactMatch(call: CallInfo): ResolutionResult {
    const importInfo = this.importMap[call.callerFile]?.[call.functionName];
    
    if (importInfo) {
      // We have an import for this function name
      const targetDefinitions = this.functionTrie.getAllDefinitions().filter(def =>
        def.filePath === importInfo.targetFile && 
        (def.functionName === importInfo.exportedName || 
         (importInfo.exportedName === 'default' && def.functionName === call.functionName))
      );

      if (targetDefinitions.length > 0) {
        return {
          success: true,
          targetNodeId: targetDefinitions[0].nodeId,
          stage: 'exact',
          confidence: 'high'
        };
      }
    }

    return { success: false, stage: 'exact', confidence: 'high' };
  }

  /**
   * Stage 2: Same-Module Match (High Confidence)
   */
  private stageSameFileMatch(call: CallInfo): ResolutionResult {
    const sameFileDefinitions = this.functionTrie.findInSameFile(call.callerFile, call.functionName);
    
    if (sameFileDefinitions.length > 0) {
      return {
        success: true,
        targetNodeId: sameFileDefinitions[0].nodeId,
        stage: 'same_file',
        confidence: 'high'
      };
    }

    return { success: false, stage: 'same_file', confidence: 'high' };
  }

  /**
   * Stage 3: Heuristic Fallback (Intelligent Guessing)
   */
  private stageHeuristicMatch(call: CallInfo): ResolutionResult {
    // Use trie to find all functions ending with this name
    const candidates = this.functionTrie.findEndingWith(call.functionName);
    
    if (candidates.length === 0) {
      return { success: false, stage: 'heuristic', confidence: 'low' };
    }

    // If only one candidate, use it
    if (candidates.length === 1) {
      return {
        success: true,
        targetNodeId: candidates[0].nodeId,
        stage: 'heuristic',
        confidence: 'medium'
      };
    }

    // Multiple candidates - apply smart heuristics
    let bestCandidate = candidates[0];
    let bestScore = this.calculateImportDistance(call.callerFile, bestCandidate.filePath);

    for (const candidate of candidates) {
      let score = this.calculateImportDistance(call.callerFile, candidate.filePath);
      
      // Special handling for method calls
      if (call.callType === 'method_call' && candidate.type === 'method') {
        // Bonus for methods in the same file (likely self/this calls)
        if (candidate.filePath === call.callerFile) {
          score -= 2; // Strong preference for same-file methods
        }
        
        // Bonus for methods in the same class context
        // This would require more context about the calling class
        // For now, we give a small bonus to method-to-method calls
        score -= 0.5;
      }
      
      // Bonus for function calls to functions (type matching)
      if (call.callType === 'function_call' && candidate.type === 'function') {
        score -= 0.5;
      }
      
      // Bonus for sibling modules (same parent directory)
      if (this.areSiblingModules(call.callerFile, candidate.filePath)) {
        score -= 1;
      }

      if (score < bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    return {
      success: true,
      targetNodeId: bestCandidate.nodeId,
      stage: 'heuristic',
      confidence: bestScore <= 1 ? 'medium' : 'low'
    };
  }

  /**
   * Calculate import distance between two file paths
   */
  private calculateImportDistance(callerFile: string, targetFile: string): number {
    const callerParts = callerFile.split('/');
    const targetParts = targetFile.split('/');
    
    // Find common prefix length
    let commonPrefixLength = 0;
    const minLength = Math.min(callerParts.length, targetParts.length);
    
    for (let i = 0; i < minLength; i++) {
      if (callerParts[i] === targetParts[i]) {
        commonPrefixLength++;
      } else {
        break;
      }
    }
    
    // Distance is max depth minus common prefix
    return Math.max(callerParts.length, targetParts.length) - commonPrefixLength;
  }

  /**
   * Check if two file paths are sibling modules (same parent directory)
   */
  private areSiblingModules(file1: string, file2: string): boolean {
    const parent1 = pathUtils.dirname(file1);
    const parent2 = pathUtils.dirname(file2);
    return parent1 === parent2;
  }

  /**
   * Check if a function call should be ignored (built-ins, standard library, etc.)
   */
  private shouldIgnoreCall(functionName: string, filePath: string): boolean {
    // Python built-in functions that should be ignored
    const pythonBuiltins = new Set([
      'int', 'str', 'float', 'bool', 'list', 'dict', 'set', 'tuple',
      'len', 'range', 'enumerate', 'zip', 'map', 'filter', 'sorted',
      'sum', 'min', 'max', 'abs', 'round', 'all', 'any', 'hasattr',
      'getattr', 'setattr', 'isinstance', 'issubclass', 'type',
      'print', 'input', 'open', 'format', 'join', 'split', 'strip',
      'replace', 'upper', 'lower', 'append', 'extend', 'insert',
      'remove', 'pop', 'clear', 'copy', 'update', 'keys', 'values',
      'items', 'get', 'add', 'discard', 'union', 'intersection',
      'difference', 'now', 'today', 'fromisoformat', 'isoformat',
      'astimezone', 'random', 'choice', 'randint', 'shuffle',
      'locals', 'globals', 'vars', 'dir', 'help', 'id', 'hash',
      'ord', 'chr', 'bin', 'oct', 'hex', 'divmod', 'pow', 'exec',
      'eval', 'compile', 'next', 'iter', 'reversed', 'slice',
      // String methods
      'endswith', 'startswith', 'find', 'rfind', 'index', 'rindex',
      'count', 'encode', 'decode', 'capitalize', 'title', 'swapcase',
      'center', 'ljust', 'rjust', 'zfill', 'expandtabs', 'splitlines',
      'partition', 'rpartition', 'translate', 'maketrans', 'casefold',
      'isalnum', 'isalpha', 'isascii', 'isdecimal', 'isdigit', 'isidentifier',
      'islower', 'isnumeric', 'isprintable', 'isspace', 'istitle', 'isupper',
      'lstrip', 'rstrip', 'removeprefix', 'removesuffix',
      // List/sequence methods
      'sort', 'reverse', 'count', 'index',
      // Dictionary methods
      'setdefault', 'popitem', 'fromkeys',
      // Set methods
      'difference_update', 'intersection_update', 'symmetric_difference',
      'symmetric_difference_update', 'isdisjoint', 'issubset', 'issuperset',
      // Date/time methods
      'strftime', 'strptime', 'timestamp', 'weekday', 'isoweekday',
      'date', 'time', 'timetz', 'utctimetuple', 'timetuple',
      // Common exceptions
      'ValueError', 'TypeError', 'KeyError', 'IndexError', 'AttributeError',
      'ImportError', 'ModuleNotFoundError', 'FileNotFoundError',
      'ConnectionError', 'HTTPException', 'RuntimeError', 'OSError',
      'Exception', 'BaseException', 'StopIteration', 'GeneratorExit',
      // Logging methods
      'debug', 'info', 'warning', 'error', 'critical', 'exception',
      // Common library functions
      'getLogger', 'basicConfig', 'StreamHandler', 'load_dotenv',
      'getenv', 'dirname', 'abspath', 'join', 'exists', 'run',
      // Database/ORM methods
      'find', 'find_one', 'update_one', 'insert_one', 'delete_one',
      'aggregate', 'bulk_write', 'to_list', 'sort', 'limit', 'close',
      // Pydantic/FastAPI
      'Field', 'validator', 'field_validator', 'model_dump', 'model_dump_json',
      // Motor/MongoDB
      'ObjectId', 'UpdateOne', 'AsyncIOMotorClient', 'command',
      // FastAPI
      'FastAPI', 'HTTPException', 'add_middleware', 'include_router',
      // Threading/async
      'Lock', 'RLock', 'Semaphore', 'Event', 'Condition', 'Barrier',
      'sleep', 'gather', 'create_task', 'run_until_complete',
      // Collections
      'defaultdict', 'Counter', 'OrderedDict', 'deque', 'namedtuple',
      // Math/statistics (numpy, pandas, statistics)
      'mean', 'median', 'mode', 'stdev', 'variance', 'sqrt', 'pow',
      'sin', 'cos', 'tan', 'log', 'exp', 'ceil', 'floor',
      // UUID
      'uuid4', 'uuid1', 'uuid3', 'uuid5',
      // URL/HTTP
      'quote', 'unquote', 'quote_plus', 'unquote_plus', 'urlencode',
      // JSON
      'loads', 'dumps', 'load', 'dump',
      // Regex
      'match', 'search', 'findall', 'finditer', 'sub', 'subn', 'compile',
      // Azure/OpenAI specific
      'AsyncAzureOpenAI', 'AzureOpenAI', 'OpenAI', 'wrap_openai', 'create'
    ]);

    // Check if it's a Python file and the function is a built-in
    if (filePath.endsWith('.py') && pythonBuiltins.has(functionName)) {
      return true;
    }

    // Ignore very short function names (likely built-ins or operators)
    if (functionName.length <= 2) {
      return true;
    }

    // Ignore common method patterns that are likely built-ins
    const commonMethodPatterns = [
      /^__\w+__$/, // Dunder methods like __init__, __str__, etc.
      /^\w+_$/, // Methods ending with underscore (often private)
    ];

    for (const pattern of commonMethodPatterns) {
      if (pattern.test(functionName)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extract function calls from AST
   */
  private extractFunctionCalls(node: Parser.SyntaxNode, filePath: string): CallInfo[] {
    const calls: CallInfo[] = [];
    const language = this.detectLanguage(filePath);

    if (language === 'python') {
      this.extractPythonCalls(node, filePath, calls);
    } else {
      this.extractJSCalls(node, filePath, calls);
    }

    return calls;
  }

  /**
   * Extract Python function calls
   */
  private extractPythonCalls(node: Parser.SyntaxNode, filePath: string, calls: CallInfo[]): void {
    if (node.type === 'call') {
      const functionNode = node.childForFieldName('function');
      if (functionNode) {
        const functionName = this.extractPythonCallName(functionNode);
        
        // Debug: Log what we're finding vs filtering
        if (functionName) {
          const shouldIgnore = this.shouldIgnoreCall(functionName, filePath);
          if (shouldIgnore) {
            // Only log a few examples to avoid spam
            if (calls.length < 3) {
              console.log(`🔍 Filtered out: ${functionName} in ${filePath.split('/').pop()}`);
            }
          } else {
            calls.push({
              callerFile: filePath,
              functionName,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              callType: 'function_call'
            });
          }
        } else {
          // Debug: Log when we can't extract function name
          if (calls.length < 3) {
            console.log(`🔍 Could not extract function name from: ${functionNode.type} in ${filePath.split('/').pop()}`);
          }
        }
      }
    }

    // Recursively process children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        this.extractPythonCalls(child, filePath, calls);
      }
    }
  }

  /**
   * Extract JavaScript/TypeScript function calls
   */
  private extractJSCalls(node: Parser.SyntaxNode, filePath: string, calls: CallInfo[]): void {
    if (node.type === 'call_expression') {
      const functionNode = node.childForFieldName('function');
      if (functionNode) {
        const functionName = this.extractJSCallName(functionNode);
        if (functionName && !this.shouldIgnoreCall(functionName, filePath)) {
          calls.push({
            callerFile: filePath,
            functionName,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            callType: functionNode.type === 'member_expression' ? 'method_call' : 'function_call'
          });
        }
      }
    } else if (node.type === 'new_expression') {
      const constructorNode = node.childForFieldName('constructor');
      if (constructorNode) {
        const constructorName = constructorNode.text;
        calls.push({
          callerFile: filePath,
          functionName: constructorName,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          callType: 'constructor_call'
        });
      }
    }

    // Recursively process children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        this.extractJSCalls(child, filePath, calls);
      }
    }
  }

  /**
   * Extract function name from Python call node
   */
  private extractPythonCallName(node: Parser.SyntaxNode): string | null {
    if (node.type === 'identifier') {
      return node.text;
    } else if (node.type === 'attribute') {
      // For method calls like obj.method(), we want just 'method'
      const attributeNode = node.childForFieldName('attribute');
      return attributeNode ? attributeNode.text : null;
    } else if (node.type === 'subscript') {
      // For calls like obj[key](), try to get the base object
      const valueNode = node.childForFieldName('value');
      if (valueNode) {
        return this.extractPythonCallName(valueNode);
      }
    } else if (node.type === 'call') {
      // Nested call - try to get the function being called
      const functionNode = node.childForFieldName('function');
      if (functionNode) {
        return this.extractPythonCallName(functionNode);
      }
    }
    
    // Debug: Log unhandled node types (but limit spam)
    if (Math.random() < 0.1) { // Only log 10% of cases to avoid spam
      console.log(`🔍 Unhandled Python call node type: ${node.type} (text: "${node.text}")`);
    }
    
    return null;
  }

  /**
   * Extract function name from JavaScript call node
   */
  private extractJSCallName(node: Parser.SyntaxNode): string | null {
    if (node.type === 'identifier') {
      return node.text;
    } else if (node.type === 'member_expression') {
      // For method calls like obj.method(), we want just 'method'
      const propertyNode = node.childForFieldName('property');
      return propertyNode ? propertyNode.text : null;
    }
    return null;
  }

  /**
   * Create CALLS relationship in the graph
   */
  private createCallRelationship(
    graph: KnowledgeGraph,
    call: CallInfo,
    targetNodeId: string
  ): void {
    // Find the caller node (could be a function, method, or file)
    const callerNode = this.findCallerNode(graph, call);
    
    if (callerNode) {
      const relationship: GraphRelationship = {
        id: generateId('calls'),
        type: 'CALLS',
        source: callerNode.id,
        target: targetNodeId,
        properties: {
          callType: this.convertCallType(call.callType),
          functionName: call.functionName,
          startLine: call.startLine,
          endLine: call.endLine
        }
      };

      // Check if relationship already exists
      const existingRel = graph.relationships.find(r =>
        r.type === 'CALLS' &&
        r.source === callerNode.id &&
        r.target === targetNodeId
      );

      if (!existingRel) {
        graph.relationships.push(relationship);
      }
    }
  }

  private convertCallType(callType: 'function_call' | 'method_call' | 'constructor_call'): 'function' | 'method' | 'constructor' {
    switch (callType) {
      case 'function_call':
        return 'function';
      case 'method_call':
        return 'method';
      case 'constructor_call':
        return 'constructor';
    }
  }

  /**
   * Find the caller node in the graph
   */
  private findCallerNode(graph: KnowledgeGraph, call: CallInfo): any {
    // First try to find a function/method that contains this call
    const containingFunction = graph.nodes.find(node =>
      (node.label === 'Function' || node.label === 'Method') &&
      node.properties.filePath === call.callerFile &&
      (node.properties.startLine as number) <= call.startLine &&
      (node.properties.endLine as number) >= call.endLine
    );

    if (containingFunction) {
      return containingFunction;
    }

    // If no containing function found, try to find a class that contains this call
    // This helps with method calls at class level
    const containingClass = graph.nodes.find(node =>
      node.label === 'Class' &&
      node.properties.filePath === call.callerFile &&
      (node.properties.startLine as number) <= call.startLine &&
      (node.properties.endLine as number) >= call.endLine
    );

    if (containingClass) {
      return containingClass;
    }

    // Fallback to file node
    return graph.nodes.find(node =>
      node.label === 'File' &&
      node.properties.filePath === call.callerFile
    );
  }

  /**
   * Detect programming language
   */
  private detectLanguage(filePath: string): 'python' | 'javascript' {
    const ext = pathUtils.extname(filePath).toLowerCase();
    return ext === '.py' ? 'python' : 'javascript';
  }

  /**
   * Reset statistics
   */
  private resetStats(): void {
    this.stats = {
      totalCalls: 0,
      exactMatches: 0,
      sameFileMatches: 0,
      heuristicMatches: 0,
      failed: 0,
      callTypes: {}
    };
  }

  /**
   * Log resolution statistics
   */
  private logStats(): void {
    console.log('📊 CallProcessor Resolution Statistics:');
    console.log(`  Total calls processed: ${this.stats.totalCalls}`);
    console.log(`  ✅ Exact matches (Stage 1): ${this.stats.exactMatches} (${((this.stats.exactMatches / this.stats.totalCalls) * 100).toFixed(1)}%)`);
    console.log(`  ✅ Same-file matches (Stage 2): ${this.stats.sameFileMatches} (${((this.stats.sameFileMatches / this.stats.totalCalls) * 100).toFixed(1)}%)`);
    console.log(`  🎯 Heuristic matches (Stage 3): ${this.stats.heuristicMatches} (${((this.stats.heuristicMatches / this.stats.totalCalls) * 100).toFixed(1)}%)`);
    console.log(`  ❌ Failed resolutions: ${this.stats.failed} (${((this.stats.failed / this.stats.totalCalls) * 100).toFixed(1)}%)`);
    console.log(`  Success rate: ${(((this.stats.totalCalls - this.stats.failed) / this.stats.totalCalls) * 100).toFixed(1)}%`);
  }

  /**
   * Get resolution statistics
   */
  getStats() {
    return this.stats;
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.importMap = {};
    this.astMap.clear();
    this.resetStats();
  }

  /**
   * Check if a file is a source file that should contain function calls
   */
  private isSourceFile(filePath: string): boolean {
    const sourceExtensions = ['.py', '.js', '.ts', '.jsx', '.tsx'];
    const ext = pathUtils.extname(filePath).toLowerCase();
    return sourceExtensions.includes(ext);
  }
}
