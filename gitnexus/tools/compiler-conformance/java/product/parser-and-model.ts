import { runInSequence } from '../../../../test/helpers/run-in-sequence.mjs';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
import { chunkNode } from '../../../../src/core/embeddings/chunker.js';
import { generateEmbeddingText } from '../../../../src/core/embeddings/text-generator.js';
import { ensureAndParse } from '../../../../src/core/embeddings/ast-utils.js';
import { extractStructuralNames } from '../../../../src/core/embeddings/structural-extractor.js';
import { runPipelineFromRepo } from '../../../../src/core/ingestion/pipeline.js';
import { getProvider } from '../../../../src/core/ingestion/languages/index.js';
import { loadParser, loadLanguage } from '../../../../src/core/tree-sitter/parser-loader.js';
import { parseFilesWithWorkers } from '../../../../test/helpers/worker-parse.js';

const fixtures = path.resolve(import.meta.dirname, '../../../../test/fixtures');
const compiler = path.join(fixtures, 'compiler-conformance');

test('Java worker registers canonical package and nested class names', async () => {
  const root = path.join(compiler, 'java-worker-qualified-names');
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.java'))
    .map((name) => ({
      path: name.replaceAll(path.sep, '/'),
      content: readFileSync(path.join(root, name), 'utf8'),
    }));
  const { model } = await parseFilesWithWorkers(files);
  for (const name of ['example.models.Outer.Inner', 'com.example.models.Config']) {
    assert.deepEqual(
      model.types.lookupClassByQualifiedName(name).map((type) => type.qualifiedName),
      [name],
    );
  }
});

test('marks the Java platform method as an external receiver', async () => {
  const result = await runPipelineFromRepo(path.join(compiler, 'java-external-receiver'), () => {});
  const drops =
    result.resolutionOutcomes?.filter(
      (outcome) =>
        outcome.kind === 'suppressed' &&
        outcome.reason === 'receiver-unresolved' &&
        outcome.filePath === 'java/src/App.java' &&
        outcome.range.startLine === 3 &&
        outcome.name === 'of',
    ) ?? [];
  assert.ok(drops.length);
  for (const drop of drops) {
    assert.equal(drop.kind, 'suppressed');
    assert.equal(drop.receiverOrigin, 'external');
  }
});

test('Java grammar captures named classes and methods in the sample file', async () => {
  const source = readFileSync(path.join(fixtures, 'sample-code/simple.java'), 'utf8');
  const parser = await loadParser();
  await loadLanguage(SupportedLanguages.Java);
  const query = new Parser.Query(
    parser.getLanguage(),
    getProvider(SupportedLanguages.Java).treeSitterQueries,
  );
  const matches = query
    .matches(parser.parse(source).rootNode)
    .filter((match) => match.captures.some((c) => c.name === 'name'));
  const captures = new Set(matches.flatMap((match) => match.captures.map((c) => c.name)));
  assert.ok(captures.has('definition.class'));
  assert.ok(captures.has('definition.method'));
});

test('embeddings reuse the parsed Java class and preserve fields and line spans', async () => {
  const file = 'Sample.java';
  const content = readFileSync(path.join(fixtures, 'java-products/embedding-fields', file), 'utf8');
  const tree = await ensureAndParse(content, file);
  assert.ok(tree);
  const startLine = 10;
  const lineAt = (offset: number) => startLine + content.slice(0, offset).split('\n').length - 1;
  const symbol = {
    id: 'Class:Sample.java:sample',
    name: 'sample',
    label: 'Class',
    filePath: file,
    content,
    startLine,
    endLine: lineAt(content.length),
    ...(await extractStructuralNames(content, file, tree)),
  };
  await runInSequence(['ast', 'fixed'] as const, async (strategy) => {
    const chunks = await chunkNode('Class', content, file, startLine, symbol.endLine, 80, 10, {
      strategy,
      tree,
    });
    assert.ok(chunks.length);
    const prepared = { ...symbol, classDeclaration: chunks[0].classDeclaration };
    const inputs = chunks
      .map((chunk) =>
        generateEmbeddingText(prepared, chunk.text, {}, chunk.chunkIndex, 'BODY_SENTINEL'),
      )
      .join('\n');
    for (const field of ['before', 'after']) assert.ok(inputs.includes(field));
    assert.doesNotMatch(inputs, /BODY_SENTINEL|LAMBDA_SENTINEL/);
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= 80);
      assert.equal(chunk.startLine, lineAt(chunk.startOffset));
      assert.equal(chunk.endLine, lineAt(Math.max(chunk.startOffset, chunk.endOffset - 1)));
    }
  });
});

test('Java export checks retain sibling and enclosing class visibility across parser trees', async () => {
  const parser = await loadParser();
  await loadLanguage(SupportedLanguages.Java);
  const provider = getProvider(SupportedLanguages.Java);
  function visibility(method: Parser.SyntaxNode) {
    const name = method.childForFieldName('name');
    assert.ok(name);
    return provider.exportChecker(name, name.text);
  }
  const siblings = parser
    .parse('class C { private void a() {} public void b() {} void c() {} }')
    .rootNode.descendantsOfType('method_declaration');
  for (const order of [siblings, [...siblings].reverse()]) {
    assert.deepEqual(order.map(visibility), [false, true, false]);
  }
  for (const modifier of ['', 'public ', '']) {
    const tree = parser.parse(
      modifier + 'class C { private void a() {} class Inner { void b() {} } }',
    );
    const methods = tree.rootNode.descendantsOfType('method_declaration');
    assert.equal(methods.length, 2);
    for (const method of methods) {
      assert.equal(visibility(method), modifier === 'public ');
      assert.equal(visibility(method), modifier === 'public ');
    }
  }
});
