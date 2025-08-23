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
    callTypes: {} as Record<string, number>,
    // Failure categorization
    failuresByCategory: {
      externalLibraries: 0,    // Calls to external/stdlib functions (expected)
      pythonBuiltins: 0,       // Python built-in functions (expected)
      actualFailures: 0        // Real resolution failures (unexpected)
    }
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
        // Reduced logging - track but don't spam console for each file
      }
    } else {
      // Reduced logging - only log summary instead of per-file details
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
        // Categorize the failure for better statistics
        this.categorizeFailureWithReason(call, this.diagnoseFailure(call));
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
      const targetDefinitions = this.functionTrie.getAllDefinitions().filter(def => {
        // Match file path
        if (def.filePath !== importInfo.targetFile) {
          return false;
        }
        
        // Handle different import types
        if (importInfo.importType === 'default') {
          // For default imports, the function name could be anything
          // Look for functions that could be the default export
          return def.functionName === call.functionName || 
                 def.functionName === importInfo.exportedName ||
                 // Common default export patterns
                 (def.type === 'function' && def.startLine === 1) ||
                 (def.type === 'class' && def.functionName === 'default');
        } else if (importInfo.importType === 'named') {
          // For named imports, match the exported name
          return def.functionName === importInfo.exportedName;
        } else if (importInfo.importType === 'namespace') {
          // For namespace imports like * as utils, 
          // the call would be utils.someFunction, so we need to handle this differently
          return def.functionName === call.functionName;
        }
        
        return false;
      });

      if (targetDefinitions.length > 0) {
        // Prefer functions over other types for function calls
        const preferred = targetDefinitions.find(def => 
          call.callType === 'function_call' ? def.type === 'function' :
          call.callType === 'method_call' ? def.type === 'method' :
          call.callType === 'constructor_call' ? def.type === 'class' : true
        ) || targetDefinitions[0];
        
        return {
          success: true,
          targetNodeId: preferred.nodeId,
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

    // JavaScript/TypeScript built-ins and common library functions
    const jsBuiltins = new Set([
      // Core JavaScript functions
      'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI',
      'encodeURIComponent', 'decodeURIComponent', 'escape', 'unescape',
      // Array methods
      'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join',
      'reverse', 'sort', 'indexOf', 'lastIndexOf', 'includes', 'find', 'findIndex',
      'filter', 'map', 'reduce', 'reduceRight', 'forEach', 'some', 'every',
      'flat', 'flatMap', 'fill', 'copyWithin', 'from', 'of', 'isArray',
      // Object methods
      'keys', 'values', 'entries', 'assign', 'create', 'defineProperty',
      'defineProperties', 'freeze', 'seal', 'preventExtensions', 'hasOwnProperty',
      'isPrototypeOf', 'propertyIsEnumerable', 'toString', 'valueOf', 'toLocaleString',
      // String methods
      'charAt', 'charCodeAt', 'codePointAt', 'concat', 'endsWith', 'includes',
      'indexOf', 'lastIndexOf', 'localeCompare', 'match', 'normalize', 'padEnd',
      'padStart', 'repeat', 'replace', 'search', 'slice', 'split', 'startsWith',
      'substring', 'substr', 'toLowerCase', 'toUpperCase', 'trim', 'trimEnd',
      'trimStart', 'trimLeft', 'trimRight',
      // Number methods
      'toFixed', 'toExponential', 'toPrecision', 'isInteger', 'isSafeInteger',
      'isFinite', 'isNaN', 'parseFloat', 'parseInt',
      // Date methods
      'getTime', 'getDate', 'getDay', 'getFullYear', 'getHours', 'getMinutes',
      'getSeconds', 'getMilliseconds', 'getMonth', 'setDate', 'setFullYear',
      'setHours', 'setMinutes', 'setSeconds', 'setMilliseconds', 'setMonth',
      'toDateString', 'toTimeString', 'toISOString', 'toJSON', 'now', 'parse',
      // Promise methods
      'then', 'catch', 'finally', 'resolve', 'reject', 'all', 'race', 'allSettled',
      // Console methods
      'log', 'error', 'warn', 'info', 'debug', 'trace', 'assert', 'clear',
      'count', 'dir', 'dirxml', 'group', 'groupCollapsed', 'groupEnd', 'table',
      'time', 'timeEnd', 'timeLog', 'profile', 'profileEnd',
      // DOM methods (common ones)
      'getElementById', 'getElementsByClassName', 'getElementsByTagName',
      'querySelector', 'querySelectorAll', 'createElement', 'createTextNode',
      'appendChild', 'removeChild', 'insertBefore', 'replaceChild', 'cloneNode',
      'getAttribute', 'setAttribute', 'removeAttribute', 'hasAttribute',
      'addEventListener', 'removeEventListener', 'dispatchEvent',
      'preventDefault', 'stopPropagation', 'stopImmediatePropagation',
      'focus', 'blur', 'click', 'submit', 'reset', 'scrollIntoView',
      // Common library methods (React, etc.)
      'useState', 'useEffect', 'useContext', 'useReducer', 'useCallback',
      'useMemo', 'useRef', 'useImperativeHandle', 'useLayoutEffect', 'useDebugValue',
      'memo', 'forwardRef', 'lazy', 'Suspense', 'Fragment', 'createElement',
      'cloneElement', 'isValidElement', 'render', 'hydrate', 'unmountComponentAtNode',
      // HTTP/Fetch
      'fetch', 'get', 'post', 'put', 'delete', 'patch', 'head', 'options',
      // JSON
      'stringify', 'parse',
      // Math
      'abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'cos', 'exp', 'floor',
      'log', 'max', 'min', 'pow', 'random', 'round', 'sin', 'sqrt', 'tan',
      // Common testing functions
      'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll',
      'mock', 'spy', 'stub', 'restore', 'reset', 'resetAllMocks', 'clearAllMocks',
      // Node.js specific
      'require', 'module', 'exports', '__dirname', '__filename', 'process', 'global',
      'Buffer', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
      'setTimeout', 'clearTimeout',
      // Worker API
      'postMessage', 'onmessage', 'onerror', 'close', 'importScripts',
      // JavaScript constructors and built-ins
      'Array', 'Object', 'String', 'Number', 'Boolean', 'Function', 'Date',
      'RegExp', 'Error', 'TypeError', 'ReferenceError', 'SyntaxError',
      'RangeError', 'EvalError', 'URIError', 'AggregateError',
      'Set', 'Map', 'WeakSet', 'WeakMap', 'Symbol', 'BigInt',
      'Promise', 'Proxy', 'Reflect', 'ArrayBuffer', 'SharedArrayBuffer',
      'DataView', 'Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array',
      'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
      'BigInt64Array', 'BigUint64Array',
      // Configuration and build tools
      'config', 'define', 'plugin', 'preset', 'loader', 'rule',
      'extend', 'override', 'merge', 'concat', 'apply',
      // ESLint specific
      'rules', 'extends', 'parser', 'parserOptions', 'env', 'globals',
      // Bundler/build tools
      'bundle', 'chunk', 'entry', 'output', 'optimization', 'resolve',
      'devtool', 'target', 'externals', 'stats', 'performance',
      // Process and execution
      'exec', 'spawn', 'fork', 'execSync', 'spawnSync',
      // File system operations
      'readFile', 'writeFile', 'readdir', 'stat', 'mkdir', 'rmdir',
      'unlink', 'rename', 'copyFile', 'access', 'watch', 'createReadStream',
      'createWriteStream'
    ]);

    // Check if it's a JS/TS file and the function is a built-in
    if ((filePath.endsWith('.js') || filePath.endsWith('.ts') || 
         filePath.endsWith('.jsx') || filePath.endsWith('.tsx')) && 
        jsBuiltins.has(functionName)) {
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
        if (functionName && !this.shouldIgnoreCall(functionName, filePath)) {
          // Don't filter here - let all calls through to resolution
          calls.push({
            callerFile: filePath,
            functionName,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            callType: 'function_call'
          });
        } else {
          // Reduced logging - don't log every individual extraction failure
          if (calls.length < 3) {
            // Only log first few failures per file to understand patterns
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
        // Don't filter constructor calls as strictly - they're important for the graph
        if (!this.shouldIgnoreCall(constructorName, filePath)) {
          calls.push({
            callerFile: filePath,
            functionName: constructorName,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            callType: 'constructor_call'
          });
        }
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
    
    // Handle additional Python call patterns
    if (node.text && node.text.length > 0 && node.text.length < 100) {
      // For simple cases, try using the text directly if it looks like a function name
      const text = node.text.trim();
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(text)) {
        return text;
      }
      
      // For attribute access, try to extract the last part
      const parts = text.split('.');
      if (parts.length > 1) {
        const lastPart = parts[parts.length - 1];
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(lastPart)) {
          return lastPart;
        }
      }
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
    } else if (node.type === 'call_expression') {
      // Handle nested calls like getData().process()
      const functionNode = node.childForFieldName('function');
      if (functionNode) {
        return this.extractJSCallName(functionNode);
      }
    } else if (node.type === 'subscript_expression') {
      // Handle array/object access like obj['method']()
      const propertyNode = node.childForFieldName('index');
      if (propertyNode && propertyNode.type === 'string') {
        // Extract string literal content
        const propText = propertyNode.text.replace(/['"`]/g, '');
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(propText)) {
          return propText;
        }
      }
    }
    
    // Fallback: try to extract from text for simple patterns
    if (node.text && node.text.length > 0 && node.text.length < 50) {
      const text = node.text.trim();
      
      // Handle simple function calls
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(text)) {
        return text;
      }
      
      // Handle member expressions like obj.method
      const memberMatch = text.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*$/);
      if (memberMatch) {
        return memberMatch[1];
      }
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
      callTypes: {},
      failuresByCategory: {
        externalLibraries: 0,
        pythonBuiltins: 0,
        actualFailures: 0
      }
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
    
    // Enhanced failure breakdown
    if (this.stats.failed > 0) {
      const { externalLibraries, pythonBuiltins, actualFailures } = this.stats.failuresByCategory;
      console.log(`     📦 External libraries (expected): ${externalLibraries} (${((externalLibraries / this.stats.failed) * 100).toFixed(1)}% of failures)`);
      console.log(`     🐍 Python built-ins (expected): ${pythonBuiltins} (${((pythonBuiltins / this.stats.failed) * 100).toFixed(1)}% of failures)`);
      console.log(`     🚨 Actual failures (unexpected): ${actualFailures} (${((actualFailures / this.stats.failed) * 100).toFixed(1)}% of failures)`);
      
      const expectedFailures = externalLibraries + pythonBuiltins;
      console.log(`  Real success rate (excluding expected failures): ${(((this.stats.totalCalls - actualFailures) / this.stats.totalCalls) * 100).toFixed(1)}%`);
    }
    
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
   * Categorize a failed call for statistics with detailed reason
   */
  private categorizeFailureWithReason(call: CallInfo, reason: string): void {
    // Check if this is an expected failure (external library or built-in)
    if (this.shouldIgnoreCall(call.functionName, call.callerFile)) {
      // It's a call we expect to fail (external library or built-in)
      if (call.callerFile.endsWith('.py')) {
        this.stats.failuresByCategory.pythonBuiltins++;
      } else {
        this.stats.failuresByCategory.externalLibraries++;
      }
    } else {
      // It's a call to user code that we failed to resolve (unexpected)
      this.stats.failuresByCategory.actualFailures++;
    }
  }

  /**
   * Diagnose why a specific call failed
   */
  private diagnoseFailure(call: CallInfo): string {
    // Check if it's in import map but target not found
    const importInfo = this.importMap[call.callerFile]?.[call.functionName];
    if (importInfo) {
      const targetDefinitions = this.functionTrie.getAllDefinitions().filter(def =>
        def.filePath === importInfo.targetFile && 
        (def.functionName === importInfo.exportedName || 
         (importInfo.exportedName === 'default' && def.functionName === call.functionName))
      );
      
      if (targetDefinitions.length === 0) {
        return `Imported from ${importInfo.targetFile} but definition not found`;
      }
    }
    
    // Check if function exists in same file
    const sameFileDefinitions = this.functionTrie.findInSameFile(call.callerFile, call.functionName);
    if (sameFileDefinitions.length === 0) {
      // Check if any similar functions exist
      const candidates = this.functionTrie.findEndingWith(call.functionName);
      if (candidates.length === 0) {
        return `No function named '${call.functionName}' found anywhere`;
      } else {
        return `Function '${call.functionName}' not in same file, ${candidates.length} candidates in other files`;
      }
    }
    
    return 'Unknown failure reason';
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
