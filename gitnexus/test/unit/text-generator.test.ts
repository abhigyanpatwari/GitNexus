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
    it('leads with name and code, dropping verbose metadata lines (#2333)', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        isExported: true,
        repoName: 'backend-user-ms',
      };
      const text = generateEmbeddingText(node, node.content);
      // Compact embedding header: name + code remain.
      expect(text).toContain('Function: parseJSON');
      expect(text).toContain('function parseJSON');
      // Low-signal metadata lines are intentionally excluded from embedding text.
      expect(text).not.toContain('Repo: backend-user-ms');
      expect(text).not.toContain('Path: src/utils/parser.ts');
      expect(text).not.toContain('Export: true');
    });

    it('excludes the Server line from embedding text even when serverName is set (#2333)', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        repoName: 'backend-user-ms',
        serverName: 'user-service',
      };
      const text = generateEmbeddingText(node, node.content);
      expect(text).not.toContain('Server: user-service');
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

    // #2333: short doc comments must not be diluted by metadata. The description
    // is hoisted directly under the name, ahead of the code body, and the
    // low-signal metadata lines are dropped from embedding text entirely.
    it('hoists a short English description above the code body (#2333)', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        label: 'Method',
        name: 'updateMaterialExpiryDate',
        description: 'validate user',
        isExported: false,
        repoName: 'my-project',
        content:
          'function updateMaterialExpiryDate(paramMap) {\n  // ... a long method body ...\n  return doWork(paramMap);\n}',
      };
      const text = generateEmbeddingText(node, node.content);
      expect(text).toContain('validate user');
      // Description appears before the code body.
      expect(text.indexOf('validate user')).toBeLessThan(text.indexOf('return doWork'));
      // Metadata noise removed.
      expect(text).not.toContain('Repo: my-project');
      expect(text).not.toContain('Path:');
      expect(text).not.toContain('Export:');
    });

    it('hoists a short CJK description above the code body (#2333)', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        label: 'Method',
        name: 'updateMaterialExpiryDate',
        description: '更新物料有效期',
        isExported: false,
        repoName: 'my-project',
        content:
          'function updateMaterialExpiryDate(paramMap) {\n  // ... a long method body ...\n  return doWork(paramMap);\n}',
      };
      const text = generateEmbeddingText(node, node.content);
      expect(text).toContain('更新物料有效期');
      expect(text.indexOf('更新物料有效期')).toBeLessThan(text.indexOf('return doWork'));
      expect(text).not.toContain('Repo: my-project');
      expect(text).not.toContain('Path:');
      expect(text).not.toContain('Export:');
    });

    it('hoists description in short-label nodes too (#2333)', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        label: 'Const',
        name: 'MAX_RETRIES',
        description: 'retry ceiling',
        content: 'const MAX_RETRIES = 5;',
      };
      const text = generateEmbeddingText(node, node.content);
      expect(text).toContain('Const: MAX_RETRIES');
      expect(text).toContain('retry ceiling');
      expect(text.indexOf('retry ceiling')).toBeLessThan(text.indexOf('const MAX_RETRIES = 5;'));
      expect(text).not.toContain('Path:');
    });

    it('keeps structural Methods/Properties lines under the compact header (#2333)', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        label: 'Class',
        name: 'Parser',
        description: 'JSON parser',
        repoName: 'my-project',
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
      expect(text).toContain('JSON parser');
      // Structural signal must survive the compact-header change.
      expect(text).toContain('Methods: parseJSON, validate');
      expect(text).toContain('Properties: options, cache');
      // Description is hoisted ahead of the structural lines (ordering guard for
      // the structural path, mirroring the function/method ordering checks).
      expect(text.indexOf('JSON parser')).toBeLessThan(text.indexOf('Container:'));
      expect(text.indexOf('JSON parser')).toBeLessThan(text.indexOf('Methods:'));
      // Metadata noise still dropped.
      expect(text).not.toContain('Repo: my-project');
    });

    it('emits no description line and no metadata when description is absent (#2333)', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        isExported: true,
        repoName: 'my-project',
        description: undefined,
      };
      const text = generateEmbeddingText(node, node.content);
      // Header is the name line, then the bounded location line, then a blank
      // line, then the code body — no stray empty description line, no verbose
      // metadata.
      expect(
        text.startsWith('Function: parseJSON\nLoc: utils/parser.ts\n\nfunction parseJSON'),
      ).toBe(true);
      expect(text).not.toContain('Repo:');
      expect(text).not.toContain('Export:');
      // Only the bounded last-1-2 segments — never the verbose deep path.
      expect(text).not.toContain('Path:');
      expect(text).not.toContain('src/utils/parser.ts');
    });

    // U3 (#2333 PR #2334 tri-review): a BOUNDED location signal (last 1-2 path
    // segments) is reinstated so path/service-qualified semantic search keeps a
    // discriminator, since FTS does not index filePath.
    it('emits a bounded location (last 2 segments), not the full deep path (#2333 U3)', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        label: 'Method',
        name: 'updateMaterialExpiryDate',
        filePath: 'src/main/java/com/example/service/MaterialServiceImpl.java',
        content: 'function updateMaterialExpiryDate() { return doWork(); }',
      };
      const text = generateEmbeddingText(node, node.content);
      expect(text).toContain('Loc: service/MaterialServiceImpl.java');
      // The deep prefix is dropped entirely.
      expect(text).not.toContain('src/main/java/com/example');
    });

    it('emits just the basename for a root-level file (#2333 U3)', () => {
      const node: EmbeddableNode = { ...baseNode, filePath: 'index.ts' };
      const text = generateEmbeddingText(node, node.content);
      expect(text).toContain('Loc: index.ts');
      // No leading slash and no stray "undefined/" prefix from slicing one segment.
      expect(text).not.toContain('Loc: /index.ts');
      expect(text).not.toContain('undefined');
    });

    it('disambiguates same-named symbols in different service folders (#2333 U3)', () => {
      const billing = generateEmbeddingText(
        { ...baseNode, name: 'handler', filePath: 'billing/handler.ts' },
        'function handler() {}',
      );
      const identity = generateEmbeddingText(
        { ...baseNode, name: 'handler', filePath: 'identity/handler.ts' },
        'function handler() {}',
      );
      expect(billing).toContain('Loc: billing/handler.ts');
      expect(identity).toContain('Loc: identity/handler.ts');
      // The two embedding texts differ — the regression the tri-review flagged
      // (both collapsing to identical vectors) is fixed.
      expect(billing).not.toBe(identity);
    });

    it('keeps the description ahead of the location signal (#2333 U3)', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        label: 'Method',
        name: 'doThing',
        description: 'batch import rows',
        filePath: 'svc/importer.ts',
        content: 'function doThing() { return run(); }',
      };
      const text = generateEmbeddingText(node, node.content);
      // description leads, then the location line, then the code body.
      expect(text.indexOf('batch import rows')).toBeLessThan(text.indexOf('Loc: svc/importer.ts'));
      expect(text.indexOf('Loc: svc/importer.ts')).toBeLessThan(text.indexOf('return run()'));
    });

    it('normalizes Windows path separators in the location signal (#2333 U3)', () => {
      const node: EmbeddableNode = { ...baseNode, filePath: 'src\\svc\\Foo.ts' };
      const text = generateEmbeddingText(node, node.content);
      expect(text).toContain('Loc: svc/Foo.ts');
      expect(text).not.toContain('\\');
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

    // U5 (#2333 PR #2334): Interface and Struct route through the same
    // generateStructuralTypeText path as Class, so the description-forward
    // ordering must hold for them too — guards against a future per-label
    // specialization silently reordering the header.
    it('keeps an Interface description ahead of its structural lines (#2333 U5)', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        label: 'Interface',
        name: 'Handler',
        description: 'event handler contract',
        methodNames: ['handle', 'validate'],
        fieldNames: ['name'],
        content: `interface Handler {
  handle(event: Event): void;
  readonly name: string;
}`,
      };
      const text = generateEmbeddingText(node, node.content);
      expect(text).toContain('Interface: Handler');
      expect(text).toContain('event handler contract');
      expect(text).toContain('Methods: handle, validate');
      expect(text).toContain('Properties: name');
      expect(text.indexOf('event handler contract')).toBeLessThan(text.indexOf('Container:'));
      expect(text.indexOf('event handler contract')).toBeLessThan(text.indexOf('Methods:'));
      expect(text).toContain('Loc: utils/parser.ts');
      expect(text).not.toContain('Repo:');
    });

    it('keeps a Struct description ahead of its structural lines (#2333 U5)', () => {
      const node: EmbeddableNode = {
        ...baseNode,
        label: 'Struct',
        name: 'User',
        description: 'user record',
        fieldNames: ['name', 'age'],
        content: `struct User {
  name: String,
  age: u32,
}`,
      };
      const text = generateEmbeddingText(node, node.content);
      expect(text).toContain('Struct: User');
      expect(text).toContain('user record');
      expect(text).toContain('Properties: name, age');
      expect(text).toContain('Container: struct User {');
      expect(text.indexOf('user record')).toBeLessThan(text.indexOf('Container:'));
      expect(text.indexOf('user record')).toBeLessThan(text.indexOf('Properties:'));
      expect(text).toContain('Loc: utils/parser.ts');
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
