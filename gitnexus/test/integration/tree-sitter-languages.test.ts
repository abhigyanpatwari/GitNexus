import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadParser, loadLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import { getLanguageFromFilename } from '../../src/core/ingestion/utils/language-detection.js';
import Parser from 'tree-sitter';

const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'sample-code');

function readFixture(filename: string): string {
  return fs.readFileSync(path.join(fixturesDir, filename), 'utf-8');
}

function parseAndQuery(parser: Parser, content: string, queryStr: string) {
  const tree = parser.parse(content);
  const lang = parser.getLanguage();
  const query = new Parser.Query(lang, queryStr);
  const matches = query.matches(tree.rootNode);
  return { tree, matches };
}

function extractDefinitions(matches: any[]) {
  const defs: { type: string; name: string }[] = [];
  for (const match of matches) {
    for (const capture of match.captures) {
      if (capture.name === 'name' && match.captures.some((c: any) =>
        c.name.startsWith('definition.'))) {
        const defType = match.captures.find((c: any) => c.name.startsWith('definition.'))!.name;
        defs.push({ type: defType, name: capture.node.text });
      }
    }
  }
  return defs;
}

describe('Tree-sitter multi-language parsing', () => {
  let parser: Parser;

  beforeAll(async () => {
    parser = await loadParser();
  });

  describe('TypeScript', () => {
    it('parses functions, classes, interfaces, methods, and arrow functions', async () => {
      await loadLanguage(SupportedLanguages.TypeScript, 'simple.ts');
      const content = readFixture('simple.ts');
      const provider = getProvider(SupportedLanguages.TypeScript);
      const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);

      const defTypes = defs.map(d => d.type);
      expect(defTypes).toContain('definition.class');
      expect(defTypes).toContain('definition.function');
    });
  });

  describe('TSX', () => {
    it('parses JSX components with tsx grammar', async () => {
      await loadLanguage(SupportedLanguages.TypeScript, 'simple.tsx');
      const content = readFixture('simple.tsx');
      const provider = getProvider(SupportedLanguages.TypeScript);
      const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);

      expect(defs.length).toBeGreaterThan(0);
      // Should detect Counter class and Button/useCounter functions
      const names = defs.map(d => d.name);
      expect(names).toContain('Counter');
    });
  });

  describe('JavaScript', () => {
    it('parses class and function declarations', async () => {
      await loadLanguage(SupportedLanguages.JavaScript);
      const content = readFixture('simple.js');
      const provider = getProvider(SupportedLanguages.JavaScript);
      const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);

      expect(defs.length).toBeGreaterThan(0);
      const names = defs.map(d => d.name);
      expect(names).toContain('EventEmitter');
      expect(names).toContain('createLogger');
    });
  });

  describe('Python', () => {
    it('parses class and function definitions', async () => {
      await loadLanguage(SupportedLanguages.Python);
      const content = readFixture('simple.py');
      const provider = getProvider(SupportedLanguages.Python);
      const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);

      const defTypes = defs.map(d => d.type);
      expect(defTypes).toContain('definition.class');
      expect(defTypes).toContain('definition.function');
    });
  });

  describe('Java', () => {
    it('parses class, method, and constructor declarations', async () => {
      await loadLanguage(SupportedLanguages.Java);
      const content = readFixture('simple.java');
      const provider = getProvider(SupportedLanguages.Java);
      const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);

      expect(defs.length).toBeGreaterThan(0);
      const defTypes = defs.map(d => d.type);
      expect(defTypes).toContain('definition.class');
      expect(defTypes).toContain('definition.method');
    });
  });

  describe('Go', () => {
    it('parses function and type declarations', async () => {
      await loadLanguage(SupportedLanguages.Go);
      const content = readFixture('simple.go');
      const provider = getProvider(SupportedLanguages.Go);
      const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);

      expect(defs.length).toBeGreaterThan(0);
      const defTypes = defs.map(d => d.type);
      expect(defTypes).toContain('definition.function');
    });
  });

  describe('C', () => {
    it('parses function definitions and structs', async () => {
      await loadLanguage(SupportedLanguages.C);
      const content = readFixture('simple.c');
      const provider = getProvider(SupportedLanguages.C);
      const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);

      expect(defs.length).toBeGreaterThan(0);
      const defTypes = defs.map(d => d.type);
      expect(defTypes).toContain('definition.function');
      const names = defs.map(d => d.name);
      expect(names).toContain('add');
      expect(names).toContain('internal_helper');
      expect(names).toContain('print_message');
    });

    it('captures pointer-returning function definitions', async () => {
      await loadLanguage(SupportedLanguages.C);
      const code = `int* get_ptr() { return 0; }\nchar** get_strs() { return 0; }`;
      const provider = getProvider(SupportedLanguages.C);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map(d => d.name);
      expect(names).toContain('get_ptr');
      expect(names).toContain('get_strs');
    });

    it('captures macros and typedefs', async () => {
      await loadLanguage(SupportedLanguages.C);
      const code = `#define MAX_SIZE 100\ntypedef unsigned int uint;\nstruct Point { int x; int y; };`;
      const provider = getProvider(SupportedLanguages.C);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map(d => d.name);
      expect(names).toContain('MAX_SIZE');
      expect(names).toContain('uint');
      expect(names).toContain('Point');
    });
  });

  describe('C++', () => {
    it('parses class, function, and namespace declarations', async () => {
      await loadLanguage(SupportedLanguages.CPlusPlus);
      const content = readFixture('simple.cpp');
      const provider = getProvider(SupportedLanguages.CPlusPlus);
      const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);

      expect(defs.length).toBeGreaterThan(0);
      const defTypes = defs.map(d => d.type);
      expect(defTypes).toContain('definition.class');
      const names = defs.map(d => d.name);
      expect(names).toContain('UserManager');
      expect(names).toContain('helperFunction');
    });

    it('captures pointer-returning methods and functions', async () => {
      await loadLanguage(SupportedLanguages.CPlusPlus);
      const code = `int* Factory::create() { return nullptr; }\nchar** getNames() { return 0; }`;
      const provider = getProvider(SupportedLanguages.CPlusPlus);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map(d => d.name);
      expect(names).toContain('create');
      expect(names).toContain('getNames');
    });

    it('captures reference-returning functions', async () => {
      await loadLanguage(SupportedLanguages.CPlusPlus);
      const code = `int& Container::at(int i) { static int x; return x; }`;
      const provider = getProvider(SupportedLanguages.CPlusPlus);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map(d => d.name);
      expect(names).toContain('at');
    });

    it('captures destructor definitions', async () => {
      await loadLanguage(SupportedLanguages.CPlusPlus);
      const code = `MyClass::~MyClass() { cleanup(); }`;
      const provider = getProvider(SupportedLanguages.CPlusPlus);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map(d => d.name);
      expect(names).toContain('~MyClass');
    });

    it('captures template declarations', async () => {
      await loadLanguage(SupportedLanguages.CPlusPlus);
      const code = `template<typename T> class Container { T value; };`;
      const provider = getProvider(SupportedLanguages.CPlusPlus);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map(d => d.name);
      expect(names).toContain('Container');
    });

    it('captures namespace definitions', async () => {
      await loadLanguage(SupportedLanguages.CPlusPlus);
      const code = `namespace utils { void helper() {} }`;
      const provider = getProvider(SupportedLanguages.CPlusPlus);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map(d => d.name);
      expect(names).toContain('utils');
      expect(names).toContain('helper');
    });
  });

  describe('C#', () => {
    it('parses class, method, and namespace declarations', async () => {
      await loadLanguage(SupportedLanguages.CSharp);
      const content = readFixture('simple.cs');
      const provider = getProvider(SupportedLanguages.CSharp);
      const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);

      expect(defs.length).toBeGreaterThan(0);
      const defTypes = defs.map(d => d.type);
      expect(defTypes).toContain('definition.class');
      expect(defTypes).toContain('definition.method');
      expect(defTypes).toContain('definition.namespace');
      const names = defs.map(d => d.name);
      expect(names).toContain('Calculator');
      expect(names).toContain('Add');
    });

    it('captures interfaces, enums, records, structs', async () => {
      await loadLanguage(SupportedLanguages.CSharp);
      const content = readFixture('simple.cs');
      const provider = getProvider(SupportedLanguages.CSharp);
      const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map(d => d.name);
      expect(names).toContain('ICalculator');
      expect(names).toContain('Operation');
      expect(names).toContain('CalculationResult');
      expect(names).toContain('Point');
    });

    it('captures file-scoped namespace declarations', async () => {
      await loadLanguage(SupportedLanguages.CSharp);
      const code = `namespace MyApp;\npublic class Program { }`;
      const provider = getProvider(SupportedLanguages.CSharp);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map(d => d.name);
      expect(names).toContain('MyApp');
      expect(names).toContain('Program');
    });

    it('captures constructors and properties', async () => {
      await loadLanguage(SupportedLanguages.CSharp);
      const content = readFixture('simple.cs');
      const provider = getProvider(SupportedLanguages.CSharp);
      const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const defTypes = defs.map(d => d.type);
      expect(defTypes).toContain('definition.constructor');
      expect(defTypes).toContain('definition.property');
    });
  });

  describe('Rust', () => {
    it('parses fn, struct, impl, trait, and enum', async () => {
      await loadLanguage(SupportedLanguages.Rust);
      const content = readFixture('simple.rs');
      const provider = getProvider(SupportedLanguages.Rust);
      const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);

      expect(defs.length).toBeGreaterThan(0);
      const defTypes = defs.map(d => d.type);
      expect(defTypes).toContain('definition.function');
      const names = defs.map(d => d.name);
      expect(names).toContain('public_function');
      expect(names).toContain('private_function');
      expect(names).toContain('Config');
    });

    it('captures impl blocks and methods', async () => {
      await loadLanguage(SupportedLanguages.Rust);
      const content = readFixture('simple.rs');
      const provider = getProvider(SupportedLanguages.Rust);
      const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const defTypes = defs.map(d => d.type);
      expect(defTypes).toContain('definition.impl');
      const names = defs.map(d => d.name);
      expect(names).toContain('new');
    });

    it('captures generic impl blocks', async () => {
      await loadLanguage(SupportedLanguages.Rust);
      const code = `struct Vec<T> { data: Vec<T> }\nimpl<T> Vec<T> { fn len(&self) -> usize { 0 } }`;
      const provider = getProvider(SupportedLanguages.Rust);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map(d => d.name);
      expect(names).toContain('Vec');
    });

    it('captures trait impl heritage', async () => {
      await loadLanguage(SupportedLanguages.Rust);
      const code = `trait Display { fn fmt(&self); }\nstruct Foo;\nimpl Display for Foo { fn fmt(&self) {} }`;
      const provider = getProvider(SupportedLanguages.Rust);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      // Look for heritage captures
      const heritageCaptures: string[] = [];
      for (const match of matches) {
        for (const capture of match.captures) {
          if (capture.name.startsWith('heritage.')) {
            heritageCaptures.push(`${capture.name}:${capture.node.text}`);
          }
        }
      }
      expect(heritageCaptures).toContain('heritage.trait:Display');
      expect(heritageCaptures).toContain('heritage.class:Foo');
    });

    it('captures modules, consts, and statics', async () => {
      await loadLanguage(SupportedLanguages.Rust);
      const code = `mod utils { pub fn helper() {} }\npub const MAX: usize = 100;\nstatic INSTANCE: i32 = 0;`;
      const provider = getProvider(SupportedLanguages.Rust);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map(d => d.name);
      expect(names).toContain('utils');
      expect(names).toContain('MAX');
      expect(names).toContain('INSTANCE');
    });
  });

  describe('PHP', () => {
    it('parses class, function, and method declarations', async () => {
      await loadLanguage(SupportedLanguages.PHP);
      const content = readFixture('simple.php');
      const provider = getProvider(SupportedLanguages.PHP);
      const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);

      expect(defs.length).toBeGreaterThan(0);
      const defTypes = defs.map(d => d.type);
      expect(defTypes).toContain('definition.class');
    });
  });

  describe('Swift', () => {
    it('parses class, struct, protocol, and function if tree-sitter-swift is available', async () => {
      try {
        await loadLanguage(SupportedLanguages.Swift);
      } catch {
        // tree-sitter-swift not installed — skip
        return;
      }

      const content = readFixture('simple.swift');
      const provider = getProvider(SupportedLanguages.Swift);
      const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);

      expect(defs.length).toBeGreaterThan(0);
    });

    it('gracefully handles missing tree-sitter-swift', async () => {
      // If Swift is NOT available, loadLanguage should throw
      // If it IS available, this test just passes
      try {
        await loadLanguage(SupportedLanguages.Swift);
      } catch (e: any) {
        expect(e.message).toContain('Unsupported language');
      }
    });
  });

  describe('unhappy path', () => {
    it('returns null/undefined for unsupported file extensions', () => {
      expect(getLanguageFromFilename('archive.xyz')).toBeNull();
      expect(getLanguageFromFilename('data.unknown')).toBeNull();
    });

    it('handles empty string file path', () => {
      expect(getLanguageFromFilename('')).toBeNull();
    });

    it('returns null/undefined for binary file extensions', () => {
      expect(getLanguageFromFilename('program.exe')).toBeNull();
      expect(getLanguageFromFilename('library.dll')).toBeNull();
      expect(getLanguageFromFilename('object.so')).toBeNull();
    });
  });

  describe('cross-language assertions', () => {
    it('all supported languages produce at least one definition from fixtures', async () => {
      const langFixtures: [SupportedLanguages, string, string?][] = [
        [SupportedLanguages.TypeScript, 'simple.ts'],
        [SupportedLanguages.JavaScript, 'simple.js'],
        [SupportedLanguages.Python, 'simple.py'],
        [SupportedLanguages.Java, 'simple.java'],
        [SupportedLanguages.Go, 'simple.go'],
        [SupportedLanguages.C, 'simple.c'],
        [SupportedLanguages.CPlusPlus, 'simple.cpp'],
        [SupportedLanguages.CSharp, 'simple.cs'],
        [SupportedLanguages.Rust, 'simple.rs'],
        [SupportedLanguages.PHP, 'simple.php'],
      ];

      for (const [lang, fixture, filePath] of langFixtures) {
        await loadLanguage(lang, filePath || fixture);
        const content = readFixture(fixture);
        const provider = getProvider(lang);
        const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
        const defs = extractDefinitions(matches);
        expect(defs.length, `${lang} (${fixture}) should have definitions`).toBeGreaterThan(0);
      }
    });
  });

  describe('parser edge cases', () => {
    it('loadLanguage throws for unsupported language', async () => {
      await expect(loadLanguage('brainfuck' as any)).rejects.toThrow(/unsupported language/i);
    });

    it('parsing empty file content produces empty matches', async () => {
      await loadLanguage(SupportedLanguages.TypeScript, 'empty.ts');
      const tree = parser.parse('');
      expect(tree.rootNode).toBeDefined();

      const lang = parser.getLanguage();
      const tsProvider = getProvider(SupportedLanguages.TypeScript);
      const query = new Parser.Query(lang, tsProvider.treeSitterQueries);
      const matches = query.matches(tree.rootNode);
      expect(matches).toEqual([]);
    });

    it('parsing malformed code does not crash', async () => {
      await loadLanguage(SupportedLanguages.TypeScript, 'malformed.ts');
      const tree = parser.parse('function {{{ class >>><< if(( end');
      expect(tree.rootNode).toBeDefined();
      expect(tree.rootNode.hasError).toBe(true);
    });
  });
});
