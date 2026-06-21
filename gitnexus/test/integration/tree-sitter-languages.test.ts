import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadParser, loadLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages, getLanguageFromFilename } from 'gitnexus-shared';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
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
      if (
        capture.name === 'name' &&
        match.captures.some((c: any) => c.name.startsWith('definition.'))
      ) {
        const defType = match.captures.find((c: any) => c.name.startsWith('definition.'))!.name;
        defs.push({ type: defType, name: capture.node.text });
      }
    }
  }
  return defs;
}

function extractCapturedCallNames(matches: any[]) {
  const names: string[] = [];
  for (const match of matches) {
    if (!match.captures.some((c: any) => c.name === 'call')) continue;
    const nameCapture = match.captures.find((c: any) => c.name === 'call.name');
    if (nameCapture) names.push(nameCapture.node.text);
  }
  return names;
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

      const defTypes = defs.map((d) => d.type);
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
      const names = defs.map((d) => d.name);
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
      const names = defs.map((d) => d.name);
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

      const defTypes = defs.map((d) => d.type);
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
      const defTypes = defs.map((d) => d.type);
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
      const defTypes = defs.map((d) => d.type);
      expect(defTypes).toContain('definition.function');
    });

    it('captures every name in multi-name const, var, and field declarations', async () => {
      await loadLanguage(SupportedLanguages.Go);
      const provider = getProvider(SupportedLanguages.Go);
      const code = `
        package main
        const X, Y,Z,A,B = 1, 2,3,4,5
        var a, b int
        var (
          c, d string
        )
        const (
          C, D = 3, 4
        )
        type Point struct { X, y int }
      `;
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);

      const constNames = defs
        .filter((def) => def.type === 'definition.const')
        .map((def) => def.name);
      expect(constNames.sort()).toEqual(['A', 'B', 'C', 'D', 'X', 'Y', 'Z']);

      const variableNames = defs
        .filter((def) => def.type === 'definition.variable')
        .map((def) => def.name);
      expect(variableNames.sort()).toEqual(['a', 'b', 'c', 'd']);

      const propertyNames = defs
        .filter((def) => def.type === 'definition.property')
        .map((def) => def.name);
      expect(propertyNames.sort()).toEqual(['X', 'y']);
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
      const defTypes = defs.map((d) => d.type);
      expect(defTypes).toContain('definition.function');
      const names = defs.map((d) => d.name);
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
      const names = defs.map((d) => d.name);
      expect(names).toContain('get_ptr');
      expect(names).toContain('get_strs');
    });

    it('captures macros and typedefs', async () => {
      await loadLanguage(SupportedLanguages.C);
      const code = `#define MAX_SIZE 100\ntypedef unsigned int uint;\nstruct Point { int x; int y; };`;
      const provider = getProvider(SupportedLanguages.C);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map((d) => d.name);
      expect(names).toContain('MAX_SIZE');
      expect(names).toContain('uint');
      expect(names).toContain('Point');
    });

    it('captures C typedef anonymous structs, enums, and enumerators', async () => {
      await loadLanguage(SupportedLanguages.C);
      const code = `
        typedef struct { int x; int y; } Point;
        typedef enum { RED, GREEN, BLUE } Color;
      `;
      const provider = getProvider(SupportedLanguages.C);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map((d) => d.name);
      expect(defs.some((d) => d.type === 'definition.struct' && d.name === 'Point')).toBe(true);
      expect(defs.some((d) => d.type === 'definition.enum' && d.name === 'Color')).toBe(true);
      expect(names).toEqual(expect.arrayContaining(['RED', 'GREEN', 'BLUE']));
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
      const defTypes = defs.map((d) => d.type);
      expect(defTypes).toContain('definition.class');
      const names = defs.map((d) => d.name);
      expect(names).toContain('UserManager');
      expect(names).toContain('helperFunction');
    });

    it('captures pointer-returning methods and functions', async () => {
      await loadLanguage(SupportedLanguages.CPlusPlus);
      const code = `int* Factory::create() { return nullptr; }\nchar** getNames() { return 0; }`;
      const provider = getProvider(SupportedLanguages.CPlusPlus);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map((d) => d.name);
      expect(names).toContain('create');
      expect(names).toContain('getNames');
    });

    it('captures reference-returning functions', async () => {
      await loadLanguage(SupportedLanguages.CPlusPlus);
      const code = `int& Container::at(int i) { static int x; return x; }`;
      const provider = getProvider(SupportedLanguages.CPlusPlus);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map((d) => d.name);
      expect(names).toContain('at');
    });

    it('captures destructor definitions', async () => {
      await loadLanguage(SupportedLanguages.CPlusPlus);
      const code = `MyClass::~MyClass() { cleanup(); }`;
      const provider = getProvider(SupportedLanguages.CPlusPlus);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map((d) => d.name);
      expect(names).toContain('~MyClass');
    });

    it('captures template declarations', async () => {
      await loadLanguage(SupportedLanguages.CPlusPlus);
      const code = `template<typename T> class Container { T value; };`;
      const provider = getProvider(SupportedLanguages.CPlusPlus);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map((d) => d.name);
      expect(names).toContain('Container');
    });

    it('captures namespace definitions', async () => {
      await loadLanguage(SupportedLanguages.CPlusPlus);
      const code = `namespace utils { void helper() {} }`;
      const provider = getProvider(SupportedLanguages.CPlusPlus);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map((d) => d.name);
      expect(names).toContain('utils');
      expect(names).toContain('helper');
    });

    it('treats CUDA .cu and .cuh files as C++ for definition extraction', async () => {
      expect(getLanguageFromFilename('src/kernels/force.cu')).toBe(SupportedLanguages.CPlusPlus);
      expect(getLanguageFromFilename('src/force/nep.cuh')).toBe(SupportedLanguages.CPlusPlus);

      await loadLanguage(SupportedLanguages.CPlusPlus, 'src/kernels/force.cu');
      const code = `class Force { public: void apply(); };\nvoid launchKernel() {}`;
      const provider = getProvider(SupportedLanguages.CPlusPlus);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map((d) => d.name);

      expect(defs.some((d) => d.type === 'definition.class' && d.name === 'Force')).toBe(true);
      expect(names).toContain('launchKernel');
    });

    it('characterizes CUDA syntax when routed through the C++ parser', async () => {
      await loadLanguage(SupportedLanguages.CPlusPlus, 'src/kernels/force.cu');
      const code = `
        __global__ void axpy(float *x) { x[0] = 1.0f; }
        void host() {
          axpy<<<1, 32>>>(nullptr);
          cudaDeviceSynchronize();
        }
      `;
      const provider = getProvider(SupportedLanguages.CPlusPlus);
      const { tree, matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const callNames = extractCapturedCallNames(matches);
      const ordinaryCalls = extractCapturedCallNames(
        parseAndQuery(
          parser,
          'void host() { cudaDeviceSynchronize(); }',
          provider.treeSitterQueries,
        ).matches,
      );

      expect(tree.rootNode.hasError).toBe(true);
      expect(defs.some((d) => d.name === 'axpy')).toBe(true);
      expect(ordinaryCalls).toContain('cudaDeviceSynchronize');
      expect(callNames).not.toContain('axpy');
    });

    it('captures C++ typedef anonymous structs, enums, and enumerators', async () => {
      await loadLanguage(SupportedLanguages.CPlusPlus);
      const code = `
        typedef struct { int x; int y; } Point;
        typedef enum { Red, Green, Blue } Color;
      `;
      const provider = getProvider(SupportedLanguages.CPlusPlus);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map((d) => d.name);
      expect(defs.some((d) => d.type === 'definition.struct' && d.name === 'Point')).toBe(true);
      expect(defs.some((d) => d.type === 'definition.enum' && d.name === 'Color')).toBe(true);
      expect(names).toEqual(expect.arrayContaining(['Red', 'Green', 'Blue']));
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
      const defTypes = defs.map((d) => d.type);
      expect(defTypes).toContain('definition.class');
      expect(defTypes).toContain('definition.method');
      expect(defTypes).toContain('definition.namespace');
      const names = defs.map((d) => d.name);
      expect(names).toContain('Calculator');
      expect(names).toContain('Add');
    });

    it('captures interfaces, enums, records, structs', async () => {
      await loadLanguage(SupportedLanguages.CSharp);
      const content = readFixture('simple.cs');
      const provider = getProvider(SupportedLanguages.CSharp);
      const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map((d) => d.name);
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
      const names = defs.map((d) => d.name);
      expect(names).toContain('MyApp');
      expect(names).toContain('Program');
    });

    it('captures constructors and properties', async () => {
      await loadLanguage(SupportedLanguages.CSharp);
      const content = readFixture('simple.cs');
      const provider = getProvider(SupportedLanguages.CSharp);
      const { matches } = parseAndQuery(parser, content, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const defTypes = defs.map((d) => d.type);
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
      const defTypes = defs.map((d) => d.type);
      expect(defTypes).toContain('definition.function');
      const names = defs.map((d) => d.name);
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
      const defTypes = defs.map((d) => d.type);
      expect(defTypes).toContain('definition.impl');
      const names = defs.map((d) => d.name);
      expect(names).toContain('new');
    });

    it('captures generic impl blocks', async () => {
      await loadLanguage(SupportedLanguages.Rust);
      const code = `struct Vec<T> { data: Vec<T> }\nimpl<T> Vec<T> { fn len(&self) -> usize { 0 } }`;
      const provider = getProvider(SupportedLanguages.Rust);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map((d) => d.name);
      expect(names).toContain('Vec');
    });

    it('captures modules, consts, and statics', async () => {
      await loadLanguage(SupportedLanguages.Rust);
      const code = `mod utils { pub fn helper() {} }\npub const MAX: usize = 100;\nstatic INSTANCE: i32 = 0;`;
      const provider = getProvider(SupportedLanguages.Rust);
      const { matches } = parseAndQuery(parser, code, provider.treeSitterQueries);
      const defs = extractDefinitions(matches);
      const names = defs.map((d) => d.name);
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
      const defTypes = defs.map((d) => d.type);
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

  describe('Dart', () => {
    const dartQueries = () => getProvider(SupportedLanguages.Dart).treeSitterQueries;

    function loadDartOrSkip() {
      return loadLanguage(SupportedLanguages.Dart).catch(() => null);
    }

    // ── Definition extraction ──────────────────────────────────────────

    it('parses classes, functions, mixins, enums, and type aliases', async () => {
      if (!(await loadDartOrSkip())) return;
      const { matches } = parseAndQuery(parser, readFixture('simple.dart'), dartQueries());
      const defs = extractDefinitions(matches);
      const defTypes = defs.map((d) => d.type);
      const defNames = defs.map((d) => d.name);

      expect(defTypes).toContain('definition.class');
      expect(defTypes).toContain('definition.function');
      expect(defTypes).toContain('definition.method');
      expect(defTypes).toContain('definition.enum');
      expect(defTypes).toContain('definition.trait'); // mixin
      expect(defTypes).toContain('definition.type'); // typedef
      expect(defTypes).toContain('definition.constructor');
      expect(defTypes).toContain('definition.property'); // getter/setter

      expect(defNames).toContain('Animal');
      expect(defNames).toContain('Dog');
      expect(defNames).toContain('greet');
      expect(defNames).toContain('Swimming');
      expect(defNames).toContain('Status');
      expect(defNames).toContain('main');
      expect(defNames).toContain('StringExtension');
    });

    it('captures factory constructor variant name (not class name)', async () => {
      if (!(await loadDartOrSkip())) return;
      const { matches } = parseAndQuery(parser, readFixture('simple.dart'), dartQueries());
      const defs = extractDefinitions(matches);
      const constructors = defs.filter((d) => d.type === 'definition.constructor');
      expect(constructors.length).toBeGreaterThan(0);
      // factory Dog.unknown() should capture 'unknown', not 'Dog'
      const constructorNames = constructors.map((c) => c.name);
      expect(constructorNames).toContain('unknown');
      expect(constructorNames).not.toContain('Dog');
    });

    it('captures getter and setter as definition.property', async () => {
      if (!(await loadDartOrSkip())) return;
      const { matches } = parseAndQuery(parser, readFixture('simple.dart'), dartQueries());
      const defs = extractDefinitions(matches);
      const props = defs.filter((d) => d.type === 'definition.property');
      expect(props.map((p) => p.name)).toContain('info'); // getter
      expect(props.map((p) => p.name)).toContain('nickname'); // setter
    });

    it('captures typedef names without duplicates', async () => {
      if (!(await loadDartOrSkip())) return;
      const { matches } = parseAndQuery(parser, readFixture('simple.dart'), dartQueries());
      const defs = extractDefinitions(matches);
      const typedefs = defs.filter((d) => d.type === 'definition.type');
      const typedefNames = typedefs.map((d) => d.name);
      expect(typedefNames).toContain('JsonMap');
      expect(typedefNames).toContain('Callback');
      // Should not capture RHS types as names
      expect(typedefNames).not.toContain('Map');
      expect(typedefNames).not.toContain('Function');
    });

    // ── Export detection (private underscore convention) ────────────────

    it('filters private symbols via underscore convention', async () => {
      if (!(await loadDartOrSkip())) return;
      const { matches } = parseAndQuery(parser, readFixture('simple.dart'), dartQueries());
      const defs = extractDefinitions(matches);
      const { dartExportChecker } = await import('../../src/core/ingestion/export-detection.js');
      const publicNames = defs
        .filter((d) => dartExportChecker(null as any, d.name))
        .map((d) => d.name);
      const privateNames = defs
        .filter((d) => !dartExportChecker(null as any, d.name))
        .map((d) => d.name);

      expect(publicNames).toContain('Animal');
      expect(publicNames).toContain('greet');
      expect(privateNames).toContain('_privateHelper');
    });

    // ── Import extraction ──────────────────────────────────────────────

    it('extracts imports', async () => {
      if (!(await loadDartOrSkip())) return;
      const { matches } = parseAndQuery(parser, readFixture('simple.dart'), dartQueries());

      const imports: string[] = [];
      for (const match of matches) {
        for (const capture of match.captures) {
          if (capture.name === 'import.source') imports.push(capture.node.text);
        }
      }
      expect(imports.length).toBe(3);
    });

    it('extracts re-exports', async () => {
      if (!(await loadDartOrSkip())) return;
      const { matches } = parseAndQuery(parser, readFixture('dart-advanced.dart'), dartQueries());

      const imports: string[] = [];
      for (const match of matches) {
        for (const capture of match.captures) {
          if (capture.name === 'import.source') imports.push(capture.node.text);
        }
      }
      // 2 imports + 1 re-export = 3 import.source captures
      expect(imports.length).toBe(3);
    });

    // ── Call extraction ────────────────────────────────────────────────

    it('extracts calls in expression statements', async () => {
      if (!(await loadDartOrSkip())) return;
      const { matches } = parseAndQuery(parser, readFixture('dart-advanced.dart'), dartQueries());

      const callNames: string[] = [];
      for (const match of matches) {
        for (const capture of match.captures) {
          if (capture.name === 'call.name') callNames.push(capture.node.text);
        }
      }
      expect(callNames).toContain('fetchUsers');
      expect(callNames).toContain('processData');
    });

    it('extracts calls in return statements', async () => {
      if (!(await loadDartOrSkip())) return;
      const { matches } = parseAndQuery(parser, readFixture('dart-advanced.dart'), dartQueries());

      const callNames: string[] = [];
      for (const match of matches) {
        for (const capture of match.captures) {
          if (capture.name === 'call.name') callNames.push(capture.node.text);
        }
      }
      expect(callNames).toContain('formatOutput');
    });

    it('extracts calls in variable assignments', async () => {
      if (!(await loadDartOrSkip())) return;
      const { matches } = parseAndQuery(parser, readFixture('dart-advanced.dart'), dartQueries());

      const callNames: string[] = [];
      for (const match of matches) {
        for (const capture of match.captures) {
          if (capture.name === 'call.name') callNames.push(capture.node.text);
        }
      }
      expect(callNames).toContain('computeScore');
      expect(callNames).toContain('loadUser');
    });

    // ── Framework detection (path-based) ───────────────────────────────

    it('detects Flutter framework from file paths', async () => {
      const { detectFrameworkFromPath } =
        await import('../../src/core/ingestion/framework-detection.js');

      expect(detectFrameworkFromPath('lib/main.dart')?.framework).toBe('flutter');
      expect(detectFrameworkFromPath('lib/app.dart')?.framework).toBe('flutter');
      expect(detectFrameworkFromPath('lib/screens/home.dart')?.framework).toBe('flutter');
      expect(detectFrameworkFromPath('lib/pages/login.dart')?.framework).toBe('flutter');
      expect(detectFrameworkFromPath('lib/widgets/button.dart')?.framework).toBe('flutter');
      expect(detectFrameworkFromPath('lib/bloc/user_bloc.dart')?.framework).toBe('flutter');
      expect(detectFrameworkFromPath('lib/services/api.dart')?.framework).toBe('flutter');
      expect(detectFrameworkFromPath('lib/routes/app_router.dart')?.framework).toBe('flutter');

      // main.dart gets highest boost
      expect(detectFrameworkFromPath('lib/main.dart')?.entryPointMultiplier).toBe(3.0);
      // widgets get lowest
      expect(detectFrameworkFromPath('lib/widgets/button.dart')?.entryPointMultiplier).toBe(1.5);
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
        // Dart and Swift are excluded — they are optionalDependencies that may not be installed
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
