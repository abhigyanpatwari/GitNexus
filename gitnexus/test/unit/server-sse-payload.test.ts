/**
 * SSE terminal payload wire shape (mountSSEProgress).
 *
 * The `event: complete` payload must carry `repoPath` (the analyzed path)
 * alongside the display `repoName` at BOTH terminal emit sites:
 *   (a) the already-terminal replay (job finished before the client subscribed)
 *   (b) the live subscription (job finishes while the client is connected)
 *
 * Clients reconnect by this identity after "Analyze new" — with duplicate
 * basenames, a name-only payload makes the web UI connect to the first
 * same-named sibling instead of the repo just analyzed (PR #2420 review R2).
 *
 * Imported from `src/server/sse-progress.ts`, NOT from `src/server/api.ts`:
 * that module pulls Express, cors, the LadybugDB native adapter and the whole
 * MCP wiring, which is what made this file cost ~25s to import (#2790 review).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobManager } from '../../src/server/analyze-job.js';
import { startSSEHarness, terminalFrame, type SSEHarness } from '../helpers/sse-harness.js';

const REPO_PATH = '/ws/b/reels';
const REPO_NAME = 'reels';

describe('mountSSEProgress terminal payload', () => {
  let harness: SSEHarness;
  let manager: JobManager;
  let baseUrl = '';

  beforeEach(async () => {
    // Mirrors the production mount in createServer().
    harness = await startSSEHarness('/api/analyze/:jobId/progress');
    manager = harness.manager;
    baseUrl = harness.baseUrl;
  });

  afterEach(() => harness.close());

  it('already-terminal replay includes repoName AND repoPath', async () => {
    const job = manager.createJob({ repoPath: REPO_PATH });
    manager.updateJob(job.id, { status: 'complete', repoName: REPO_NAME });

    const response = await fetch(`${baseUrl}/api/analyze/${job.id}/progress`);
    const body = await response.text();

    expect(body).toContain('event: complete');
    // Exact match locks the wire shape (error is undefined → omitted by JSON).
    expect(terminalFrame(body, 'complete')).toEqual({
      repoName: REPO_NAME,
      repoPath: REPO_PATH,
    });
  });

  it('live subscription terminal event includes repoName AND repoPath', async () => {
    const job = manager.createJob({ repoPath: REPO_PATH });

    // fetch resolves once headers arrive — the handler has already subscribed
    // to progress events by then (subscription happens synchronously).
    const response = await fetch(`${baseUrl}/api/analyze/${job.id}/progress`);
    manager.updateJob(job.id, {
      status: 'analyzing',
      progress: { phase: 'parsing', percent: 30, message: 'Parsing' },
    });
    manager.updateJob(job.id, { status: 'complete', repoName: REPO_NAME });

    const body = await response.text();

    expect(body).toContain('event: complete');
    expect(terminalFrame(body, 'complete')).toEqual({
      repoName: REPO_NAME,
      repoPath: REPO_PATH,
    });
  });
});
