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
import type { RepoMeta } from '../../src/storage/repo-meta.js';
import { RebuildReasonCollector, type RebuildReasonKey } from '../../src/core/rebuild-reasons.js';
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
  vi.restoreAllMocks();
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

/** What the collector held, and printed, at the pre-pipeline summary. */
interface SummaryCall {
  keys: RebuildReasonKey[];
  summary: string | undefined;
}

/**
 * Record every pre-pipeline summary the real collector formats. The pipeline
 * mock ends the run before `runFullAnalysis` can return its keys, so the
 * summary checkpoint is the seam: what was collected, and the exact text it
 * printed, without re-typing any reason.
 */
const recordSummaries = (): SummaryCall[] => {
  const calls: SummaryCall[] = [];
  const formatSummary = RebuildReasonCollector.prototype.formatSummary;
  vi.spyOn(RebuildReasonCollector.prototype, 'formatSummary').mockImplementation(function (
    this: RebuildReasonCollector,
  ) {
    const keys = this.keys();
    const summary = formatSummary.call(this);
    calls.push({ keys, summary });
    return summary;
  });
  return calls;
};

/** Run to the (mocked) pipeline and return the log lines. */
const runToPipeline = async (
  repoPath: string,
  options: {
    useParseCache?: boolean;
    skills?: boolean;
    repairFts?: boolean;
    dropEmbeddings?: boolean;
  },
): Promise<string[]> => {
  const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
  const logs: string[] = [];
  await expect(
    runFullAnalysis(
      repoPath,
      { skipAgentsMd: true, ...options },
      { onProgress: () => {}, onLog: (m: string) => logs.push(m) },
    ),
  ).rejects.toThrow(PIPELINE_REACHED);
  return logs;
};

const writeMeta = async (repoPath: string, meta: Omit<RepoMeta, 'repoPath'>): Promise<void> => {
  const metaDir = path.dirname(getStoragePaths(repoPath).metaPath);
  await fsp.mkdir(metaDir, { recursive: true });
  await saveMeta(metaDir, { repoPath, ...meta });
};

describe('pre-pipeline rebuild reasons (#3137)', () => {
  it.each([
    { flag: 'skills', options: { skills: true }, key: 'skills' },
    { flag: 'useParseCache: false', options: { useParseCache: false }, key: 'parse-cache-bypass' },
  ] as const)(
    '$flag alone contributes only its own reason, once',
    async ({ options, key }) => {
      vi.stubEnv('GITNEXUS_STREAM_GRAPH_EMIT', '1');
      const summaries = recordSummaries();
      const tmpRepo = await createTempDir('gitnexus-rebuild-reason-flag-');
      try {
        const logs = await runToPipeline(tmpRepo.dbPath, options);

        expect(summaries.map(({ keys }) => keys)).toEqual([[key]]);
        const [{ summary }] = summaries;
        expect(logs.filter((m) => m === summary)).toHaveLength(1);
        // The flag no longer masquerades as --force: it forces the rebuild itself.
        expect(captured.options[0]).toMatchObject({ streamGraphEmit: true });
      } finally {
        await tmpRepo.cleanup();
      }
    },
    120_000,
  );

  it('--repair-fts after a retention change yields one content-retention entry', async () => {
    const summaries = recordSummaries();
    const tmpRepo = await createTempDir('gitnexus-rebuild-reason-retention-');
    try {
      // Built under a different retention than this run's default (`full`):
      // both the --repair-fts conversion and the retention gate fire.
      await writeMeta(tmpRepo.dbPath, {
        lastCommit: '',
        indexedAt: new Date(0).toISOString(),
        schemaFingerprint: 'a0b1c2d3e4f5',
        contentRetention: 'none',
      });

      await runToPipeline(tmpRepo.dbPath, { repairFts: true });

      expect(summaries).toHaveLength(1);
      expect(summaries[0].keys.filter((k) => k === 'content-retention')).toHaveLength(1);
      // The repair was converted into the rebuild instead of returning early.
      expect(captured.options).toHaveLength(1);
    } finally {
      await tmpRepo.cleanup();
    }
  }, 120_000);

  it('--drop-embeddings over a stored embedding checkpoint contributes the drop-embeddings reason', async () => {
    const summaries = recordSummaries();
    const tmpRepo = await createTempDir('gitnexus-rebuild-reason-drop-embeddings-');
    try {
      // The reason is collected only where a checkpoint is being discarded.
      await writeMeta(tmpRepo.dbPath, {
        lastCommit: '',
        indexedAt: new Date(0).toISOString(),
        embeddingCheckpoint: {
          at: new Date(0).toISOString(),
          nodesProcessed: 0,
          totalNodes: 1,
          chunksProcessed: 0,
          model: 'test-model',
          dimensions: 384,
          provider: 'local',
          pendingNodeIds: [],
        },
      });

      const logs = await runToPipeline(tmpRepo.dbPath, { dropEmbeddings: true });

      expect(summaries).toHaveLength(1);
      expect(summaries[0].keys).toContain('drop-embeddings');
      expect(logs).toContain('Discarding the embedding checkpoint (--drop-embeddings).');
    } finally {
      await tmpRepo.cleanup();
    }
  }, 120_000);

  it('a first-build claim retry names no schema or runner-identity change', async () => {
    const summaries = recordSummaries();
    const tmpRepo = await createTempDir('gitnexus-rebuild-reason-claim-');
    try {
      // Exactly what the slot claim writes before a first build that then crashed.
      await writeMeta(tmpRepo.dbPath, {
        storagePath: path.dirname(getStoragePaths(tmpRepo.dbPath).metaPath),
        lastCommit: '',
        indexedAt: new Date(0).toISOString(),
      });

      await runToPipeline(tmpRepo.dbPath, {});

      expect(summaries).toEqual([{ keys: [], summary: undefined }]);
    } finally {
      await tmpRepo.cleanup();
    }
  }, 120_000);

  it('a first build of a non-git folder rebuilds structurally with no summary', async () => {
    vi.stubEnv('GITNEXUS_STREAM_GRAPH_EMIT', '1');
    const summaries = recordSummaries();
    const tmpRepo = await createTempDir('gitnexus-rebuild-reason-nongit-');
    try {
      await runToPipeline(tmpRepo.dbPath, {});

      expect(summaries).toEqual([{ keys: [], summary: undefined }]);
      // Structural, not collected: the pipeline sees no forced rebuild.
      expect(captured.options[0]).toMatchObject({ streamGraphEmit: false });
    } finally {
      await tmpRepo.cleanup();
    }
  }, 120_000);
});
