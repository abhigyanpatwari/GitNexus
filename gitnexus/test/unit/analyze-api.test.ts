import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JobManager } from '../../src/server/analyze-job.js';

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
