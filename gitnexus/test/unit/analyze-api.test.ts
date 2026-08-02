import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobManager } from '../../src/server/analyze-job.js';
import { loadMeta, saveMeta, type RepoMeta } from '../../src/storage/repo-manager.js';
import { deriveEmbeddingMode } from '../../src/core/embedding-mode.js';

describe('analyze API logic', () => {
  let manager: JobManager;

  beforeEach(() => {
    manager = new JobManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  it('creates a job and returns 202 shape', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    const response = { jobId: job.id, status: job.status };
    expect(response.jobId).toBeTruthy();
    expect(response.status).toBe('queued');
  });

  it('rejects when job already active for different repo', () => {
    const job1 = manager.createJob({ repoUrl: 'https://github.com/user/repo1' });
    manager.updateJob(job1.id, { status: 'analyzing' });
    expect(() => manager.createJob({ repoUrl: 'https://github.com/user/repo2' })).toThrow(
      /already in progress/,
    );
  });

  it('returns existing job for same repo URL', () => {
    const job1 = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    manager.updateJob(job1.id, { status: 'analyzing' });
    const job2 = manager.createJob({ repoUrl: 'https://github.com/user/repo' });
    expect(job2.id).toBe(job1.id);
  });

  it('SSE progress listener receives all events including terminal', () => {
    const job = manager.createJob({ repoUrl: 'https://github.com/user/sse-test' });
    const events: any[] = [];
    const unsub = manager.onProgress(job.id, (progress) => {
      events.push(progress);
    });

    manager.updateJob(job.id, {
      status: 'analyzing',
      progress: { phase: 'parsing', percent: 30, message: 'Parsing' },
    });
    manager.updateJob(job.id, {
      progress: { phase: 'calls', percent: 50, message: 'Tracing calls' },
    });
    manager.updateJob(job.id, { status: 'complete', repoName: 'sse-test' });

    unsub();

    expect(events.length).toBe(3);
    expect(events[0].phase).toBe('parsing');
    expect(events[1].phase).toBe('calls');
    expect(events[2].phase).toBe('complete');
    expect(events[2].percent).toBe(100);
  });
});

/**
 * ── #2790: POST /api/embed must not report unqualified success ─────────
 *
 * The pipeline no longer throws when a sub-batch loses its endpoint — it
 * deletes the affected nodes' rows and names them in `failedNodeIds`. The route
 * discarded that receipt: it cleared `embeddingCheckpoint` and marked the job
 * 'complete', so a partial run looked identical to a clean one and the dropped
 * nodes were never retried (pre-#2790 the pipeline threw and the catch marked
 * the job failed).
 *
 * The route body is an inline closure inside `createServer` — only reachable by
 * booting an HTTP server over a real repo, a real LadybugDB and a real
 * embedding endpoint. There is no behavioral harness for it (the only existing
 * /api/embed test, api-readonly-wiring.test.ts, is source-text matching), so the
 * decision it makes is exercised through the exported helper it delegates to,
 * and the observable job outcome through the real JobManager the route uses.
 */
describe('POST /api/embed partial-run outcome (#2790)', () => {
  const identity = { model: 'test-model', dimensions: 384, provider: 'local' };

  it('clears the checkpoint and reports no error on a clean run', async () => {
    const { resolveEmbedRunOutcome } = await import('../../src/server/api.js');
    const outcome = resolveEmbedRunOutcome(identity, {
      nodesProcessed: 12,
      chunksProcessed: 30,
      failedNodeIds: [],
    });
    expect(outcome.checkpoint).toBeUndefined();
    expect(outcome.error).toBeUndefined();
  });

  it('retains the checkpoint with the dropped ids and reports an error on a partial run', async () => {
    const { resolveEmbedRunOutcome } = await import('../../src/server/api.js');
    const outcome = resolveEmbedRunOutcome(identity, {
      nodesProcessed: 10,
      chunksProcessed: 24,
      failedNodeIds: ['node-a', 'node-b'],
    });
    // The record of what failed survives — this is the pending set the next
    // run's `forceReembedNodeIds` re-embeds.
    expect(outcome.checkpoint).toMatchObject({
      pendingNodeIds: ['node-a', 'node-b'],
      nodesProcessed: 10,
      totalNodes: 12,
      chunksProcessed: 24,
      model: 'test-model',
      dimensions: 384,
      provider: 'local',
    });
    expect(outcome.error).toMatch(/2 node\(s\)/);
  });

  it('a partial run is distinguishable from a clean one on the job record and the SSE stream', async () => {
    const { resolveEmbedRunOutcome } = await import('../../src/server/api.js');
    const manager = new JobManager();
    try {
      const partial = resolveEmbedRunOutcome(identity, {
        nodesProcessed: 10,
        chunksProcessed: 24,
        failedNodeIds: ['node-a'],
      });
      const job = manager.createJob({ repoPath: '/tmp/embed-partial' });
      manager.updateJob(job.id, { status: 'analyzing' });
      // The pipeline's `ready` phase already mapped to 'complete' before the
      // route could know anything failed — the terminal update must correct it.
      manager.updateJob(job.id, {
        progress: { phase: 'complete', percent: 100, message: 'Embeddings complete' },
      });

      const events: Array<{ phase: string; message: string }> = [];
      const unsub = manager.onProgress(job.id, (progress) =>
        events.push({ phase: progress.phase, message: progress.message }),
      );
      manager.updateJob(job.id, {
        status: 'failed',
        error: partial.error,
        progress: { phase: 'failed', percent: 100, message: String(partial.error) },
      });
      unsub();

      expect(manager.getJob(job.id)).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('finished partially'),
        progress: { phase: 'failed' },
      });
      expect(events).toEqual([
        { phase: 'failed', message: expect.stringContaining('finished partially') },
      ]);
    } finally {
      manager.dispose();
    }
  });
});

/**
 * Wiring guard for the same route. The behavioral tests above pin the DECISION;
 * this pins that the route still asks for it — the helper being right while the
 * call site keeps writing `embeddingCheckpoint: undefined` is exactly the
 * regression #2790 is about, and the route body cannot be reached without
 * booting a server over a real repo + DB + endpoint. Static-analysis layer,
 * same precedent as api-readonly-wiring.test.ts.
 */
describe('POST /api/embed partial-run wiring (#2790)', () => {
  it('feeds the pipeline result through resolveEmbedRunOutcome into the finalize write', async () => {
    const source = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'server', 'api.ts'),
      'utf-8',
    );
    // The result is captured, not discarded…
    expect(source).toMatch(/const pipelineResult = await runEmbeddingPipeline\(/);
    // …handed to the helper, and its checkpoint is what the finalize meta write
    // persists (pre-fix: a hardcoded `embeddingCheckpoint: undefined`).
    expect(source).toMatch(
      /resolveEmbedRunOutcome\(embeddingIdentity, pipelineResult\)[\s\S]{0,400}embeddingCheckpoint: outcome\.checkpoint/,
    );
    // …and a partial run does not reach `status: 'complete'`.
    expect(source).toMatch(
      /partialRunError === undefined[\s\S]{0,80}status: 'complete'[\s\S]{0,120}status: 'failed'/,
    );
  });
});

/**
 * ── The /api/embed count omission (silent embedding loss) ──────────────
 *
 * The route generated embeddings and wrote `embeddingCheckpoint`, but never
 * `stats.embeddings`. A repo embedded purely through the server therefore kept
 * whatever count the last CLI `analyze` stamped — `0` for a repo analyzed
 * without embeddings. The next CLI run reads that as `existingEmbeddingCount`,
 * `deriveEmbeddingMode` sees `hasExisting: false` → `shouldLoadCache: false`,
 * and `gitnexus analyze --force` wipes the database with no cache load: every
 * server-generated embedding is destroyed with no warning.
 *
 * The route body is an inline closure inside `createServer` (see the #2790
 * block above), so its finalize sequence is replayed here over the SAME
 * exported helpers the route calls, with real meta.json I/O and the real
 * `deriveEmbeddingMode`. The consequence is what these tests pin, not the field.
 */
describe('POST /api/embed records the embedding count it measured', () => {
  const identity = { model: 'test-model', dimensions: 384, provider: 'local' };
  const cleanRun = { nodesProcessed: 412, chunksProcessed: 900, failedNodeIds: [] };
  let metaDir: string;
  let seeded: RepoMeta;

  beforeEach(async () => {
    metaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-embed-count-'));
  });

  afterEach(async () => {
    await fs.rm(metaDir, { recursive: true, force: true });
  });

  /** What a CLI `analyze` leaves on disk before the server embeds anything. */
  const seedMeta = async (embeddings: number | undefined): Promise<void> => {
    seeded = {
      repoPath: '/repo/embed-count',
      lastCommit: 'abc123',
      indexedAt: new Date(0).toISOString(),
      stats: { nodes: 500, ...(embeddings === undefined ? {} : { embeddings }) },
    };
    await saveMeta(metaDir, seeded);
  };

  const rowsWith = (cnt: unknown) => async () => [{ cnt } as Record<string, unknown>];

  /** The route's finalize sequence: measure → resolve outcome → write meta. */
  const finalizeEmbedRun = async (
    runQuery: (cypher: string) => Promise<Array<Record<string, unknown>> | undefined>,
    pipelineResult: { nodesProcessed: number; chunksProcessed: number; failedNodeIds: string[] },
  ): Promise<RepoMeta | null> => {
    const { measurePersistedEmbeddingCount, resolveEmbedRunOutcome, withMeasuredEmbeddingCount } =
      await import('../../src/server/api.js');
    const measured = await measurePersistedEmbeddingCount(runQuery);
    const outcome = resolveEmbedRunOutcome(identity, pipelineResult);
    const finalMeta = (await loadMeta(metaDir)) ?? seeded;
    await saveMeta(
      metaDir,
      withMeasuredEmbeddingCount(
        { ...finalMeta, embeddingCheckpoint: outcome.checkpoint },
        measured,
      ),
    );
    return loadMeta(metaDir);
  };

  const embeddingCountOf = (meta: RepoMeta | null): number => meta?.stats?.embeddings ?? 0;

  it('writes the measured count into meta on a clean run, without disturbing the other stats', async () => {
    await seedMeta(0);
    const asked: string[] = [];
    const written = await finalizeEmbedRun(async (cypher) => {
      asked.push(cypher);
      return [{ cnt: 412 }];
    }, cleanRun);

    expect(written).toMatchObject({ stats: { nodes: 500, embeddings: 412 } });
    // A clean run still clears the checkpoint (#2790 contract, unchanged).
    expect(written?.embeddingCheckpoint).toBeUndefined();
    // Measured, not restated: the count comes from the live embedding table.
    expect(asked).toEqual([expect.stringMatching(/MATCH \(e:\w+\) RETURN count\(e\) AS cnt/)]);
  });

  it('is what makes the next CLI run preserve instead of wipe', async () => {
    await seedMeta(0);

    // Pre-fix state: the server embedded 412 nodes but meta still says 0.
    const stale = embeddingCountOf(await loadMeta(metaDir));
    expect(stale).toBe(0);
    expect(deriveEmbeddingMode({ force: true }, stale)).toMatchObject({
      // `--force` rebuilds without loading the embedding cache → the 412
      // server-generated vectors are destroyed.
      shouldLoadCache: false,
      preserveExistingEmbeddings: false,
    });

    const written = await finalizeEmbedRun(rowsWith(412), cleanRun);
    const honest = embeddingCountOf(written);
    expect(honest).toBe(412);

    // Post-fix: `--force` loads the cache and regenerates on top of it rather
    // than discarding the index. (`preserveExistingEmbeddings` is false here by
    // design — `--force` upgrades to `forceRegenerateEmbeddings`; the wipe
    // protection is `shouldLoadCache`.)
    expect(deriveEmbeddingMode({ force: true }, honest)).toMatchObject({
      shouldLoadCache: true,
      forceRegenerateEmbeddings: true,
    });
    // A routine `analyze` preserves them outright.
    expect(deriveEmbeddingMode({}, honest)).toMatchObject({
      shouldLoadCache: true,
      preserveExistingEmbeddings: true,
    });
  });

  it('treats an unanswerable count query as unknown rather than 0', async () => {
    const { measurePersistedEmbeddingCount } = await import('../../src/server/api.js');
    // The query throws for reasons unrelated to how many rows were written.
    await expect(
      measurePersistedEmbeddingCount(async () => {
        throw new Error('Connection closed');
      }),
    ).resolves.toBeUndefined();
    // No row / no cell: an empty table would still answer with a 0.
    await expect(measurePersistedEmbeddingCount(async () => [])).resolves.toBeUndefined();
    await expect(measurePersistedEmbeddingCount(async () => undefined)).resolves.toBeUndefined();
    // Non-numeric cell — same class of unknown.
    await expect(measurePersistedEmbeddingCount(rowsWith('many'))).resolves.toBeUndefined();
    // A real zero is still a real answer.
    await expect(measurePersistedEmbeddingCount(rowsWith(0))).resolves.toBe(0);
  });

  it('leaves the previous count alone when the measurement fails, never writing a fabricated 0', async () => {
    await seedMeta(137);
    const written = await finalizeEmbedRun(async () => {
      throw new Error('Connection closed');
    }, cleanRun);

    expect(written).toMatchObject({ stats: { embeddings: 137 } });
    // The dangerous direction is wrong-LOW: a fabricated 0 here would arm the
    // wipe the test above describes.
    expect(deriveEmbeddingMode({ force: true }, embeddingCountOf(written))).toMatchObject({
      shouldLoadCache: true,
    });
  });

  it('records the honest count on a partial run, alongside the pending checkpoint', async () => {
    await seedMeta(0);
    const written = await finalizeEmbedRun(rowsWith(300), {
      nodesProcessed: 300,
      chunksProcessed: 700,
      failedNodeIds: ['node-a', 'node-b'],
    });

    // A partial index that is honest about itself survives the next run: the
    // count keeps `--force` from wiping it, the checkpoint re-embeds the rest.
    expect(written).toMatchObject({
      stats: { embeddings: 300 },
      embeddingCheckpoint: { pendingNodeIds: ['node-a', 'node-b'], nodesProcessed: 300 },
    });
    expect(deriveEmbeddingMode({ force: true }, embeddingCountOf(written))).toMatchObject({
      shouldLoadCache: true,
    });
  });
});

/**
 * Wiring guard for the count fix. The behavioral tests above pin the helpers;
 * this pins that the route calls them — and calls them in the one place where
 * the answer is trustworthy: after `flushWAL()` (so the count describes durable
 * rows) and inside `withLbugDb` (so the connection is still open).
 */
describe('POST /api/embed count wiring', () => {
  const readSource = () =>
    fs.readFile(path.join(__dirname, '..', '..', 'src', 'server', 'api.ts'), 'utf-8');

  it('measures after the WAL flush and folds the result into the finalize write', async () => {
    const source = await readSource();
    expect(source).toMatch(
      /await flushWAL\(\);[\s\S]{0,600}const measuredEmbeddings = await measurePersistedEmbeddingCount\(executeQuery\);[\s\S]{0,600}withMeasuredEmbeddingCount\([\s\S]{0,200}measuredEmbeddings/,
    );
  });

  it('measures in the post-flush checkpoint callback and nowhere else in the pipeline options', async () => {
    const source = await readSource();
    expect(source).toMatch(
      /onCheckpoint: async \(checkpoint\) => \{[\s\S]{0,300}await flushWAL\(\);[\s\S]{0,200}measurePersistedEmbeddingCount\(executeQuery\)/,
    );
    // The window-start callback fires before any row exists — it must pass no
    // count rather than restate a stale one.
    expect(source).toMatch(
      /onCheckpointWindowStart: async \(\{ nodeIds, \.\.\.checkpoint \}\) => \{\s*await saveEmbeddingCheckpoint\(checkpoint, nodeIds\);\s*\},/,
    );
  });
});
