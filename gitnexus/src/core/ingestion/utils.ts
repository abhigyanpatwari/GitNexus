import { SupportedLanguages } from '../../config/supported-languages.js';

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
]);

/** Check if a name is a built-in function or common noise that should be filtered out */
export const isBuiltInOrNoise = (name: string): boolean => BUILT_IN_NAMES.has(name);

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

    // Fallback for other languages
    if (!funcName) {
      const nameNode = node.childForFieldName?.('name') ||
                        node.children?.find((c: any) => c.type === 'identifier' || c.type === 'property_identifier');
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
  }

  return { funcName, label };
};

/**
 * Yield control to the event loop so spinners/progress can render.
 * Call periodically in hot loops to prevent UI freezes.
 */
export const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

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
  if (filename.endsWith('.swift')) return SupportedLanguages.Swift;
  return null;
};

export const isVerboseIngestionEnabled = (): boolean => {
  const raw = process.env.GITNEXUS_VERBOSE;
  if (!raw) return false;
  const value = raw.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
};
