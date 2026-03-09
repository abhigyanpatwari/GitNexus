import { describe, it, expect } from 'vitest';
import { getLanguageFromFilename, isBuiltInOrNoise, extractFunctionName } from '../../src/core/ingestion/utils.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import Parser from 'tree-sitter';
import C from 'tree-sitter-c';
import CPP from 'tree-sitter-cpp';

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

    it('detects .h header files', () => {
      expect(getLanguageFromFilename('header.h')).toBe(SupportedLanguages.C);
    });
  });

  describe('C++', () => {
    it.each(['.cpp', '.cc', '.cxx', '.hpp', '.hxx', '.hh'])(
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

  describe('Kotlin', () => {
    it.each(['.kt', '.kts'])(
      'detects %s files',
      (ext) => {
        expect(getLanguageFromFilename(`file${ext}`)).toBe(SupportedLanguages.Kotlin);
      }
    );
  });

  describe('unsupported', () => {
    it.each(['.rb', '.scala', '.r', '.lua', '.zig', '.txt', '.md', '.json', '.yaml'])(
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
  });
});
