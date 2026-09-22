/**
 * DELETE /api/analyze/:jobId and DELETE /api/embed/:jobId body must match
 * live JobManager state after cancelJob — not a hard-coded `failed`.
 *
 * A registered child keeps the in-memory job non-terminal until exit;
 * clients that trusted a synthetic `failed` DELETE body retried and 409'd.
 *
 * Boots createServer the same way as api-fts-mode.test.ts (mocked listen,
 * no LadybugDB/MCP). analyze-api.test.ts cannot import api.ts.
 */
import express from 'express';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isTerminalJobStatus, type JobManager } from '../../src/server/analyze-job.js';

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

type Lane = 'analyze' | 'embed';

const lanes: Array<{ lane: Lane; route: string; manager: () => JobManager }> = [
  { lane: 'analyze', route: '/api/analyze/:jobId', manager: () => captured.managers[0]! },
  { lane: 'embed', route: '/api/embed/:jobId', manager: () => captured.managers[1]! },
];

const fakeChild = () => {
  const child = {
    connected: true,
    exitCode: null,
    signalCode: null,
    send: () => true,
    kill: () => true,
    on: () => child,
  };
  return child;
};

const invokeDelete = (route: string, jobId: string): { statusCode: number; body: any } => {
  const layer = app.router.stack.find(
    (item: any) => item.route?.path === route && item.route.methods?.delete,
  );
  expect(layer, `DELETE ${route}`).toBeDefined();
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
  handler({ params: { jobId } }, res);
  return res;
};

describe('DELETE analyze/embed cancel body matches JobManager', () => {
  it('boots two JobManagers (analyze then embed)', () => {
    expect(captured.managers.length).toBe(2);
  });

  it.each(lanes)(
    'DELETE $route with a registered child stays $lane analyzing, not failed',
    ({ lane, route, manager }) => {
      const jobs = manager();
      const job = jobs.createJob({ repoPath: `/tmp/cancel-child-${lane}` });
      jobs.updateJob(job.id, { status: 'analyzing', repoName: `cancel-child-${lane}` });
      jobs.registerChild(job.id, fakeChild() as any);

      const res = invokeDelete(route, job.id);
      const live = jobs.getJob(job.id);

      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe(live?.status);
      expect(res.body.status).toBe('analyzing');
      expect(res.body.lane).toBe(lane);
      expect(res.body.id).toBe(job.id);
      expect(isTerminalJobStatus(res.body.status)).toBe(false);
    },
  );

  it.each(lanes)('DELETE $route without a child marks $lane failed', ({ lane, route, manager }) => {
    const jobs = manager();
    const job = jobs.createJob({ repoPath: `/tmp/cancel-no-child-${lane}` });
    jobs.updateJob(job.id, { status: 'analyzing', repoName: `cancel-no-child-${lane}` });

    const res = invokeDelete(route, job.id);
    const live = jobs.getJob(job.id);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe(live?.status);
    expect(res.body.status).toBe('failed');
    expect(res.body.error).toBe('Cancelled by user');
    expect(res.body.lane).toBe(lane);
    expect(res.body.id).toBe(job.id);
  });
});
