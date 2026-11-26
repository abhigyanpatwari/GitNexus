import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { expect } from 'expect';
import { runPipelineFromRepo } from '../support/fixture.js';
import type { PipelineResult } from '../../../../src/types/pipeline.js';

it('surfaces an exported function JSDoc as its node description through the pipeline', async () => {
  const result: PipelineResult = await runPipelineFromRepo(
    fileURLToPath(
      new URL(
        '../../../../test/fixtures/compiler-conformance/typescript-exported-doc-comment/',
        import.meta.url,
      ),
    ),
    () => {},
    {
      skipGraphPhases: true,
      workerPoolSize: 2,
    },
  );

  const descriptions = new Map<string, unknown>();
  result.graph.forEachNode((node) => {
    descriptions.set(`${node.label}:${node.properties.name}`, node.properties.description);
  });

  expect(result.usedWorkerPool).toBe(true);
  expect(descriptions.get('Function:computeBalance')).toContain('EXPORTEDDOC');
});
