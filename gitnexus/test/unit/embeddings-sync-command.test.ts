/**
 * Tests for `gitnexus embeddings sync` writer-safety contracts (#3065 review):
 * index lock, missing-DB preflight, identity fail-closed, tri-state count,
 * closeLbug masking, and hash-only cache load.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  acquireIndexLockMock,
  releaseMock,
  getStoragePathsMock,
  loadMetaMock,
  saveMetaMock,
  initLbugMock,
  closeLbugMock,
  executeQueryMock,
  executeWithReusedStatementMock,
  fetchExistingEmbeddingHashesMock,
  runEmbeddingPipelineMock,
  resolveEmbeddingIdentityMock,
} = vi.hoisted(() => ({
  acquireIndexLockMock: vi.fn(),
  releaseMock: vi.fn(),
  getStoragePathsMock: vi.fn(),
  loadMetaMock: vi.fn(),
  saveMetaMock: vi.fn(),
  initLbugMock: vi.fn(),
  closeLbugMock: vi.fn(),
  executeQueryMock: vi.fn(),
  executeWithReusedStatementMock: vi.fn(),
  fetchExistingEmbeddingHashesMock: vi.fn(),
  runEmbeddingPipelineMock: vi.fn(),
  resolveEmbeddingIdentityMock: vi.fn(),
}));

vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: () => '/tmp/emb-sync-repo',
}));

vi.mock('../../src/storage/index-lock.js', () => ({
  acquireIndexLock: (...args: unknown[]) => acquireIndexLockMock(...args),
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  getStoragePaths: (...args: unknown[]) => getStoragePathsMock(...args),
  loadMeta: (...args: unknown[]) => loadMetaMock(...args),
  saveMeta: (...args: unknown[]) => saveMetaMock(...args),
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  initLbug: (...args: unknown[]) => initLbugMock(...args),
  closeLbug: (...args: unknown[]) => closeLbugMock(...args),
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
  executeWithReusedStatement: (...args: unknown[]) => executeWithReusedStatementMock(...args),
  fetchExistingEmbeddingHashes: (...args: unknown[]) => fetchExistingEmbeddingHashesMock(...args),
}));

vi.mock('../../src/core/embeddings/embedding-pipeline.js', () => ({
  runEmbeddingPipeline: (...args: unknown[]) => runEmbeddingPipelineMock(...args),
}));

vi.mock('../../src/core/embeddings/embedding-identity.js', () => ({
  resolveEmbeddingIdentity: () => resolveEmbeddingIdentityMock(),
}));

const IDENTITY = { model: 'test-model', dimensions: 768, provider: 'local' } as const;

const BASE_META = {
  repoPath: '/tmp/emb-sync-repo',
  lastCommit: 'abc123',
  indexedAt: '2026-01-01T00:00:00.000Z',
  stats: { embeddings: 1 },
};

const lockHandle = (release: () => void = releaseMock) => ({
  record: {
    v: 1 as const,
    pid: 1,
    hostname: 'h',
    startTime: null,
    token: 't',
    invocationId: 'i',
    acquiredAt: '',
  },
  release,
});

async function run(inputPath = '/tmp/emb-sync-repo') {
  const { embeddingsSyncCommand } = await import('../../src/cli/embeddings-sync.js');
  await embeddingsSyncCommand(inputPath);
}

describe('embeddingsSyncCommand writer safety (#3065)', () => {
  const tmpDirs: string[] = [];

  async function store(kind: 'file' | 'missing' | 'dir' = 'file') {
    const dir = await mkdtemp(path.join(tmpdir(), 'emb-sync-'));
    tmpDirs.push(dir);
    const lbugPath = path.join(dir, 'lbug');
    const metaPath = path.join(dir, 'gitnexus.json');
    if (kind === 'file') await writeFile(lbugPath, 'db');
    if (kind === 'dir') await mkdir(lbugPath);
    getStoragePathsMock.mockReturnValue({ lbugPath, metaPath });
    return { dir, lbugPath, metaPath };
  }

  beforeEach(() => {
    vi.resetModules();
    acquireIndexLockMock.mockReset().mockResolvedValue(lockHandle());
    releaseMock.mockReset();
    getStoragePathsMock.mockReset();
    loadMetaMock.mockReset().mockResolvedValue({ ...BASE_META });
    saveMetaMock.mockReset().mockResolvedValue(undefined);
    initLbugMock.mockReset().mockResolvedValue(undefined);
    closeLbugMock.mockReset().mockResolvedValue(undefined);
    executeQueryMock.mockReset().mockResolvedValue([{ cnt: 2 }]);
    executeWithReusedStatementMock.mockReset();
    fetchExistingEmbeddingHashesMock.mockReset().mockResolvedValue(new Map([['n1', 'hash-1']]));
    runEmbeddingPipelineMock.mockReset().mockResolvedValue({
      nodesProcessed: 2,
      chunksProcessed: 2,
      failedNodeIds: [],
    });
    resolveEmbeddingIdentityMock.mockReset().mockReturnValue({ ...IDENTITY });
  });

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('acquires the index lock before re-reading metadata and releases it in finally', async () => {
    const { dir } = await store();
    const order: string[] = [];
    acquireIndexLockMock.mockImplementation(async () => {
      order.push('lock');
      return lockHandle(() => {
        order.push('release');
        releaseMock();
      });
    });
    loadMetaMock.mockImplementation(async () => {
      order.push('loadMeta');
      return { ...BASE_META };
    });
    initLbugMock.mockImplementation(async () => {
      order.push('init');
    });

    await run();

    expect(acquireIndexLockMock).toHaveBeenCalledWith(dir);
    expect(order[0]).toBe('lock');
    expect(order.indexOf('loadMeta')).toBeGreaterThan(order.indexOf('lock'));
    expect(order.indexOf('init')).toBeGreaterThan(order.indexOf('loadMeta'));
    expect(order.at(-1)).toBe('release');
  });

  it('refuses to create a new database when the LadybugDB file is missing', async () => {
    const { lbugPath } = await store('missing');
    await expect(run()).rejects.toThrow(
      `The LadybugDB graph store at ${lbugPath} is missing. Run gitnexus analyze first.`,
    );
    expect(initLbugMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalled();
  });

  it('refuses to open a LadybugDB path that is not a regular file', async () => {
    const { lbugPath } = await store('dir');
    await expect(run()).rejects.toThrow(
      `The LadybugDB graph store at ${lbugPath} is not a usable database file. Run gitnexus analyze first.`,
    );
    expect(initLbugMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalled();
  });

  it('fails closed on an identity-mismatched partial checkpoint', async () => {
    await store();
    loadMetaMock.mockResolvedValue({
      ...BASE_META,
      embeddingCheckpoint: {
        at: '2026-01-01T00:00:00.000Z',
        nodesProcessed: 1,
        totalNodes: 2,
        chunksProcessed: 1,
        model: 'old-model',
        dimensions: 768,
        provider: 'local',
        kind: 'partial',
        pendingNodeIds: ['n2'],
      },
    });
    resolveEmbeddingIdentityMock.mockReturnValue({
      model: 'new-model',
      dimensions: 768,
      provider: 'http:deadbeef',
    });

    await expect(run()).rejects.toThrow(/Cannot sync embeddings: the index checkpoint was written/);
    expect(initLbugMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalled();
  });

  it('fails closed on an identity-mismatched unverified-count checkpoint', async () => {
    // `decideEmbeddingResume` abandons this kind before comparing identity, so
    // the command's own gate is the only thing that keeps a foreign model from
    // filling the remaining holes beside the old model's vectors.
    await store();
    loadMetaMock.mockResolvedValue({
      ...BASE_META,
      embeddingCheckpoint: {
        at: '2026-01-01T00:00:00.000Z',
        nodesProcessed: 2,
        totalNodes: 2,
        chunksProcessed: 2,
        model: 'old-model',
        dimensions: 768,
        provider: 'local',
        kind: 'unverified-count',
        pendingNodeIds: [],
      },
    });
    resolveEmbeddingIdentityMock.mockReturnValue({
      model: 'new-model',
      dimensions: 768,
      provider: 'http:deadbeef',
    });

    await expect(run()).rejects.toThrow(/Cannot sync embeddings: the index checkpoint was written/);
    expect(initLbugMock).not.toHaveBeenCalled();
    expect(runEmbeddingPipelineMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalled();
  });

  it('refuses to sync when the recorded vector width differs from this run', async () => {
    await store();
    loadMetaMock.mockResolvedValue({ ...BASE_META, embeddingDims: 1 });

    await expect(run()).rejects.toThrow(/Cannot sync embeddings: this index stores FLOAT\[1\]/);
    expect(initLbugMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalled();
  });

  it('refuses to sync while the structural index is incomplete', async () => {
    await store();
    loadMetaMock.mockResolvedValue({
      ...BASE_META,
      incrementalInProgress: { startedAt: '2026-01-01T00:00:00.000Z', toWriteCount: 3 },
    });

    await expect(run()).rejects.toThrow(
      'The structural index is incomplete. Run gitnexus analyze --force first.',
    );
    expect(initLbugMock).not.toHaveBeenCalled();
    expect(saveMetaMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalled();
  });

  it('persists an interrupted checkpoint from the pipeline checkpoint callbacks', async () => {
    // The resume contract lives in these callbacks; a mock that never invokes
    // them leaves the whole save path unexecuted.
    await store();
    runEmbeddingPipelineMock.mockImplementation(
      async (
        _executeQuery: unknown,
        _executeWithReusedStatement: unknown,
        _onProgress: unknown,
        _config: unknown,
        _signal: unknown,
        _existing: unknown,
        options: {
          onCheckpointWindowStart: (checkpoint: Record<string, unknown>) => Promise<void>;
          onCheckpoint: (checkpoint: Record<string, unknown>) => Promise<void>;
        },
      ) => {
        await options.onCheckpointWindowStart({
          nodeIds: ['n2', 'n3'],
          nodesProcessed: 1,
          totalNodes: 3,
          chunksProcessed: 1,
        });
        await options.onCheckpoint({ nodesProcessed: 3, totalNodes: 3, chunksProcessed: 3 });
        return { nodesProcessed: 3, chunksProcessed: 3, failedNodeIds: [] };
      },
    );

    await run();

    type SavedMeta = {
      stats?: { embeddings?: number };
      embeddingCheckpoint?: { pendingNodeIds?: string[] };
    };
    const windowStart = saveMetaMock.mock.calls[0]?.[1] as SavedMeta;
    expect(windowStart.embeddingCheckpoint?.pendingNodeIds).toEqual(['n2', 'n3']);
    // The window marker carries no count, so the last known one must survive.
    expect(windowStart.stats?.embeddings).toBe(1);

    const windowEnd = saveMetaMock.mock.calls[1]?.[1] as SavedMeta;
    expect(windowEnd.embeddingCheckpoint?.pendingNodeIds).toEqual([]);
    expect(windowEnd.stats?.embeddings).toBe(2);
  });

  it('keeps a partial checkpoint when some nodes failed to embed', async () => {
    await store();
    runEmbeddingPipelineMock.mockResolvedValue({
      nodesProcessed: 2,
      chunksProcessed: 2,
      failedNodeIds: ['n9'],
    });

    await run();

    const saved = saveMetaMock.mock.calls.at(-1)?.[1] as {
      embeddingCheckpoint?: { pendingNodeIds?: string[] };
    };
    expect(saved.embeddingCheckpoint).toBeDefined();
    expect(saved.embeddingCheckpoint?.pendingNodeIds).toEqual(['n9']);
  });

  it('does not publish a missing count cell as zero', async () => {
    await store();
    executeQueryMock.mockResolvedValue([{}]);

    await expect(run()).rejects.toThrow('Could not verify persisted embedding count.');
    expect(saveMetaMock).toHaveBeenCalledTimes(1);
    const saved = saveMetaMock.mock.calls[0]?.[1] as {
      stats?: { embeddings?: number };
      embeddingCheckpoint?: { kind?: string; pendingNodeIds?: string[] };
    };
    expect(saved.stats?.embeddings).toBe(1);
    expect(saved.embeddingCheckpoint?.kind).toBe('unverified-count');
    expect(saved.embeddingCheckpoint?.pendingNodeIds).toEqual([]);
    expect(releaseMock).toHaveBeenCalled();
  });

  it('keeps the pipeline error when closeLbug also rejects', async () => {
    await store();
    runEmbeddingPipelineMock.mockRejectedValue(new Error('pipeline boom'));
    closeLbugMock.mockRejectedValue(new Error('close boom'));

    await expect(run()).rejects.toThrow('pipeline boom');
    expect(releaseMock).toHaveBeenCalled();
  });

  it('loads existing hashes without materializing cached vectors', async () => {
    await store();
    const hashes = new Map([
      ['n1', 'h1'],
      ['n2', 'h2'],
    ]);
    fetchExistingEmbeddingHashesMock.mockResolvedValue(hashes);

    await run();

    expect(fetchExistingEmbeddingHashesMock).toHaveBeenCalledTimes(1);
    const existingArg = runEmbeddingPipelineMock.mock.calls[0]?.[5];
    expect(existingArg).toBe(hashes);
  });
});
