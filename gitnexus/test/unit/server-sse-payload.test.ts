/**
 * SSE terminal payload wire shape (mountSSEProgress).
 *
 * The `event: complete` payload carries the display `repoName` at BOTH
 * terminal emit sites:
 *   (a) the already-terminal replay (job finished before the client subscribed)
 *   (b) the live subscription (job finishes while the client is connected)
 *
 * The analyzed filesystem path is NOT on this unauthenticated stream: `/api/ops`
 * enumerates job ids, so a LAN or official-Vercel origin must not recover
 * operator home directories from a terminal frame. Clients reconnect by the
 * opaque `repoId` (matches `id` on `GET /api/repos`). Older servers that still emit `repoPath` keep working in the UI.
 *
 * Imported from `src/server/sse-progress.ts`, NOT from `src/server/api.ts`:
 * that module pulls Express, cors, the LadybugDB native adapter and the whole
 * MCP wiring, which is what made this file cost ~25s to import (#2790 review).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobManager } from '../../src/server/analyze-job.js';
import { publicRepoId } from '../../src/server/public-repo-id.js';
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

  it('already-terminal replay includes repoName and omits repoPath', async () => {
    const job = manager.createJob({ repoPath: REPO_PATH });
    manager.updateJob(job.id, { status: 'complete', repoName: REPO_NAME });

    const response = await fetch(`${baseUrl}/api/analyze/${job.id}/progress`);
    const body = await response.text();

    expect(body).toContain('event: complete');
    expect(body).not.toContain(REPO_PATH);
    // Exact match locks the wire shape (error is undefined → omitted by JSON).
    expect(terminalFrame(body, 'complete')).toEqual({
      repoName: REPO_NAME,
      repoId: publicRepoId(REPO_PATH),
    });
  });

  it('live subscription terminal event includes repoName and omits repoPath', async () => {
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
    expect(body).not.toContain(REPO_PATH);
    expect(terminalFrame(body, 'complete')).toEqual({
      repoName: REPO_NAME,
      repoId: publicRepoId(REPO_PATH),
    });
  });

  it('redacts repository URLs in progress and error without leaking repoPath', async () => {
    const job = manager.createJob({ repoPath: REPO_PATH });
    manager.updateJob(job.id, {
      repoName: REPO_NAME,
      status: 'cloning',
      progress: {
        phase: 'cloning',
        percent: 0,
        message: 'Cloning https://x-access-token:ghs_secret@github.com/user/repo.git...',
      },
    });

    const response = await fetch(`${baseUrl}/api/analyze/${job.id}/progress`);
    manager.updateJob(job.id, {
      status: 'failed',
      repoName: REPO_NAME,
      error: 'fatal: unable to access https://x-access-token:ghs_secret@github.com/user/repo.git/',
    });

    const body = await response.text();
    expect(body).not.toContain('ghs_secret');
    expect(body).not.toContain('x-access-token');
    expect(body).not.toContain(REPO_PATH);
    expect(body).toContain('Cloning [repo]...');
    expect(terminalFrame(body, 'failed')).toEqual({
      repoName: REPO_NAME,
      error: 'fatal: unable to access [repo]',
    });
  });
});
