import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('Ruby attribute dispatch through the production pipeline', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-accessor-dispatch'), () => {}, {
      workerPoolSize: 1,
    });
  }, 60000);

  it('resolves local, inherited and mixed-in reader calls without crossing singleton boundaries', () => {
    // Ruby attributes are synthesized methods: their reads use CALLS to the
    // Property node, while setter assignments separately produce ACCESSES.
    const reads = getRelationships(result, 'CALLS')
      .filter((edge) => edge.targetLabel === 'Property' && edge.source !== 'write_attributes')
      .map((edge) => `${edge.source}->${edge.target}`)
      .sort();
    expect(reads).toEqual([
      'class_access->class_name',
      'instance_access->inherited',
      'instance_access->name',
      'read_attributes->class_name',
      'read_attributes->inherited',
      'read_attributes->module_label',
      'read_attributes->name',
      'read_attributes->slot',
    ]);
  });

  it('keeps setter writes and their existing access relationship contract', () => {
    const writes = getRelationships(result, 'ACCESSES').map((edge) => ({
      source: edge.source,
      target: edge.target,
      reason: edge.rel.reason,
      confidence: edge.rel.confidence,
    }));
    expect(writes.sort((left, right) => left.target.localeCompare(right.target))).toEqual([
      { source: 'write_attributes', target: 'inherited', reason: 'write', confidence: 1 },
      { source: 'write_attributes', target: 'name', reason: 'write', confidence: 1 },
    ]);
  });

  it('lets a child reader hide its parent method and refuses invalid reader arity', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.filter((edge) => edge.target === 'slot').map((edge) => edge.targetLabel)).toEqual([
      'Property',
    ]);
    expect(calls.filter((edge) => edge.source === 'invalid_reader_arity')).toEqual([]);
  });
});
