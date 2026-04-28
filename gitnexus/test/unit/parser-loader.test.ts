import { describe, it, expect } from 'vitest';
import { loadParser, loadLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

describe('parser-loader', () => {
  describe('loadParser', () => {
    it('returns a Parser instance', async () => {
      const parser = await loadParser();
      expect(parser).toBeDefined();
      expect(typeof parser.parse).toBe('function');
    });

    it('returns the same singleton instance', async () => {
      const parser1 = await loadParser();
      const parser2 = await loadParser();
      expect(parser1).toBe(parser2);
    });
  });

  describe('loadLanguage', () => {
    it('loads TypeScript language', async () => {
      await expect(loadLanguage(SupportedLanguages.TypeScript)).resolves.not.toThrow();
    });

    it('loads JavaScript language', async () => {
      await expect(loadLanguage(SupportedLanguages.JavaScript)).resolves.not.toThrow();
    });

    it('loads Python language', async () => {
      await expect(loadLanguage(SupportedLanguages.Python)).resolves.not.toThrow();
    });

    it('loads Java language', async () => {
      await expect(loadLanguage(SupportedLanguages.Java)).resolves.not.toThrow();
    });

    it('loads C language', async () => {
      await expect(loadLanguage(SupportedLanguages.C)).resolves.not.toThrow();
    });

    it('loads C++ language', async () => {
      await expect(loadLanguage(SupportedLanguages.CPlusPlus)).resolves.not.toThrow();
    });

    it('loads C# language', async () => {
      await expect(loadLanguage(SupportedLanguages.CSharp)).resolves.not.toThrow();
    });

    it('loads Go language', async () => {
      await expect(loadLanguage(SupportedLanguages.Go)).resolves.not.toThrow();
    });

    it('loads Rust language', async () => {
      await expect(loadLanguage(SupportedLanguages.Rust)).resolves.not.toThrow();
    });

    it('loads PHP language', async () => {
      await expect(loadLanguage(SupportedLanguages.PHP)).resolves.not.toThrow();
    });

    it('loads TSX grammar for .tsx files', async () => {
      // TSX uses a different grammar (TypeScript.tsx vs TypeScript.typescript)
      await expect(
        loadLanguage(SupportedLanguages.TypeScript, 'Component.tsx'),
      ).resolves.not.toThrow();
    });

    it('loads TS grammar for .ts files', async () => {
      await expect(loadLanguage(SupportedLanguages.TypeScript, 'utils.ts')).resolves.not.toThrow();
    });

    it('loads Ruby language', async () => {
      await expect(loadLanguage(SupportedLanguages.Ruby)).resolves.not.toThrow();
    });

    it('throws for unsupported language', async () => {
      await expect(loadLanguage('erlang' as SupportedLanguages)).rejects.toThrow(
        'Unsupported language',
      );
    });
  });

  describe('Swift optional dependency', () => {
    it('loads Swift from the default optional dependency and parses source', async () => {
      const parser = await loadParser();
      await loadLanguage(SupportedLanguages.Swift);

      const tree = parser.parse('class Foo { func bar() {} }');

      expect(tree.rootNode.type).toBe('source_file');
      expect(tree.rootNode.namedChildCount).toBe(1);
    });
  });
});
