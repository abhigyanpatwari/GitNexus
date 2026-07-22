import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('Python calls through constructor-assigned receiver fields', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-constructor-field-receiver'),
      () => {},
    );
  }, 60_000);

  it('resolves all production callers to the receiver-constrained method', () => {
    const productionCalls = getRelationships(result, 'CALLS').filter(
      (edge) =>
        edge.target === 'extract_and_store_graph' &&
        edge.targetFilePath === 'knowledge_graph_service.py',
    );

    expect(productionCalls.map((edge) => `${edge.sourceFilePath}:${edge.source}`).sort()).toEqual([
      'memory_service.py:archive_memory',
      'memory_service.py:ingest_memory',
      'memory_service.py:restore_memory',
      'memory_service.py:store_memory',
    ]);
    expect(productionCalls.every((edge) => edge.rel.confidence >= 0.85)).toBe(true);
  });

  it('does not redirect production calls to the same-named decoy', () => {
    const misresolved = getRelationships(result, 'CALLS').filter(
      (edge) =>
        edge.sourceFilePath === 'memory_service.py' &&
        edge.target === 'extract_and_store_graph' &&
        edge.targetFilePath === 'test_fixture.py',
    );

    expect(misresolved).toEqual([]);
  });
});
