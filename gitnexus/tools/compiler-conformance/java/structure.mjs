import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { javaClassConfig } from '../../../dist/core/ingestion/class-extractors/configs/jvm.js';
import { createClassExtractor } from '../../../dist/core/ingestion/class-extractors/generic.js';
import { getTreeSitterBufferSize } from '../../../dist/core/ingestion/constants.js';
import { getJavaParser } from '../../../dist/core/ingestion/languages/java/query.js';
import { parseSourceSafe } from '../../../dist/core/tree-sitter/safe-parse.js';
import { compareCodeUnits } from '../compare.mjs';

const typeLabels = new Set(['Class', 'Enum', 'Interface', 'Record', 'Annotation']);
const extractor = createClassExtractor(javaClassConfig);

function sourceTypes(dir, file) {
  const source = readFileSync(path.join(dir, file), 'utf8');
  const { rootNode: root } = parseSourceSafe(
    getJavaParser(),
    source,
    undefined,
    { bufferSize: getTreeSitterBufferSize(source) },
    file,
  );
  const pkg = extractor.qualifyScopeName(root, '');
  const declarations = new Map();
  for (const type of root.descendantsOfType(javaClassConfig.typeDeclarationNodes)) {
    if (javaClassConfig.shouldSkipClassCapture({ definitionNode: type })) continue;
    const { name, qualifiedName } = extractor.extract(type);
    const key = JSON.stringify([type.startPosition.row, name, qualifiedName]);
    declarations.set(key, javaClassConfig.extractName(type) !== undefined);
  }
  return { prefix: pkg ? pkg + '.' : '', declarations };
}

// Java source uses dots for member types. Class files use '$', including javac's
// per-host numbering for anonymous and local declarations.
export function javaTypeIdentity(dir) {
  const files = new Map();
  return (node) => {
    if (!typeLabels.has(node.label)) return undefined;
    const { filePath, startLine, name, qualifiedName } = node.properties;
    // Annotation graph nodes expose their source name without a qualifiedName.
    if (node.label === 'Annotation') return filePath + '#@' + name;
    if (!files.has(filePath)) files.set(filePath, sourceTypes(dir, filePath));
    const { prefix, declarations } = files.get(filePath);
    const synthesized = declarations.get(JSON.stringify([startLine, name, qualifiedName]));
    assert.notEqual(
      synthesized,
      undefined,
      `No source declaration for ${node.id} (${qualifiedName})`,
    );
    const binary = synthesized ? name : qualifiedName.slice(prefix.length).replaceAll('.', '$');
    return `${filePath}#${prefix}${binary}`;
  };
}

export function compareJavaStructure(reference, result, typeIdentity, methods) {
  const expected = [];
  const actual = [];
  for (const { file, kind, name, binaryName } of reference.declarations) {
    if (kind === 'Annotation') expected.push(`Annotation ${file}#@${name}`);
    else if (binaryName) expected.push(`${kind} ${file}#${binaryName}`);
    else if (methods) expected.push(`Method ${file}#${name}`);
  }
  for (const node of result.graph.nodes) {
    const type = typeIdentity(node);
    if (type) actual.push(`${node.label} ${type}`);
    else if (methods && node.label === 'Method')
      actual.push(`Method ${node.properties.filePath}#${node.properties.name}`);
  }
  assert.ok(expected.length, 'javac produced no source declarations');
  actual.sort(compareCodeUnits);
  expected.sort(compareCodeUnits);
  assert.deepEqual(actual, expected, 'Java source declarations');
  const heritage = [];
  for (const relation of ['EXTENDS', 'IMPLEMENTS']) {
    for (const edge of result.graph.iterRelationshipsByType(relation)) {
      const from = typeIdentity(result.graph.getNode(edge.sourceId));
      const to = typeIdentity(result.graph.getNode(edge.targetId));
      heritage.push(`${relation} ${from} -> ${to}`);
    }
  }
  const expectedEdges = new Set(
    reference.heritage.map(({ relation, from, to }) => `${relation} ${from} -> ${to}`),
  );
  const actualEdges = new Set(heritage);
  assert.equal(actualEdges.size, heritage.length, 'Duplicate source heritage edge');
  return [
    ...[...expectedEdges]
      .filter((e) => !actualEdges.has(e))
      .map((e) => 'Missing from GitNexus: ' + e),
    ...[...actualEdges]
      .filter((e) => !expectedEdges.has(e))
      .map((e) => 'Unexpected in GitNexus: ' + e),
  ];
}

export function compareConstructors(reference, graph, typeIdentity) {
  const constructors = new Map();
  for (const node of graph.nodes) {
    if (node.label !== 'Constructor') continue;
    const key = node.properties.filePath + '#constructor:' + (node.properties.startLine + 1);
    assert.ok(!constructors.has(key), 'Constructor declaration line is ambiguous: ' + key);
    constructors.set(key, node.id);
  }
  function identity(node) {
    const { filePath, startLine, startColumn } = node.properties;
    if (node.label === 'Constructor') return filePath + '#constructor:' + (startLine + 1);
    return typeIdentity(node) ?? filePath + '#' + (startLine + 1) + ':' + startColumn;
  }
  const observed = new Set();
  for (const edge of graph.iterRelationshipsByType('CALLS')) {
    const target = graph.getNode(edge.targetId);
    if (target.label === 'Constructor' || typeLabels.has(target.label)) {
      observed.add(identity(graph.getNode(edge.sourceId)) + ' -> ' + identity(target));
    }
  }
  assert.ok(reference.constructors.length > 0, 'No source constructor invocations');
  assert.deepEqual(
    observed,
    new Set(reference.constructors.map(({ from, to }) => from + ' -> ' + to)),
    'Source constructor edges',
  );
}
