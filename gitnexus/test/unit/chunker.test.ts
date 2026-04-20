/**
 * Unit tests for character chunking and AST-aware chunking logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { characterChunk } from '../../src/core/embeddings/character-chunk.js';

const { createParserForLanguage } = vi.hoisted(() => ({
  createParserForLanguage: vi.fn(),
}));

const { getLanguageFromFilename } = vi.hoisted(() => ({
  getLanguageFromFilename: vi.fn((filePath: string) =>
    filePath.endsWith('.rs') ? 'rust' : 'typescript',
  ),
}));

vi.mock('../../src/core/tree-sitter/parser-loader.js', () => ({
  createParserForLanguage,
  isLanguageAvailable: vi.fn().mockReturnValue(true),
  resolveLanguageKey: vi.fn((language: string, filePath?: string) =>
    language === 'typescript' && filePath?.endsWith('.tsx') ? 'typescript:tsx' : language,
  ),
}));

vi.mock('gitnexus-shared', () => ({
  getLanguageFromFilename,
}));

import { chunkNode } from '../../src/core/embeddings/chunker.js';

type FakeNode = {
  type: string;
  startIndex: number;
  endIndex: number;
  namedChildCount: number;
  namedChild: (index: number) => FakeNode | null;
  childForFieldName?: (name: string) => FakeNode | null;
};

const makeFakeNode = (
  type: string,
  startIndex: number,
  endIndex: number,
  children: FakeNode[] = [],
  fields: Record<string, FakeNode> = {},
): FakeNode => ({
  type,
  startIndex,
  endIndex,
  namedChildCount: children.length,
  namedChild: (index: number) => children[index] ?? null,
  childForFieldName: (name: string) => fields[name] ?? null,
});

const makeFunctionTree = (content: string, statementTexts: string[]) => {
  const statementNodes = statementTexts.map((text) => {
    const startIndex = content.indexOf(text);
    return makeFakeNode('expression_statement', startIndex, startIndex + text.length);
  });

  const bodyStart = content.indexOf('{');
  const bodyEnd = content.lastIndexOf('}') + 1;
  const bodyNode = makeFakeNode('statement_block', bodyStart, bodyEnd, statementNodes);
  const fnNode = makeFakeNode('function_declaration', 0, bodyEnd, [], { body: bodyNode });
  const root = makeFakeNode('program', 0, content.length, [fnNode]);

  return {
    rootNode: root,
  };
};

const makeTypedFunctionTree = (nodeType: string, content: string, statementTexts: string[]) => {
  const statementNodes = statementTexts.map((text) => {
    const startIndex = content.indexOf(text);
    return makeFakeNode('expression_statement', startIndex, startIndex + text.length);
  });

  const bodyStart = content.indexOf('{');
  const bodyEnd = content.lastIndexOf('}') + 1;
  const bodyNode = makeFakeNode('statement_block', bodyStart, bodyEnd, statementNodes);
  const fnNode = makeFakeNode(nodeType, 0, bodyEnd, [], { body: bodyNode });
  const root = makeFakeNode('program', 0, content.length, [fnNode]);

  return {
    rootNode: root,
  };
};

const makeDeclarationTree = (
  nodeType: string,
  bodyType: string,
  content: string,
  memberTexts: string[],
) => {
  let searchFrom = 0;
  const memberNodes = memberTexts.map((text, index) => {
    const startIndex = content.indexOf(text, searchFrom);
    if (startIndex < 0) {
      throw new Error(`Unable to locate member text: ${text}`);
    }
    searchFrom = startIndex + text.length;
    const inferredType =
      text.includes('()') || text.includes(': void') || text.includes(': boolean')
        ? 'method_definition'
        : 'field_definition';
    return makeFakeNode(inferredType, startIndex, startIndex + text.length);
  });

  const bodyStart = content.indexOf('{');
  const bodyEnd = content.lastIndexOf('}') + 1;
  const bodyNode = makeFakeNode(bodyType, bodyStart, bodyEnd, memberNodes);
  const declNode = makeFakeNode(nodeType, 0, bodyEnd, [bodyNode], { body: bodyNode });
  const root = makeFakeNode('program', 0, content.length, [declNode]);

  return {
    rootNode: root,
  };
};

describe('characterChunk', () => {
  it('returns single chunk when content fits', () => {
    const result = characterChunk('short content', 1, 5, 1200, 120);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('short content');
    expect(result[0].chunkIndex).toBe(0);
    expect(result[0].startOffset).toBe(0);
    expect(result[0].endOffset).toBe('short content'.length);
    expect(result[0].startLine).toBe(1);
    expect(result[0].endLine).toBe(5);
  });

  it('splits long content into multiple chunks', () => {
    const longContent = 'a'.repeat(3000);
    const result = characterChunk(longContent, 1, 100, 1200, 120);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.text.length).toBeLessThanOrEqual(1200);
    }
  });

  it('maintains sequential chunkIndex and offsets', () => {
    const longContent = 'x'.repeat(3000);
    const result = characterChunk(longContent, 1, 100, 1200, 120);
    for (let i = 0; i < result.length; i++) {
      expect(result[i].chunkIndex).toBe(i);
      expect(result[i].text).toBe(longContent.slice(result[i].startOffset, result[i].endOffset));
    }
  });

  it('includes overlap between chunks', () => {
    const content = 'abcdefghij'.repeat(200);
    const result = characterChunk(content, 1, 50, 500, 50);
    if (result.length > 1) {
      const endOfFirst = result[0].text.slice(-50);
      expect(result[1].text.startsWith(endOfFirst)).toBe(true);
    }
  });

  it('keeps the first chunk on the real starting line', () => {
    const content = 'alpha\nbeta\ngamma';
    const result = characterChunk(content, 38, 40, 6, 0);
    expect(result[0].startLine).toBe(38);
  });

  it('does not advance endLine when a chunk ends at a newline boundary', () => {
    const content = 'aaa\nbbb\nccc';
    const result = characterChunk(content, 10, 12, 4, 0);
    expect(result[0].text).toBe('aaa\n');
    expect(result[0].startLine).toBe(10);
    expect(result[0].endLine).toBe(10);
  });
});

describe('chunkNode', () => {
  beforeEach(() => {
    createParserForLanguage.mockReset();
    getLanguageFromFilename.mockImplementation((filePath: string) =>
      filePath.endsWith('.rs') ? 'rust' : 'typescript',
    );
  });

  it('returns single chunk for short content', async () => {
    const result = await chunkNode('Function', 'short', 'test.ts', 1, 5, 1200, 120);
    expect(result).toHaveLength(1);
    expect(result[0].chunkIndex).toBe(0);
    expect(result[0].text).toBe('short');
    expect(result[0].startOffset).toBe(0);
  });

  it('splits a class by members instead of raw character windows', async () => {
    const content = [
      'class Parser {',
      '  options: ParserOptions;',
      '  cache: Map<string, any>;',
      '  parseJSON() { return JSON.parse("{}"); }',
      '  validate() { return true; }',
      '}',
    ].join('\n');
    const tree = makeDeclarationTree('class_declaration', 'class_body', content, [
      'options: ParserOptions;',
      'cache: Map<string, any>;',
      'parseJSON() { return JSON.parse("{}"); }',
      'validate() { return true; }',
    ]);
    createParserForLanguage.mockResolvedValue({
      parse: vi.fn().mockReturnValue(tree),
    });

    const result = await chunkNode('Class', content, 'test.ts', 1, 6, 90, 0);

    expect(result).toHaveLength(2);
    expect(result[0].text).toContain('class Parser {');
    expect(result[0].text).toContain('options: ParserOptions;');
    expect(result[0].text).toContain('cache: Map<string, any>;');
    expect(result[1].text).toContain('parseJSON()');
    expect(result[1].text).toContain('validate()');
    expect(result[0].startLine).toBe(1);
    expect(result[1].startLine).toBe(4);
  });

  it('preserves interface signatures via declaration-aware chunking', async () => {
    const content = [
      'interface Handler {',
      '  handle(event: Event): void;',
      '  validate(input: string): boolean;',
      '  readonly name: string;',
      '}',
    ].join('\n');
    const tree = makeDeclarationTree('interface_declaration', 'object_type', content, [
      'handle(event: Event): void;',
      'validate(input: string): boolean;',
      'readonly name: string;',
    ]);
    createParserForLanguage.mockResolvedValue({
      parse: vi.fn().mockReturnValue(tree),
    });

    const result = await chunkNode('Interface', content, 'test.ts', 10, 14, 500, 0);

    expect(result).toHaveLength(1);
    expect(result[0].text).toContain('interface Handler {');
    expect(result[0].text).toContain('handle(event: Event): void;');
    expect(result[0].text).toContain('validate(input: string): boolean;');
    expect(result[0].text).toContain('readonly name: string;');
  });

  it('uses declaration-aware chunking for Struct labels', async () => {
    const content = [
      'struct User {',
      '  name: String,',
      '  email: String,',
      '  age: u32,',
      '  address: String,',
      '}',
    ].join('\n');
    const tree = makeDeclarationTree('struct_item', 'declaration_list', content, [
      'name: String,',
      'email: String,',
      'age: u32,',
      'address: String,',
    ]);
    createParserForLanguage.mockResolvedValue({
      parse: vi.fn().mockReturnValue(tree),
    });

    const result = await chunkNode('Struct', content, 'test.rs', 40, 45, 45, 0);

    expect(result).toHaveLength(2);
    expect(result[0].text).toContain('struct User {');
    expect(result[0].text).toContain('name: String,');
    expect(result[0].text).toContain('email: String');
    const combinedText = result.map((chunk) => chunk.text).join('\n');
    expect(combinedText).toContain('email: String');
    expect(combinedText).toContain('age: u32');
    expect(combinedText).toContain('address: String');
    expect(result[0].startLine).toBe(40);
  });

  it('splits a function into multiple AST-aware chunks using snippet offsets', async () => {
    const content = [
      'function example() {',
      '  const first = 1;',
      '',
      '  const second = 2;',
      '  return first + second;',
      '}',
    ].join('\n');
    const tree = makeFunctionTree(content, [
      'const first = 1;',
      'const second = 2;',
      'return first + second;',
    ]);
    createParserForLanguage.mockResolvedValue({
      parse: vi.fn().mockReturnValue(tree),
    });

    const result = await chunkNode('Function', content, 'test.ts', 38, 43, 68, 0);

    expect(result).toHaveLength(2);
    expect(result[0].startOffset).toBe(0);
    expect(result[0].endOffset).toBeGreaterThan(content.indexOf('const second = 2;'));
    expect(result[0].startLine).toBe(38);
    expect(result[0].endLine).toBe(42);
    expect(result[0].text).toContain('function example() {');
    expect(result[0].text).toContain('\n\n  const second = 2;');
    expect(result[1].startOffset).toBeGreaterThan(content.indexOf('const second = 2;'));
    expect(result[1].startLine).toBeGreaterThanOrEqual(42);
    expect(result[1].endLine).toBe(43);
    expect(result[1].text.length).toBeGreaterThan(0);
  });

  it('uses AST-aware chunking for Constructor labels too', async () => {
    const content = [
      'constructor() {',
      '  this.ready = true;',
      '  this.mode = "prod";',
      '  this.start();',
      '}',
    ].join('\n');
    const tree = makeFunctionTree(content, [
      'this.ready = true;',
      'this.mode = "prod";',
      'this.start();',
    ]);
    createParserForLanguage.mockResolvedValue({
      parse: vi.fn().mockReturnValue(tree),
    });

    const result = await chunkNode('Constructor', content, 'test.ts', 12, 16, 55, 0);

    expect(result).toHaveLength(2);
    expect(result[0].text).toContain('constructor() {');
    expect(result[0].startLine).toBe(12);
    expect(result[1].startLine).toBe(14);
  });

  it('recognizes Rust function_item nodes for AST-aware chunking', async () => {
    const content = [
      'fn build_user() {',
      '    let first = 1;',
      '    let second = 2;',
      '    return first + second;',
      '}',
    ].join('\n');
    const tree = makeTypedFunctionTree('function_item', content, [
      'let first = 1;',
      'let second = 2;',
      'return first + second;',
    ]);
    createParserForLanguage.mockResolvedValue({
      parse: vi.fn().mockReturnValue(tree),
    });

    const result = await chunkNode('Function', content, 'test.rs', 20, 24, 52, 0);

    expect(result).toHaveLength(2);
    expect(result[0].text).toContain('fn build_user() {');
    expect(result[0].startLine).toBe(20);
    expect(result[1].text).toContain('return first + second;');
  });

  it('falls back to character chunks when AST parsing fails', async () => {
    createParserForLanguage.mockRejectedValueOnce(new Error('no parser'));

    const content = 'x'.repeat(3000);
    const result = await chunkNode('Function', content, 'test.tsx', 1, 100, 1200, 120);
    expect(result.length).toBeGreaterThan(1);
    expect(result[0].startOffset).toBe(0);
  });
});
