/**
 * Language-specific configuration and built-ins
 * Centralized configuration to eliminate hardcoded values
 */

export interface LanguageConfig {
  name: string;
  extensions: string[];
  builtinFunctions: Set<string>;
  builtinTypes: Set<string>;
  commentPatterns: {
    singleLine: string[];
    multiLineStart: string[];
    multiLineEnd: string[];
  };
  importPatterns: {
    import: RegExp[];
    fromImport: RegExp[];
    require: RegExp[];
  };

}

// Python built-in functions and types
const PYTHON_BUILTINS = new Set([
  // Core built-ins
  'int', 'str', 'float', 'bool', 'list', 'dict', 'set', 'tuple',
  'len', 'range', 'enumerate', 'zip', 'map', 'filter', 'sorted',
  'sum', 'min', 'max', 'abs', 'round', 'all', 'any', 'hasattr',
  'getattr', 'setattr', 'isinstance', 'issubclass', 'type',
  'print', 'input', 'open', 'format', 'join', 'split', 'strip',
  'replace', 'upper', 'lower', 'append', 'extend', 'insert',
  'remove', 'pop', 'clear', 'copy', 'update', 'keys', 'values',
  'items', 'get', 'add', 'discard', 'union', 'intersection',
  'difference', 'locals', 'globals', 'vars', 'dir', 'help', 'id', 'hash',
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
  
  // Common exceptions
  'ValueError', 'TypeError', 'KeyError', 'IndexError', 'AttributeError',
  'ImportError', 'ModuleNotFoundError', 'FileNotFoundError',
  'ConnectionError', 'HTTPException', 'RuntimeError', 'OSError',
  'Exception', 'BaseException', 'StopIteration', 'GeneratorExit'
]);

const PYTHON_LIBRARY_FUNCTIONS = new Set([
  // Date/time methods
  'now', 'today', 'fromisoformat', 'isoformat', 'astimezone', 
  'strftime', 'strptime', 'timestamp', 'weekday', 'isoweekday',
  'date', 'time', 'timetz', 'utctimetuple', 'timetuple',
    
  // Random
  'random', 'choice', 'randint', 'shuffle',
  
  // Logging methods
  'debug', 'info', 'warning', 'error', 'critical', 'exception',
  'getLogger', 'basicConfig', 'StreamHandler',
  
  // Environment
  'load_dotenv', 'getenv', 'dirname', 'abspath', 'join', 'exists', 'run',
  
  // Database/ORM methods
  'find', 'find_one', 'update_one', 'insert_one', 'delete_one',
  'aggregate', 'bulk_write', 'to_list', 'sort', 'limit', 'close',
  'ObjectId', 'UpdateOne', 'AsyncIOMotorClient', 'command',
  
  // Pydantic/FastAPI
  'Field', 'validator', 'field_validator', 'model_dump', 'model_dump_json',
  'FastAPI', 'HTTPException', 'add_middleware', 'include_router',
  
  // Threading/async
  'Lock', 'RLock', 'Semaphore', 'Event', 'Condition', 'Barrier',
  'sleep', 'gather', 'create_task', 'run_until_complete',
  
  // Collections
  'defaultdict', 'Counter', 'OrderedDict', 'deque', 'namedtuple',
  
  // Math/statistics
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
  
  // AI/ML libraries
  'AsyncAzureOpenAI', 'AzureOpenAI', 'OpenAI', 'wrap_openai', 'create'
]);

// JavaScript built-in functions and types
const JAVASCRIPT_BUILTINS = new Set([
  // Global functions
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI', 'decodeURIComponent',
  'encodeURI', 'encodeURIComponent', 'eval', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'console', 'alert', 'confirm', 'prompt',
  
  // Object methods
  'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
  
  // Array methods
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join',
  'reverse', 'sort', 'indexOf', 'lastIndexOf', 'forEach', 'map', 'filter',
  'reduce', 'reduceRight', 'every', 'some', 'find', 'findIndex', 'includes',
  
  // String methods
  'charAt', 'charCodeAt', 'concat', 'indexOf', 'lastIndexOf', 'localeCompare',
  'match', 'replace', 'search', 'slice', 'split', 'substring', 'toLowerCase',
  'toUpperCase', 'trim', 'padStart', 'padEnd',
  
  // Math
  'abs', 'ceil', 'floor', 'round', 'max', 'min', 'pow', 'sqrt', 'random',
  
  // Date
  'getTime', 'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours',
  'getMinutes', 'getSeconds', 'getMilliseconds', 'toISOString', 'toDateString',
  
  // Promise/async
  'then', 'catch', 'finally', 'resolve', 'reject', 'all', 'race',

  // JSON
  'parse', 'stringify',
  
  // Types
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Function', 'Date',
  'RegExp', 'Error', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet'
]);

// TypeScript built-ins (extends JavaScript)
const TYPESCRIPT_BUILTINS = new Set([
  ...JAVASCRIPT_BUILTINS,
  // TypeScript specific
  'Partial', 'Required', 'Readonly', 'Pick', 'Omit', 'Exclude', 'Extract',
  'Record', 'Parameters', 'ConstructorParameters', 'ReturnType',
  'InstanceType', 'ThisParameterType', 'OmitThisParameter', 'ThisType'
]);

// Centralized ignore patterns
export const IGNORE_PATTERNS = new Set([
  // Version Control
  '.git', '.svn', '.hg',
  
  // Package Managers & Dependencies
  'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'deps',
  
  // Python Virtual Environments & Cache
  'venv', 'env', '.venv', '.env', 'envs', 'virtualenv', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.tox',
  
  // Build & Distribution Directories
  'build', 'dist', 'out', 'target', 'bin', 'obj', '.gradle', '_build',
  
  // IDE & Editor Directories
  '.vs', '.vscode', '.idea', '.eclipse', '.settings',
  
  // Temporary & Log Directories
  'tmp', '.tmp', 'temp', 'logs', 'log',
  
  // Coverage & Testing
  'coverage', '.coverage', 'htmlcov', '.nyc_output',
  
  // OS & System
  '.DS_Store', 'Thumbs.db',
  
  // Documentation Build Output
  '_site', '.docusaurus',
  
  // Cache Directories
  '.cache', '.parcel-cache', '.next', '.nuxt'
]);

// Language configurations
export const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  python: {
    name: 'Python',
    extensions: ['.py', '.pyx', '.pyi'],
    builtinFunctions: new Set([...PYTHON_BUILTINS, ...PYTHON_LIBRARY_FUNCTIONS]),
    builtinTypes: new Set(['int', 'str', 'float', 'bool', 'list', 'dict', 'set', 'tuple']),
    commentPatterns: {
      singleLine: ['#'],
      multiLineStart: ['"""', "'''"],
      multiLineEnd: ['"""', "'''"]
    },
    importPatterns: {
      import: [/^import\s+(.+)$/],
      fromImport: [/^from\s+(.+)\s+import\s+(.+)$/],
      require: []
    }
  },
  
  javascript: {
    name: 'JavaScript',
    extensions: ['.js', '.mjs', '.cjs', '.jsx'],
    builtinFunctions: JAVASCRIPT_BUILTINS,
    builtinTypes: new Set(['Object', 'Array', 'String', 'Number', 'Boolean', 'Function']),
    commentPatterns: {
      singleLine: ['//'],
      multiLineStart: ['/*'],
      multiLineEnd: ['*/']
    },
    importPatterns: {
      import: [/^import\s+.*\s+from\s+['"'](.+)['"]$/],
      fromImport: [],
      require: [/require\s*\(\s*['"'](.+)['"]\s*\)/]
    }
  },

  typescript: {
    name: 'TypeScript',
    extensions: ['.ts', '.tsx'],
    builtinFunctions: TYPESCRIPT_BUILTINS,
    builtinTypes: new Set(['Object', 'Array', 'String', 'Number', 'Boolean', 'Function']),
    commentPatterns: {
      singleLine: ['//'],
      multiLineStart: ['/*'],
      multiLineEnd: ['*/']
    },
    importPatterns: {
      import: [/^import\s+.*\s+from\s+['"'](.+)['"]$/],
      fromImport: [],
      require: [/require\s*\(\s*['"'](.+)['"]\s*\)/]
    }
  }
};

// Language abstraction interface
export interface ParsedDefinition {
  name: string;
  type: 'function' | 'class' | 'method' | 'interface' | 'enum' | 'decorator' | 'variable';
  startLine: number;
  endLine: number;
  parentClass?: string;
  decorators?: string[];
  baseClasses?: string[];
  parameters?: string[];
  returnType?: string;
}

export interface ImportInfo {
  localName: string;
  importedFrom: string;
  exportedName: string;
  importType: 'default' | 'named' | 'namespace' | 'dynamic';
}

export interface LanguageProcessor {
  name: string;
  extensions: string[];
  isBuiltinFunction(name: string): boolean;
  isBuiltinType(name: string): boolean;
  parseDefinitions(content: string, filePath: string): ParsedDefinition[];
  extractImports(content: string): ImportInfo[];
}

// Base language processor implementation
export abstract class BaseLanguageProcessor implements LanguageProcessor {
  protected config: LanguageConfig;

  constructor(config: LanguageConfig) {
    this.config = config;
  }

  get name(): string {
    return this.config.name;
  }

  get extensions(): string[] {
    return this.config.extensions;
  }

  isBuiltinFunction(name: string): boolean {
    return this.config.builtinFunctions.has(name);
  }

  isBuiltinType(name: string): boolean {
    return this.config.builtinTypes.has(name);
  }

  abstract parseDefinitions(content: string, filePath: string): ParsedDefinition[];
  abstract extractImports(content: string): ImportInfo[];
}

// Language processor factory
export class LanguageProcessorFactory {
  private static processors: Map<string, () => LanguageProcessor> = new Map();

  static register(language: string, factory: () => LanguageProcessor): void {
    this.processors.set(language, factory);
  }

  static create(language: string): LanguageProcessor | null {
    const factory = this.processors.get(language);
    return factory ? factory() : null;
  }

  static getConfig(language: string): LanguageConfig | null {
    return LANGUAGE_CONFIGS[language] || null;
  }

  static getSupportedLanguages(): string[] {
    return Object.keys(LANGUAGE_CONFIGS);
  }
}

// Utility functions for language detection
export const languageDetection = {
  detectFromExtension(filePath: string): string | null {
    const extension = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    
    for (const [lang, config] of Object.entries(LANGUAGE_CONFIGS)) {
      if (config.extensions.includes(extension)) {
        return lang;
      }
    }
    
    return null;
  },

  detectFromContent(content: string): string | null {
    // Simple content-based detection
    if (content.includes('def ') && content.includes('import ')) {
      return 'python';
    }
    if (content.includes('function ') || content.includes('const ') || content.includes('let ')) {
      if (content.includes('interface ') || content.includes(': string')) {
        return 'typescript';
      }
      return 'javascript';
    }
    
    return null;
  }
};