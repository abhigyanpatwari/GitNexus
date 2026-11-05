import { afterEach, describe, expect, it, vi } from 'vitest';
import { chunkNode, characterChunk } from '../../src/core/embeddings/chunker.js';
import { generateEmbeddingText } from '../../src/core/embeddings/text-generator.js';
import { contentHashForNode } from '../../src/core/embeddings/embedding-pipeline.js';
import * as ast from '../../src/core/embeddings/ast-utils.js';
import { extractStructuralNames } from '../../src/core/embeddings/structural-extractor.js';
import type { EmbeddableNode } from '../../src/core/embeddings/types.js';

afterEach(() => vi.restoreAllMocks());

const node = (content: string, label = 'Function', filePath = 'sample.ts'): EmbeddableNode => ({
  id: `${label}:${filePath}:sample`,
  name: 'sample',
  label,
  filePath,
  content,
  startLine: 10,
  endLine: 10 + content.split('\n').length - 1,
});

describe('AST embedding contracts with real parsers (#702)', () => {
  it.each([
    [
      'single-line-constructor.kt',
      'class Sample(val callback: () -> Unit = { println("LAMBDA_BODY") }) { val field = 42 }',
      'callback',
    ],
    [
      'sample.ts',
      'class Sample extends makeBase(() => { return "LAMBDA_BODY"; }) { field = 42; }',
      'extends makeBase',
    ],
    [
      'multiline-constructor.kt',
      'class Sample(\n val callback: () -> Unit = {\n  println("LAMBDA_BODY")\n }\n) {\n val field = 42\n}',
      'callback',
    ],
    ['sample.cs', 'class Sample { string Name => "GETTER_BODY"; int field = 42; }', 'string Name'],
  ])(
    'excludes implementations from every retained class declaration in %s',
    async (filePath, source, declaration) => {
      const tree = await ast.ensureAndParse(source, filePath);
      expect(tree?.rootNode.hasError).toBe(false);
      for (const strategy of ['ast', 'fixed'] as const) {
        const chunks = await chunkNode(
          'Class',
          source,
          filePath,
          0,
          source.split('\n').length - 1,
          80,
          10,
          {
            tree,
            name: 'Sample',
            strategy,
          },
        );
        const prepared = {
          ...node(source, 'Class', filePath),
          name: 'Sample',
          classDeclaration: chunks[0].classDeclaration,
        };
        const projected = chunks.map((chunk) => chunk.text).join('\n');
        const inputs = chunks
          .map((chunk) => generateEmbeddingText(prepared, chunk.text, {}, chunk.chunkIndex))
          .join('\n');
        expect(projected).toContain(declaration);
        expect(projected).toContain('field = 42');
        expect(inputs).not.toContain('_BODY');
        for (const chunk of chunks) {
          expect(chunk.text.length).toBeLessThanOrEqual(80);
          expect(chunk.startLine).toBe(source.slice(0, chunk.startOffset).split('\n').length - 1);
          expect(chunk.endLine).toBe(source.slice(0, chunk.endOffset - 1).split('\n').length - 1);
          expect(chunk.startOffset).toBeLessThan(chunk.endOffset);
          expect(chunk.endOffset).toBeLessThanOrEqual(source.length);
        }
      }
    },
  );

  it.each(['@interface Empty : NSObject', '@protocol Empty', '@implementation Empty'])(
    'preserves an empty direct-member declaration: %s',
    async (header) => {
      const source = `${header}\n@end`;
      const tree = await ast.ensureAndParse(source, 'sample.m');
      expect(tree?.rootNode.hasError).toBe(false);
      for (const strategy of ['ast', 'fixed'] as const) {
        const chunks = await chunkNode('Class', source, 'sample.m', 0, 1, 1200, 120, {
          tree,
          name: 'Empty',
          strategy,
        });
        expect(chunks.map((chunk) => chunk.text).join('\n')).toContain(header);
      }
    },
  );

  it('does not mistake a callable return type for its declaration name', async () => {
    const tree = await ast.ensureAndParse(
      'Bar other() { return {}; } Baz Bar() { return {}; }',
      'sample.cpp',
    );
    expect(tree?.rootNode.hasError).toBe(false);
    // Neither callable exposes a name field; ambiguity must fall back safely.
    expect(ast.findFunctionNode(tree.rootNode, 'Bar')).toBeNull();
  });

  it.each(['Outer', 'Inner'])('selects the named nested Kotlin class: %s', async (name) => {
    const source = 'class Outer { val outerField = 1; class Inner { val innerField = 2 } }';
    const tree = await ast.ensureAndParse(source, 'sample.kt');
    expect(tree?.rootNode.hasError).toBe(false);
    const field = name === 'Outer' ? 'outerField' : 'innerField';
    const other = name === 'Outer' ? 'innerField' : 'outerField';
    const chunks = await chunkNode('Class', source, 'sample.kt', 0, 0, 1200, 120, { tree, name });
    const text = chunks.map((chunk) => chunk.text).join('\n');
    expect(text).toContain(`class ${name}`);
    expect(text).toContain(field);
    expect(text).not.toContain(other);
    expect((await extractStructuralNames(source, 'sample.kt', tree, name)).fieldNames).toContain(
      field,
    );
  });

  it('preserves C++ class declarations and fields while excluding method implementations', async () => {
    const source = 'class Cache { int capacity; int size() { return 12345; } };';
    const tree = await ast.ensureAndParse(source, 'sample.cpp');
    expect(tree?.rootNode.hasError).toBe(false);
    const chunks = await chunkNode('Class', source, 'sample.cpp', 0, 0, 1200, 120, {
      tree,
      name: 'Cache',
    });
    const text = chunks.map((chunk) => chunk.text).join('\n');
    expect(text).toContain('class Cache');
    expect(text).toContain('int capacity;');
    expect(text).not.toContain('12345');
    expect(await extractStructuralNames(source, 'sample.cpp', tree, 'Cache')).toMatchObject({
      fieldNames: ['capacity'],
      methodNames: ['size'],
    });
  });

  it.each([
    [
      'sample.kt',
      'class Sample { val callback = { println("LAMBDA_BODY") }; val value: String get() = "GETTER_BODY"; var stored: String = "FIELD_VALUE"\n get() { return "BLOCK_GETTER_BODY" }\n set(value) { println("SETTER_BODY") } }',
    ],
    [
      'sample.swift',
      'class Sample { var callback = { print("LAMBDA_BODY") }; var value: String { return "GETTER_BODY" }; var stored = "FIELD_VALUE" { willSet { print("WILLSET_BODY") } didSet { print("DIDSET_BODY") } } }',
    ],
    [
      'sample.swift',
      'class Sample { var callback = { (arg: String) in print("LAMBDA_BODY") }; var value: String { get { return "GETTER_BODY" } set { print("SETTER_BODY") } }; var stored = "FIELD_VALUE" }',
    ],
  ])('excludes field implementation bodies in %s: %s', async (filePath, source) => {
    const tree = await ast.ensureAndParse(source, filePath);
    expect(tree?.rootNode.hasError).toBe(false);
    for (const strategy of ['ast', 'fixed'] as const) {
      const chunks = await chunkNode(
        'Class',
        source,
        filePath,
        0,
        source.split('\n').length - 1,
        80,
        10,
        { tree, name: 'Sample', strategy },
      );
      const text = chunks.map((chunk) => chunk.text).join('\n');
      expect(text).toContain('class Sample');
      expect(text).toContain('callback');
      expect(text).toContain('value');
      expect(text).toContain('FIELD_VALUE');
      expect(text).not.toContain('_BODY');
      for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(80);
    }
  });

  it('selects a nested Python class without including its enclosing class or method body', async () => {
    const source =
      'class Outer:\n    outer = 2\n    class Inner:\n        field = 1\n        def run(self):\n            return "BODY"\n';
    const chunks = await chunkNode('Class', source, 'sample.py', 0, 6, 1200, 120, {
      name: 'Inner',
    });
    const text = chunks.map((chunk) => chunk.text).join('\n');
    expect(text).toContain('class Inner:');
    expect(text).toContain('field = 1');
    expect(text).not.toContain('outer = 2');
    expect(text).not.toContain('BODY');
  });

  it('excludes accessor and field-lambda bodies and rejects error-recovered class projections', async () => {
    const source =
      'class Sample { get value() { return "ACCESSOR_BODY"; } field = () => { return "LAMBDA_BODY"; }; }';
    const chunks = await chunkNode('Class', source, 'sample.ts', 0, 0);
    const text = chunks.map((chunk) => chunk.text).join('\n');
    expect(text).toContain('field = () =>');
    expect(text).not.toContain('ACCESSOR_BODY');
    expect(text).not.toContain('LAMBDA_BODY');
    const malformed = 'class Sample { before = 1;\n invalid !!!\n run() { return "BODY"; } }';
    expect((await chunkNode('Class', malformed, 'sample.ts', 0, 2))[0].text).toBe('');
  });

  it('selects the indexed declaration when siblings share a line', async () => {
    const source = 'class A { wrong = 1; } class B { right = 2; run() { return "BODY"; } }';
    const tree = await ast.ensureAndParse(source, 'sample.ts');
    const chunks = await chunkNode('Class', source, 'sample.ts', 0, 0, 1200, 120, {
      tree,
      name: 'B',
    });
    expect(chunks.map((chunk) => chunk.text).join('\n')).toContain('right = 2');
    expect(chunks.map((chunk) => chunk.text).join('\n')).not.toContain('wrong');
    expect(await extractStructuralNames(source, 'sample.ts', tree, 'B')).toMatchObject({
      fieldNames: ['right'],
    });
    expect(
      (await chunkNode('Class', source, 'sample.ts', 0, 0, 1200, 120, { tree, name: 'Missing' }))[0]
        .text,
    ).toBe('');
    const functions = `function other() { return "WRONG"; } function chosen() { ${'consume();'.repeat(150)} return "RIGHT"; }`;
    const body = await chunkNode('Function', functions, 'sample.ts', 0, 0, 500, 50, {
      name: 'chosen',
    });
    expect(body.map((chunk) => chunk.text).join('\n')).toContain('RIGHT');
    expect(body.map((chunk) => chunk.text).join('\n')).not.toContain('WRONG');
  });
  it('keeps short callable text/hash byte compatible and never parses it', async () => {
    const parse = vi.spyOn(ast, 'ensureAndParse');
    const short = { ...node('function sample() { return 42; }'), startLine: 1, endLine: 1 };
    expect(contentHashForNode(short)).toBe('549e259ecc957e1275f39b14406a9f52d4803730');
    expect(await chunkNode('Function', short.content, short.filePath, 1, 1)).toEqual(
      characterChunk(short.content, 1, 1),
    );
    expect(parse).not.toHaveBeenCalled();
  });

  it('fixed mode uses character windows without parsing long callables', async () => {
    const parse = vi.spyOn(ast, 'ensureAndParse');
    const source = `function sample() {\n${'consume(value);\n'.repeat(120)}}`;
    expect(
      await chunkNode('Function', source, 'sample.ts', 10, 131, 500, 50, { strategy: 'fixed' }),
    ).toEqual(characterChunk(source, 10, 131, 500, 50));
    expect(parse).not.toHaveBeenCalled();
  });

  it.each([
    [
      'sample.ts',
      'class Sample {\n before: string;\n run() { return "BODY_SENTINEL"; }\n after = 42;\n callback = () => "LAMBDA_SENTINEL";\n}',
      'before',
      'after',
    ],
    [
      'sample.py',
      'class Sample:\n    before: str = "value"\n    def run(self):\n        return "BODY_SENTINEL"\n    after = 42\n',
      'before',
      'after',
    ],
    [
      'Sample.java',
      'class Sample {\n String before;\n Sample() { consume("BODY_SENTINEL"); }\n String run() { return "BODY_SENTINEL"; }\n int after = 42;\n}',
      'before',
      'after',
    ],
    [
      'Sample.h',
      '@interface Sample : NSObject {\n id before;\n int after;\n}\n- (void)run;\n@end',
      'before',
      'after',
    ],
  ])(
    'projects declarations and fields with one shared parse: %s',
    async (filePath, source, before, after) => {
      const parse = vi.spyOn(ast, 'ensureAndParse');
      const tree = await ast.ensureAndParse(source, filePath);
      expect(tree).toBeTruthy();
      const names = await extractStructuralNames(source, filePath, tree);
      for (const strategy of ['ast', 'fixed'] as const) {
        const chunks = await chunkNode(
          'Class',
          source,
          filePath,
          10,
          10 + source.split('\n').length - 1,
          80,
          10,
          { strategy, tree },
        );
        const prepared = {
          ...node(source, 'Class', filePath),
          ...names,
          classDeclaration: chunks[0].classDeclaration,
        };
        const inputs = chunks.map((chunk) =>
          generateEmbeddingText(prepared, chunk.text, {}, chunk.chunkIndex, 'BODY_SENTINEL'),
        );
        expect(inputs.join('\n')).toContain(before);
        expect(inputs.join('\n')).toContain(after);
        expect(inputs.join('\n')).not.toContain('BODY_SENTINEL');
        expect(inputs.join('\n')).not.toContain('LAMBDA_SENTINEL');
        for (const chunk of chunks) {
          expect(chunk.text.length).toBeLessThanOrEqual(80);
          expect(chunk.startLine).toBe(
            10 + source.slice(0, chunk.startOffset).split('\n').length - 1,
          );
          expect(chunk.endLine).toBe(
            10 +
              source.slice(0, Math.max(chunk.startOffset, chunk.endOffset - 1)).split('\n').length -
              1,
          );
        }
      }
      expect(parse).toHaveBeenCalledTimes(1);
    },
  );

  it('filters short one-line classes and fails closed when parsing is unavailable', async () => {
    const source = 'class Sample { field = 42; run() { return "BODY_SENTINEL"; } }';
    const chunks = await chunkNode('Class', source, 'sample.ts', 20, 20);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('field = 42');
    expect(chunks[0].text).not.toContain('BODY_SENTINEL');
    const fallback = await chunkNode('Class', source, 'sample.unknown', 20, 20);
    expect(fallback).toHaveLength(1);
    expect(fallback[0].text).toBe('');
    const rawNode = node(source, 'Class');
    expect(generateEmbeddingText(rawNode, source, {}, 1, source)).not.toContain('BODY_SENTINEL');
    expect(
      generateEmbeddingText(
        node('run() { return "BODY_SENTINEL"; }', 'Method'),
        'run() { return "BODY_SENTINEL"; }',
      ),
    ).toContain('BODY_SENTINEL');
  });

  it('uses nested statement boundaries without dropping branch syntax or tail text', async () => {
    const statements = Array.from({ length: 30 }, (_, i) => `consume(uniqueValue${i});`);
    const source = `function sample() {\n if (ready) {\n  for (const item of items) {\n${statements.slice(0, 20).join('\n')}\n  }\n } else {\n${statements.slice(20).join('\n')}\n }\n return tailSentinel;\n}`;
    const parse = vi.spyOn(ast, 'ensureAndParse');
    const chunks = await chunkNode('Function', source, 'sample.ts', 10, 50, 150, 0);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(chunks.length).toBeGreaterThan(1);
    for (const statement of statements)
      expect(chunks.some((chunk) => chunk.text.includes(statement))).toBe(true);
    expect(chunks.some((chunk) => chunk.text.includes('return tailSentinel;'))).toBe(true);
    const covered = new Uint8Array(source.length);
    for (const chunk of chunks) {
      expect(chunk.text).toBe(source.slice(chunk.startOffset, chunk.endOffset));
      expect(chunk.text.length).toBeLessThanOrEqual(150);
      covered.fill(1, chunk.startOffset, chunk.endOffset);
    }
    for (let i = 0; i < source.length; i++)
      if (!/\s/.test(source[i])) expect(covered[i], `uncovered offset ${i}`).toBe(1);
  });

  it('bounds irreducible expressions and retains their complete tail', async () => {
    const source = `function sample() { return "${'x'.repeat(900)}TAIL_SENTINEL"; }`;
    const chunks = await chunkNode('Function', source, 'sample.ts', 1, 1, 100, 0);
    expect(chunks.every((chunk) => chunk.text.length <= 100)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(source);
  });

  it.each([
    ['array.ts', 'function sample() { const values = [', ']; return values; }'],
    ['arguments.ts', 'function sample() { return consume(', '); }'],
    ['list.py', 'def sample():\n    return [', ']'],
  ])('splits oversized expressions at child boundaries in %s', async (filePath, prefix, suffix) => {
    const entries = Array.from({ length: 35 }, (_, i) => `"value_${i}_λ😀_${'x'.repeat(24)}"`);
    const source = `${prefix}\r\n${entries.join(',\r\n')}\r\n${suffix}`;
    expect((await ast.ensureAndParse(source, filePath))?.rootNode.hasError).toBe(false);
    for (const size of [80, 150]) {
      for (const overlap of [0, 15]) {
        const chunks = await chunkNode('Function', source, filePath, 10, 50, size, overlap);
        for (const entry of entries)
          expect(
            chunks.some((chunk) => chunk.text.includes(entry)),
            entry,
          ).toBe(true);
        const covered = new Uint8Array(source.length);
        for (const chunk of chunks) {
          expect(chunk.text).toBe(source.slice(chunk.startOffset, chunk.endOffset));
          expect(chunk.text.length).toBeLessThanOrEqual(size);
          expect(chunk.startLine).toBe(
            10 + source.slice(0, chunk.startOffset).split('\n').length - 1,
          );
          expect(chunk.endLine).toBe(
            10 + source.slice(0, chunk.endOffset - 1).split('\n').length - 1,
          );
          covered.fill(1, chunk.startOffset, chunk.endOffset);
        }
        for (let i = 0; i < source.length; i++)
          if (!/\s/.test(source[i])) expect(covered[i], `uncovered offset ${i}`).toBe(1);
        for (let i = 1; i < chunks.length; i++)
          expect(chunks[i - 1].endOffset - chunks[i].startOffset).toBeLessThanOrEqual(overlap);
      }
    }
  });

  it.each([
    ['', ''],
    ['other(); ', ''],
    ['', ' other();'],
  ])(
    'keeps a fitting expression whole when wrapper syntax consumes its budget (%s, %s)',
    async (prefix, suffix) => {
      const statement = `consume("${'x'.repeat(137)}");`;
      const source = `function sample() { ${prefix}${statement}${suffix} }`;
      const chunks = await chunkNode('Function', source, 'sample.ts', 0, 0, 150, 15);
      expect(statement.length).toBeLessThanOrEqual(150);
      expect(chunks.some((chunk) => chunk.text.includes(statement))).toBe(true);
      expect(chunks.every((chunk) => chunk.text.length <= 150)).toBe(true);
      const covered = new Uint8Array(source.length);
      for (const chunk of chunks) covered.fill(1, chunk.startOffset, chunk.endOffset);
      for (let i = 0; i < source.length; i++)
        if (!/\s/.test(source[i])) expect(covered[i], `uncovered offset ${i}`).toBe(1);
    },
  );

  it('does not repeat a large whole statement beyond the overlap budget', async () => {
    const statements = Array.from({ length: 30 }, (_, i) => `consume(${i}, "${'x'.repeat(280)}");`);
    const source = `function sample() {\n${statements.join('\n')}\n}`;
    const chunks = await chunkNode('Function', source, 'sample.ts', 0, 31, 1200, 120);
    expect(chunks.length).toBeLessThanOrEqual(10);
    for (const statement of statements)
      expect(chunks.filter((chunk) => chunk.text.includes(statement))).toHaveLength(1);
    for (let i = 1; i < chunks.length; i++)
      expect(chunks[i - 1].endOffset - chunks[i].startOffset).toBeLessThanOrEqual(120);
  });

  it('keeps fitting statements whole inside long switch cases and defaults', async () => {
    const statements = Array.from({ length: 60 }, (_, i) => `consume(uniqueValue${i});`);
    const source = `function sample(x) { switch (x) { case 1:\n${statements.slice(0, 30).join('\n')}\nbreak;\ndefault:\n${statements.slice(30).join('\n')}\n} return tail; }`;
    const chunks = await chunkNode('Function', source, 'sample.ts', 10, 75, 150, 15);
    for (const statement of statements)
      expect(
        chunks.some((chunk) => chunk.text.includes(statement)),
        statement,
      ).toBe(true);
    const covered = new Uint8Array(source.length);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(150);
      covered.fill(1, chunk.startOffset, chunk.endOffset);
    }
    for (let i = 0; i < source.length; i++)
      if (!/\s/.test(source[i])) expect(covered[i], `uncovered offset ${i}`).toBe(1);
  });

  it('fingerprints effective layout without parsing or transient metadata', () => {
    const parse = vi.spyOn(ast, 'ensureAndParse');
    const long = node(`function sample() { ${'consume();'.repeat(300)} }`);
    const defaults = contentHashForNode(long);
    const smaller = contentHashForNode(long, { chunkSize: 500, overlap: 50 });
    expect(smaller).not.toBe(defaults);
    expect(contentHashForNode(long, { chunkSize: 1200, overlap: 120, chunkStrategy: 'ast' })).toBe(
      defaults,
    );
    expect(contentHashForNode(long, { chunkStrategy: 'fixed' })).not.toBe(defaults);
    expect(contentHashForNode(long, { overlap: 0 })).not.toBe(defaults);
    const cls = node('class Sample { value = 42; }', 'Class');
    expect(
      contentHashForNode({
        ...cls,
        methodNames: ['run'],
        fieldNames: ['value'],
        classDeclaration: 'class Sample {',
      }),
    ).toBe(contentHashForNode(cls));
    expect(contentHashForNode({ ...cls, content: 'class Sample { value = 43; }' })).not.toBe(
      contentHashForNode(cls),
    );
    expect(parse).not.toHaveBeenCalled();
  });
});

describe('AST chunk boundary lookup', () => {
  it.each([
    {
      name: 'sparse Unicode arrays',
      source: 'function sample() {\nreturn ["λ😀_unique_0",,"λ😀_unique_1",,"λ😀_unique_2"];\n}',
      overlap: 0,
      spans: [
        [0, 20],
        [20, 27],
        [27, 42],
        [42, 58],
        [58, 78],
      ],
    },
    {
      name: 'dense arrays with 80% overlap',
      source: 'function sample() {\nreturn [0,1,2,3,4,5,6,7,8,9,10,11,12];\n}',
      overlap: 16,
      spans: [
        [0, 20],
        [20, 39],
        [27, 47],
        [31, 50],
        [35, 53],
        [37, 57],
        [41, 60],
      ],
    },
  ])('preserves exact chunk spans for $name', async ({ source, overlap, spans }) => {
    const tree = await ast.ensureAndParse(source, 'sample.ts');
    expect(tree?.rootNode.hasError).toBe(false);
    const chunks = await chunkNode('Function', source, 'sample.ts', 10, 12, 20, overlap);
    expect(chunks.map((chunk) => [chunk.startOffset, chunk.endOffset])).toEqual(spans);
    for (const chunk of chunks)
      expect(chunk.text).toBe(source.slice(chunk.startOffset, chunk.endOffset));
  });
});
