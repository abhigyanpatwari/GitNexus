/**
 * Streamed structural emit must be resolved AFTER the guards that force a full
 * rebuild (#2680 / PR #2793).
 *
 * `resolveStreamGraphEmit` gates on `options.force`, which several freshness
 * guards rebind long after function entry — see the comment at the
 * `resolveStreamGraphEmit` call in `run-analyze.ts` for the full list.
 * Resolving at entry froze it `false` for every rebuild they trigger, so the
 * pipeline took the in-memory emit path exactly when the #2649 memory relief
 * matters most — and a schema bump makes EVERY existing index take that path on
 * its next `analyze`.
 *
 * The seam: mock `runPipelineFromRepo` so it records the `PipelineOptions` the
 * orchestrator actually built and then rejects. That asserts the real wiring
 * (`streamGraphEmit` + `graphEmitCsvDir` as handed to the pipeline) rather than
 * re-testing the pure resolver, which `stream-graph-emit-config.test.ts`
 * already covers. Everything after the pipeline call is out of scope, so the
 * mock's rejection is the intended end of the run.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { getStoragePaths, saveMeta } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

type PipelineModule = typeof import('../../src/core/ingestion/pipeline.js');
type CapturedPipelineOptions = NonNullable<Parameters<PipelineModule['runPipelineFromRepo']>[2]>;

/** Sentinel: the pipeline was reached, and the run ends there by design. */
const PIPELINE_REACHED = 'stream-graph-emit-ordering: pipeline reached';

const captured = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock('../../src/core/ingestion/pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<PipelineModule>();
  return {
    ...actual,
    runPipelineFromRepo: (
      _repoPath: string,
      _onProgress: unknown,
      options: unknown,
    ): Promise<never> => {
      captured.options.push(options);
      return Promise.reject(new Error(PIPELINE_REACHED));
    },
  };
});

afterEach(() => {
  captured.options.length = 0;
  vi.unstubAllEnvs();
});

describe('streamGraphEmit is resolved after the force-mutating freshness guards', () => {
  it('arms streaming for the rebuild a schema-fingerprint mismatch forces', async () => {
    // Pin the escape hatch ON so the assertion cannot be moved by ambient env.
    // Before the fix this changed nothing: `force` was still unset at the entry
    // read, and the `force !== true` short-circuit precedes the env lookup.
    vi.stubEnv('GITNEXUS_STREAM_GRAPH_EMIT', '1');

    const tmpRepo = await createTempDir('gitnexus-stream-order-');
    const repoPath = tmpRepo.dbPath;
    try {
      const { metaPath } = getStoragePaths(repoPath);
      const metaDir = path.dirname(metaPath);
      await fsp.mkdir(metaDir, { recursive: true });
      // An index built from a DIFFERENT schema — what an already-indexed repo
      // looks like on its first analyze after the DDL changes.
      await saveMeta(metaDir, {
        repoPath,
        lastCommit: '',
        indexedAt: new Date(0).toISOString(),
        schemaFingerprint: 'a0b1c2d3e4f5',
        fileHashes: { 'src/a.ts': 'stale-hash' },
      });

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const logs: string[] = [];

      // NOTE: no `force` from the caller — the rebuild is entirely guard-driven,
      // which is the whole point.
      await expect(
        runFullAnalysis(
          repoPath,
          { skipAgentsMd: true },
          { onProgress: () => {}, onLog: (m: string) => logs.push(m) },
        ),
      ).rejects.toThrow(PIPELINE_REACHED);

      // The schema-version guard is what supplied `force` on this run.
      expect(logs.filter((m) => m.includes('index schema changed'))).toHaveLength(1);

      expect(captured.options).toHaveLength(1);
      const pipelineOptions = captured.options[0] as CapturedPipelineOptions;
      // The regression: pre-fix this was `false` / `undefined`, and the run
      // built the whole relationship set in memory.
      expect(pipelineOptions).toMatchObject({ streamGraphEmit: true });
      // The paired CSV dir must be armed with it — the two are resolved from one
      // value precisely so they cannot disagree.
      expect(typeof pipelineOptions.graphEmitCsvDir).toBe('string');
    } finally {
      await tmpRepo.cleanup();
    }
  }, 120_000);
});
