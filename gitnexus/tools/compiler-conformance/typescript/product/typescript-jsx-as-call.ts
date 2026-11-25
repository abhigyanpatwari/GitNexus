import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { FIXTURES, getRelationships, runPipelineFromRepo } from '../support/fixture.js';

test('JSX graph edges preserve invocation counts and member access semantics', async () => {
  const result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-jsx-as-call'), () => {});
  const calls = getRelationships(result, 'CALLS');
  for (const [caller, target] of [
    ['useBar', 'Bar'],
    ['Wrapped', 'Foo'],
  ]) {
    assert.equal(
      calls.filter((edge) => edge.source === caller && edge.target === target).length,
      1,
    );
  }
  const accesses = getRelationships(result, 'ACCESSES');
  assert.deepEqual(
    accesses.filter((edge) => edge.source === 'useNamespaced' && edge.target === 'Title'),
    [],
  );
});
