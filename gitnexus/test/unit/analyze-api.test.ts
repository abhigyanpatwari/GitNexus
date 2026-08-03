import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobManager } from '../../src/server/analyze-job.js';
import {
  startSSEHarness,
  terminalFrame,
  terminalFrameCount,
  type SSEHarness,
} from '../helpers/sse-harness.js';
import {
  resolveEmbedRunOutcome,
  withMeasuredEmbeddingCount,
  type EmbeddingRunResult,
} from '../../src/server/embed-run-outcome.js';
import { mintInterruptedCheckpoint } from '../../src/core/embedding-checkpoint.js';
import {
  measurePersistedEmbeddingCount,
  persistedEmbeddingCountOrUndefined,
} from '../../src/core/embedding-count.js';
import { loadMeta, saveMeta, type RepoMeta } from '../../src/storage/repo-manager.js';
import { deriveEmbeddingMode } from '../../src/core/embedding-mode.js';

/**
 * NOTHING in this file imports `src/server/api.ts` for behavior. That module
 * pulls Express, cors, the LadybugDB native adapter and the whole MCP wiring:
 * reaching three pure helpers through it cost one 30s TIMEOUT and ~20s/~22s on
 * the runs that passed, against a 30s `testTimeout` (#2790 review, finding 9).
 * The helpers now live in `src/server/{sse-progress,embed-run-outcome}.ts` and
 * `src/core/embedding-{count,checkpoint}.ts`, none of which import a database
 * or a server.
 */

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
    const events: Array<{ phase: string; percent: number }> = [];
    const unsub = manager.onProgress(job.id, (progress) => {
      events.push({ phase: progress.phase, percent: progress.percent });
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

    expect(events).toEqual([
      { phase: 'parsing', percent: 30 },
      { phase: 'calls', percent: 50 },
      { phase: 'complete', percent: 100 },
    ]);
  });
});

const IDENTITY = { model: 'test-model', dimensions: 384, provider: 'local' };
const CLEAN_RUN: EmbeddingRunResult = {
  nodesProcessed: 412,
  chunksProcessed: 900,
  failedNodeIds: [],
};
/** Progress figures an in-flight checkpoint records. */
const PROGRESS = { nodesProcessed: 4, totalNodes: 12, chunksProcessed: 9 };

/**
 * ── #2790: an SSE client must not be told a partial run succeeded ──────────
 *
 * `runEmbeddingPipeline` emits `phase: 'ready'` / 100% UNCONDITIONALLY before
 * returning — including when it dropped nodes to endpoint failures — and
 * /api/embed relayed that as a progress phase before it had measured anything
 * or decided the outcome. The relay treated a progress PHASE STRING of
 * 'complete'/'failed' as terminal, so it wrote `event: complete` with
 * `error: undefined`, called `res.end()` and unsubscribed; the route's later
 * `updateJob({status:'failed'})` went into a stream with no listener. The web
 * client fired `onComplete` and showed "ready" while a `GET /api/embed/:jobId`
 * poller saw `failed` — the two consumers of one job disagreeing about whether
 * the data is complete, and a regression against the pre-#2790 behavior where
 * the pipeline threw and the client received the failure.
 *
 * These tests drive the REAL relay over a REAL HTTP server (same harness as
 * server-sse-payload.test.ts) and subscribe BEFORE the misleading event is
 * emitted — subscribing after it is exactly why the previous version of this
 * suite passed while the bug was live.
 */
describe('mountSSEProgress terminality (#2790)', () => {
  let harness: SSEHarness;
  let manager: JobManager;
  let baseUrl = '';

  beforeEach(async () => {
    // Mirrors both production mounts in createServer().
    harness = await startSSEHarness('/api/embed/:jobId/progress');
    manager = harness.manager;
    baseUrl = harness.baseUrl;
  });

  afterEach(() => harness.close());

  it('a partial run reaches the client as a failure, not a success', async () => {
    const job = manager.createJob({ repoPath: '/ws/embed-partial' });
    manager.updateJob(job.id, {
      repoName: 'embed-partial',
      status: 'analyzing',
      progress: { phase: 'embedding', percent: 40, message: 'Embedding nodes (40%)...' },
    });

    // The client is connected and listening BEFORE anything terminal-looking is
    // emitted. `fetch` resolves once headers arrive, and the handler subscribes
    // synchronously before that (see server-sse-payload.test.ts).
    const response = await fetch(`${baseUrl}/api/embed/${job.id}/progress`);

    // A progress event that CLAIMS to be terminal. Production now maps the
    // pipeline's `ready` to 'finalizing' instead, but a phase string must not be
    // able to end the stream no matter who sends it — that is the invariant.
    manager.updateJob(job.id, {
      progress: { phase: 'complete', percent: 100, message: 'Embeddings complete' },
    });

    // Only now does the route learn the run dropped nodes.
    const outcome = resolveEmbedRunOutcome(IDENTITY, {
      nodesProcessed: 10,
      chunksProcessed: 24,
      failedNodeIds: ['node-a', 'node-b'],
    });
    manager.updateJob(job.id, {
      status: 'failed',
      error: outcome.error,
      partial: outcome.partial,
      progress: { phase: 'failed', percent: 100, message: String(outcome.error) },
    });

    const body = await response.text();

    expect(body).not.toContain('event: complete');
    expect(terminalFrameCount(body)).toBe(1);
    expect(terminalFrame(body, 'failed')).toMatchObject({
      repoName: 'embed-partial',
      repoPath: '/ws/embed-partial',
      error: expect.stringContaining('finished partially') as unknown as string,
      // The distinction a UI needs to offer "retry 2 nodes" instead of a bare
      // red chip — carried without adding a `status` union member.
      partial: { kind: 'embedding-partial', pendingNodeCount: 2, nodesProcessed: 10 },
    });
  });

  it('a clean run produces exactly one terminal complete event', async () => {
    const job = manager.createJob({ repoPath: '/ws/embed-clean' });
    manager.updateJob(job.id, {
      repoName: 'embed-clean',
      status: 'analyzing',
      progress: { phase: 'embedding', percent: 40, message: 'Embedding nodes (40%)...' },
    });

    const response = await fetch(`${baseUrl}/api/embed/${job.id}/progress`);

    // What the route actually emits between the pipeline returning and the
    // outcome being known.
    manager.updateJob(job.id, {
      progress: { phase: 'finalizing', percent: 100, message: 'Finalizing embeddings...' },
    });
    manager.updateJob(job.id, {
      status: 'complete',
      progress: { phase: 'complete', percent: 100, message: 'Embeddings complete' },
    });

    const body = await response.text();

    expect(body).not.toContain('event: failed');
    // Exactly one — the status update carries a `progress` too, and #2264's
    // single-emit rule is what keeps that from double-writing the terminal frame.
    expect(terminalFrameCount(body)).toBe(1);
    expect(terminalFrame(body, 'complete')).toEqual({
      repoName: 'embed-clean',
      repoPath: '/ws/embed-clean',
    });
    // The 'finalizing' frame was relayed as ordinary progress, not swallowed.
    expect(body).toContain('"phase":"finalizing"');
  });

  it('the analyze path still closes on its own terminal update', async () => {
    // /api/analyze mounts the same relay. Its worker reports phases like
    // 'parsing' and 'done' (never 'complete'), so the fix must not leave that
    // stream open — it closes when the job's STATUS becomes terminal.
    const job = manager.createJob({ repoPath: '/ws/reels' });
    manager.updateJob(job.id, {
      status: 'analyzing',
      progress: { phase: 'parsing', percent: 30, message: 'Parsing' },
    });

    const response = await fetch(`${baseUrl}/api/embed/${job.id}/progress`);

    manager.updateJob(job.id, {
      progress: { phase: 'done', percent: 100, message: 'Done' },
    });
    manager.updateJob(job.id, { status: 'complete', repoName: 'reels' });

    const body = await response.text();

    expect(terminalFrameCount(body)).toBe(1);
    expect(terminalFrame(body, 'complete')).toEqual({ repoName: 'reels', repoPath: '/ws/reels' });
  });

  it('a job that finished before the client connected replays its outcome', async () => {
    const job = manager.createJob({ repoPath: '/ws/embed-late' });
    const outcome = resolveEmbedRunOutcome(IDENTITY, {
      nodesProcessed: 3,
      chunksProcessed: 9,
      failedNodeIds: ['node-a'],
    });
    manager.updateJob(job.id, {
      status: 'failed',
      repoName: 'embed-late',
      error: outcome.error,
      partial: outcome.partial,
    });

    const body = await (await fetch(`${baseUrl}/api/embed/${job.id}/progress`)).text();

    expect(terminalFrameCount(body)).toBe(1);
    expect(terminalFrame(body, 'failed')).toMatchObject({
      error: expect.stringContaining('finished partially') as unknown as string,
      partial: { kind: 'embedding-partial', pendingNodeCount: 1, nodesProcessed: 3 },
    });
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
 */
describe('resolveEmbedRunOutcome (#2790)', () => {
  it('clears the checkpoint and reports no error on a clean, measured run', () => {
    const outcome = resolveEmbedRunOutcome(IDENTITY, CLEAN_RUN, { measuredEmbeddings: 412 });
    expect(outcome.checkpoint).toBeUndefined();
    expect(outcome.error).toBeUndefined();
    expect(outcome.partial).toBeUndefined();
  });

  it('retains the checkpoint with the dropped ids and reports an error on a partial run', () => {
    const outcome = resolveEmbedRunOutcome(IDENTITY, {
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
      // The run COMPLETED: these nodes provably hold zero rows, so a later
      // identity mismatch may drop the set with a warning instead of wedging
      // every subsequent run (repo-manager.ts).
      kind: 'partial',
    });
    expect(outcome.error).toMatch(/2 node\(s\)/);
    expect(outcome.partial).toEqual({
      kind: 'embedding-partial',
      pendingNodeCount: 2,
      nodesProcessed: 10,
    });
  });

  it('stamps no attempt count on a fresh partial run', () => {
    const outcome = resolveEmbedRunOutcome(
      IDENTITY,
      { nodesProcessed: 10, chunksProcessed: 24, failedNodeIds: ['node-a'] },
      // Resumed from an in-flight marker, not a partial one.
      { resumedFrom: mintInterruptedCheckpoint(IDENTITY, PROGRESS, ['node-a']) },
    );
    expect(outcome.checkpoint).toMatchObject({ kind: 'partial' });
    expect(outcome.checkpoint?.attempts).toBeUndefined();
  });

  it('advances the attempt count only when a resumed pending node fails again', () => {
    const resumedFrom: RepoMeta['embeddingCheckpoint'] = {
      at: new Date(0).toISOString(),
      nodesProcessed: 10,
      totalNodes: 12,
      chunksProcessed: 24,
      ...IDENTITY,
      kind: 'partial',
      attempts: 1,
      pendingNodeIds: ['node-a', 'node-b'],
    };

    // Same node failed again → the retry is not converging; the budget advances.
    expect(
      resolveEmbedRunOutcome(
        IDENTITY,
        { nodesProcessed: 11, chunksProcessed: 26, failedNodeIds: ['node-a'] },
        { resumedFrom },
      ).checkpoint,
    ).toMatchObject({ kind: 'partial', attempts: 2 });

    // The resumed set cleared and DIFFERENT nodes were lost → a fresh partial,
    // so the budget resets. The bound exists for a node the endpoint rejects
    // deterministically, not for an endpoint that is merely flaky.
    expect(
      resolveEmbedRunOutcome(
        IDENTITY,
        { nodesProcessed: 11, chunksProcessed: 26, failedNodeIds: ['node-z'] },
        { resumedFrom },
      ).checkpoint?.attempts,
    ).toBeUndefined();
  });
});

describe('the mid-run marker /api/embed writes (mintInterruptedCheckpoint, #2790)', () => {
  it('stamps interrupted, so resume regenerates a possibly half-written window', () => {
    const checkpoint = mintInterruptedCheckpoint(IDENTITY, PROGRESS, ['node-a', 'node-b']);
    expect(checkpoint).toMatchObject({
      kind: 'interrupted',
      nodesProcessed: 4,
      totalNodes: 12,
      chunksProcessed: 9,
      model: 'test-model',
      dimensions: 384,
      provider: 'local',
      pendingNodeIds: ['node-a', 'node-b'],
    });
    // `attempts` bounds retries of a 'partial' set; an in-flight marker has no
    // such budget because its rows may exist.
    expect(checkpoint.attempts).toBeUndefined();
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
 * The route body is an inline closure inside `createServer`, so its finalize
 * sequence is replayed here over the SAME helpers the route calls, with real
 * meta.json I/O and the real `deriveEmbeddingMode`. The consequence is what
 * these tests pin, not the field.
 */
describe('POST /api/embed records the embedding count it measured', () => {
  let metaDir: string;
  let seeded: RepoMeta;

  beforeEach(async () => {
    metaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-embed-count-'));
  });

  afterEach(async () => {
    await fs.rm(metaDir, { recursive: true, force: true });
  });

  /** What a CLI `analyze` (plus any mid-run checkpoint) leaves on disk. */
  const seedMeta = async (
    embeddings: number | undefined,
    embeddingCheckpoint?: RepoMeta['embeddingCheckpoint'],
  ): Promise<void> => {
    seeded = {
      repoPath: '/repo/embed-count',
      lastCommit: 'abc123',
      indexedAt: new Date(0).toISOString(),
      stats: { nodes: 500, ...(embeddings === undefined ? {} : { embeddings }) },
      embeddingCheckpoint,
    };
    await saveMeta(metaDir, seeded);
  };

  const rowsWith = (cnt: unknown) => async () => [{ cnt } as Record<string, unknown>];

  /** The route's finalize sequence: measure → re-read meta → resolve → write. */
  const finalizeEmbedRun = async (
    runQuery: (cypher: string) => Promise<Array<Record<string, unknown>> | undefined>,
    pipelineResult: EmbeddingRunResult,
  ): Promise<RepoMeta | null> => {
    const measured = await measurePersistedEmbeddingCount(runQuery);
    const finalMeta = (await loadMeta(metaDir)) ?? seeded;
    const outcome = resolveEmbedRunOutcome(IDENTITY, pipelineResult, {
      measuredEmbeddings: persistedEmbeddingCountOrUndefined(measured),
      onDisk: finalMeta,
    });
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
    }, CLEAN_RUN);

    expect(written).toMatchObject({ stats: { nodes: 500, embeddings: 412 } });
    // A clean, MEASURED run clears the checkpoint (#2790 contract).
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

    const written = await finalizeEmbedRun(rowsWith(412), CLEAN_RUN);
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
    // The query throws for reasons unrelated to how many rows were written.
    await expect(
      measurePersistedEmbeddingCount(async () => {
        throw new Error('Connection closed');
      }),
    ).resolves.toMatchObject({ kind: 'unknown', reason: 'Connection closed' });
    // No row / no cell: an empty table would still answer with a 0.
    await expect(measurePersistedEmbeddingCount(async () => [])).resolves.toMatchObject({
      kind: 'unknown',
    });
    await expect(measurePersistedEmbeddingCount(async () => undefined)).resolves.toMatchObject({
      kind: 'unknown',
    });
    // Non-numeric cell — same class of unknown.
    await expect(measurePersistedEmbeddingCount(rowsWith('many'))).resolves.toMatchObject({
      kind: 'unknown',
    });
    // A real zero is still a real answer.
    await expect(measurePersistedEmbeddingCount(rowsWith(0))).resolves.toEqual({
      kind: 'measured',
      count: 0,
    });
  });

  it('leaves the previous count alone when the measurement fails, never writing a fabricated 0', async () => {
    await seedMeta(137);
    const written = await finalizeEmbedRun(async () => {
      throw new Error('Connection closed');
    }, CLEAN_RUN);

    expect(written).toMatchObject({ stats: { embeddings: 137 } });
    // The dangerous direction is wrong-LOW: a fabricated 0 here would arm the
    // wipe the test above describes.
    expect(deriveEmbeddingMode({ force: true }, embeddingCountOf(written))).toMatchObject({
      shouldLoadCache: true,
    });
  });

  it('keeps the recovery marker when a clean run cannot verify its own count', async () => {
    // The state that arms the silent wipe: meta records 0 embeddings (a repo
    // analyzed without them, embedded through the server), the run succeeded,
    // and the count query cannot answer — so no honest count can be stamped.
    const midRunMarker = mintInterruptedCheckpoint(IDENTITY, PROGRESS, ['node-a']);
    await seedMeta(0, midRunMarker);

    const written = await finalizeEmbedRun(async () => {
      throw new Error('Connection closed');
    }, CLEAN_RUN);

    // No fabricated value: neither a 0 nor a NaN/null lands in meta.
    expect(written).toMatchObject({ stats: { nodes: 500, embeddings: 0 } });
    // …and the marker this run wrote SURVIVES, so something on disk still
    // records that embeddings were produced. Clearing it here would leave the
    // index with zero evidence of its own embeddings.
    expect(written?.embeddingCheckpoint).toMatchObject({
      kind: 'interrupted',
      pendingNodeIds: ['node-a'],
    });
  });

  it('still clears the marker on an unverifiable run once meta records embeddings', async () => {
    // Same unmeasurable run, but the recorded count already proves the index is
    // accounted for — nothing needs preserving, so the clean-run contract wins.
    await seedMeta(412, mintInterruptedCheckpoint(IDENTITY, PROGRESS, ['node-a']));

    const written = await finalizeEmbedRun(async () => {
      throw new Error('Connection closed');
    }, CLEAN_RUN);

    expect(written).toMatchObject({ stats: { embeddings: 412 } });
    expect(written?.embeddingCheckpoint).toBeUndefined();
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
      embeddingCheckpoint: {
        pendingNodeIds: ['node-a', 'node-b'],
        nodesProcessed: 300,
        kind: 'partial',
      },
    });
    expect(deriveEmbeddingMode({ force: true }, embeddingCountOf(written))).toMatchObject({
      shouldLoadCache: true,
    });
  });
});

/**
 * Wiring guard for the route. Everything the helpers DECIDE is pinned
 * behaviorally above; what remains is that the inline route closure inside
 * `createServer` still asks them — the helper being right while the call site
 * keeps writing `embeddingCheckpoint: undefined` is exactly the regression
 * #2790 is about, and that closure cannot be reached without booting a server
 * over a real repo + LadybugDB + embedding endpoint. Static-analysis layer of
 * last resort, same precedent as api-readonly-wiring.test.ts.
 */
describe('POST /api/embed route wiring (#2790)', () => {
  const readSource = () =>
    fs.readFile(path.join(__dirname, '..', '..', 'src', 'server', 'api.ts'), 'utf-8');

  /**
   * The body of the route's `withLbugDb` callback — everything that may only
   * run while the database connection is open. Sliced rather than matched with
   * a character-distance regex so a comment edit cannot silently un-assert it.
   */
  const insideWithLbugDb = (source: string): string => {
    const start = source.indexOf('await withLbugDb(lbugPath, async () => {');
    const end = source.indexOf('\n            });', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  };

  it('feeds the pipeline result through resolveEmbedRunOutcome into the finalize write', async () => {
    const source = await readSource();
    // The result is captured, not discarded…
    expect(source).toContain('const pipelineResult = await runEmbeddingPipeline(');
    // …handed to the helper with the finalize context…
    expect(source).toMatch(
      /resolveEmbedRunOutcome\(\s*embeddingIdentity,\s*pipelineResult,\s*finalizeContext,\s*\)/,
    );
    // …and its checkpoint is what the finalize meta write persists (pre-fix: a
    // hardcoded `embeddingCheckpoint: undefined`).
    expect(source).toContain('embeddingCheckpoint: outcome.checkpoint');
    expect(source).toContain('partialRunError = outcome.error;');
    // A partial run does not reach `status: 'complete'`, and carries its detail.
    expect(source).toMatch(
      /partialRunError === undefined[\s\S]{0,400}status: 'complete'[\s\S]{0,600}status: 'failed'/,
    );
    expect(source).toContain('partial: partialRunDetail,');
  });

  it('measures after the WAL flush, inside withLbugDb, and folds the result into the write', async () => {
    const source = await readSource();
    const region = insideWithLbugDb(source);
    // Inside the open connection — this is the route's only chance to stamp
    // `stats.embeddings`, and the next CLI run's preserve-or-wipe decision
    // hangs on it.
    expect(region).toContain('const measuredEmbeddings = await countPersistedEmbeddings();');
    expect(region).toContain('await saveMeta(entry.storagePath, embeddingMeta);');
    // Ordering, without brittle character spans: flush → measure → decide →
    // write. Counting before the flush would describe rows still in the WAL.
    const flushed = region.lastIndexOf('await flushWAL();');
    const measured = region.indexOf('const measuredEmbeddings = await countPersistedEmbeddings();');
    const decided = region.indexOf('const outcome = resolveEmbedRunOutcome(');
    const folded = region.indexOf('embeddingMeta = withMeasuredEmbeddingCount(', measured);
    expect(flushed).toBeLessThan(measured);
    expect(measured).toBeLessThan(decided);
    expect(decided).toBeLessThan(folded);
    expect(region.slice(folded)).toContain('measuredEmbeddings,');
  });

  it('measures in the post-flush checkpoint callback and nowhere else in the pipeline options', async () => {
    const source = await readSource();
    expect(source).toContain(
      'await saveEmbeddingCheckpoint(checkpoint, [], await countPersistedEmbeddings());',
    );
    // The window-start callback fires before any row exists — it must pass no
    // count rather than restate a stale one.
    expect(source).toMatch(
      /onCheckpointWindowStart: async \(\{ nodeIds, \.\.\.checkpoint \}\) => \{\s*await saveEmbeddingCheckpoint\(checkpoint, nodeIds\);\s*\},/,
    );
  });

  it('resolves a found checkpoint through the shared resume decision', async () => {
    const source = await readSource();
    const region = insideWithLbugDb(source);
    // The route asks the SAME decider the CLI does, instead of hard-throwing on
    // any identity mismatch and ignoring `attempts` — the disagreement that let
    // a CLI-written `'partial'` marker wedge every later `POST /api/embed`.
    expect(region).toMatch(/decideEmbeddingResume\(priorCheckpoint, embeddingIdentity\)/);
    // Every action is routed: abort fails the run, abandon warns and proceeds
    // with an empty pending set, resume hands the decision's ids to the pipeline.
    expect(region).toContain("if (resume?.action === 'abort') throw new Error(resume.error);");
    expect(region).toMatch(/resume\?\.action === 'resume'\s*\?\s*resume\.pendingNodeIds/);
    // No second copy of the gate: the route no longer authors its own message.
    expect(region).not.toContain('Cannot resume embedding checkpoint:');
  });

  it('never maps the pipeline ready phase to a phase a client can read as terminal', async () => {
    const source = await readSource();
    // `ready` fires unconditionally before the route knows the outcome (#2790).
    expect(source).toMatch(/p\.phase === 'ready'\s*\?\s*'finalizing'/);
    expect(source).not.toMatch(/p\.phase === 'ready' \? 'complete'/);
  });
});
