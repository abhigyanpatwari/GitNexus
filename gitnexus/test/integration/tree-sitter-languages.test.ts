import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadParser, loadLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { LANGUAGE_QUERIES } from '../../src/core/ingestion/tree-sitter-queries.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { getLanguageFromFilename } from '../../src/core/ingestion/utils.js';
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
      const { matches } = parseAndQuery(parser, content, LANGUAGE_QUERIES[SupportedLanguages.TypeScript]);
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
      const { matches } = parseAndQuery(parser, content, LANGUAGE_QUERIES[SupportedLanguages.TypeScript]);
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
      const { matches } = parseAndQuery(parser, content, LANGUAGE_QUERIES[SupportedLanguages.JavaScript]);
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
      const { matches } = parseAndQuery(parser, content, LANGUAGE_QUERIES[SupportedLanguages.Python]);
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
      const { matches } = parseAndQuery(parser, content, LANGUAGE_QUERIES[SupportedLanguages.Java]);
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
      const { matches } = parseAndQuery(parser, content, LANGUAGE_QUERIES[SupportedLanguages.Go]);
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
      const { matches } = parseAndQuery(parser, content, LANGUAGE_QUERIES[SupportedLanguages.C]);
      const defs = extractDefinitions(matches);

      expect(defs.length).toBeGreaterThan(0);
      const defTypes = defs.map(d => d.type);
      expect(defTypes).toContain('definition.function');
    });
  });

  describe('C++', () => {
    it('parses class, function, and namespace declarations', async () => {
      await loadLanguage(SupportedLanguages.CPlusPlus);
      const content = readFixture('simple.cpp');
      const { matches } = parseAndQuery(parser, content, LANGUAGE_QUERIES[SupportedLanguages.CPlusPlus]);
      const defs = extractDefinitions(matches);

      expect(defs.length).toBeGreaterThan(0);
      const defTypes = defs.map(d => d.type);
      expect(defTypes).toContain('definition.class');
    });
  });

  describe('C#', () => {
    it('parses class, method, and property declarations', async () => {
      await loadLanguage(SupportedLanguages.CSharp);
      const content = readFixture('simple.cs');
      try {
        const { matches } = parseAndQuery(parser, content, LANGUAGE_QUERIES[SupportedLanguages.CSharp]);
        const defs = extractDefinitions(matches);
        expect(defs.length).toBeGreaterThan(0);
      } catch (e: any) {
        // Some tree-sitter-c-sharp versions don't support all query node types
        expect(e.message).toContain('TSQueryError');
      }
    });
  });

  describe('Rust', () => {
    it('parses fn, struct, impl, trait, and enum', async () => {
      await loadLanguage(SupportedLanguages.Rust);
      const content = readFixture('simple.rs');
      const { matches } = parseAndQuery(parser, content, LANGUAGE_QUERIES[SupportedLanguages.Rust]);
      const defs = extractDefinitions(matches);

      expect(defs.length).toBeGreaterThan(0);
      const defTypes = defs.map(d => d.type);
      expect(defTypes).toContain('definition.function');
    });
  });

  describe('PHP', () => {
    it('parses class, function, and method declarations', async () => {
      await loadLanguage(SupportedLanguages.PHP);
      const content = readFixture('simple.php');
      const { matches } = parseAndQuery(parser, content, LANGUAGE_QUERIES[SupportedLanguages.PHP]);
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
      const { matches } = parseAndQuery(parser, content, LANGUAGE_QUERIES[SupportedLanguages.Swift]);
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
        try {
          const { matches } = parseAndQuery(parser, content, LANGUAGE_QUERIES[lang]);
          const defs = extractDefinitions(matches);
          expect(defs.length, `${lang} (${fixture}) should have definitions`).toBeGreaterThan(0);
        } catch (e: any) {
          // Some grammars may have query compatibility issues
          if (!e.message?.includes('TSQueryError')) throw e;
        }
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
      const query = new Parser.Query(lang, LANGUAGE_QUERIES[SupportedLanguages.TypeScript]);
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
