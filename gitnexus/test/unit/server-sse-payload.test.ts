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
 */
import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountSSEProgress } from '../../src/server/api.js';
import { JobManager } from '../../src/server/analyze-job.js';

const REPO_PATH = '/ws/b/reels';
const REPO_NAME = 'reels';

/** Extract the parsed JSON payload of the `event: complete` SSE frame. */
const parseCompletePayload = (body: string): unknown => {
  const frame = body.split('\n\n').find((f) => f.includes('event: complete'));
  expect(frame).toBeDefined();
  const dataLine = frame?.split('\n').find((line) => line.startsWith('data: '));
  expect(dataLine).toBeDefined();
  return JSON.parse(dataLine?.slice('data: '.length) ?? '{}') as unknown;
};

describe('mountSSEProgress terminal payload', () => {
  let manager: JobManager;
  let server: http.Server | undefined;
  let baseUrl = '';

  beforeEach(() => {
    manager = new JobManager();
    const app = express();
    // Mirrors the production mount in createServer().
    mountSSEProgress(app, '/api/analyze/:jobId/progress', manager);
    return new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server?.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterEach(() => {
    manager.dispose();
    return new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((err) => (err ? reject(err) : resolve()));
      server = undefined;
    });
  });

  it('already-terminal replay includes repoName AND repoPath', async () => {
    const job = manager.createJob({ repoPath: REPO_PATH });
    manager.updateJob(job.id, { status: 'complete', repoName: REPO_NAME });

    const response = await fetch(`${baseUrl}/api/analyze/${job.id}/progress`);
    const body = await response.text();

    expect(body).toContain('event: complete');
    // Exact match locks the wire shape (error is undefined → omitted by JSON).
    expect(parseCompletePayload(body)).toEqual({
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
    expect(parseCompletePayload(body)).toEqual({
      repoName: REPO_NAME,
      repoPath: REPO_PATH,
    });
  });
});
