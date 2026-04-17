/**
 * Integration test: Embedding chunking pipeline
 *
 * Tests the chunking + text generation pipeline together.
 */
import { describe, it, expect, vi } from 'vitest';
import { characterChunk } from '../../src/core/embeddings/character-chunk.js';
import { generateEmbeddingText } from '../../src/core/embeddings/text-generator.js';
import type { EmbeddableNode } from '../../src/core/embeddings/types.js';

const { createParserForLanguage } = vi.hoisted(() => ({
  createParserForLanguage: vi.fn(),
}));

vi.mock('../../src/core/tree-sitter/parser-loader.js', () => ({
  createParserForLanguage,
  isLanguageAvailable: vi.fn().mockReturnValue(true),
  resolveLanguageKey: vi.fn((language: string) => language),
}));

vi.mock('gitnexus-shared', () => ({
  getLanguageFromFilename: vi.fn().mockReturnValue('typescript'),
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

const makeDeclarationTree = (
  nodeType: string,
  bodyType: string,
  content: string,
  members: Array<{ text: string; type: string }>,
) => {
  let searchFrom = 0;
  const memberNodes = members.map((member) => {
    const startIndex = content.indexOf(member.text, searchFrom);
    if (startIndex < 0) {
      throw new Error(`Unable to locate declaration member text: ${member.text}`);
    }
    searchFrom = startIndex + member.text.length;
    return makeFakeNode(member.type, startIndex, startIndex + member.text.length);
  });

  const bodyStart = content.indexOf('{');
  const bodyEnd = content.lastIndexOf('}') + 1;
  const bodyNode = makeFakeNode(bodyType, bodyStart, bodyEnd, memberNodes);
  const declNode = makeFakeNode(nodeType, 0, bodyEnd, [bodyNode], { body: bodyNode });
  return {
    rootNode: makeFakeNode('program', 0, content.length, [declNode]),
  };
};

describe('embedding-chunking integration', () => {
  const makeNode = (overrides: Partial<EmbeddableNode>): EmbeddableNode => ({
    id: 'Function:src/test.ts:test',
    name: 'test',
    label: 'Function',
    filePath: 'src/test.ts',
    content: '',
    startLine: 1,
    endLine: 10,
    ...overrides,
  });

  it('short function produces single chunk with metadata', () => {
    const node = makeNode({
      content: 'function hello() { return "world"; }',
      isExported: true,
      repoName: 'my-project',
      serverName: 'my-service',
    });

    const chunks = characterChunk(node.content, 1, 3, 1200, 120);
    expect(chunks).toHaveLength(1);

    const text = generateEmbeddingText(node, chunks[0].text);
    expect(text).toContain('Function: test');
    expect(text).toContain('Repo: my-project');
    expect(text).toContain('Server: my-service');
    expect(text).toContain('Export: true');
    expect(text).toContain('function hello()');
  });

  it('long function produces multiple chunks', () => {
    const longContent = Array.from({ length: 100 }, (_, i) => `  const line${i} = ${i};`).join(
      '\n',
    );
    const node = makeNode({
      content: `function longFn() {\n${longContent}\n}`,
      startLine: 1,
      endLine: 102,
    });

    const chunks = characterChunk(node.content, 1, 102, 1200, 120);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].chunkIndex).toBe(0);
  });

  it('short labels (TypeAlias) skip chunking and embed directly', () => {
    const node = makeNode({
      label: 'TypeAlias',
      name: 'Result',
      content: 'type Result<T> = Success<T> | Error;',
    });

    const chunks = characterChunk(node.content, 1, 1, 1200, 120);
    expect(chunks).toHaveLength(1);

    const text = generateEmbeddingText(node, chunks[0].text);
    expect(text).toContain('TypeAlias: Result');
    expect(text).toContain('type Result<T> = Success<T> | Error;');
  });

  it('long enum uses character fallback', () => {
    const enumContent = Array.from(
      { length: 200 },
      (_, i) => `  Value${i} = "${'x'.repeat(20)}${i}",`,
    ).join('\n');
    const node = makeNode({
      label: 'Enum',
      name: 'LargeEnum',
      content: `enum LargeEnum {\n${enumContent}\n}`,
      startLine: 1,
      endLine: 202,
    });

    const chunks = characterChunk(node.content, 1, 202, 1200, 120);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('long class produces member-aware chunks with structural metadata', async () => {
    const node = makeNode({
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
      startLine: 20,
      endLine: 25,
    });
    createParserForLanguage.mockResolvedValue({
      parse: vi.fn().mockReturnValue(
        makeDeclarationTree('class_declaration', 'class_body', node.content, [
          { text: 'options: ParserOptions;', type: 'field_definition' },
          { text: 'cache: Map<string, any>;', type: 'field_definition' },
          {
            text: 'parseJSON(text: string) { return JSON.parse(text); }',
            type: 'method_definition',
          },
          { text: 'validate() { return true; }', type: 'method_definition' },
        ]),
      ),
    });

    const chunks = await chunkNode(node.label, node.content, node.filePath, 20, 25, 90, 0);
    expect(chunks).toHaveLength(2);

    const secondText = generateEmbeddingText(node, chunks[1].text);
    expect(secondText).toContain('Class: Parser');
    expect(secondText).toContain('Methods: parseJSON, validate');
    expect(secondText).toContain('Properties: options, cache');
    expect(secondText).toContain('parseJSON(text: string)');
  });

  it('interface chunks retain structural metadata and signatures', async () => {
    const node = makeNode({
      label: 'Interface',
      name: 'Handler',
      methodNames: ['handle', 'validate'],
      fieldNames: ['name'],
      content: `interface Handler {
  handle(event: Event): void;
  validate(input: string): boolean;
  readonly name: string;
}`,
      startLine: 30,
      endLine: 34,
    });
    createParserForLanguage.mockResolvedValue({
      parse: vi.fn().mockReturnValue(
        makeDeclarationTree('interface_declaration', 'object_type', node.content, [
          { text: 'handle(event: Event): void;', type: 'method_definition' },
          { text: 'validate(input: string): boolean;', type: 'method_definition' },
          { text: 'readonly name: string;', type: 'property_signature' },
        ]),
      ),
    });

    const chunks = await chunkNode(node.label, node.content, node.filePath, 30, 34, 500, 0);
    expect(chunks).toHaveLength(1);

    const text = generateEmbeddingText(node, chunks[0].text);
    expect(text).toContain('Interface: Handler');
    expect(text).toContain('Methods: handle, validate');
    expect(text).toContain('readonly name: string;');
  });

  it('metadata is present in every chunk', () => {
    const longContent = 'x'.repeat(3000);
    const node = makeNode({
      content: longContent,
      repoName: 'test-repo',
    });

    const chunks = characterChunk(node.content, 1, 100, 1200, 120);
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const text = generateEmbeddingText(node, chunk.text);
      expect(text).toContain('Function: test');
      expect(text).toContain('Repo: test-repo');
      expect(text).toContain('Path: src/test.ts');
    }
  });
});
