import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { runPipelineFromRepo } from '../support/fixture.js';

test('an explicit export disambiguates colliding star exports in the resolution ledger', async () => {
  const fixture = path.resolve(
    import.meta.dirname,
    '../../../../test/fixtures/compiler-conformance/typescript-named-over-star',
  );
  const result = await runPipelineFromRepo(fixture, () => {});
  assert.deepEqual(
    result.resolutionOutcomes.filter((outcome) => outcome.kind === 'reexport-ambiguous'),
    [],
  );
});
