import { compareCodeUnits } from '../compare.mjs';
import assert from 'node:assert/strict';

export function checkRecoveredCalls(graph, reference, spec) {
  const sourceMethods = [...reference.methods].filter(([, method]) => method.name !== '<init>');
  assert.equal(sourceMethods.length, spec.sourceMethods, 'Compiler source-method count');
  const position = ({ properties: p }) =>
    p.filePath + '#' + (p.startLine + 1) + ':' + p.startColumn;
  const methods = [...graph.iterNodes()].filter((node) => node.label === 'Method');
  const published = new Set(methods.map((node) => position(node) + ' ' + node.properties.name));
  for (const [location, method] of sourceMethods) {
    assert.ok(
      published.has(location + ' ' + method.name),
      'Missing source method ' + method.name + ' at ' + location,
    );
  }
  const expected = new Set(reference.calls.map((call) => call.from + ' -> ' + call.to));
  const actual = new Set();
  for (const edge of graph.iterRelationshipsByType('CALLS')) {
    if (edge.reason === 'interface-dispatch') continue;
    const from = graph.getNode(edge.sourceId);
    const to = graph.getNode(edge.targetId);
    if (
      [from, to].every(
        (n) =>
          n?.label === 'Method' &&
          n.properties.filePath.endsWith('.java') &&
          !n.properties.synthetic,
      )
    )
      actual.add(position(from) + ' -> ' + position(to));
  }
  const differences = [
    ...[...expected].filter((edge) => !actual.has(edge)).map((edge) => '- ' + edge),
    ...[...actual].filter((edge) => !expected.has(edge)).map((edge) => '+ ' + edge),
  ].sort(compareCodeUnits);
  assert.deepEqual(
    differences,
    [...(spec.callDifferences ?? [])].sort(compareCodeUnits),
    spec.reason ?? 'Compiler and published caller-target agreement',
  );
}
