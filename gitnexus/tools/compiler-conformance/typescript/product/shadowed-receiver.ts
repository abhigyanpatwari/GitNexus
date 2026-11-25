import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runPipelineFromRepo } from '../../../../src/core/ingestion/pipeline.js';
import { suppressionReasonsAt } from '../../../../test/helpers/resolution-fixture.js';

test('shadowed receivers stop at the TypeScript name claim without a suppression', async () => {
  const root = fileURLToPath(
    new URL(
      '../../../../test/fixtures/compiler-conformance/typescript-shadowed-receiver/',
      import.meta.url,
    ),
  );
  const result = await runPipelineFromRepo(root, () => {});
  for (const [line, column] of [
    [6, 2],
    [11, 4],
    [19, 4],
  ] as const) {
    assert.deepEqual(suppressionReasonsAt(result, ['app.ts', line, column, 'saveTs', 'call']), []);
  }
});
