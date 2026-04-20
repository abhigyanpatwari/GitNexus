import { describe, it, expect } from 'vitest';
import {
  generateEmbeddingText,
  truncateDescription,
  extractDeclarationOnly,
} from '../../src/core/embeddings/text-generator.js';
import { isChunkableLabel } from '../../src/core/embeddings/types.js';
import type { EmbeddableNode } from '../../src/core/embeddings/types.js';

const baseNode: EmbeddableNode = {
  id: 'Function:src/utils.ts:parseJSON',
  name: 'parseJSON',
  label: 'Function',
  filePath: 'src/utils/parser.ts',
  content: 'function parseJSON(text: string): Result<any> {\n  return JSON.parse(text);\n}',
  startLine: 10,
  endLine: 12,
};

describe('text-generator', () => {
  describe('generateEmbeddingText', () => {
    it('includes metadata header for Function', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        isExported: true,
        repoName: 'backend-user-ms',
      };
      const text = generateEmbeddingText(node, node.content);
      expect(text).toContain('Function: parseJSON');
      expect(text).toContain('Repo: backend-user-ms');
      expect(text).toContain('Path: src/utils/parser.ts');
      expect(text).toContain('Export: true');
      expect(text).toContain('function parseJSON');
    });

    it('includes Server line when serverName is set', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        repoName: 'backend-user-ms',
        serverName: 'user-service',
      };
      const text = generateEmbeddingText(node, node.content);
      expect(text).toContain('Server: user-service');
    });

    it('omits Server line when serverName is undefined', () => {
      const text = generateEmbeddingText(baseNode, baseNode.content);
      expect(text).not.toContain('Server:');
    });

    it('includes truncated description', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        description: 'This function parses JSON text and returns a typed result object.',
      };
      const text = generateEmbeddingText(node, node.content);
      expect(text).toContain('This function parses JSON text');
    });

    it('generates short node text for TypeAlias without chunking', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        label: 'TypeAlias',
        name: 'Result',
        content: 'type Result<T> = Success<T> | Error;',
      };
      const text = generateEmbeddingText(node, node.content);
      expect(text).toContain('TypeAlias: Result');
      expect(text).toContain('type Result<T> = Success<T> | Error;');
    });

    it('generates Class text with AST-extracted method/field names', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        label: 'Class',
        name: 'Parser',
        methodNames: ['parseJSON', 'validate'],
        fieldNames: ['options', 'cache'],
        content: `class Parser {
  options: ParserOptions;
  private cache: Map<string, any>;
  parseJSON(text: string) { return JSON.parse(text); }
  validate() { return true; }
}`,
      };
      const text = generateEmbeddingText(node, node.content);
      expect(text).toContain('Class: Parser');
      expect(text).toContain('Methods: parseJSON, validate');
      expect(text).toContain('Properties: options, cache');
      // Method bodies should NOT appear in declaration section
      expect(text).not.toContain('return JSON.parse');
      expect(text).not.toContain('return true');
    });

    it('generates Class text without method names when not provided', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        label: 'Class',
        name: 'Parser',
        content: `class Parser {
  parse(input) { }
}`,
      };
      const text = generateEmbeddingText(node, node.content);
      expect(text).toContain('Class: Parser');
      expect(text).not.toContain('Methods:');
    });

    it('generates Interface text with structural names and signatures', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        label: 'Interface',
        name: 'Handler',
        methodNames: ['handle', 'validate'],
        fieldNames: ['name'],
        content: `interface Handler {
  handle(event: Event): void;
  validate(input: string): boolean;
  readonly name: string;
}`,
      };
      const text = generateEmbeddingText(node, node.content);
      expect(text).toContain('Interface: Handler');
      expect(text).toContain('Methods: handle, validate');
      expect(text).toContain('Properties: name');
      expect(text).toContain('handle(event: Event): void;');
      expect(text).toContain('readonly name: string;');
    });

    it('includes chunk body for structural node chunks', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        label: 'Class',
        name: 'Parser',
        methodNames: ['parseJSON', 'validate'],
        fieldNames: ['options', 'cache'],
        content: `class Parser {
  options: ParserOptions;
  cache: Map<string, any>;
  parseJSON(text: string) { return JSON.parse(text); }
  validate() { return true; }
}`,
      };
      const chunkBody = `parseJSON(text: string) { return JSON.parse(text); }`;
      const text = generateEmbeddingText(node, chunkBody);
      expect(text).toContain('Class: Parser');
      expect(text).toContain('Methods: parseJSON, validate');
      expect(text).toContain('class Parser {');
      expect(text).toContain('parseJSON(text: string) { return JSON.parse(text); }');
    });

    it('generates Struct text with structural metadata', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        label: 'Struct',
        name: 'User',
        fieldNames: ['name', 'age'],
        content: `struct User {
  name: String,
  age: u32,
}`,
      };
      const text = generateEmbeddingText(node, node.content);
      expect(text).toContain('Struct: User');
      expect(text).toContain('Properties: name, age');
      expect(text).toContain('Container: struct User {');
      expect(text).toContain('struct User {');
    });

    it('keeps compact container context on later structural chunks', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        label: 'Class',
        name: 'Parser',
        methodNames: ['parseJSON', 'validate'],
        fieldNames: ['options', 'cache'],
        content: `class Parser {
  options: ParserOptions;
  cache: Map<string, any>;
  parseJSON(text: string) { return JSON.parse(text); }
  validate() { return true; }
}`,
      };
      const text = generateEmbeddingText(
        node,
        'validate() { return true; }',
        {},
        1,
        'parseJSON(text: string) { return JSON.parse(text); }',
      );
      expect(text).toContain('Class: Parser');
      expect(text).toContain('Container: class Parser {');
      expect(text).toContain('[preceding context]: ...parseJSON(text: string)');
      expect(text).not.toContain('Methods: parseJSON, validate');
      expect(text).not.toContain('Properties: options, cache');
    });

    it('adds preceding context to non-structural chunk text', () => {
      const text = generateEmbeddingText(
        baseNode,
        'return JSON.parse(text);',
        {},
        1,
        'function parseJSON(text: string): Result<any> {',
      );
      expect(text).toContain('Function: parseJSON');
      expect(text).toContain('[preceding context]: ...function parseJSON');
      expect(text).toContain('return JSON.parse(text);');
    });
  });

  describe('Constructor label', () => {
    it('is recognized as chunkable', () => {
      expect(isChunkableLabel('Constructor')).toBe(true);
    });

    it('is recognized as embeddable', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        label: 'Constructor',
        name: 'constructor',
        content: 'constructor(private service: ApiClient) {\n  this.service = service;\n}',
      };
      const text = generateEmbeddingText(node, node.content);
      expect(text).toContain('Constructor: constructor');
      expect(text).toContain('this.service = service');
    });
  });

  describe('extractDeclarationOnly', () => {
    it('strips method bodies from TS class', () => {
      const content = `class Foo {
  prop1: string;
  method1() {
    if (x) { nested }
  }
  method2() { return 1; }
}`;
      const result = extractDeclarationOnly(content);
      expect(result).toContain('class Foo {');
      expect(result).toContain('prop1: string;');
      expect(result).not.toContain('if (x)');
      expect(result).not.toContain('return 1');
    });

    it('keeps single-line methods with semicolon (property initializers)', () => {
      const content = `class Foo {
  config = { timeout: 5000 };
  count = 0;
}`;
      const result = extractDeclarationOnly(content);
      expect(result).toContain('config = { timeout: 5000 };');
      expect(result).toContain('count = 0;');
    });

    it('returns empty for non-brace languages (Python)', () => {
      const content = `class User:
    def __init__(self, name):
        self.name = name`;
      const result = extractDeclarationOnly(content);
      expect(result).toBe('');
    });

    it('preserves all fields in Rust struct', () => {
      const content = `struct User {
    name: String,
    age: u32,
}`;
      const result = extractDeclarationOnly(content);
      expect(result).toContain('struct User {');
      expect(result).toContain('name: String,');
      expect(result).toContain('age: u32,');
    });

    it('preserves all lines in interface (no method bodies)', () => {
      const content = `interface Handler {
  handle(event: Event): void;
  validate(input: string): boolean;
}`;
      const result = extractDeclarationOnly(content);
      expect(result).toContain('interface Handler {');
      expect(result).toContain('handle(event: Event): void;');
      expect(result).toContain('validate(input: string): boolean;');
    });
  });

  describe('truncateDescription', () => {
    it('returns short text unchanged', () => {
      expect(truncateDescription('short text', 150)).toBe('short text');
    });

    it('truncates at sentence boundary', () => {
      const text = 'First sentence. Second sentence. Third very long sentence that goes on and on.';
      const result = truncateDescription(text, 40);
      expect(result).toContain('First sentence');
      expect(result.length).toBeLessThan(text.length);
    });

    it('truncates at word boundary when no sentence end', () => {
      const text =
        'this is a long description without any sentence ending punctuation marks at all';
      const result = truncateDescription(text, 30);
      expect(result.length).toBeLessThanOrEqual(30);
      expect(result.length).toBeLessThan(text.length);
    });
  });
});
