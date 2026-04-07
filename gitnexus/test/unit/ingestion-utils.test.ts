import { describe, it, expect } from 'vitest';
import { getLanguageFromFilename, SupportedLanguages } from 'gitnexus-shared';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';
import type { NodeLabel } from 'gitnexus-shared';
import type { LanguageProvider } from '../../src/core/ingestion/language-provider.js';
import {
  getTreeSitterBufferSize,
  TREE_SITTER_BUFFER_SIZE,
  TREE_SITTER_MAX_BUFFER,
} from '../../src/core/ingestion/constants.js';
import Parser from 'tree-sitter';
import C from 'tree-sitter-c';
import CPP from 'tree-sitter-cpp';
import Python from 'tree-sitter-python';
import TypeScript from 'tree-sitter-typescript';

describe('getLanguageFromFilename', () => {
  describe('TypeScript', () => {
    it('detects .ts files', () => {
      expect(getLanguageFromFilename('index.ts')).toBe(SupportedLanguages.TypeScript);
    });

    it('detects .tsx files', () => {
      expect(getLanguageFromFilename('Component.tsx')).toBe(SupportedLanguages.TypeScript);
    });

    it('detects .ts files in paths', () => {
      expect(getLanguageFromFilename('src/core/utils.ts')).toBe(SupportedLanguages.TypeScript);
    });
  });

  describe('JavaScript', () => {
    it('detects .js files', () => {
      expect(getLanguageFromFilename('index.js')).toBe(SupportedLanguages.JavaScript);
    });

    it('detects .jsx files', () => {
      expect(getLanguageFromFilename('App.jsx')).toBe(SupportedLanguages.JavaScript);
    });
  });

  describe('Python', () => {
    it('detects .py files', () => {
      expect(getLanguageFromFilename('main.py')).toBe(SupportedLanguages.Python);
    });
  });

  describe('Java', () => {
    it('detects .java files', () => {
      expect(getLanguageFromFilename('Main.java')).toBe(SupportedLanguages.Java);
    });
  });

  describe('C', () => {
    it('detects .c files', () => {
      expect(getLanguageFromFilename('main.c')).toBe(SupportedLanguages.C);
    });
  });

  describe('C++', () => {
    it.each(['.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx', '.hh'])('detects %s files', (ext) => {
      expect(getLanguageFromFilename(`file${ext}`)).toBe(SupportedLanguages.CPlusPlus);
    });
  });

  describe('C#', () => {
    it('detects .cs files', () => {
      expect(getLanguageFromFilename('Program.cs')).toBe(SupportedLanguages.CSharp);
    });
  });

  describe('Go', () => {
    it('detects .go files', () => {
      expect(getLanguageFromFilename('main.go')).toBe(SupportedLanguages.Go);
    });
  });

  describe('Rust', () => {
    it('detects .rs files', () => {
      expect(getLanguageFromFilename('main.rs')).toBe(SupportedLanguages.Rust);
    });
  });

  describe('PHP', () => {
    it.each(['.php', '.phtml', '.php3', '.php4', '.php5', '.php8'])('detects %s files', (ext) => {
      expect(getLanguageFromFilename(`file${ext}`)).toBe(SupportedLanguages.PHP);
    });
  });

  describe('Swift', () => {
    it('detects .swift files', () => {
      expect(getLanguageFromFilename('App.swift')).toBe(SupportedLanguages.Swift);
    });
  });

  describe('Ruby', () => {
    it.each(['.rb', '.rake', '.gemspec'])('detects %s files', (ext) => {
      expect(getLanguageFromFilename(`file${ext}`)).toBe(SupportedLanguages.Ruby);
    });

    it('detects extensionless Rakefile', () => {
      expect(getLanguageFromFilename('Rakefile')).toBe(SupportedLanguages.Ruby);
    });

    it('detects extensionless Gemfile', () => {
      expect(getLanguageFromFilename('Gemfile')).toBe(SupportedLanguages.Ruby);
    });
  });

  describe('Kotlin', () => {
    it.each(['.kt', '.kts'])('detects %s files', (ext) => {
      expect(getLanguageFromFilename(`file${ext}`)).toBe(SupportedLanguages.Kotlin);
    });
  });

  describe('unsupported', () => {
    it.each(['.scala', '.r', '.lua', '.zig', '.txt', '.md', '.json', '.yaml'])(
      'returns null for %s files',
      (ext) => {
        expect(getLanguageFromFilename(`file${ext}`)).toBeNull();
      },
    );

    it('returns null for files without extension', () => {
      expect(getLanguageFromFilename('Makefile')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(getLanguageFromFilename('')).toBeNull();
    });
  });
});

describe('isBuiltInOrNoise', () => {
  const js = getProvider(SupportedLanguages.JavaScript);
  const py = getProvider(SupportedLanguages.Python);
  const php = getProvider(SupportedLanguages.PHP);
  const c = getProvider(SupportedLanguages.C);
  const kt = getProvider(SupportedLanguages.Kotlin);
  const swift = getProvider(SupportedLanguages.Swift);
  const rust = getProvider(SupportedLanguages.Rust);
  const cs = getProvider(SupportedLanguages.CSharp);

  describe('JavaScript/TypeScript', () => {
    it('filters console methods', () => {
      expect(js.isBuiltInName('console')).toBe(true);
      expect(js.isBuiltInName('log')).toBe(true);
      expect(js.isBuiltInName('warn')).toBe(true);
    });

    it('filters React hooks', () => {
      expect(js.isBuiltInName('useState')).toBe(true);
      expect(js.isBuiltInName('useEffect')).toBe(true);
      expect(js.isBuiltInName('useCallback')).toBe(true);
    });

    it('filters array methods', () => {
      expect(js.isBuiltInName('map')).toBe(true);
      expect(js.isBuiltInName('filter')).toBe(true);
      expect(js.isBuiltInName('reduce')).toBe(true);
    });
  });

  describe('Python', () => {
    it('filters built-in functions', () => {
      expect(py.isBuiltInName('print')).toBe(true);
      expect(py.isBuiltInName('len')).toBe(true);
      expect(py.isBuiltInName('range')).toBe(true);
    });
  });

  describe('PHP', () => {
    it('filters PHP built-in functions', () => {
      expect(php.isBuiltInName('echo')).toBe(true);
      expect(php.isBuiltInName('isset')).toBe(true);
      expect(php.isBuiltInName('date')).toBe(true);
      expect(php.isBuiltInName('json_encode')).toBe(true);
      expect(php.isBuiltInName('array_map')).toBe(true);
    });

    it('filters PHP string functions', () => {
      expect(php.isBuiltInName('strlen')).toBe(true);
      expect(php.isBuiltInName('substr')).toBe(true);
      expect(php.isBuiltInName('str_replace')).toBe(true);
    });
  });

  describe('C/C++', () => {
    it('filters standard library functions', () => {
      expect(c.isBuiltInName('printf')).toBe(true);
      expect(c.isBuiltInName('malloc')).toBe(true);
      expect(c.isBuiltInName('free')).toBe(true);
    });

    it('filters Linux kernel macros', () => {
      expect(c.isBuiltInName('container_of')).toBe(true);
      expect(c.isBuiltInName('ARRAY_SIZE')).toBe(true);
      expect(c.isBuiltInName('pr_info')).toBe(true);
    });
  });

  describe('Kotlin', () => {
    it('filters stdlib functions', () => {
      expect(kt.isBuiltInName('println')).toBe(true);
      expect(kt.isBuiltInName('listOf')).toBe(true);
      expect(kt.isBuiltInName('TODO')).toBe(true);
    });

    it('filters coroutine functions', () => {
      expect(kt.isBuiltInName('launch')).toBe(true);
      expect(kt.isBuiltInName('async')).toBe(true);
    });
  });

  describe('Swift', () => {
    it('filters built-in functions', () => {
      expect(swift.isBuiltInName('print')).toBe(true);
      expect(swift.isBuiltInName('fatalError')).toBe(true);
    });

    it('filters UIKit methods', () => {
      expect(swift.isBuiltInName('addSubview')).toBe(true);
      expect(swift.isBuiltInName('reloadData')).toBe(true);
    });
  });

  describe('Rust', () => {
    it('filters Result/Option methods', () => {
      expect(rust.isBuiltInName('unwrap')).toBe(true);
      expect(rust.isBuiltInName('expect')).toBe(true);
      expect(rust.isBuiltInName('unwrap_or')).toBe(true);
      expect(rust.isBuiltInName('unwrap_or_else')).toBe(true);
      expect(rust.isBuiltInName('unwrap_or_default')).toBe(true);
      expect(rust.isBuiltInName('ok')).toBe(true);
      expect(rust.isBuiltInName('err')).toBe(true);
      expect(rust.isBuiltInName('is_ok')).toBe(true);
      expect(rust.isBuiltInName('is_err')).toBe(true);
      expect(rust.isBuiltInName('map_err')).toBe(true);
      expect(rust.isBuiltInName('and_then')).toBe(true);
      expect(rust.isBuiltInName('or_else')).toBe(true);
    });

    it('filters trait conversion methods', () => {
      expect(rust.isBuiltInName('clone')).toBe(true);
      expect(rust.isBuiltInName('to_string')).toBe(true);
      expect(rust.isBuiltInName('to_owned')).toBe(true);
      expect(rust.isBuiltInName('into')).toBe(true);
      expect(rust.isBuiltInName('from')).toBe(true);
      expect(rust.isBuiltInName('as_ref')).toBe(true);
      expect(rust.isBuiltInName('as_mut')).toBe(true);
    });

    it('filters iterator methods', () => {
      expect(rust.isBuiltInName('iter')).toBe(true);
      expect(rust.isBuiltInName('into_iter')).toBe(true);
      expect(rust.isBuiltInName('collect')).toBe(true);
      expect(rust.isBuiltInName('fold')).toBe(true);
      expect(rust.isBuiltInName('for_each')).toBe(true);
    });

    it('filters collection methods', () => {
      expect(rust.isBuiltInName('len')).toBe(true);
      expect(rust.isBuiltInName('is_empty')).toBe(true);
      expect(rust.isBuiltInName('push')).toBe(true);
      expect(rust.isBuiltInName('pop')).toBe(true);
      expect(rust.isBuiltInName('insert')).toBe(true);
      expect(rust.isBuiltInName('remove')).toBe(true);
      expect(rust.isBuiltInName('contains')).toBe(true);
    });

    it('filters macro-like and panic functions', () => {
      expect(rust.isBuiltInName('format')).toBe(true);
      expect(rust.isBuiltInName('panic')).toBe(true);
      expect(rust.isBuiltInName('unreachable')).toBe(true);
      expect(rust.isBuiltInName('todo')).toBe(true);
      expect(rust.isBuiltInName('unimplemented')).toBe(true);
      expect(rust.isBuiltInName('vec')).toBe(true);
      expect(rust.isBuiltInName('println')).toBe(true);
      expect(rust.isBuiltInName('eprintln')).toBe(true);
      expect(rust.isBuiltInName('dbg')).toBe(true);
    });

    it('filters sync primitives', () => {
      expect(rust.isBuiltInName('lock')).toBe(true);
      expect(rust.isBuiltInName('try_lock')).toBe(true);
      expect(rust.isBuiltInName('spawn')).toBe(true);
      expect(rust.isBuiltInName('join')).toBe(true);
      expect(rust.isBuiltInName('sleep')).toBe(true);
    });

    it('filters enum constructors', () => {
      expect(rust.isBuiltInName('Some')).toBe(true);
      expect(rust.isBuiltInName('None')).toBe(true);
      expect(rust.isBuiltInName('Ok')).toBe(true);
      expect(rust.isBuiltInName('Err')).toBe(true);
    });

    it('does not filter user-defined Rust functions', () => {
      expect(rust.isBuiltInName('process_request')).toBe(false);
      expect(rust.isBuiltInName('handle_connection')).toBe(false);
      expect(rust.isBuiltInName('build_response')).toBe(false);
    });
  });

  describe('C#/.NET', () => {
    it('filters Console I/O', () => {
      expect(cs.isBuiltInName('Console')).toBe(true);
      expect(cs.isBuiltInName('WriteLine')).toBe(true);
      expect(cs.isBuiltInName('ReadLine')).toBe(true);
    });

    it('filters LINQ methods', () => {
      expect(cs.isBuiltInName('Where')).toBe(true);
      expect(cs.isBuiltInName('Select')).toBe(true);
      expect(cs.isBuiltInName('GroupBy')).toBe(true);
      expect(cs.isBuiltInName('OrderBy')).toBe(true);
      expect(cs.isBuiltInName('FirstOrDefault')).toBe(true);
      expect(cs.isBuiltInName('ToList')).toBe(true);
    });

    it('filters Task async methods', () => {
      expect(cs.isBuiltInName('Task')).toBe(true);
      expect(cs.isBuiltInName('Run')).toBe(true);
      expect(cs.isBuiltInName('WhenAll')).toBe(true);
      expect(cs.isBuiltInName('ConfigureAwait')).toBe(true);
    });

    it('filters Object base methods', () => {
      expect(cs.isBuiltInName('ToString')).toBe(true);
      expect(cs.isBuiltInName('GetType')).toBe(true);
      expect(cs.isBuiltInName('Equals')).toBe(true);
      expect(cs.isBuiltInName('GetHashCode')).toBe(true);
    });
  });

  describe('user-defined functions', () => {
    it('does not filter custom function names', () => {
      expect(js.isBuiltInName('myCustomFunction')).toBe(false);
      expect(py.isBuiltInName('processData')).toBe(false);
      expect(rust.isBuiltInName('handleUserRequest')).toBe(false);
    });
  });
});

describe('extractFunctionName (via methodExtractor)', () => {
  const parser = new Parser();
  const cProvider = getProvider(SupportedLanguages.C);
  const cppProvider = getProvider(SupportedLanguages.CPlusPlus);
  const tsProvider = getProvider(SupportedLanguages.TypeScript);

  /** Test helper: extracts function name using methodExtractor hook with generic fallback. */
  const extractFunctionName = (
    node: SyntaxNode | null,
    provider?: LanguageProvider,
  ): { funcName: string | null; label: NodeLabel } => {
    if (!node) return { funcName: null, label: 'Function' };
    const result = provider?.methodExtractor?.extractFunctionName?.(node);
    if (result) return result;
    const funcName = node.childForFieldName?.('name')?.text ?? null;
    return { funcName, label: 'Function' };
  };

  describe('C', () => {
    it('extracts function name from C function definition', () => {
      parser.setLanguage(C);
      const code = `int main() { return 0; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode, cProvider);

      expect(result.funcName).toBe('main');
      expect(result.label).toBe('Function');
    });

    it('extracts function name with parameters', () => {
      parser.setLanguage(C);
      const code = `void helper(int a, char* b) {}`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode, cProvider);

      expect(result.funcName).toBe('helper');
      expect(result.label).toBe('Function');
    });
  });

  describe('C++', () => {
    it('extracts method name from C++ class method definition', () => {
      parser.setLanguage(CPP);
      const code = `int MyClass::OnEncryptData() { return 0; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode, cppProvider);

      expect(result.funcName).toBe('OnEncryptData');
      expect(result.label).toBe('Method');
    });

    it('extracts method name with namespace', () => {
      parser.setLanguage(CPP);
      const code = `void HuksListener::OnDataOprEvent(int type, DataInfo& info) {}`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode, cppProvider);

      expect(result.funcName).toBe('OnDataOprEvent');
      expect(result.label).toBe('Method');
    });

    it('extracts C function (not method)', () => {
      parser.setLanguage(CPP);
      const code = `void standalone_function() {}`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode, cppProvider);

      expect(result.funcName).toBe('standalone_function');
      expect(result.label).toBe('Function');
    });

    it('extracts method with parenthesized declarator', () => {
      parser.setLanguage(CPP);
      const code = `void (MyClass::handler)() {}`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode, cppProvider);

      expect(result.funcName).toBe('handler');
      expect(result.label).toBe('Method');
    });
  });

  describe('C pointer returns', () => {
    it('extracts name from function returning pointer', () => {
      parser.setLanguage(C);
      const code = `int* get_data() { return 0; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode, cProvider);

      expect(result.funcName).toBe('get_data');
      expect(result.label).toBe('Function');
    });

    it('extracts name from function returning double pointer', () => {
      parser.setLanguage(C);
      const code = `char** get_strings() { return 0; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode, cProvider);

      expect(result.funcName).toBe('get_strings');
      expect(result.label).toBe('Function');
    });

    it('extracts name from struct pointer return', () => {
      parser.setLanguage(C);
      const code = `struct Node* create_node(int val) { return 0; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode, cProvider);

      expect(result.funcName).toBe('create_node');
      expect(result.label).toBe('Function');
    });
  });

  describe('C++ pointer/reference returns', () => {
    it('extracts name from method returning pointer', () => {
      parser.setLanguage(CPP);
      const code = `int* MyClass::getData() { return nullptr; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode, cppProvider);

      expect(result.funcName).toBe('getData');
      expect(result.label).toBe('Method');
    });

    it('extracts name from function returning reference', () => {
      parser.setLanguage(CPP);
      const code = `std::string& get_name() { static std::string s; return s; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode, cppProvider);

      expect(result.funcName).toBe('get_name');
      expect(result.label).toBe('Function');
    });

    it('extracts name from method returning reference', () => {
      parser.setLanguage(CPP);
      const code = `int& Container::at(int i) { return data[i]; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode, cppProvider);

      expect(result.funcName).toBe('at');
      expect(result.label).toBe('Method');
    });

    it('extracts name from method returning const reference', () => {
      parser.setLanguage(CPP);
      const code = `const std::string& Config::getName() const { return name_; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode, cppProvider);

      expect(result.funcName).toBe('getName');
      expect(result.label).toBe('Method');
    });
  });

  describe('C++ destructors', () => {
    it('extracts destructor name from out-of-line definition', () => {
      parser.setLanguage(CPP);
      const code = `MyClass::~MyClass() { cleanup(); }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode, cppProvider);

      // destructor_name includes the ~ prefix
      expect(result.funcName).toBe('~MyClass');
      expect(result.label).toBe('Method');
    });
  });

  describe('TypeScript', () => {
    it('extracts arrow function name from variable declarator', () => {
      parser.setLanguage(TypeScript.typescript);
      const code = `const myHandler = () => { return 1; }`;
      const tree = parser.parse(code);
      const program = tree.rootNode;
      const varDecl = program.child(0);
      const declarator = varDecl!.namedChild(0);
      const arrowFunc = declarator!.namedChild(1);

      const result = extractFunctionName(arrowFunc, tsProvider);

      expect(result.funcName).toBe('myHandler');
      expect(result.label).toBe('Function');
    });

    it('extracts function expression name from variable declarator', () => {
      parser.setLanguage(TypeScript.typescript);
      const code = `const processItem = function() { }`;
      const tree = parser.parse(code);
      const program = tree.rootNode;
      const varDecl = program.child(0);
      const declarator = varDecl!.namedChild(0);
      const funcExpr = declarator!.namedChild(1);

      const result = extractFunctionName(funcExpr, tsProvider);

      expect(result.funcName).toBe('processItem');
      expect(result.label).toBe('Function');
    });
  });

  describe('Python', () => {
    it('extracts function name from Python function definition', () => {
      parser.setLanguage(Python);
      const code = `def hello_world():\n    pass`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode);

      expect(result.funcName).toBe('hello_world');
      expect(result.label).toBe('Function');
    });

    it('extracts function name with parameters', () => {
      parser.setLanguage(Python);
      const code = `def calculate_sum(a, b):\n    return a + b`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode);

      expect(result.funcName).toBe('calculate_sum');
      expect(result.label).toBe('Function');
    });

    it('extracts async function name', () => {
      parser.setLanguage(Python);
      const code = `async def fetch_data():\n    pass`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode);

      expect(result.funcName).toBe('fetch_data');
      expect(result.label).toBe('Function');
    });

    it('extracts function name with type hints', () => {
      parser.setLanguage(Python);
      const code = `def process_data(items: list[int]) -> bool:\n    return True`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode);

      expect(result.funcName).toBe('process_data');
      expect(result.label).toBe('Function');
    });

    it('extracts nested function name', () => {
      parser.setLanguage(Python);
      const code = `def outer():\n    def inner():\n        pass`;
      const tree = parser.parse(code);
      const outerFunc = tree.rootNode.child(0);
      const block = outerFunc!.child(4);
      const innerFunc = block!.namedChild(0);

      const result = extractFunctionName(innerFunc);

      expect(result.funcName).toBe('inner');
      expect(result.label).toBe('Function');
    });
  });
});

describe('getTreeSitterBufferSize', () => {
  it('returns minimum 512KB for small files', () => {
    expect(getTreeSitterBufferSize(100)).toBe(TREE_SITTER_BUFFER_SIZE);
    expect(getTreeSitterBufferSize(0)).toBe(TREE_SITTER_BUFFER_SIZE);
    expect(getTreeSitterBufferSize(1000)).toBe(TREE_SITTER_BUFFER_SIZE);
  });

  it('returns 2x content length when larger than minimum', () => {
    const size = 400 * 1024; // 400 KB — 2x = 800 KB > 512 KB min
    expect(getTreeSitterBufferSize(size)).toBe(size * 2);
  });

  it('caps at 32MB for very large files', () => {
    const huge = 20 * 1024 * 1024; // 20 MB — 2x = 40 MB > 32 MB cap
    expect(getTreeSitterBufferSize(huge)).toBe(32 * 1024 * 1024);
  });

  it('returns exactly 512KB at the boundary', () => {
    // 256KB * 2 = 512KB = minimum, so should return minimum
    expect(getTreeSitterBufferSize(256 * 1024)).toBe(TREE_SITTER_BUFFER_SIZE);
  });

  it('scales linearly between min and max', () => {
    const small = getTreeSitterBufferSize(300 * 1024);
    const medium = getTreeSitterBufferSize(1 * 1024 * 1024);
    const large = getTreeSitterBufferSize(5 * 1024 * 1024);
    expect(small).toBeLessThan(medium);
    expect(medium).toBeLessThan(large);
  });

  it('TREE_SITTER_MAX_BUFFER is 32MB', () => {
    expect(TREE_SITTER_MAX_BUFFER).toBe(32 * 1024 * 1024);
  });

  it('returns max buffer at exact boundary (16MB input)', () => {
    // 16MB * 2 = 32MB = max
    expect(getTreeSitterBufferSize(16 * 1024 * 1024)).toBe(TREE_SITTER_MAX_BUFFER);
  });

  it('file just over max returns max buffer', () => {
    // 17MB * 2 = 34MB > 32MB cap
    expect(getTreeSitterBufferSize(17 * 1024 * 1024)).toBe(TREE_SITTER_MAX_BUFFER);
  });

  it('handles files between old 512KB limit and new 32MB limit', () => {
    // This is the range that was previously silently skipped
    const sizes = [600 * 1024, 1024 * 1024, 5 * 1024 * 1024, 10 * 1024 * 1024];
    for (const size of sizes) {
      const bufSize = getTreeSitterBufferSize(size);
      expect(bufSize).toBeGreaterThanOrEqual(TREE_SITTER_BUFFER_SIZE);
      expect(bufSize).toBeLessThanOrEqual(TREE_SITTER_MAX_BUFFER);
    }
  });
});
