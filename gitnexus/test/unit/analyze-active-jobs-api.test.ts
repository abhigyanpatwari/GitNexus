/**
 * GET /api/analyze lists the analyze jobs still running (#1584), so the web
 * UI can badge the repo being indexed and point a 409 at the running job.
 *
 * Boots createServer the same way as analyze-delete-api.test.ts (mocked
 * listen, no LadybugDB/MCP).
 */
import express from 'express';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isTerminalJobStatus, type JobManager } from '../../src/server/analyze-job.js';
import { publicRepoId } from '../../src/server/public-repo-id.js';

const captured = vi.hoisted(() => ({
  managers: [] as JobManager[],
}));

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  loadMeta: vi.fn(async () => ({})),
  listRegisteredRepos: vi.fn(async () => []),
}));
vi.mock('../../src/storage/storage-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/storage-resolver.js')>()),
  requireRegisteredStoragePath: vi.fn(async (entry: { storagePath: string }) => entry.storagePath),
}));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  withLbugDb: vi.fn(),
  executeQuery: vi.fn(async () => []),
  executePrepared: vi.fn(async () => []),
  executeWithReusedStatement: vi.fn(async () => []),
  streamQuery: vi.fn(async () => 0),
  flushWAL: vi.fn(),
  closeLbug: vi.fn(),
  isReadOnlyDbError: vi.fn(() => false),
}));
vi.mock('../../src/core/search/bm25-index.js', () => ({ searchFTSFromLbug: vi.fn() }));
vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    async init() {
      return true;
    }
  },
}));
vi.mock('../../src/server/mcp-http.js', () => ({
  installServeMcpAuth: vi.fn(),
  mountMCPEndpoints: vi.fn(async () => vi.fn()),
}));
vi.mock('../../src/server/upload-sweep.js', () => ({ sweepStaleUploads: vi.fn(async () => {}) }));
vi.mock('../../src/server/update-controller.js', () => ({
  createServeUpdateController: vi.fn(() => ({ stop: vi.fn() })),
  bindServeUpdateControllerLifecycle: vi.fn(),
  buildServerInfo: vi.fn(),
}));
vi.mock('../../src/server/grep-scan.js', () => ({
  runGrepScanInWorker: vi.fn(async () => ({ results: [], timedOut: false })),
}));
vi.mock('../../src/server/sse-progress.js', () => ({ mountSSEProgress: vi.fn() }));
vi.mock('../../src/server/analyze-job.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/server/analyze-job.js')>();
  return {
    ...actual,
    JobManager: class extends actual.JobManager {
      constructor() {
        super();
        captured.managers.push(this);
      }
    },
  };
});

import { createServer } from '../../src/server/api.js';

let app: express.Express;
const events = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const;
const originalListeners = new Map(events.map((event) => [event, process.listeners(event)]));

beforeAll(async () => {
  const listen = vi.spyOn(express.application, 'listen').mockImplementation(function (
    this: express.Express,
    ...args: any[]
  ) {
    app = this;
    queueMicrotask(args.at(-1));
    return new EventEmitter() as any;
  });
  try {
    await createServer(0);
  } finally {
    listen.mockRestore();
  }
});

afterAll(() => {
  for (const manager of captured.managers) manager.dispose();
  for (const event of events) {
    for (const listener of process.listeners(event)) {
      if (!originalListeners.get(event)!.includes(listener)) {
        process.removeListener(event, listener);
      }
    }
  }
});

afterEach(() => {
  for (const manager of captured.managers) {
    for (const job of manager.listJobs()) {
      manager.releaseChild(job.id);
      if (!isTerminalJobStatus(job.status)) {
        manager.updateJob(job.id, { status: 'failed', error: 'test cleanup' });
      }
    }
  }
});

const analyzeJobs = (): JobManager => captured.managers[0]!;

const invokeList = (): { statusCode: number; body: any } => {
  const layer = app.router.stack.find(
    (item: any) => item.route?.path === '/api/analyze' && item.route.methods?.get,
  );
  expect(layer, 'GET /api/analyze').toBeDefined();
  const handler = layer.route.stack.at(-1).handle;
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  handler({} as express.Request, res as unknown as express.Response, vi.fn());
  return res;
};

describe('GET /api/analyze', () => {
  it('returns an empty list when nothing is running', () => {
    const res = invokeList();

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ jobs: [] });
  });

  it('lists only running jobs, with progress', () => {
    const jobs = analyzeJobs();
    const done = jobs.createJob({ repoPath: '/tmp/list-done' });
    jobs.updateJob(done.id, { status: 'complete' });
    const running = jobs.createJob({ repoPath: '/tmp/list-running' });
    jobs.updateJob(running.id, {
      status: 'analyzing',
      repoName: 'list-running',
      progress: { phase: 'parsing', percent: 42, message: 'Parsing code' },
    });

    const res = invokeList();

    expect(res.statusCode).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0]).toMatchObject({
      id: running.id,
      lane: 'analyze',
      status: 'analyzing',
      repoName: 'list-running',
      repoId: publicRepoId('/tmp/list-running'),
      progress: { phase: 'parsing', percent: 42, message: 'Parsing code' },
    });
  });

  it('never exposes the repo URL, path or branch', () => {
    const jobs = analyzeJobs();
    const url = 'https://user:secret-token@github.com/acme/private-repo.git';
    const job = jobs.createJob({ repoUrl: url, branch: 'release/secret-branch' });
    jobs.updateJob(job.id, {
      status: 'cloning',
      repoPath: '/home/alice/.gitnexus/repos/private-repo',
      progress: { phase: 'cloning', percent: 5, message: `Cloning ${url}` },
    });

    const res = invokeList();
    const [view] = res.body.jobs;
    const raw = JSON.stringify(res.body);

    expect(view.repoName).toBe('private-repo');
    expect(view).not.toHaveProperty('repoUrl');
    expect(view).not.toHaveProperty('repoPath');
    expect(view).not.toHaveProperty('branch');
    expect(raw).not.toContain('secret-token');
    expect(raw).not.toContain('github.com');
    expect(raw).not.toContain('/home/alice');
    expect(raw).not.toContain('secret-branch');
  });
});
