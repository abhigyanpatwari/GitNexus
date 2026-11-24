import assert from 'node:assert/strict';
import { compareCodeUnits } from '../compare.mjs';

const typeLabels = new Set(['Class', 'Enum', 'Interface', 'Record', 'Annotation']);

export function javaTypeIdentity(node) {
  if (!typeLabels.has(node.label)) return undefined;
  const { filePath, name, qualifiedName } = node.properties;
  if (node.label === 'Annotation') return filePath + '#@' + name;
  assert.ok(
    name && (qualifiedName === name || qualifiedName?.endsWith('.' + name)),
    `Inconsistent Java type name for ${node.id}: ${name} (${qualifiedName})`,
  );
  return filePath + '#' + qualifiedName;
}

export function compareJavaStructure(reference, result, typeIdentity, methods) {
  const expected = [];
  const actual = [];
  for (const { file, kind, name, qualifiedName } of reference.declarations) {
    if (kind === 'Annotation') expected.push(`Annotation ${file}#@${name}`);
    else if (qualifiedName) expected.push(`${kind} ${file}#${qualifiedName}`);
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
