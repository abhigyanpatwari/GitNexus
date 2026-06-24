/**
 * End-to-end coverage for issue #2270: a leading doc comment must survive the
 * full parse pipeline into the node's `description` property (the field the
 * embedding metadata header reads for semantic search). The unit tests stop at
 * the `descriptionExtractor` hook; this exercises the real worker pipeline and
 * the highest-value case — an EXPORTED TS function, whose JSDoc precedes the
 * wrapping `export_statement` (PR #2286 review fix).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from './resolvers/helpers.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

function createTsRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-desc-e2e-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'doc-desc-e2e', version: '1.0.0' }),
  );
  fs.writeFileSync(
    path.join(dir, 'index.ts'),
    [
      '/** Computes the running balance, marker EXPORTEDDOC. */',
      'export function computeBalance(userId: number): number {',
      '  return userId;',
      '}',
      '',
    ].join('\n'),
  );
  return dir;
}

describe('doc-comment description end-to-end (issue #2270)', () => {
  it('surfaces an exported function JSDoc as its node description through the pipeline', async () => {
    const result: PipelineResult = await runPipelineFromRepo(createTsRepo(), () => {}, {
      skipGraphPhases: true,
      workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
      workerPoolSize: 2,
    });

    const descriptions = new Map<string, unknown>();
    result.graph.forEachNode((node) => {
      descriptions.set(`${node.label}:${node.properties.name}`, node.properties.description);
    });

    expect(result.usedWorkerPool).toBe(true);
    expect(descriptions.get('Function:computeBalance')).toContain('EXPORTEDDOC');
  });
});
