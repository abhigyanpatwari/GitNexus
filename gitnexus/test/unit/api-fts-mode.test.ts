import express from 'express';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _captureLogger } from '../../src/core/logger.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const heap = vi.hoisted(() => ({ bytes: 1024 ** 3 }));

vi.mock('../../src/core/ingestion/utils/effective-ram.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/ingestion/utils/effective-ram.js')>()),
  effectiveRamBytes: () => 8 * 1024 ** 3,
}));
vi.mock('node:v8', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:v8')>();
  return {
    ...actual,
    getHeapStatistics: () => ({ ...actual.getHeapStatistics(), heap_size_limit: heap.bytes }),
  };
});

const mocks = vi.hoisted(() => ({
  loadMeta: vi.fn(),
  saveMeta: vi.fn(),
  listRegisteredRepos: vi.fn(),
  acquireIndexLock: vi.fn(),
  releaseIndexLock: vi.fn(),
  ensurePrivateSharedGraph: vi.fn(),
  runEmbeddingPipeline: vi.fn(),
  semanticSearch: vi.fn(async () => [
    { nodeId: 'Function:a.ts:alpha', name: 'alpha', distance: 0 },
  ]),
  embedQuery: vi.fn(async () => [1, 0, 0, 0]),
  isEmbedderReady: vi.fn(() => false),
  runAnalysisEmbeddingPhase: vi.fn(),
  withLbugDb: vi.fn(),
  search: vi.fn(),
  updateJob: vi.fn(),
  disconnect: vi.fn(async () => {}),
  serverClose: vi.fn(),
  activeJob: undefined as
    | { id: string; repoName: string; status: string; progress: { graphPhase?: 'ready' } }
    | undefined,
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
  semanticSearch: mocks.semanticSearch,
}));
vi.mock('../../src/core/embeddings/embedder.js', () => ({
  isEmbedderReady: mocks.isEmbedderReady,
}));
vi.mock('../../src/mcp/core/embedder.js', () => ({ embedQuery: mocks.embedQuery }));
vi.mock('../../src/core/analysis-embedding-phase.js', () => ({
  runAnalysisEmbeddingPhase: mocks.runAnalysisEmbeddingPhase,
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
  fetchExistingEmbeddingHashes: vi.fn(async () => new Map()),
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
    disconnect = mocks.disconnect;
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
  isTerminalJobStatus: (status: string) => status === 'complete' || status === 'failed',
  JobManager: class {
    controllers: AbortController[] = [];
    createJob() {
      return { id: 'embed-job', status: 'queued' };
    }
    updateJob = mocks.updateJob;
    registerAbortController(_id: string, controller: AbortController) {
      this.controllers.push(controller);
    }
    dispose() {
      for (const controller of this.controllers) controller.abort();
    }
    async waitForChildren() {}
    getJob() {
      return mocks.activeJob ?? { status: 'analyzing' };
    }
    listJobs() {
      return mocks.activeJob ? [mocks.activeJob] : [];
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
    return Object.assign(new EventEmitter(), { close: mocks.serverClose }) as any;
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
  heap.bytes = 1024 ** 3;
  mocks.isEmbedderReady.mockReturnValue(false);
  mocks.activeJob = undefined;
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
  mocks.runAnalysisEmbeddingPhase.mockResolvedValue({ stats: { embeddings: 2 } });
  mocks.listRegisteredRepos.mockResolvedValue([entry]);
  mocks.withLbugDb.mockImplementation(async (_path, callback) => callback());
  mocks.search.mockImplementation(async (_query, _limit, _exec, reason) => ({
    results: [],
    ftsAvailable: !reason,
  }));
});

it.each(['analyzing', 'failed'])(
  'releases a waiting graph query after publication while embedding is %s',
  async (status) => {
    vi.useFakeTimers();
    mocks.activeJob = {
      id: 'analysis-job',
      repoName: entry.name,
      status: 'analyzing',
      progress: {},
    };
    mocks.listRegisteredRepos.mockResolvedValueOnce([]).mockResolvedValue([entry]);
    mocks.loadMeta.mockResolvedValue({ capabilities: { fts: { status: 'available' } } });
    const pending = invoke('/api/search', { repo: entry.name });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.search).not.toHaveBeenCalled();
      mocks.activeJob.progress.graphPhase = 'ready';
      mocks.activeJob.status = status;
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.search).toHaveBeenCalledOnce();
      await pending;
      expect(mocks.updateJob).not.toHaveBeenCalled();
    } finally {
      mocks.activeJob.status = 'complete';
      await vi.advanceTimersByTimeAsync(1000);
      await pending.catch(() => {});
      vi.useRealTimers();
    }
  },
);

describe('POST /api/embed staged recovery preflight', () => {
  it('hands the indexed storage slot to the shared phase and reports source failures', async () => {
    const fileHashes = { 'sample.ts': 'a'.repeat(64) };
    mocks.loadMeta.mockResolvedValue({
      repoPath: entry.path,
      fileHashes,
      contentRetention: 'full',
      stats: { embeddings: 3 },
    });
    const log = _captureLogger();
    try {
      mocks.runAnalysisEmbeddingPhase.mockRejectedValueOnce(
        new Error('source fingerprint mismatch', {
          cause: new Error('private provider response excerpt'),
        }),
      );
      await invoke('/api/embed');
      await vi.waitFor(() => expect(mocks.releaseIndexLock).toHaveBeenCalledTimes(1));
      // The shared phase reads source identity from this slot's published metadata.
      // embedding-job-controller.test.ts exercises that read with the real controller.
      expect(mocks.runAnalysisEmbeddingPhase).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          metadataDirectory: entry.storagePath,
          graphPath: path.join(entry.storagePath, 'lbug'),
          nodeLimit: 0,
          resources: expect.objectContaining({ automatic: true, mainHeapMb: 1024 }),
          signal: expect.any(AbortSignal),
        }),
      );
      expect(mocks.runEmbeddingPipeline).not.toHaveBeenCalled();
      expect(entry.path).not.toBe(entry.storagePath);
      expect(mocks.updateJob).toHaveBeenCalledWith(
        'embed-job',
        expect.objectContaining({ status: 'failed', error: 'source fingerprint mismatch' }),
      );
      expect(mocks.saveMeta).not.toHaveBeenCalled();
      expect(log.records()).toContainEqual(
        expect.objectContaining({
          reason: 'source fingerprint mismatch',
          repo: entry.name,
          msg: 'Embedding generation failed',
        }),
      );
      expect(log.text()).not.toContain('private provider response excerpt');
    } finally {
      log.restore();
    }
  });

  it.each([2096, 65536])(
    'rejects a %i MiB running heap before locking or starting embedding work',
    async (heapMb) => {
      vi.stubEnv('GITNEXUS_EMBEDDING_URL', undefined);
      vi.stubEnv('GITNEXUS_EMBEDDING_MODEL', undefined);
      mocks.loadMeta.mockResolvedValue({ repoPath: entry.path });
      heap.bytes = heapMb * 1024 ** 2;
      const response = await invoke('/api/embed', {}, {}, 500);
      expect(response.body.error).toContain('cannot admit');
      expect(mocks.acquireIndexLock).not.toHaveBeenCalled();
      expect(mocks.ensurePrivateSharedGraph).not.toHaveBeenCalled();
      expect(mocks.runAnalysisEmbeddingPhase).not.toHaveBeenCalled();
      expect(mocks.updateJob).not.toHaveBeenCalled();

      heap.bytes = 1024 ** 3;
      await invoke('/api/embed');
      await vi.waitFor(() => expect(mocks.releaseIndexLock).toHaveBeenCalledOnce());
      expect(mocks.runAnalysisEmbeddingPhase).toHaveBeenCalledOnce();
    },
  );

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(entry.storagePath, { recursive: true, force: true });
    fs.mkdirSync(entry.storagePath, { recursive: true });
  });

  async function useRealIndexLock() {
    vi.stubEnv('GITNEXUS_INDEX_LOCK_BACKEND', 'file');
    const actual = await vi.importActual<typeof import('../../src/storage/index-lock.js')>(
      '../../src/storage/index-lock.js',
    );
    mocks.acquireIndexLock.mockImplementation(
      async (...args: Parameters<typeof actual.acquireIndexLock>) => {
        const lock = await actual.acquireIndexLock(...args);
        return {
          ...lock,
          release: () => {
            lock.release();
            mocks.releaseIndexLock();
          },
        };
      },
    );
  }

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
    await useRealIndexLock();
    const lockPath = path.join(entry.storagePath, 'analyze.lock');
    const lbugPath = path.join(entry.storagePath, 'lbug');
    const metaPath = path.join(entry.storagePath, 'gitnexus.json');
    const sourcePath = path.join(
      entry.storagePath,
      'lbug.staging.12345678-1234-4123-8123-123456789abc',
    );
    fs.writeFileSync(lbugPath, 'published graph');
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
    mocks.loadMeta.mockImplementation(async () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    });
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
    expect(mocks.acquireIndexLock).toHaveBeenCalledWith(entry.storagePath, { sweep: false });
    expect(mocks.loadMeta.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.acquireIndexLock.mock.invocationCallOrder[0]!,
    );
    expect(mocks.ensurePrivateSharedGraph).not.toHaveBeenCalled();
    expect(mocks.withLbugDb).not.toHaveBeenCalled();
    expect(mocks.runEmbeddingPipeline).not.toHaveBeenCalled();
    expect(mocks.saveMeta).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readFileSync(metaPath, 'utf8')).toBe(metadataBytes);
    expect(fs.readFileSync(lbugPath, 'utf8')).toBe('published graph');
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe('completed paid vectors');
    expect(fs.readFileSync(`${sourcePath}.wal`, 'utf8')).toBe('unfinished window');

    // A second accepted job proves the in-memory repo lock was also released.
    await invoke('/api/embed');
    await vi.waitFor(() => expect(mocks.releaseIndexLock).toHaveBeenCalledTimes(2));
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('sweeps orphaned staging files before a writable job without a recovery receipt', async () => {
    await useRealIndexLock();
    const metaPath = path.join(entry.storagePath, 'gitnexus.json');
    fs.writeFileSync(metaPath, JSON.stringify({ repoPath: entry.path }));
    const sourcePath = path.join(
      entry.storagePath,
      'lbug.staging.12345678-1234-4123-8123-123456789abc',
    );
    fs.writeFileSync(sourcePath, 'orphaned database');
    fs.writeFileSync(`${sourcePath}.wal`, 'orphaned WAL');
    mocks.loadMeta.mockImplementation(async () => JSON.parse(fs.readFileSync(metaPath, 'utf8')));
    mocks.ensurePrivateSharedGraph.mockImplementation(async () => {
      expect(fs.existsSync(path.join(entry.storagePath, 'analyze.lock'))).toBe(true);
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.existsSync(`${sourcePath}.wal`)).toBe(false);
      return true;
    });
    mocks.withLbugDb.mockResolvedValue(undefined);

    await invoke('/api/embed');
    await vi.waitFor(() => expect(mocks.releaseIndexLock).toHaveBeenCalledTimes(1));

    expect(mocks.updateJob).toHaveBeenCalledWith(
      'embed-job',
      expect.objectContaining({ status: 'complete' }),
    );
    expect(mocks.ensurePrivateSharedGraph).toHaveBeenCalledTimes(1);
    expect(mocks.runAnalysisEmbeddingPhase).toHaveBeenCalledTimes(1);
    expect(mocks.withLbugDb).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(entry.storagePath, 'analyze.lock'))).toBe(false);
  });
});

async function invoke(
  route: string,
  query: Record<string, unknown> = {},
  body: Record<string, unknown> = {},
  expectedStatus = route === '/api/embed' ? 202 : 200,
) {
  const layer = app.router.stack.find((item: any) => item.route?.path === route);
  expect(layer, route).toBeDefined();
  const handler = layer.route.stack.at(-1).handle;
  const req = Object.assign(new EventEmitter(), {
    query,
    body: { cypher: 'RETURN 1 AS value', query: 'handler', mode: 'bm25', enrich: false, ...body },
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
  await handler(req as unknown as express.Request, res as unknown as express.Response, vi.fn());
  expect(res.statusCode, JSON.stringify(res.body)).toBe(expectedStatus);
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
    'keeps the $name graph out of the legacy writable DB path during embed',
    async ({ fts }) => {
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
      expect(mocks.runAnalysisEmbeddingPhase).toHaveBeenCalledWith(
        expect.objectContaining({
          metadataDirectory: entry.storagePath,
          graphPath: path.join(entry.storagePath, 'lbug'),
        }),
      );
      expect(mocks.withLbugDb).not.toHaveBeenCalled();
      expect(mocks.saveMeta).not.toHaveBeenCalled();
    },
  );
});

describe('POST /api/embed published-phase outcomes', () => {
  it('keeps graph readiness nonterminal until the shared phase completes', async () => {
    mocks.loadMeta.mockResolvedValue({ repoPath: entry.path });
    let finish!: () => void;
    mocks.runAnalysisEmbeddingPhase.mockImplementation(async ({ callbacks }) => {
      callbacks.onProgress('graph-ready', 90, 'Graph available', { graphPhase: 'ready' });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { stats: { embeddings: 2 } };
    });
    await invoke('/api/embed');
    await vi.waitFor(() => expect(mocks.runAnalysisEmbeddingPhase).toHaveBeenCalledOnce());
    expect(mocks.updateJob).toHaveBeenCalledWith(
      'embed-job',
      expect.objectContaining({
        progress: expect.objectContaining({ graphPhase: 'ready', phase: 'graph-ready' }),
      }),
    );
    expect(mocks.updateJob).not.toHaveBeenCalledWith(
      'embed-job',
      expect.objectContaining({ status: 'complete' }),
    );
    expect(mocks.releaseIndexLock).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(mocks.releaseIndexLock).toHaveBeenCalledOnce());
    expect(mocks.updateJob).toHaveBeenCalledWith(
      'embed-job',
      expect.objectContaining({ status: 'complete' }),
    );
    expect(mocks.saveMeta).not.toHaveBeenCalled();
  });

  it('surfaces incomplete vectors without clearing durable work or reporting complete', async () => {
    mocks.loadMeta.mockResolvedValue({
      repoPath: entry.path,
      stats: { embeddings: 1 },
      embeddingJob: { identity: 'retained' },
    });
    mocks.runAnalysisEmbeddingPhase.mockImplementation(async ({ callbacks }) => {
      callbacks.onProgress('embeddings', 98, 'Incomplete', {
        graphPhase: 'ready',
        embeddingProgress: { phase: 'failed', completedNodes: 1, pendingNodes: 2 },
      });
      throw new Error('Provider unavailable; resume durable progress');
    });
    await invoke('/api/embed');
    await vi.waitFor(() => expect(mocks.releaseIndexLock).toHaveBeenCalledOnce());
    expect(mocks.updateJob).toHaveBeenCalledWith(
      'embed-job',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('resume durable progress'),
      }),
    );
    expect(mocks.updateJob).not.toHaveBeenCalledWith(
      'embed-job',
      expect.objectContaining({ status: 'complete' }),
    );
    expect(mocks.saveMeta).not.toHaveBeenCalled();
    expect(mocks.withLbugDb).not.toHaveBeenCalled();
  });
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

it.each(['semantic', 'hybrid'])(
  'searches published vectors in %s mode without requiring a previously loaded model',
  async (mode) => {
    mocks.isEmbedderReady.mockReturnValue(true);
    const metadata = {
      graphGeneration: { version: 1, id: 'a'.repeat(32), coveredContent: 'b'.repeat(64) },
    };
    mocks.loadMeta.mockResolvedValue(metadata);
    await invoke('/api/search', {}, { mode });
    expect(mocks.semanticSearch).toHaveBeenCalledOnce();
    const args = mocks.semanticSearch.mock.calls[0] as unknown[];
    expect(args[4]).toEqual({
      metadataDirectory: entry.storagePath,
      metadata,
      graphPath: path.join(entry.storagePath, 'lbug'),
    });
    expect(args[5]).toBeTypeOf('function');
    // Only the verified vector reader invokes this lazy callback.
    expect(mocks.embedQuery).not.toHaveBeenCalled();
  },
);

it.each(['semantic', 'hybrid'])(
  'degrades %s search when published vectors have no usable embedder',
  async (mode) => {
    mocks.loadMeta.mockResolvedValue({
      graphGeneration: { version: 1, id: 'a'.repeat(32), coveredContent: 'b'.repeat(64) },
    });
    const response = await invoke('/api/search', {}, { mode });
    expect(response.body.results).toEqual([]);
    expect(mocks.semanticSearch).not.toHaveBeenCalled();
    expect(mocks.embedQuery).not.toHaveBeenCalled();
    expect(mocks.search).toHaveBeenCalledTimes(mode === 'hybrid' ? 1 : 0);
  },
);

it('waits for embedding native cleanup before closing the backend or exiting on shutdown', async () => {
  mocks.loadMeta.mockResolvedValue({ repoPath: entry.path });
  let finish!: () => void;
  let signal!: AbortSignal;
  mocks.runAnalysisEmbeddingPhase.mockImplementation(async (options) => {
    signal = options.signal;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    signal.throwIfAborted();
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  await invoke('/api/embed');
  await vi.waitFor(() => expect(mocks.runAnalysisEmbeddingPhase).toHaveBeenCalledOnce());
  const shutdown = process
    .listeners('SIGTERM')
    .find((listener) => !originalListeners.get('SIGTERM')!.includes(listener));
  expect(shutdown).toBeDefined();
  const stopped = (shutdown as unknown as () => Promise<void>)();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(signal.aborted).toBe(true);
    expect(mocks.serverClose).toHaveBeenCalledOnce();
    expect(mocks.releaseIndexLock).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  } finally {
    finish();
    await stopped;
    await vi.waitFor(() => expect(mocks.releaseIndexLock).toHaveBeenCalledOnce());
    exit.mockRestore();
  }
  expect(mocks.disconnect).toHaveBeenCalledOnce();
});
