/**
 * Tests for `gitnexus embeddings sync` writer-safety contracts (#3065 review):
 * index lock, missing-DB preflight, identity fail-closed, tri-state count,
 * closeLbug masking, and hash-only cache load.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  acquireIndexLockMock,
  ensurePrivateSharedGraphMock,
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
  runAnalysisEmbeddingPhaseMock,
  resolveEmbeddingIdentityMock,
  installEmbeddingRuntimeMock,
  resolveEmbeddingRuntimeMock,
  isPrefixRuntimeLoadableMock,
  reapEmbeddingSidecarMock,
} = vi.hoisted(() => ({
  acquireIndexLockMock: vi.fn(),
  ensurePrivateSharedGraphMock: vi.fn(),
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
  runAnalysisEmbeddingPhaseMock: vi.fn(),
  resolveEmbeddingIdentityMock: vi.fn(),
  installEmbeddingRuntimeMock: vi.fn(),
  resolveEmbeddingRuntimeMock: vi.fn(),
  isPrefixRuntimeLoadableMock: vi.fn(),
  reapEmbeddingSidecarMock: vi.fn(),
}));

vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: () => '/tmp/emb-sync-repo',
}));

vi.mock('../../src/core/shared-store-analyze.js', () => ({
  ensurePrivateSharedGraph: (...args: unknown[]) => ensurePrivateSharedGraphMock(...args),
}));

vi.mock('../../src/storage/index-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/index-lock.js')>()),
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

vi.mock('../../src/core/analysis-embedding-phase.js', () => ({
  runAnalysisEmbeddingPhase: (...args: unknown[]) => runAnalysisEmbeddingPhaseMock(...args),
}));

vi.mock('../../src/core/embeddings/embedding-pipeline.js', () => ({
  runEmbeddingPipeline: (...args: unknown[]) => runEmbeddingPipelineMock(...args),
}));

vi.mock('../../src/core/embeddings/embedding-identity.js', () => ({
  resolveEmbeddingIdentity: () => resolveEmbeddingIdentityMock(),
}));

vi.mock('../../src/core/embeddings/runtime-install.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/embeddings/runtime-install.js')>()),
  installEmbeddingRuntime: (...args: unknown[]) => installEmbeddingRuntimeMock(...args),
  resolveEmbeddingRuntime: () => resolveEmbeddingRuntimeMock(),
  isPrefixRuntimeLoadable: () => isPrefixRuntimeLoadableMock(),
}));

vi.mock('../../src/core/embeddings/embedding-sidecar-client.js', () => ({
  reapEmbeddingSidecar: () => reapEmbeddingSidecarMock(),
}));

const IDENTITY = { model: 'test-model', dimensions: 768, provider: 'local' } as const;
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

async function useRealIndexLock() {
  vi.stubEnv('GITNEXUS_INDEX_LOCK_BACKEND', 'file');
  const actual = await vi.importActual<typeof import('../../src/storage/index-lock.js')>(
    '../../src/storage/index-lock.js',
  );
  acquireIndexLockMock.mockImplementation(
    async (...args: Parameters<typeof actual.acquireIndexLock>) => {
      const lock = await actual.acquireIndexLock(...args);
      return {
        ...lock,
        release: () => {
          lock.release();
          releaseMock();
        },
      };
    },
  );
}

describe('embeddingsSyncCommand writer safety (#3065)', () => {
  const tmpDirs: string[] = [];
  const originalEmbeddingUrl = process.env.GITNEXUS_EMBEDDING_URL;
  const originalEmbeddingModel = process.env.GITNEXUS_EMBEDDING_MODEL;

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
    heap.bytes = 1024 ** 3;
    vi.resetModules();
    acquireIndexLockMock.mockReset().mockResolvedValue(lockHandle());
    ensurePrivateSharedGraphMock.mockReset().mockResolvedValue(true);
    releaseMock.mockReset();
    getStoragePathsMock.mockReset();
    loadMetaMock.mockReset().mockResolvedValue({ ...BASE_META });
    saveMetaMock.mockReset().mockResolvedValue(undefined);
    initLbugMock.mockReset().mockResolvedValue(undefined);
    runAnalysisEmbeddingPhaseMock
      .mockReset()
      .mockResolvedValue({ ...BASE_META, stats: { embeddings: 2 } });
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
    installEmbeddingRuntimeMock.mockReset().mockResolvedValue(undefined);
    resolveEmbeddingRuntimeMock.mockReset().mockReturnValue({ source: 'package' });
    isPrefixRuntimeLoadableMock.mockReset().mockReturnValue(true);
    reapEmbeddingSidecarMock.mockReset();
    delete process.env.GITNEXUS_EMBEDDING_URL;
    delete process.env.GITNEXUS_EMBEDDING_MODEL;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (originalEmbeddingUrl === undefined) delete process.env.GITNEXUS_EMBEDDING_URL;
    else process.env.GITNEXUS_EMBEDDING_URL = originalEmbeddingUrl;
    if (originalEmbeddingModel === undefined) delete process.env.GITNEXUS_EMBEDDING_MODEL;
    else process.env.GITNEXUS_EMBEDDING_MODEL = originalEmbeddingModel;
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('accounts for the running process heap when sync cannot respawn', async () => {
    await store();
    await run();
    expect(runAnalysisEmbeddingPhaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: expect.objectContaining({ automatic: true, mainHeapMb: 1024 }),
      }),
    );
  });

  it.each([2096, 65536])(
    'rejects a %i MiB running heap that cannot fit with the local model on 8 GiB before locking',
    async (heapMb) => {
      await store();
      heap.bytes = heapMb * 1024 ** 2;
      await expect(run()).rejects.toThrow('cannot admit');
      expect(acquireIndexLockMock).not.toHaveBeenCalled();
      expect(ensurePrivateSharedGraphMock).not.toHaveBeenCalled();
      expect(initLbugMock).not.toHaveBeenCalled();
      expect(runAnalysisEmbeddingPhaseMock).not.toHaveBeenCalled();
    },
  );

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
    runAnalysisEmbeddingPhaseMock.mockImplementation(async () => {
      order.push('phase');
      return BASE_META;
    });

    await run();

    expect(acquireIndexLockMock).toHaveBeenCalledWith(dir, { sweep: false });
    expect(order[0]).toBe('lock');
    expect(order.indexOf('loadMeta')).toBeGreaterThan(order.indexOf('lock'));
    expect(order.indexOf('phase')).toBeGreaterThan(order.indexOf('loadMeta'));
    expect(order.at(-1)).toBe('release');
  });

  it('refuses an unlocked embeddings sync', async () => {
    await store();
    acquireIndexLockMock.mockResolvedValue({ ...lockHandle(), lockFree: true as const });
    await expect(run()).rejects.toThrow('refusing an unlocked embeddings sync');
    expect(loadMetaMock).not.toHaveBeenCalled();
    expect(initLbugMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalled();
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
  ])('preserves a $name before any writable sync work', async ({ recovery }) => {
    const { dir, lbugPath, metaPath } = await store();
    await useRealIndexLock();
    const lockPath = path.join(dir, 'analyze.lock');
    const sourcePath = path.join(dir, 'lbug.staging.12345678-1234-4123-8123-123456789abc');
    await writeFile(sourcePath, 'completed paid vectors');
    await writeFile(`${sourcePath}.wal`, 'unfinished window');
    const metadataBytes = JSON.stringify({
      ...BASE_META,
      embeddingCheckpoint: {
        ...IDENTITY,
        at: '2026-01-01T00:00:00.000Z',
        nodesProcessed: 1,
        totalNodes: 2,
        chunksProcessed: 1,
        kind: 'interrupted',
        pendingNodeIds: ['n2'],
        recovery,
      },
    });
    await writeFile(metaPath, metadataBytes);
    loadMetaMock.mockImplementation(async () => {
      expect(existsSync(lockPath)).toBe(true);
      return JSON.parse(await readFile(metaPath, 'utf8'));
    });
    resolveEmbeddingRuntimeMock.mockReturnValue(null);

    await expect(run()).rejects.toThrow(
      /staged embeddings.*Run `gitnexus analyze` to recover them first/,
    );

    expect(acquireIndexLockMock).toHaveBeenCalledWith(dir, { sweep: false });
    expect(loadMetaMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      acquireIndexLockMock.mock.invocationCallOrder[0]!,
    );
    expect(ensurePrivateSharedGraphMock).not.toHaveBeenCalled();
    expect(resolveEmbeddingIdentityMock).not.toHaveBeenCalled();
    expect(installEmbeddingRuntimeMock).not.toHaveBeenCalled();
    expect(initLbugMock).not.toHaveBeenCalled();
    expect(runEmbeddingPipelineMock).not.toHaveBeenCalled();
    expect(saveMetaMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(false);
    expect(await readFile(metaPath, 'utf8')).toBe(metadataBytes);
    expect(await readFile(lbugPath, 'utf8')).toBe('db');
    expect(await readFile(sourcePath, 'utf8')).toBe('completed paid vectors');
    expect(await readFile(`${sourcePath}.wal`, 'utf8')).toBe('unfinished window');
  });

  it('sweeps orphaned staging files before writable sync work without a recovery receipt', async () => {
    const { dir, metaPath } = await store();
    await useRealIndexLock();
    await writeFile(metaPath, JSON.stringify(BASE_META));
    const sourcePath = path.join(dir, 'lbug.staging.12345678-1234-4123-8123-123456789abc');
    await writeFile(sourcePath, 'orphaned database');
    await writeFile(`${sourcePath}.wal`, 'orphaned WAL');
    loadMetaMock.mockImplementation(async () => JSON.parse(await readFile(metaPath, 'utf8')));
    ensurePrivateSharedGraphMock.mockImplementation(async () => {
      expect(existsSync(path.join(dir, 'analyze.lock'))).toBe(true);
      expect(existsSync(sourcePath)).toBe(false);
      expect(existsSync(`${sourcePath}.wal`)).toBe(false);
      return true;
    });

    await run();

    expect(ensurePrivateSharedGraphMock).toHaveBeenCalledTimes(1);
    expect(runAnalysisEmbeddingPhaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(dir, 'analyze.lock'))).toBe(false);
  });

  it('does not clear durable partial work when the shared phase fails', async () => {
    const { dir } = await store();
    const retained = { ...BASE_META, embeddingJob: { identity: 'retained-work' } };
    loadMetaMock.mockResolvedValue(retained);
    runAnalysisEmbeddingPhaseMock.mockRejectedValue(new Error('provider unavailable'));
    await expect(run()).rejects.toThrow('provider unavailable');
    expect(runAnalysisEmbeddingPhaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadataDirectory: dir,
        nodeLimit: 0,
      }),
    );
    expect(saveMetaMock).not.toHaveBeenCalled();
    expect(runEmbeddingPipelineMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it('keeps the shared phase error without opening or closing a legacy writable graph', async () => {
    await store();
    runAnalysisEmbeddingPhaseMock.mockRejectedValue(new Error('phase boom'));
    closeLbugMock.mockRejectedValue(new Error('close boom'));
    reapEmbeddingSidecarMock.mockImplementation(() => {
      throw new Error('reap boom');
    });
    await expect(run()).rejects.toThrow('phase boom');
    expect(initLbugMock).not.toHaveBeenCalled();
    expect(closeLbugMock).not.toHaveBeenCalled();
    expect(reapEmbeddingSidecarMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it('preserves a prepared graph receipt before any embedding or staging cleanup', async () => {
    const { dir } = await store();
    const receipt = path.join(dir, 'analysis-publication.json');
    await writeFile(receipt, '{ malformed retained receipt');
    await expect(run()).rejects.toThrow();
    expect(await readFile(receipt, 'utf8')).toBe('{ malformed retained receipt');
    expect(runAnalysisEmbeddingPhaseMock).not.toHaveBeenCalled();
    expect(ensurePrivateSharedGraphMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it('does not spawn npm on darwin/x64', async () => {
    await store();
    resolveEmbeddingRuntimeMock.mockReturnValue(null);
    const orig = { platform: process.platform, arch: process.arch };
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
    try {
      await expect(run()).rejects.toThrow(/macOS Intel/);
      expect(installEmbeddingRuntimeMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: orig.platform, configurable: true });
      Object.defineProperty(process, 'arch', { value: orig.arch, configurable: true });
    }
  });

  it('auto-heals a missing stack without requesting CUDA binaries', async () => {
    await store();
    resolveEmbeddingRuntimeMock.mockReturnValue(null);

    await run();

    expect(installEmbeddingRuntimeMock).toHaveBeenCalledTimes(1);
    expect(installEmbeddingRuntimeMock.mock.calls[0]?.[0]).toEqual({});
    expect(installEmbeddingRuntimeMock.mock.calls[0]?.[0]).not.toMatchObject({ cuda: true });
  });

  it('wraps a failed auto-install with the missing-stack recovery path', async () => {
    await store();
    resolveEmbeddingRuntimeMock.mockReturnValue(null);
    installEmbeddingRuntimeMock.mockRejectedValue(new Error('npm install timed out'));

    await expect(run()).rejects.toThrow(
      /Could not install the embedding runtime[\s\S]*gitnexus embeddings install/,
    );
    expect(initLbugMock).not.toHaveBeenCalled();
  });

  it('does not statically import the embedding pipeline', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/cli/embeddings-sync.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^import .*analysis-embedding-phase/m);
    expect(src).toContain("await import('../core/analysis-embedding-phase.js')");
  });

  it('passes the owned graph generation without materializing hashes or vectors', async () => {
    const { dir, metaPath } = await store();
    const metadata = {
      ...BASE_META,
      graphPath: 'lbug.generation.' + 'a'.repeat(32),
      graphGeneration: { id: 'a'.repeat(32) },
    };
    await writeFile(metaPath, JSON.stringify(metadata));
    await writeFile(path.join(dir, metadata.graphPath), 'owned graph');
    loadMetaMock.mockResolvedValue(metadata);
    await run();
    expect(runAnalysisEmbeddingPhaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        graphPath: path.join(dir, metadata.graphPath),
        expectedGeneration: metadata.graphGeneration.id,
      }),
    );
    expect(fetchExistingEmbeddingHashesMock).not.toHaveBeenCalled();
    expect(runEmbeddingPipelineMock).not.toHaveBeenCalled();
    expect(saveMetaMock).not.toHaveBeenCalled();
  });
});
