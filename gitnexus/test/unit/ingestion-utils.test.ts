import { describe, it, expect } from 'vitest';
import { getLanguageFromFilename, isBuiltInOrNoise, extractFunctionName } from '../../src/core/ingestion/utils.js';
import { getTreeSitterBufferSize, TREE_SITTER_BUFFER_SIZE, TREE_SITTER_MAX_BUFFER } from '../../src/core/ingestion/constants.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
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
    it.each(['.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx', '.hh'])(
      'detects %s files',
      (ext) => {
        expect(getLanguageFromFilename(`file${ext}`)).toBe(SupportedLanguages.CPlusPlus);
      }
    );
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
    it.each(['.php', '.phtml', '.php3', '.php4', '.php5', '.php8'])(
      'detects %s files',
      (ext) => {
        expect(getLanguageFromFilename(`file${ext}`)).toBe(SupportedLanguages.PHP);
      }
    );
  });

  describe('Swift', () => {
    it('detects .swift files', () => {
      expect(getLanguageFromFilename('App.swift')).toBe(SupportedLanguages.Swift);
    });
  });

  describe('Ruby', () => {
    it.each(['.rb', '.rake', '.gemspec'])(
      'detects %s files',
      (ext) => {
        expect(getLanguageFromFilename(`file${ext}`)).toBe(SupportedLanguages.Ruby);
      }
    );

    it('detects extensionless Rakefile', () => {
      expect(getLanguageFromFilename('Rakefile')).toBe(SupportedLanguages.Ruby);
    });

    it('detects extensionless Gemfile', () => {
      expect(getLanguageFromFilename('Gemfile')).toBe(SupportedLanguages.Ruby);
    });
  });

  describe('Kotlin', () => {
    it.each(['.kt', '.kts'])(
      'detects %s files',
      (ext) => {
        expect(getLanguageFromFilename(`file${ext}`)).toBe(SupportedLanguages.Kotlin);
      }
    );
  });

  describe('unsupported', () => {
    it.each(['.scala', '.r', '.lua', '.zig', '.txt', '.md', '.json', '.yaml'])(
      'returns null for %s files',
      (ext) => {
        expect(getLanguageFromFilename(`file${ext}`)).toBeNull();
      }
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
  describe('JavaScript/TypeScript', () => {
    it('filters console methods', () => {
      expect(isBuiltInOrNoise('console')).toBe(true);
      expect(isBuiltInOrNoise('log')).toBe(true);
      expect(isBuiltInOrNoise('warn')).toBe(true);
    });

    it('filters React hooks', () => {
      expect(isBuiltInOrNoise('useState')).toBe(true);
      expect(isBuiltInOrNoise('useEffect')).toBe(true);
      expect(isBuiltInOrNoise('useCallback')).toBe(true);
    });

    it('filters array methods', () => {
      expect(isBuiltInOrNoise('map')).toBe(true);
      expect(isBuiltInOrNoise('filter')).toBe(true);
      expect(isBuiltInOrNoise('reduce')).toBe(true);
    });
  });

  describe('Python', () => {
    it('filters built-in functions', () => {
      expect(isBuiltInOrNoise('print')).toBe(true);
      expect(isBuiltInOrNoise('len')).toBe(true);
      expect(isBuiltInOrNoise('range')).toBe(true);
    });
  });

  describe('PHP', () => {
    it('filters PHP built-in functions', () => {
      expect(isBuiltInOrNoise('echo')).toBe(true);
      expect(isBuiltInOrNoise('isset')).toBe(true);
      expect(isBuiltInOrNoise('date')).toBe(true);
      expect(isBuiltInOrNoise('json_encode')).toBe(true);
      expect(isBuiltInOrNoise('array_map')).toBe(true);
    });

    it('filters PHP string functions', () => {
      expect(isBuiltInOrNoise('strlen')).toBe(true);
      expect(isBuiltInOrNoise('substr')).toBe(true);
      expect(isBuiltInOrNoise('str_replace')).toBe(true);
    });
  });

  describe('C/C++', () => {
    it('filters standard library functions', () => {
      expect(isBuiltInOrNoise('printf')).toBe(true);
      expect(isBuiltInOrNoise('malloc')).toBe(true);
      expect(isBuiltInOrNoise('free')).toBe(true);
    });

    it('filters Linux kernel macros', () => {
      expect(isBuiltInOrNoise('container_of')).toBe(true);
      expect(isBuiltInOrNoise('ARRAY_SIZE')).toBe(true);
      expect(isBuiltInOrNoise('pr_info')).toBe(true);
    });
  });

  describe('Kotlin', () => {
    it('filters stdlib functions', () => {
      expect(isBuiltInOrNoise('println')).toBe(true);
      expect(isBuiltInOrNoise('listOf')).toBe(true);
      expect(isBuiltInOrNoise('TODO')).toBe(true);
    });

    it('filters coroutine functions', () => {
      expect(isBuiltInOrNoise('launch')).toBe(true);
      expect(isBuiltInOrNoise('async')).toBe(true);
    });
  });

  describe('Swift', () => {
    it('filters built-in functions', () => {
      expect(isBuiltInOrNoise('print')).toBe(true);
      expect(isBuiltInOrNoise('fatalError')).toBe(true);
    });

    it('filters UIKit methods', () => {
      expect(isBuiltInOrNoise('addSubview')).toBe(true);
      expect(isBuiltInOrNoise('reloadData')).toBe(true);
    });
  });

  describe('Rust', () => {
    it('filters Result/Option methods', () => {
      expect(isBuiltInOrNoise('unwrap')).toBe(true);
      expect(isBuiltInOrNoise('expect')).toBe(true);
      expect(isBuiltInOrNoise('unwrap_or')).toBe(true);
      expect(isBuiltInOrNoise('unwrap_or_else')).toBe(true);
      expect(isBuiltInOrNoise('unwrap_or_default')).toBe(true);
      expect(isBuiltInOrNoise('ok')).toBe(true);
      expect(isBuiltInOrNoise('err')).toBe(true);
      expect(isBuiltInOrNoise('is_ok')).toBe(true);
      expect(isBuiltInOrNoise('is_err')).toBe(true);
      expect(isBuiltInOrNoise('map_err')).toBe(true);
      expect(isBuiltInOrNoise('and_then')).toBe(true);
      expect(isBuiltInOrNoise('or_else')).toBe(true);
    });

    it('filters trait conversion methods', () => {
      expect(isBuiltInOrNoise('clone')).toBe(true);
      expect(isBuiltInOrNoise('to_string')).toBe(true);
      expect(isBuiltInOrNoise('to_owned')).toBe(true);
      expect(isBuiltInOrNoise('into')).toBe(true);
      expect(isBuiltInOrNoise('from')).toBe(true);
      expect(isBuiltInOrNoise('as_ref')).toBe(true);
      expect(isBuiltInOrNoise('as_mut')).toBe(true);
    });

    it('filters iterator methods', () => {
      expect(isBuiltInOrNoise('iter')).toBe(true);
      expect(isBuiltInOrNoise('into_iter')).toBe(true);
      expect(isBuiltInOrNoise('collect')).toBe(true);
      expect(isBuiltInOrNoise('fold')).toBe(true);
      expect(isBuiltInOrNoise('for_each')).toBe(true);
    });

    it('filters collection methods', () => {
      expect(isBuiltInOrNoise('len')).toBe(true);
      expect(isBuiltInOrNoise('is_empty')).toBe(true);
      expect(isBuiltInOrNoise('push')).toBe(true);
      expect(isBuiltInOrNoise('pop')).toBe(true);
      expect(isBuiltInOrNoise('insert')).toBe(true);
      expect(isBuiltInOrNoise('remove')).toBe(true);
      expect(isBuiltInOrNoise('contains')).toBe(true);
    });

    it('filters macro-like and panic functions', () => {
      expect(isBuiltInOrNoise('format')).toBe(true);
      expect(isBuiltInOrNoise('panic')).toBe(true);
      expect(isBuiltInOrNoise('unreachable')).toBe(true);
      expect(isBuiltInOrNoise('todo')).toBe(true);
      expect(isBuiltInOrNoise('unimplemented')).toBe(true);
      expect(isBuiltInOrNoise('vec')).toBe(true);
      expect(isBuiltInOrNoise('println')).toBe(true);
      expect(isBuiltInOrNoise('eprintln')).toBe(true);
      expect(isBuiltInOrNoise('dbg')).toBe(true);
    });

    it('filters sync primitives', () => {
      expect(isBuiltInOrNoise('lock')).toBe(true);
      expect(isBuiltInOrNoise('try_lock')).toBe(true);
      expect(isBuiltInOrNoise('spawn')).toBe(true);
      expect(isBuiltInOrNoise('join')).toBe(true);
      expect(isBuiltInOrNoise('sleep')).toBe(true);
    });

    it('filters enum constructors', () => {
      expect(isBuiltInOrNoise('Some')).toBe(true);
      expect(isBuiltInOrNoise('None')).toBe(true);
      expect(isBuiltInOrNoise('Ok')).toBe(true);
      expect(isBuiltInOrNoise('Err')).toBe(true);
    });

    it('does not filter user-defined Rust functions', () => {
      expect(isBuiltInOrNoise('process_request')).toBe(false);
      expect(isBuiltInOrNoise('handle_connection')).toBe(false);
      expect(isBuiltInOrNoise('build_response')).toBe(false);
    });
  });

  describe('C#/.NET', () => {
    it('filters Console I/O', () => {
      expect(isBuiltInOrNoise('Console')).toBe(true);
      expect(isBuiltInOrNoise('WriteLine')).toBe(true);
      expect(isBuiltInOrNoise('ReadLine')).toBe(true);
    });

    it('filters LINQ methods', () => {
      expect(isBuiltInOrNoise('Where')).toBe(true);
      expect(isBuiltInOrNoise('Select')).toBe(true);
      expect(isBuiltInOrNoise('GroupBy')).toBe(true);
      expect(isBuiltInOrNoise('OrderBy')).toBe(true);
      expect(isBuiltInOrNoise('FirstOrDefault')).toBe(true);
      expect(isBuiltInOrNoise('ToList')).toBe(true);
    });

    it('filters Task async methods', () => {
      expect(isBuiltInOrNoise('Task')).toBe(true);
      expect(isBuiltInOrNoise('Run')).toBe(true);
      expect(isBuiltInOrNoise('WhenAll')).toBe(true);
      expect(isBuiltInOrNoise('ConfigureAwait')).toBe(true);
    });

    it('filters Object base methods', () => {
      expect(isBuiltInOrNoise('ToString')).toBe(true);
      expect(isBuiltInOrNoise('GetType')).toBe(true);
      expect(isBuiltInOrNoise('Equals')).toBe(true);
      expect(isBuiltInOrNoise('GetHashCode')).toBe(true);
    });
  });

  describe('user-defined functions', () => {
    it('does not filter custom function names', () => {
      expect(isBuiltInOrNoise('myCustomFunction')).toBe(false);
      expect(isBuiltInOrNoise('processData')).toBe(false);
      expect(isBuiltInOrNoise('handleUserRequest')).toBe(false);
    });
  });
});

describe('extractFunctionName', () => {
  const parser = new Parser();

  describe('C', () => {
    it('extracts function name from C function definition', () => {
      parser.setLanguage(C);
      const code = `int main() { return 0; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode);

      expect(result.funcName).toBe('main');
      expect(result.label).toBe('Function');
    });

    it('extracts function name with parameters', () => {
      parser.setLanguage(C);
      const code = `void helper(int a, char* b) {}`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode);

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

      const result = extractFunctionName(funcNode);

      expect(result.funcName).toBe('OnEncryptData');
      expect(result.label).toBe('Method');
    });

    it('extracts method name with namespace', () => {
      parser.setLanguage(CPP);
      const code = `void HuksListener::OnDataOprEvent(int type, DataInfo& info) {}`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode);

      expect(result.funcName).toBe('OnDataOprEvent');
      expect(result.label).toBe('Method');
    });

    it('extracts C function (not method)', () => {
      parser.setLanguage(CPP);
      const code = `void standalone_function() {}`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode);

      expect(result.funcName).toBe('standalone_function');
      expect(result.label).toBe('Function');
    });

    it('extracts method with parenthesized declarator', () => {
      parser.setLanguage(CPP);
      const code = `void (MyClass::handler)() {}`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode);

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

      const result = extractFunctionName(funcNode);

      expect(result.funcName).toBe('get_data');
      expect(result.label).toBe('Function');
    });

    it('extracts name from function returning double pointer', () => {
      parser.setLanguage(C);
      const code = `char** get_strings() { return 0; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode);

      expect(result.funcName).toBe('get_strings');
      expect(result.label).toBe('Function');
    });

    it('extracts name from struct pointer return', () => {
      parser.setLanguage(C);
      const code = `struct Node* create_node(int val) { return 0; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode);

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

      const result = extractFunctionName(funcNode);

      expect(result.funcName).toBe('getData');
      expect(result.label).toBe('Method');
    });

    it('extracts name from function returning reference', () => {
      parser.setLanguage(CPP);
      const code = `std::string& get_name() { static std::string s; return s; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode);

      expect(result.funcName).toBe('get_name');
      expect(result.label).toBe('Function');
    });

    it('extracts name from method returning reference', () => {
      parser.setLanguage(CPP);
      const code = `int& Container::at(int i) { return data[i]; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode);

      expect(result.funcName).toBe('at');
      expect(result.label).toBe('Method');
    });

    it('extracts name from method returning const reference', () => {
      parser.setLanguage(CPP);
      const code = `const std::string& Config::getName() const { return name_; }`;
      const tree = parser.parse(code);
      const funcNode = tree.rootNode.child(0);

      const result = extractFunctionName(funcNode);

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

      const result = extractFunctionName(funcNode);

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

      const result = extractFunctionName(arrowFunc);

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

      const result = extractFunctionName(funcExpr);

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
