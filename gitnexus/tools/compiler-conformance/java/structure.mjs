import assert from 'node:assert/strict';

const typeLabels = new Set(['Class', 'Enum', 'Interface', 'Record', 'Annotation']);

// Java source uses dots for member types. Class files use '$', including javac's
// per-host numbering for anonymous and local declarations.
export function javaTypeIdentity(reference) {
  const packages = new Map();
  for (const { file, binaryName } of reference.declarations) {
    if (binaryName) packages.set(file, binaryName.slice(0, binaryName.lastIndexOf('.') + 1));
  }
  return (node) => {
    if (!typeLabels.has(node.label)) return undefined;
    const { filePath, name, qualifiedName } = node.properties;
    // Annotation graph nodes expose their source name without a qualifiedName.
    if (node.label === 'Annotation') return filePath + '#@' + name;
    const prefix = packages.get(filePath) ?? '';
    assert.ok(qualifiedName?.startsWith(prefix), `Missing qualified Java name for ${node.id}`);
    const binary = /\$\d/.test(name)
      ? name
      : qualifiedName.slice(prefix.length).replaceAll('.', '$');
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
  assert.deepEqual(actual.sort(), expected.sort(), 'Java source declarations');
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
