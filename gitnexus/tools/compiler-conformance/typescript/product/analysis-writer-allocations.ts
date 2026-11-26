import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, it, mock } from 'node:test';
import { registerCases } from '../support/cases.mjs';
import { isolateAnalysisHome } from '../support/analysis-home.js';
import * as config from '../../../../dist/core/lbug/lbug-config.js';
import { resolveAnalysisResourceBudget } from '../../../../dist/core/analysis-resource-budget.js';

await isolateAnalysisHome();
const stopped = new Error('native opener reached');
const open = mock.fn(async (..._args: Parameters<typeof config.openLbugConnection>) => {
  throw stopped;
});
const configMock = mock.module(
  new URL('../../../../dist/core/lbug/lbug-config.js', import.meta.url).href,
  {
    namedExports: {
      ...config,
      openLbugConnection: open,
      getEffectiveBufferPoolSize: () => 2048 * 1024 ** 2,
    },
  },
);
after(() => configMock.restore());
const { runFullAnalysis } = await import('../../../../dist/core/run-analyze.js');
const writerAllocations = [
  { totalMb: undefined, pdg: true, workers: 1, threads: 4 },
  { totalMb: 3072, pdg: false, workers: 1, threads: 4 },
  { totalMb: 6144, pdg: true, workers: 1, threads: 1 },
  { totalMb: 6145, pdg: true, workers: 1, threads: 4 },
  { totalMb: 3072, pdg: true, workers: 2, threads: 4 },
];

registerCases(
  it,
  writerAllocations,
  'opens the graph with $threads threads (budget=$totalMb, pdg=$pdg, workers=$workers)',
  async ({ totalMb, pdg, workers, threads }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-test-writer-allocations-'));
    try {
      const resources = resolveAnalysisResourceBudget({
        effectiveMemoryBytes: 8192 * 1024 ** 2,
        availableCpus: 4,
        modelMemoryMb: 0,
        totalMb,
        workers,
      });
      open.mock.resetCalls();
      await fs.writeFile(path.join(root, 'a.ts'), 'export function a() {return 1;}');
      await assert.rejects(
        runFullAnalysis(
          root,
          { pdg, resources, skipGit: true, skipFts: true, skipAgentsMd: true, skipSkills: true },
          { onProgress: () => {} },
        ),
        { message: stopped.message },
      );
      assert.ok(open.mock.callCount() > 0);
      for (const call of open.mock.calls) {
        assert.equal(call.arguments[2]?.bufferPoolBytes, resources.parse.graphPoolBytes);
        assert.equal(call.arguments[2]?.threads, threads);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
