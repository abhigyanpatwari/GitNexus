import type Parser from 'tree-sitter';
import { SupportedLanguages } from '../../config/supported-languages.js';
import { generateId } from '../../lib/utils.js';

/** Tree-sitter AST node. Re-exported for use across ingestion modules. */
export type SyntaxNode = Parser.SyntaxNode;

/**
 * Ordered list of definition capture keys for tree-sitter query matches.
 * Used to extract the definition node from a capture map.
 */
export const DEFINITION_CAPTURE_KEYS = [
  'definition.function',
  'definition.class',
  'definition.interface',
  'definition.method',
  'definition.struct',
  'definition.enum',
  'definition.namespace',
  'definition.module',
  'definition.trait',
  'definition.impl',
  'definition.type',
  'definition.const',
  'definition.static',
  'definition.typedef',
  'definition.macro',
  'definition.union',
  'definition.property',
  'definition.record',
  'definition.delegate',
  'definition.annotation',
  'definition.constructor',
  'definition.template',
] as const;

/** Extract the definition node from a tree-sitter query capture map. */
export const getDefinitionNodeFromCaptures = (captureMap: Record<string, any>): any | null => {
  for (const key of DEFINITION_CAPTURE_KEYS) {
    if (captureMap[key]) return captureMap[key];
  }
  return null;
};

/**
 * Node types that represent function/method definitions across languages.
 * Used to find the enclosing function for a call site.
 */
export const FUNCTION_NODE_TYPES = new Set([
  // TypeScript/JavaScript
  'function_declaration',
  'arrow_function',
  'function_expression',
  'method_definition',
  'generator_function_declaration',
  // Python
  'function_definition',
  // Common async variants
  'async_function_declaration',
  'async_arrow_function',
  // Java
  'method_declaration',
  'constructor_declaration',
  // C/C++
  // 'function_definition' already included above
  // Go
  // 'method_declaration' already included from Java
  // C#
  'local_function_statement',
  // Rust
  'function_item',
  'impl_item', // Methods inside impl blocks
  // PHP
  'anonymous_function',
  // Kotlin
  'lambda_literal',
  // Swift
  'init_declaration',
  'deinit_declaration',
  // Ruby
  'method',           // def foo
  'singleton_method', // def self.foo
]);

/**
 * Node types for standard function declarations that need C/C++ declarator handling.
 * Used by extractFunctionName to determine how to extract the function name.
 */
export const FUNCTION_DECLARATION_TYPES = new Set([
  'function_declaration',
  'function_definition',
  'async_function_declaration',
  'generator_function_declaration',
  'function_item',
]);

/**
 * Built-in function/method names that should not be tracked as call targets.
 * Covers JS/TS, Python, Kotlin, C/C++, PHP, Swift standard library functions.
 */
export const BUILT_IN_NAMES = new Set([
  // JavaScript/TypeScript
  'console', 'log', 'warn', 'error', 'info', 'debug',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
  'JSON', 'parse', 'stringify',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'resolve', 'reject', 'then', 'catch', 'finally',
  'Math', 'Date', 'RegExp', 'Error',
  'require', 'import', 'export', 'fetch', 'Response', 'Request',
  'useState', 'useEffect', 'useCallback', 'useMemo', 'useRef', 'useContext',
  'useReducer', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue',
  'createElement', 'createContext', 'createRef', 'forwardRef', 'memo', 'lazy',
  'map', 'filter', 'reduce', 'forEach', 'find', 'findIndex', 'some', 'every',
  'includes', 'indexOf', 'slice', 'splice', 'concat', 'join', 'split',
  'push', 'pop', 'shift', 'unshift', 'sort', 'reverse',
  'keys', 'values', 'entries', 'assign', 'freeze', 'seal',
  'hasOwnProperty', 'toString', 'valueOf',
  // Python
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
  'append', 'extend', 'update',
  // NOTE: 'open', 'read', 'write', 'close' removed — these are real C POSIX syscalls
  'super', 'type', 'isinstance', 'issubclass', 'getattr', 'setattr', 'hasattr',
  'enumerate', 'zip', 'sorted', 'reversed', 'min', 'max', 'sum', 'abs',
  // Kotlin stdlib
  'println', 'print', 'readLine', 'require', 'requireNotNull', 'check', 'assert', 'lazy', 'error',
  'listOf', 'mapOf', 'setOf', 'mutableListOf', 'mutableMapOf', 'mutableSetOf',
  'arrayOf', 'sequenceOf', 'also', 'apply', 'run', 'with', 'takeIf', 'takeUnless',
  'TODO', 'buildString', 'buildList', 'buildMap', 'buildSet',
  'repeat', 'synchronized',
  // Kotlin coroutine builders & scope functions
  'launch', 'async', 'runBlocking', 'withContext', 'coroutineScope',
  'supervisorScope', 'delay',
  // Kotlin Flow operators
  'flow', 'flowOf', 'collect', 'emit', 'onEach', 'catch',
  'buffer', 'conflate', 'distinctUntilChanged',
  'flatMapLatest', 'flatMapMerge', 'combine',
  'stateIn', 'shareIn', 'launchIn',
  // Kotlin infix stdlib functions
  'to', 'until', 'downTo', 'step',
  // C/C++ standard library
  'printf', 'fprintf', 'sprintf', 'snprintf', 'vprintf', 'vfprintf', 'vsprintf', 'vsnprintf',
  'scanf', 'fscanf', 'sscanf',
  'malloc', 'calloc', 'realloc', 'free', 'memcpy', 'memmove', 'memset', 'memcmp',
  'strlen', 'strcpy', 'strncpy', 'strcat', 'strncat', 'strcmp', 'strncmp', 'strstr', 'strchr', 'strrchr',
  'atoi', 'atol', 'atof', 'strtol', 'strtoul', 'strtoll', 'strtoull', 'strtod',
  'sizeof', 'offsetof', 'typeof',
  'assert', 'abort', 'exit', '_exit',
  'fopen', 'fclose', 'fread', 'fwrite', 'fseek', 'ftell', 'rewind', 'fflush', 'fgets', 'fputs',
  // Linux kernel common macros/helpers (not real call targets)
  'likely', 'unlikely', 'BUG', 'BUG_ON', 'WARN', 'WARN_ON', 'WARN_ONCE',
  'IS_ERR', 'PTR_ERR', 'ERR_PTR', 'IS_ERR_OR_NULL',
  'ARRAY_SIZE', 'container_of', 'list_for_each_entry', 'list_for_each_entry_safe',
  'min', 'max', 'clamp', 'abs', 'swap',
  'pr_info', 'pr_warn', 'pr_err', 'pr_debug', 'pr_notice', 'pr_crit', 'pr_emerg',
  'printk', 'dev_info', 'dev_warn', 'dev_err', 'dev_dbg',
  'GFP_KERNEL', 'GFP_ATOMIC',
  'spin_lock', 'spin_unlock', 'spin_lock_irqsave', 'spin_unlock_irqrestore',
  'mutex_lock', 'mutex_unlock', 'mutex_init',
  'kfree', 'kmalloc', 'kzalloc', 'kcalloc', 'krealloc', 'kvmalloc', 'kvfree',
  'get', 'put',
  // C# / .NET built-ins
  'Console', 'WriteLine', 'ReadLine', 'Write',
  'Task', 'Run', 'Wait', 'WhenAll', 'WhenAny', 'FromResult', 'Delay', 'ContinueWith',
  'ConfigureAwait', 'GetAwaiter', 'GetResult',
  'ToString', 'GetType', 'Equals', 'GetHashCode', 'ReferenceEquals',
  'Add', 'Remove', 'Contains', 'Clear', 'Count', 'Any', 'All',
  'Where', 'Select', 'SelectMany', 'OrderBy', 'OrderByDescending', 'GroupBy',
  'First', 'FirstOrDefault', 'Single', 'SingleOrDefault', 'Last', 'LastOrDefault',
  'ToList', 'ToArray', 'ToDictionary', 'AsEnumerable', 'AsQueryable',
  'Aggregate', 'Sum', 'Average', 'Min', 'Max', 'Distinct', 'Skip', 'Take',
  'String', 'Format', 'IsNullOrEmpty', 'IsNullOrWhiteSpace', 'Concat', 'Join',
  'Trim', 'TrimStart', 'TrimEnd', 'Split', 'Replace', 'StartsWith', 'EndsWith',
  'Convert', 'ToInt32', 'ToDouble', 'ToBoolean', 'ToByte',
  'Math', 'Abs', 'Ceiling', 'Floor', 'Round', 'Pow', 'Sqrt',
  'Dispose', 'Close',
  'TryParse', 'Parse',
  'AddRange', 'RemoveAt', 'RemoveAll', 'FindAll', 'Exists', 'TrueForAll',
  'ContainsKey', 'TryGetValue', 'AddOrUpdate',
  'Throw', 'ThrowIfNull',
  // PHP built-ins
  'echo', 'isset', 'empty', 'unset', 'list', 'array', 'compact', 'extract',
  'count', 'strlen', 'strpos', 'strrpos', 'substr', 'strtolower', 'strtoupper', 'trim',
  'ltrim', 'rtrim', 'str_replace', 'str_contains', 'str_starts_with', 'str_ends_with',
  'sprintf', 'vsprintf', 'printf', 'number_format',
  'array_map', 'array_filter', 'array_reduce', 'array_push', 'array_pop', 'array_shift',
  'array_unshift', 'array_slice', 'array_splice', 'array_merge', 'array_keys', 'array_values',
  'array_key_exists', 'in_array', 'array_search', 'array_unique', 'usort', 'rsort',
  'json_encode', 'json_decode', 'serialize', 'unserialize',
  'intval', 'floatval', 'strval', 'boolval', 'is_null', 'is_string', 'is_int', 'is_array',
  'is_object', 'is_numeric', 'is_bool', 'is_float',
  'var_dump', 'print_r', 'var_export',
  'date', 'time', 'strtotime', 'mktime', 'microtime',
  'file_exists', 'file_get_contents', 'file_put_contents', 'is_file', 'is_dir',
  'preg_match', 'preg_match_all', 'preg_replace', 'preg_split',
  'header', 'session_start', 'session_destroy', 'ob_start', 'ob_end_clean', 'ob_get_clean',
  'dd', 'dump',
  // Swift/iOS built-ins and standard library
  'print', 'debugPrint', 'dump', 'fatalError', 'precondition', 'preconditionFailure',
  'assert', 'assertionFailure', 'NSLog',
  'abs', 'min', 'max', 'zip', 'stride', 'sequence', 'repeatElement',
  'swap', 'withUnsafePointer', 'withUnsafeMutablePointer', 'withUnsafeBytes',
  'autoreleasepool', 'unsafeBitCast', 'unsafeDowncast', 'numericCast',
  'type', 'MemoryLayout',
  // Swift collection/string methods (common noise)
  'map', 'flatMap', 'compactMap', 'filter', 'reduce', 'forEach', 'contains',
  'first', 'last', 'prefix', 'suffix', 'dropFirst', 'dropLast',
  'sorted', 'reversed', 'enumerated', 'joined', 'split',
  'append', 'insert', 'remove', 'removeAll', 'removeFirst', 'removeLast',
  'isEmpty', 'count', 'index', 'startIndex', 'endIndex',
  // UIKit/Foundation common methods (noise in call graph)
  'addSubview', 'removeFromSuperview', 'layoutSubviews', 'setNeedsLayout',
  'layoutIfNeeded', 'setNeedsDisplay', 'invalidateIntrinsicContentSize',
  'addTarget', 'removeTarget', 'addGestureRecognizer',
  'addConstraint', 'addConstraints', 'removeConstraint', 'removeConstraints',
  'NSLocalizedString', 'Bundle',
  'reloadData', 'reloadSections', 'reloadRows', 'performBatchUpdates',
  'register', 'dequeueReusableCell', 'dequeueReusableSupplementaryView',
  'beginUpdates', 'endUpdates', 'insertRows', 'deleteRows', 'insertSections', 'deleteSections',
  'present', 'dismiss', 'pushViewController', 'popViewController', 'popToRootViewController',
  'performSegue', 'prepare',
  // GCD / async
  'DispatchQueue', 'async', 'sync', 'asyncAfter',
  'Task', 'withCheckedContinuation', 'withCheckedThrowingContinuation',
  // Combine
  'sink', 'store', 'assign', 'receive', 'subscribe',
  // Notification / KVO
  'addObserver', 'removeObserver', 'post', 'NotificationCenter',
  // Rust standard library (common noise in call graphs)
  'unwrap', 'expect', 'unwrap_or', 'unwrap_or_else', 'unwrap_or_default',
  'ok', 'err', 'is_ok', 'is_err', 'map', 'map_err', 'and_then', 'or_else',
  'clone', 'to_string', 'to_owned', 'into', 'from', 'as_ref', 'as_mut',
  'iter', 'into_iter', 'collect', 'map', 'filter', 'fold', 'for_each',
  'len', 'is_empty', 'push', 'pop', 'insert', 'remove', 'contains',
  'format', 'write', 'writeln', 'panic', 'unreachable', 'todo', 'unimplemented',
  'vec', 'println', 'eprintln', 'dbg',
  'lock', 'read', 'write', 'try_lock',
  'spawn', 'join', 'sleep',
  'Some', 'None', 'Ok', 'Err',
  // Ruby built-ins and Kernel methods
  'puts', 'p', 'pp', 'raise', 'fail',
  'require', 'require_relative', 'load', 'autoload',
  'include', 'extend', 'prepend',
  'attr_accessor', 'attr_reader', 'attr_writer',
  'public', 'private', 'protected', 'module_function',
  'lambda', 'proc', 'block_given?',
  'nil?', 'is_a?', 'kind_of?', 'instance_of?', 'respond_to?',
  'freeze', 'frozen?', 'dup', 'tap', 'yield_self',
  // Ruby enumerables
  'each', 'select', 'reject', 'detect', 'collect',
  'inject', 'flat_map', 'each_with_object', 'each_with_index',
  'any?', 'all?', 'none?', 'count', 'first', 'last',
  'sort_by', 'min_by', 'max_by',
  'group_by', 'partition', 'compact', 'flatten', 'uniq',
]);

/** Check if a name is a built-in function or common noise that should be filtered out */
export const isBuiltInOrNoise = (name: string): boolean => BUILT_IN_NAMES.has(name);

/** AST node types that represent a class-like container (for HAS_METHOD edge extraction) */
export const CLASS_CONTAINER_TYPES = new Set([
  'class_declaration', 'abstract_class_declaration',
  'interface_declaration', 'struct_declaration', 'record_declaration',
  'class_specifier', 'struct_specifier',
  'impl_item', 'trait_item',
  'class_definition',
  'trait_declaration',
  'protocol_declaration',
  // Ruby
  'class',
  'module',
]);

export const CONTAINER_TYPE_TO_LABEL: Record<string, string> = {
  class_declaration: 'Class',
  abstract_class_declaration: 'Class',
  interface_declaration: 'Interface',
  struct_declaration: 'Struct',
  struct_specifier: 'Struct',
  class_specifier: 'Class',
  class_definition: 'Class',
  impl_item: 'Impl',
  trait_item: 'Trait',
  trait_declaration: 'Trait',
  record_declaration: 'Record',
  protocol_declaration: 'Interface',
  class: 'Class',
  module: 'Module',
};

/** Walk up AST to find enclosing class/struct/interface/impl, return its generateId or null.
 *  For Go method_declaration nodes, extracts receiver type (e.g. `func (u *User) Save()` → User struct). */
export const findEnclosingClassId = (node: any, filePath: string): string | null => {
  let current = node.parent;
  while (current) {
    // Go: method_declaration has a receiver parameter with the struct type
    if (current.type === 'method_declaration') {
      const receiver = current.childForFieldName?.('receiver');
      if (receiver) {
        // receiver is a parameter_list: (u *User) or (u User)
        const paramDecl = receiver.namedChildren?.find?.((c: any) => c.type === 'parameter_declaration');
        if (paramDecl) {
          const typeNode = paramDecl.childForFieldName?.('type');
          if (typeNode) {
            // Unwrap pointer_type (*User → User)
            const inner = typeNode.type === 'pointer_type' ? typeNode.firstNamedChild : typeNode;
            if (inner && (inner.type === 'type_identifier' || inner.type === 'identifier')) {
              return generateId('Struct', `${filePath}:${inner.text}`);
            }
          }
        }
      }
    }
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      // Rust impl_item: for `impl Trait for Struct {}`, pick the type after `for`
      if (current.type === 'impl_item') {
        const children = current.children ?? [];
        const forIdx = children.findIndex((c: any) => c.text === 'for');
        if (forIdx !== -1) {
          const nameNode = children.slice(forIdx + 1).find((c: any) =>
            c.type === 'type_identifier' || c.type === 'identifier'
          );
          if (nameNode) {
            return generateId('Impl', `${filePath}:${nameNode.text}`);
          }
        }
        // Fall through: plain `impl Struct {}` — use first type_identifier below
      }
      const nameNode = current.childForFieldName?.('name')
        ?? current.children?.find((c: any) =>
          c.type === 'type_identifier' || c.type === 'identifier' || c.type === 'name' || c.type === 'constant'
        );
      if (nameNode) {
        const label = CONTAINER_TYPE_TO_LABEL[current.type] || 'Class';
        return generateId(label, `${filePath}:${nameNode.text}`);
      }
    }
    current = current.parent;
  }
  return null;
};

/**
 * Extract function name and label from a function_definition or similar AST node.
 * Handles C/C++ qualified_identifier (ClassName::MethodName) and other language patterns.
 */
export const extractFunctionName = (node: any): { funcName: string | null; label: string } => {
  let funcName: string | null = null;
  let label = 'Function';

  // Swift init/deinit
  if (node.type === 'init_declaration' || node.type === 'deinit_declaration') {
    return {
      funcName: node.type === 'init_declaration' ? 'init' : 'deinit',
      label: 'Constructor',
    };
  }

  if (FUNCTION_DECLARATION_TYPES.has(node.type)) {
    // C/C++: function_definition -> [pointer_declarator ->] function_declarator -> qualified_identifier/identifier
    // Unwrap pointer_declarator / reference_declarator wrappers to reach function_declarator
    let declarator = node.childForFieldName?.('declarator') ||
                        node.children?.find((c: any) => c.type === 'function_declarator');
    while (declarator && (declarator.type === 'pointer_declarator' || declarator.type === 'reference_declarator')) {
      declarator = declarator.childForFieldName?.('declarator') ||
                   declarator.children?.find((c: any) =>
                     c.type === 'function_declarator' || c.type === 'pointer_declarator' || c.type === 'reference_declarator');
    }
    if (declarator) {
      const innerDeclarator = declarator.childForFieldName?.('declarator') ||
                               declarator.children?.find((c: any) =>
                                 c.type === 'qualified_identifier' || c.type === 'identifier' || c.type === 'parenthesized_declarator');

      if (innerDeclarator?.type === 'qualified_identifier') {
        const nameNode = innerDeclarator.childForFieldName?.('name') ||
                          innerDeclarator.children?.find((c: any) => c.type === 'identifier');
        if (nameNode?.text) {
          funcName = nameNode.text;
          label = 'Method';
        }
      } else if (innerDeclarator?.type === 'identifier') {
        funcName = innerDeclarator.text;
      } else if (innerDeclarator?.type === 'parenthesized_declarator') {
        const nestedId = innerDeclarator.children?.find((c: any) =>
          c.type === 'qualified_identifier' || c.type === 'identifier');
        if (nestedId?.type === 'qualified_identifier') {
          const nameNode = nestedId.childForFieldName?.('name') ||
                            nestedId.children?.find((c: any) => c.type === 'identifier');
          if (nameNode?.text) {
            funcName = nameNode.text;
            label = 'Method';
          }
        } else if (nestedId?.type === 'identifier') {
          funcName = nestedId.text;
        }
      }
    }

    // Fallback for other languages (Kotlin uses simple_identifier, Swift uses simple_identifier)
    if (!funcName) {
      const nameNode = node.childForFieldName?.('name') ||
                        node.children?.find((c: any) => c.type === 'identifier' || c.type === 'property_identifier' || c.type === 'simple_identifier');
      funcName = nameNode?.text;
    }
  } else if (node.type === 'impl_item') {
    const funcItem = node.children?.find((c: any) => c.type === 'function_item');
    if (funcItem) {
      const nameNode = funcItem.childForFieldName?.('name') ||
                        funcItem.children?.find((c: any) => c.type === 'identifier');
      funcName = nameNode?.text;
      label = 'Method';
    }
  } else if (node.type === 'method_definition') {
    const nameNode = node.childForFieldName?.('name') ||
                      node.children?.find((c: any) => c.type === 'property_identifier');
    funcName = nameNode?.text;
    label = 'Method';
  } else if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
    const nameNode = node.childForFieldName?.('name') ||
                      node.children?.find((c: any) => c.type === 'identifier');
    funcName = nameNode?.text;
    label = 'Method';
  } else if (node.type === 'arrow_function' || node.type === 'function_expression') {
    const parent = node.parent;
    if (parent?.type === 'variable_declarator') {
      const nameNode = parent.childForFieldName?.('name') ||
                        parent.children?.find((c: any) => c.type === 'identifier');
      funcName = nameNode?.text;
    }
  } else if (node.type === 'method' || node.type === 'singleton_method') {
    const nameNode = node.childForFieldName?.('name') ||
                      node.children?.find((c: any) => c.type === 'identifier');
    funcName = nameNode?.text;
    label = 'Method';
  }

  return { funcName, label };
};

/**
 * Yield control to the event loop so spinners/progress can render.
 * Call periodically in hot loops to prevent UI freezes.
 */
export const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** Ruby extensionless filenames recognised as Ruby source */
const RUBY_EXTENSIONLESS_FILES = new Set(['Rakefile', 'Gemfile', 'Guardfile', 'Vagrantfile', 'Brewfile']);

/**
 * Find a child of `childType` within a sibling node of `siblingType`.
 * Used for Kotlin AST traversal where visibility_modifier lives inside a modifiers sibling.
 */
export const findSiblingChild = (parent: any, siblingType: string, childType: string): any | null => {
  for (let i = 0; i < parent.childCount; i++) {
    const sibling = parent.child(i);
    if (sibling?.type === siblingType) {
      for (let j = 0; j < sibling.childCount; j++) {
        const child = sibling.child(j);
        if (child?.type === childType) return child;
      }
    }
  }
  return null;
};

/**
 * Map file extension to SupportedLanguage enum
 */
export const getLanguageFromFilename = (filename: string): SupportedLanguages | null => {
  // TypeScript (including TSX)
  if (filename.endsWith('.tsx')) return SupportedLanguages.TypeScript;
  if (filename.endsWith('.ts')) return SupportedLanguages.TypeScript;
  // JavaScript (including JSX)
  if (filename.endsWith('.jsx')) return SupportedLanguages.JavaScript;
  if (filename.endsWith('.js')) return SupportedLanguages.JavaScript;
  // Python
  if (filename.endsWith('.py')) return SupportedLanguages.Python;
  // Java
  if (filename.endsWith('.java')) return SupportedLanguages.Java;
  // C source files
  if (filename.endsWith('.c')) return SupportedLanguages.C;
  // C++ (all common extensions, including .h)
  // .h is parsed as C++ because tree-sitter-cpp is a strict superset of C, so pure-C
  // headers parse correctly, and C++ headers (classes, templates) are handled properly.
  if (filename.endsWith('.cpp') || filename.endsWith('.cc') || filename.endsWith('.cxx') ||
      filename.endsWith('.h') || filename.endsWith('.hpp') || filename.endsWith('.hxx') || filename.endsWith('.hh')) return SupportedLanguages.CPlusPlus;
  // C#
  if (filename.endsWith('.cs')) return SupportedLanguages.CSharp;
  // Go
  if (filename.endsWith('.go')) return SupportedLanguages.Go;
  // Rust
  if (filename.endsWith('.rs')) return SupportedLanguages.Rust;
  // Kotlin
  if (filename.endsWith('.kt') || filename.endsWith('.kts')) return SupportedLanguages.Kotlin;
  // PHP (all common extensions)
  if (filename.endsWith('.php') || filename.endsWith('.phtml') ||
      filename.endsWith('.php3') || filename.endsWith('.php4') ||
      filename.endsWith('.php5') || filename.endsWith('.php8')) {
    return SupportedLanguages.PHP;
  }
  // Ruby (extensions)
  if (filename.endsWith('.rb') || filename.endsWith('.rake') || filename.endsWith('.gemspec')) {
    return SupportedLanguages.Ruby;
  }
  // Ruby (extensionless files)
  const basename = filename.split('/').pop() || filename;
  if (RUBY_EXTENSIONLESS_FILES.has(basename)) {
    return SupportedLanguages.Ruby;
  }
  // Swift (extensions)
  if (filename.endsWith('.swift')) return SupportedLanguages.Swift;
  return null;
};

export interface MethodSignature {
  parameterCount: number | undefined;
  returnType: string | undefined;
}

const CALL_ARGUMENT_LIST_TYPES = new Set([
  'arguments',
  'argument_list',
  'value_arguments',
]);

/**
 * Extract parameter count and return type text from an AST method/function node.
 * Works across languages by looking for common AST patterns.
 */
export const extractMethodSignature = (node: SyntaxNode | null | undefined): MethodSignature => {
  let parameterCount: number | undefined = 0;
  let returnType: string | undefined;
  let isVariadic = false;

  if (!node) return { parameterCount, returnType };

  const paramListTypes = new Set([
    'formal_parameters', 'parameters', 'parameter_list',
    'function_parameters', 'method_parameters', 'function_value_parameters',
  ]);

  // Node types that indicate variadic/rest parameters
  const VARIADIC_PARAM_TYPES = new Set([
    'variadic_parameter_declaration',  // Go: ...string
    'variadic_parameter',              // Rust: extern "C" fn(...)
    'spread_parameter',                // Java: Object... args
    'list_splat_pattern',              // Python: *args
    'dictionary_splat_pattern',        // Python: **kwargs
  ]);

  const findParameterList = (current: SyntaxNode): SyntaxNode | null => {
    for (const child of current.children) {
      if (paramListTypes.has(child.type)) return child;
    }
    for (const child of current.children) {
      const nested = findParameterList(child);
      if (nested) return nested;
    }
    return null;
  };

  const parameterList = (
    paramListTypes.has(node.type) ? node                // node itself IS the parameter list (e.g. C# primary constructors)
      : node.childForFieldName?.('parameters')
        ?? findParameterList(node)
  );

  if (parameterList && paramListTypes.has(parameterList.type)) {
    for (const param of parameterList.namedChildren) {
      if (param.type === 'comment') continue;
      if (param.text === 'self' || param.text === '&self' || param.text === '&mut self' ||
          param.type === 'self_parameter') {
        continue;
      }
      // Check for variadic parameter types
      if (VARIADIC_PARAM_TYPES.has(param.type)) {
        isVariadic = true;
        continue;
      }
      // TypeScript/JavaScript: rest parameter — required_parameter containing rest_pattern
      if (param.type === 'required_parameter' || param.type === 'optional_parameter') {
        for (const child of param.children) {
          if (child.type === 'rest_pattern') {
            isVariadic = true;
            break;
          }
        }
        if (isVariadic) continue;
      }
      // Kotlin: vararg modifier on a regular parameter
      if (param.type === 'parameter' || param.type === 'formal_parameter') {
        const prev = param.previousSibling;
        if (prev?.type === 'parameter_modifiers' && prev.text.includes('vararg')) {
          isVariadic = true;
        }
      }
      parameterCount++;
    }
    // C/C++: bare `...` token in parameter list (not a named child — check all children)
    if (!isVariadic) {
      for (const child of parameterList.children) {
        if (!child.isNamed && child.text === '...') {
          isVariadic = true;
          break;
        }
      }
    }
  }

  // Return type extraction — language-specific field names
  // Go: 'result' field is either a type_identifier or parameter_list (multi-return)
  const goResult = node.childForFieldName?.('result');
  if (goResult) {
    returnType = goResult.type === 'parameter_list'
      ? goResult.text   // multi-return: "(string, error)"
      : goResult.text;  // single return: "int"
  }

  // Rust: 'return_type' field — the value IS the type node (e.g. primitive_type, type_identifier).
  // Skip if the node is a type_annotation (TS/Python), which is handled by the generic loop below.
  if (!returnType) {
    const rustReturn = node.childForFieldName?.('return_type');
    if (rustReturn && rustReturn.type !== 'type_annotation') {
      returnType = rustReturn.text;
    }
  }

  // C/C++: 'type' field on function_definition
  if (!returnType) {
    const cppType = node.childForFieldName?.('type');
    if (cppType && cppType.text !== 'void') {
      returnType = cppType.text;
    }
  }

  // TS/Rust/Python/C#/Kotlin: type_annotation or return_type child
  if (!returnType) {
    for (const child of node.children) {
      if (child.type === 'type_annotation' || child.type === 'return_type') {
        const typeNode = child.children.find((c) => c.isNamed);
        if (typeNode) returnType = typeNode.text;
      }
    }
  }

  if (isVariadic) parameterCount = undefined;

  return { parameterCount, returnType };
};

/**
 * Count direct arguments for a call expression across common tree-sitter grammars.
 * Returns undefined when the argument container cannot be located cheaply.
 */
export const countCallArguments = (callNode: SyntaxNode | null | undefined): number | undefined => {
  if (!callNode) return undefined;

  // Direct field or direct child (most languages)
  let argsNode: SyntaxNode | null | undefined = callNode.childForFieldName('arguments')
    ?? callNode.children.find((child) => CALL_ARGUMENT_LIST_TYPES.has(child.type));

  // Kotlin/Swift: call_expression → call_suffix → value_arguments
  // Search one level deeper for languages that wrap arguments in a suffix node
  if (!argsNode) {
    for (const child of callNode.children) {
      if (!child.isNamed) continue;
      const nested = child.children.find((gc) => CALL_ARGUMENT_LIST_TYPES.has(gc.type));
      if (nested) { argsNode = nested; break; }
    }
  }

  if (!argsNode) return undefined;

  let count = 0;
  for (const child of argsNode.children) {
    if (!child.isNamed) continue;
    if (child.type === 'comment') continue;
    count++;
  }

  return count;
};

// ── Call-form discrimination (Phase 1, Step D) ─────────────────────────

/**
 * AST node types that indicate a member-access wrapper around the callee name.
 * When nameNode.parent.type is one of these, the call is a member call.
 */
const MEMBER_ACCESS_NODE_TYPES = new Set([
  'member_expression',           // TS/JS: obj.method()
  'attribute',                   // Python: obj.method()
  'member_access_expression',    // C#: obj.Method()
  'field_expression',            // Rust/C++: obj.method() / ptr->method()
  'selector_expression',         // Go: obj.Method()
  'navigation_suffix',           // Kotlin/Swift: obj.method() — nameNode sits inside navigation_suffix
]);

/**
 * Call node types that are inherently constructor invocations.
 * Only includes patterns that the tree-sitter queries already capture as @call.
 */
const CONSTRUCTOR_CALL_NODE_TYPES = new Set([
  'constructor_invocation',              // Kotlin: Foo()
  'new_expression',                      // TS/JS/C++: new Foo()
  'object_creation_expression',          // Java/C#/PHP: new Foo()
  'implicit_object_creation_expression', // C# 9: User u = new(...)
  'composite_literal',                   // Go: User{...}
  'struct_expression',                   // Rust: User { ... }
]);

/**
 * AST node types for scoped/qualified calls (e.g., Foo::new() in Rust, Foo::bar() in C++).
 */
const SCOPED_CALL_NODE_TYPES = new Set([
  'scoped_identifier',           // Rust: Foo::new()
  'qualified_identifier',        // C++: ns::func()
]);

type CallForm = 'free' | 'member' | 'constructor';

/**
 * Infer whether a captured call site is a free call, member call, or constructor.
 * Returns undefined if the form cannot be determined.
 *
 * Works by inspecting the AST structure between callNode (@call) and nameNode (@call.name).
 * No tree-sitter query changes needed — the distinction is in the node types.
 */
export const inferCallForm = (
  callNode: SyntaxNode,
  nameNode: SyntaxNode,
): CallForm | undefined => {
  // 1. Constructor: callNode itself is a constructor invocation (Kotlin)
  if (CONSTRUCTOR_CALL_NODE_TYPES.has(callNode.type)) {
    return 'constructor';
  }

  // 2. Member call: nameNode's parent is a member-access wrapper
  const nameParent = nameNode.parent;
  if (nameParent && MEMBER_ACCESS_NODE_TYPES.has(nameParent.type)) {
    return 'member';
  }

  // 3. PHP: the callNode itself distinguishes member vs free calls
  if (callNode.type === 'member_call_expression' || callNode.type === 'nullsafe_member_call_expression') {
    return 'member';
  }
  if (callNode.type === 'scoped_call_expression') {
    return 'member'; // static call Foo::bar()
  }

  // 4. Java method_invocation: member if it has an 'object' field
  if (callNode.type === 'method_invocation' && callNode.childForFieldName('object')) {
    return 'member';
  }

  // 4b. Ruby call with receiver: obj.method
  if (callNode.type === 'call' && callNode.childForFieldName('receiver')) {
    return 'member';
  }

  // 5. Scoped calls (Rust Foo::new(), C++ ns::func()): treat as free
  //    The receiver is a type, not an instance — handled differently in Phase 3
  if (nameParent && SCOPED_CALL_NODE_TYPES.has(nameParent.type)) {
    return 'free';
  }

  // 6. Default: if nameNode is a direct child of callNode, it's a free call
  if (nameNode.parent === callNode || nameParent?.parent === callNode) {
    return 'free';
  }

  return undefined;
};

/**
 * Extract the receiver identifier for member calls.
 * Only captures simple identifiers — returns undefined for complex expressions
 * like getUser().save() or arr[0].method().
 */
const SIMPLE_RECEIVER_TYPES = new Set([
  'identifier',
  'simple_identifier',
  'variable_name',     // PHP $variable (tree-sitter-php)
  'name',              // PHP name node
  'this',              // TS/JS/Java/C# this.method()
  'self',              // Rust/Python self.method()
]);

export const extractReceiverName = (
  nameNode: SyntaxNode,
): string | undefined => {
  const parent = nameNode.parent;
  if (!parent) return undefined;

  // PHP: member_call_expression / nullsafe_member_call_expression — receiver is on the callNode
  // Java: method_invocation — receiver is the 'object' field on callNode
  // For these, parent of nameNode is the call itself, so check the call's object field
  const callNode = parent.parent ?? parent;

  let receiver: SyntaxNode | null = null;

  // Try standard field names used across grammars
  receiver = parent.childForFieldName('object')       // TS/JS member_expression, Python attribute, PHP, Java
    ?? parent.childForFieldName('value')               // Rust field_expression
    ?? parent.childForFieldName('operand')             // Go selector_expression
    ?? parent.childForFieldName('expression')          // C# member_access_expression
    ?? parent.childForFieldName('argument');            // C++ field_expression

  // Java method_invocation: 'object' field is on the callNode, not on nameNode's parent
  if (!receiver && callNode.type === 'method_invocation') {
    receiver = callNode.childForFieldName('object');
  }

  // PHP: member_call_expression has 'object' on the call node
  if (!receiver && (callNode.type === 'member_call_expression' || callNode.type === 'nullsafe_member_call_expression')) {
    receiver = callNode.childForFieldName('object');
  }

  // Ruby: call node has 'receiver' field
  if (!receiver && parent.type === 'call') {
    receiver = parent.childForFieldName('receiver');
  }

  // Kotlin/Swift: navigation_expression target is the first child
  if (!receiver && parent.type === 'navigation_suffix') {
    const navExpr = parent.parent;
    if (navExpr?.type === 'navigation_expression') {
      // First named child is the target (receiver)
      for (const child of navExpr.children) {
        if (child.isNamed && child !== parent) {
          receiver = child;
          break;
        }
      }
    }
  }

  if (!receiver) return undefined;

  // Only capture simple identifiers — refuse complex expressions
  if (SIMPLE_RECEIVER_TYPES.has(receiver.type)) {
    return receiver.text;
  }

  return undefined;
};

export const isVerboseIngestionEnabled = (): boolean => {
  const raw = process.env.GITNEXUS_VERBOSE;
  if (!raw) return false;
  const value = raw.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
};




