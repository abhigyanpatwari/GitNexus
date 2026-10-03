import express from 'express';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadMeta: vi.fn(),
  saveMeta: vi.fn(),
  listRegisteredRepos: vi.fn(),
  acquireIndexLock: vi.fn(),
  releaseIndexLock: vi.fn(),
  ensurePrivateSharedGraph: vi.fn(),
  runEmbeddingPipeline: vi.fn(),
  withLbugDb: vi.fn(),
  search: vi.fn(),
  updateJob: vi.fn(),
}));

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  loadMeta: mocks.loadMeta,
  saveMeta: mocks.saveMeta,
  listRegisteredRepos: mocks.listRegisteredRepos,
}));
vi.mock('../../src/storage/index-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/index-lock.js')>()),
  acquireIndexLock: mocks.acquireIndexLock,
}));
vi.mock('../../src/core/shared-store-analyze.js', () => ({
  ensurePrivateSharedGraph: mocks.ensurePrivateSharedGraph,
}));
vi.mock('../../src/core/embeddings/embedding-pipeline.js', () => ({
  runEmbeddingPipeline: mocks.runEmbeddingPipeline,
}));
vi.mock('../../src/storage/storage-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/storage-resolver.js')>()),
  requireRegisteredStoragePath: vi.fn(async (entry: { storagePath: string }) => entry.storagePath),
}));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  withLbugDb: mocks.withLbugDb,
  executeQuery: vi.fn(async () => []),
  executePrepared: vi.fn(async () => [{ value: 1 }]),
  executeWithReusedStatement: vi.fn(async () => []),
  streamQuery: vi.fn(async () => 0),
  flushWAL: vi.fn(),
  closeLbug: vi.fn(),
  isReadOnlyDbError: vi.fn(() => false),
}));
vi.mock('../../src/core/search/bm25-index.js', () => ({ searchFTSFromLbug: mocks.search }));
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
vi.mock('../../src/server/analyze-job.js', () => ({
  isTerminalJobStatus: vi.fn(() => true),
  JobManager: class {
    createJob() {
      return { id: 'embed-job', status: 'queued' };
    }
    updateJob = mocks.updateJob;
    registerAbortController() {}
    getJob() {
      return { status: 'complete' };
    }
    listJobs() {
      return [];
    }
  },
}));

import { createServer } from '../../src/server/api.js';
import { FTS_DISABLED_MESSAGE } from '../../src/core/search/fts-policy.js';
import { extensionManager, resetExtensionState } from '../../src/core/lbug/extension-loader.js';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fts-mode-fixture-'));
const entry = {
  name: 'fts-mode-fixture',
  path: fixtureRoot,
  storagePath: path.join(fixtureRoot, '.gitnexus'),
};
fs.mkdirSync(entry.storagePath, { recursive: true });
let app: express.Express;
const events = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const;
const originalListeners = new Map(events.map((event) => [event, process.listeners(event)]));

beforeAll(async () => {
  // Capture the real registered handlers without binding a socket or starting MCP/native work.
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
  for (const event of events) {
    for (const listener of process.listeners(event)) {
      if (!originalListeners.get(event)!.includes(listener))
        process.removeListener(event, listener);
    }
  }
  vi.unstubAllEnvs();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.acquireIndexLock.mockResolvedValue({
    release: mocks.releaseIndexLock,
    record: {
      v: 1,
      pid: process.pid,
      hostname: 'test-host',
      startTime: null,
      token: 'test-lock',
      invocationId: 'test-run',
      acquiredAt: '',
    },
  });
  mocks.ensurePrivateSharedGraph.mockResolvedValue(true);
  mocks.listRegisteredRepos.mockResolvedValue([entry]);
  mocks.withLbugDb.mockImplementation(async (_path, callback) => callback());
  mocks.search.mockImplementation(async (_query, _limit, _exec, reason) => ({
    results: [],
    ftsAvailable: !reason,
  }));
});

describe('POST /api/embed staged recovery preflight', () => {
  it.each([
    {
      name: 'valid staged receipt',
      recovery: {
        stagingFile: 'lbug.staging.12345678-1234-4123-8123-123456789abc',
        schemaFingerprint: 'test-schema',
        unsafeNodeIds: ['n2', 'inherited-window-node'],
      },
    },
    { name: 'null receipt', recovery: null },
    { name: 'malformed receipt', recovery: { stagingFile: 'invalid' } },
    { name: 'false receipt', recovery: false },
  ])('preserves a $name and releases the job locks', async ({ recovery }) => {
    const metaPath = path.join(entry.storagePath, 'gitnexus.json');
    const sourcePath = path.join(
      entry.storagePath,
      'lbug.staging.12345678-1234-4123-8123-123456789abc',
    );
    fs.writeFileSync(sourcePath, 'completed paid vectors');
    fs.writeFileSync(`${sourcePath}.wal`, 'unfinished window');
    const metadataBytes = JSON.stringify({
      repoPath: entry.path,
      lastCommit: 'abc123',
      indexedAt: '2026-01-01T00:00:00.000Z',
      stats: { embeddings: 7 },
      embeddingCheckpoint: {
        at: '2026-01-01T00:00:00.000Z',
        nodesProcessed: 1,
        totalNodes: 2,
        chunksProcessed: 1,
        model: 'test-model',
        dimensions: 768,
        provider: 'local',
        kind: 'interrupted',
        pendingNodeIds: ['n2'],
        recovery,
      },
    });
    fs.writeFileSync(metaPath, metadataBytes);
    mocks.loadMeta.mockImplementation(async () => JSON.parse(fs.readFileSync(metaPath, 'utf8')));
    mocks.withLbugDb.mockResolvedValue(undefined);

    await invoke('/api/embed');
    await vi.waitFor(() => expect(mocks.releaseIndexLock).toHaveBeenCalledTimes(1));

    expect(mocks.updateJob).toHaveBeenCalledWith(
      'embed-job',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringMatching(
          /staged embeddings.*Run `gitnexus analyze` to recover them first/,
        ),
      }),
    );
    expect(mocks.acquireIndexLock).toHaveBeenCalledWith(entry.storagePath);
    expect(mocks.loadMeta.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.acquireIndexLock.mock.invocationCallOrder[0]!,
    );
    expect(mocks.ensurePrivateSharedGraph).not.toHaveBeenCalled();
    expect(mocks.withLbugDb).not.toHaveBeenCalled();
    expect(mocks.runEmbeddingPipeline).not.toHaveBeenCalled();
    expect(mocks.saveMeta).not.toHaveBeenCalled();
    expect(fs.readFileSync(metaPath, 'utf8')).toBe(metadataBytes);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe('completed paid vectors');
    expect(fs.readFileSync(`${sourcePath}.wal`, 'utf8')).toBe('unfinished window');

    // A second accepted job proves the in-memory repo lock was also released.
    await invoke('/api/embed');
    await vi.waitFor(() => expect(mocks.releaseIndexLock).toHaveBeenCalledTimes(2));
  });
});

async function invoke(route: string, query: Record<string, unknown> = {}) {
  const layer = app.router.stack.find((item: any) => item.route?.path === route);
  expect(layer, route).toBeDefined();
  const handler = layer.route.stack.at(-1).handle;
  const req = Object.assign(new EventEmitter(), {
    query,
    body: { cypher: 'RETURN 1 AS value', query: 'handler', mode: 'bm25', enrich: false },
  });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    body: undefined as any,
    writableEnded: false,
    destroyed: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    set() {
      return this;
    },
    setHeader() {
      return this;
    },
    flushHeaders() {},
    write() {
      return true;
    },
    end() {
      this.writableEnded = true;
      this.emit('finish');
    },
  });
  await handler(req, res);
  expect(res.statusCode, JSON.stringify(res.body)).toBe(route === '/api/embed' ? 202 : 200);
  return res;
}

const cases = [
  {
    name: 'flag-disabled',
    fts: { provider: 'ladybugdb-fts', status: 'unavailable', skipReason: 'disabled-by-flag' },
    skip: true,
  },
  {
    name: 'env-disabled',
    fts: { provider: 'ladybugdb-fts', status: 'unavailable', skipReason: 'disabled-by-env' },
    skip: true,
  },
  { name: 'normal', fts: { provider: 'ladybugdb-fts', status: 'available' }, skip: false },
  { name: 'legacy', fts: undefined, skip: false },
  {
    name: 'degraded',
    fts: { provider: 'ladybugdb-fts', status: 'degraded', skipReason: 'build-failed' },
    skip: false,
  },
  {
    name: 'native-abort',
    fts: { provider: 'ladybugdb-fts', status: 'unavailable', skipReason: 'native-abort' },
    skip: false,
  },
  {
    name: 'tuple-missing',
    fts: { provider: 'ladybugdb-fts', status: 'unavailable', skipReason: 'tuple-missing' },
    skip: false,
  },
] as const;

describe('serve uses one metadata-derived FTS mode on every DB-open path', () => {
  it.each(cases)(
    'keeps mixed read requests consistent for $name indexes',
    async ({ fts, skip }) => {
      // The server process environment must not override persisted per-index intent.
      vi.stubEnv('GITNEXUS_SKIP_FTS', skip ? undefined : '1');
      mocks.loadMeta.mockResolvedValue({ capabilities: { fts } });
      const sequence = [
        ['/api/search', {}],
        ['/api/query', {}],
        ['/api/graph', {}],
        ['/api/search', {}],
        ['/api/graph', { stream: 'true' }],
        ['/api/grep', { pattern: 'handler' }],
        ['/api/query', {}],
        ['/api/search', {}],
      ] as const;
      for (const [route, query] of sequence) {
        const response = await invoke(route, query);
        if (route === '/api/search') {
          expect(response.body.warning).toBe(skip ? FTS_DISABLED_MESSAGE : undefined);
        }
      }
      expect(mocks.withLbugDb).toHaveBeenCalledTimes(sequence.length);
      // Grep also loads metadata for getSourceAvailability before the FTS session.
      expect(mocks.loadMeta).toHaveBeenCalledTimes(sequence.length + 1);
      for (const [dbPath, , options] of mocks.withLbugDb.mock.calls) {
        expect(dbPath).toBe(path.join(entry.storagePath, 'lbug'));
        expect(options).toEqual({ readOnly: true, ...(skip ? { skipFts: true } : {}) });
      }
    },
  );

  it('reads mode changes between requests instead of caching stale metadata', async () => {
    for (const mode of [cases[0], cases[2], cases[1]]) {
      mocks.loadMeta.mockResolvedValue({ capabilities: { fts: mode.fts } });
      await invoke('/api/query');
      expect(mocks.withLbugDb.mock.lastCall?.[2]).toEqual({
        readOnly: true,
        ...(mode.skip ? { skipFts: true } : {}),
      });
    }
  });

  it.each(cases)(
    'preserves write mode while honoring $name metadata for embed',
    async ({ fts, skip }) => {
      mocks.loadMeta.mockResolvedValue({ capabilities: { fts } });
      // This test stops at the DB boundary; it must not generate vectors or write an index.
      mocks.withLbugDb.mockResolvedValue(undefined);
      await invoke('/api/embed');
      await vi.waitFor(() =>
        expect(mocks.updateJob).toHaveBeenCalledWith(
          'embed-job',
          expect.objectContaining({ status: 'complete' }),
        ),
      );
      expect(mocks.withLbugDb).toHaveBeenCalledExactlyOnceWith(
        path.join(entry.storagePath, 'lbug'),
        expect.any(Function),
        skip ? { skipFts: true } : {},
      );
      expect(mocks.loadMeta).toHaveBeenCalledTimes(2);
      expect(mocks.loadMeta).toHaveBeenNthCalledWith(1, entry.storagePath);
      expect(mocks.loadMeta).toHaveBeenNthCalledWith(2, entry.storagePath);
    },
  );
});

describe('GET /api/search FTS warning redaction', () => {
  afterEach(() => {
    resetExtensionState();
  });

  it('redacts a space-containing vendor path from the HTTP response body', async () => {
    const spaced = '/tmp/fts vendor/lbug-fts/prebuilds/linux-x64/libfts.lbug_extension';
    await extensionManager.ensure(
      vi
        .fn()
        .mockRejectedValue(new Error(`Failed to load library '${spaced}': invalid ELF header`)),
      'fts',
      'FTS',
      { policy: 'load-only', vendorRoot: '/tmp/empty-vendor-root' },
    );
    mocks.loadMeta.mockResolvedValue({
      capabilities: { fts: { provider: 'ladybugdb-fts', status: 'available' } },
    });
    mocks.search.mockResolvedValue({ results: [], ftsAvailable: false });
    const response = await invoke('/api/search');
    expect(String(response.body.warning)).toContain('invalid ELF header');
    expect(String(response.body.warning)).not.toMatch(/fts vendor|\/tmp\/|C:\\Users\\/);
  });
});

describe('GET /api/repos catalog validation', () => {
  it('lists registered repos with validate: true', async () => {
    mocks.loadMeta.mockResolvedValue({});
    await invoke('/api/repos');
    expect(mocks.listRegisteredRepos).toHaveBeenCalledWith({ validate: true });
    expect(mocks.listRegisteredRepos).toHaveBeenCalledTimes(1);
  });
});
