import { compareCodeUnits } from '../compare.mjs';
import assert from 'node:assert/strict';

function declaration(node) {
  assert.ok(node, 'Missing published declaration');
  const { filePath, startLine, startColumn } = node.properties;
  assert.ok(filePath && Number.isInteger(startLine) && Number.isInteger(startColumn), node.id);
  return filePath + '#' + (startLine + 1) + ':' + startColumn;
}

function matchesCaller(node, caller) {
  if (caller.endsWith('#')) return node.id.startsWith(caller);
  return node.id === caller || node.properties.name === caller;
}

export function checkCalls(graph, ref, spec) {
  const { caller, member, source } = spec;
  const message = caller + ' calls ' + member;
  const nodes = [...graph.iterNodes()].filter(
    (n) => (caller.includes(':') || n.label === 'Method') && matchesCaller(n, caller),
  );
  assert.ok(nodes.length, 'Missing caller ' + caller);
  if (source.length)
    assert.deepEqual(nodes.map(declaration).sort(compareCodeUnits), source, message + ' source');
  const ids = new Set(nodes.map((n) => n.id));
  const actual = [...graph.iterRelationshipsByType('CALLS')].filter(
    (edge) =>
      ids.has(edge.sourceId) &&
      edge.targetId !== spec.exceptTarget &&
      (member === '*' || graph.getNode(edge.targetId)?.properties.name === member),
  );
  const expected = [
    ...new Set(
      ref.calls
        .filter((call) => source.includes(call.from) && (member === '*' || call.name === member))
        .map((call) => call.to),
    ),
  ].sort(compareCodeUnits);
  if (spec.compilerTargets === undefined)
    assert.equal(expected.length, spec.targets ?? 1, message + ' javac target count');
  if (spec.compilerTargets) {
    assert.deepEqual(expected, spec.compilerTargets, message + ' compiler selection');
    const targets = actual.map((edge) => edge.targetId).sort(compareCodeUnits);
    if (spec.excludes)
      assert.ok(!targets.includes(spec.excludes), message + ' selected ' + spec.excludes);
    else assert.deepEqual(targets, spec.published, message + ' recovery graph');
  } else {
    assert.deepEqual(
      actual.map((edge) => declaration(graph.getNode(edge.targetId))).sort(compareCodeUnits),
      expected,
      message,
    );
  }
}

export function checkRelationships(graph, { type, where, projection, expected }) {
  const edges = [...graph.iterRelationshipsByType(type)].filter((edge) => {
    if (!where) return true;
    const value = edge[where.key.slice('rel.'.length)];
    return where.op === 'startsWith' ? value.startsWith(where.value) : value === where.value;
  });
  const actual = edges
    .map((edge) => projection.replaceAll(/#\{rel\.(\w+)\}/g, (_, key) => edge[key]))
    .sort(compareCodeUnits);
  assert.deepEqual(actual, expected, type + ' graph relationships');
}
