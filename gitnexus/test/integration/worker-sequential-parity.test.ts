/**
 * Worker-mode vs sequential-mode parity (#1741 / Problem D).
 *
 * rc99 produced almost no bindings/edges (13 bindings vs rc91's 106,305)
 * because a worker-path failure left extracted results unmerged while the run
 * still reported success. This test pins the invariant that regression broke:
 * for the same repo, the worker pool and the sequential path must produce the
 * SAME graph — identical CALLS / IMPORTS / DEFINES / HAS_METHOD edges and the
 * same defs. A silent divergence (either mode dropping results) fails here
 * instead of shipping a hollow index.
 *
 * Requires the compiled worker (`dist/.../parse-worker.js`); the integration
 * runner builds it via `pretest:integration`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import {
  runPipelineFromRepo,
  getRelationships,
  getNodesByLabel,
  edgeSet,
  type PipelineResult,
} from './resolvers/helpers.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'cross-file-binding', 'ts-simple');

const runMode = (mode: 'worker' | 'sequential'): Promise<PipelineResult> =>
  runPipelineFromRepo(FIXTURE, () => {}, {
    skipGraphPhases: true,
    // Force the worker-pool gate low so even a 3-file fixture engages the pool
    // in worker mode (production threshold is 15 files / 512 KB).
    workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
    ...(mode === 'worker'
      ? { workerPoolSize: 2 }
      : // skipWorkers is the explicit "parse sequentially" path (the supported
        // way to opt out of workers, equivalent to --workers 0). It never
        // creates a pool, so the #1741 startup fail-fast does not apply.
        { skipWorkers: true }),
  });

describe('worker vs sequential parity (#1741 Problem D)', () => {
  let worker: PipelineResult;
  let sequential: PipelineResult;

  beforeAll(async () => {
    worker = await runMode('worker');
    sequential = await runMode('sequential');
  }, 120_000);

  it('worker mode genuinely used the pool; sequential did not (guards against silent fallback)', () => {
    expect(worker.usedWorkerPool).toBe(true);
    expect(sequential.usedWorkerPool).toBe(false);
  });

  it.each(['CALLS', 'IMPORTS', 'DEFINES', 'HAS_METHOD'])(
    'produces identical %s edges in both modes',
    (relType) => {
      const w = edgeSet(getRelationships(worker, relType));
      const s = edgeSet(getRelationships(sequential, relType));
      expect(w).toEqual(s);
    },
  );

  it('does not silently collapse to ~zero edges (the rc99 regression signature)', () => {
    // A healthy run of this cross-file fixture has real CALLS and IMPORTS in
    // BOTH modes. The rc99 collapse showed up as near-empty output.
    expect(edgeSet(getRelationships(worker, 'CALLS')).length).toBeGreaterThan(0);
    expect(edgeSet(getRelationships(worker, 'IMPORTS')).length).toBeGreaterThan(0);
    expect(edgeSet(getRelationships(sequential, 'CALLS')).length).toBeGreaterThan(0);
    expect(edgeSet(getRelationships(sequential, 'IMPORTS')).length).toBeGreaterThan(0);
  });

  it.each(['Class', 'Function', 'Method'])(
    'produces identical %s definitions in both modes',
    (label) => {
      expect(getNodesByLabel(worker, label)).toEqual(getNodesByLabel(sequential, label));
    },
  );
});
