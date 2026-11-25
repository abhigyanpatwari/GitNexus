import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runPipelineFromRepo } from '../../../../src/core/ingestion/pipeline.js';

test('generic interface dispatch retains each compatible implementation', async () => {
  const root = fileURLToPath(
    new URL(
      '../../../../test/fixtures/compiler-conformance/typescript-generic-interface-dispatch/',
      import.meta.url,
    ),
  );
  const { graph } = await runPipelineFromRepo(root, () => {});
  const implementations = new Map<string, Set<string>>();
  for (const edge of graph.iterRelationshipsByType('CALLS')) {
    if (edge.reason !== 'interface-dispatch') continue;
    const caller = graph.getNode(edge.sourceId)?.properties.name;
    const target = graph.getNode(edge.targetId);
    if (!caller || target?.properties.name !== 'check') continue;
    if (!implementations.has(caller)) implementations.set(caller, new Set());
    implementations.get(caller)?.add(target.properties.filePath);
  }
  assert.deepEqual(implementations.get('run'), new Set(['string-validator.ts']));
  assert.deepEqual(
    implementations.get('runAny'),
    new Set(['string-validator.ts', 'number-validator.ts']),
  );
});
