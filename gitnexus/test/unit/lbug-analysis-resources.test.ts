import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const native = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(async () => {}),
  quarantine: vi.fn(async () => ({ quarantinedPath: '/unused' })),
}));
vi.mock('../../src/core/lbug/lbug-config.js', async (original) => ({
  ...(await original<typeof import('../../src/core/lbug/lbug-config.js')>()),
  openLbugConnection: native.open,
  closeLbugConnection: native.close,
}));
vi.mock('../../src/core/lbug/sidecar-recovery.js', async (original) => ({
  ...(await original<typeof import('../../src/core/lbug/sidecar-recovery.js')>()),
  quarantineWalForMissingShadow: native.quarantine,
  isMissingShadowSidecarError: (error: unknown) =>
    error instanceof Error && error.message === 'missing shadow test',
}));
vi.mock('../../src/core/lbug/extension-loader.js', async (original) => ({
  ...(await original<typeof import('../../src/core/lbug/extension-loader.js')>()),
  extensionManager: {
    ensure: vi.fn(async () => true),
    reset: vi.fn(),
    getCapabilities: vi.fn(() => []),
  },
}));

describe('analysis database resource allocations', () => {
  let root: string;
  let adapter: typeof import('../../src/core/lbug/lbug-adapter.js');
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-analysis-resources-'));
    native.open.mockImplementation(async () => ({
      db: { close: vi.fn(async () => {}) },
      conn: {
        query: vi.fn(async () => ({ getAll: async () => [], close: () => {} })),
        close: vi.fn(async () => {}),
      },
    }));
    adapter = await import('../../src/core/lbug/lbug-adapter.js');
  });
  afterEach(async () => {
    await adapter.closeLbug();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('applies native allocations and reopens only when the allocation changes', async () => {
    const dbPath = path.join(root, 'lbug');
    const options = { skipFts: true, bufferPoolBytes: 64 * 1024 * 1024, threads: 3 };
    await adapter.initLbug(dbPath, options);
    await adapter.initLbug(dbPath, { ...options });
    expect(native.open).toHaveBeenCalledTimes(1);
    expect(native.open.mock.calls[0][2]).toEqual({
      bufferPoolBytes: options.bufferPoolBytes,
      threads: 3,
    });
    const first = await native.open.mock.results[0].value;
    await adapter.initLbug(dbPath, { ...options, threads: 2 });
    expect(first.conn.close).toHaveBeenCalledTimes(1);
    expect(first.db.close).toHaveBeenCalledTimes(1);
    expect(native.open).toHaveBeenCalledTimes(2);
    expect(native.open.mock.calls[1][2]).toEqual({
      bufferPoolBytes: options.bufferPoolBytes,
      threads: 2,
    });
  });

  it.each([undefined, 3072])(
    'caps the native graph opener at admitted budget %s',
    async (totalMb) => {
      const config = await import('../../src/core/lbug/lbug-config.js');
      const sizedPool = vi
        .spyOn(config, 'getEffectiveBufferPoolSize')
        .mockReturnValue(2048 * 1024 ** 2);
      const { resolveAnalysisResourceBudget } =
        await import('../../src/core/analysis-resource-budget.js');
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const resources = resolveAnalysisResourceBudget({
        effectiveMemoryBytes: 4096 * 1024 ** 2,
        availableCpus: 4,
        modelMemoryMb: 0,
        totalMb,
      });
      const stopped = new Error('native opener reached');
      native.open.mockRejectedValue(stopped);
      await fs.writeFile(path.join(root, 'a.ts'), 'export function a() { return 1; }');
      try {
        await expect(
          runFullAnalysis(
            root,
            { resources, skipGit: true, skipFts: true, skipAgentsMd: true, skipSkills: true },
            { onProgress: () => {} },
          ),
        ).rejects.toThrow(stopped.message);
        expect(native.open).toHaveBeenCalled();
        for (const call of native.open.mock.calls) {
          expect(call[2]).toMatchObject({ bufferPoolBytes: resources.parse.graphPoolBytes });
        }
      } finally {
        sizedPool.mockRestore();
      }
    },
  );

  it('rejects invalid allocations before creating the database directory or opening native code', async () => {
    const parent = path.join(root, 'not-created');
    for (const options of [
      { bufferPoolBytes: -1 },
      { bufferPoolBytes: 0.5 },
      { bufferPoolBytes: 1024 },
      { threads: 0 },
      { threads: 1.5 },
    ]) {
      await expect(adapter.initLbug(path.join(parent, 'lbug'), options)).rejects.toThrow(
        /Explicit LadybugDB/,
      );
    }
    expect(native.open).not.toHaveBeenCalled();
    await expect(fs.stat(parent)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves the zero override for the native default pool', async () => {
    await adapter.initLbug(path.join(root, 'lbug'), { skipFts: true, bufferPoolBytes: 0 });
    expect(native.open).toHaveBeenCalledOnce();
    expect(native.open.mock.calls[0][2]).toMatchObject({ bufferPoolBytes: 0 });
  });

  it.each(['conn', 'db'] as const)(
    'retains a failed %s close and refuses to allocate another pool',
    async (handle) => {
      const dbPath = path.join(root, 'lbug');
      const options = { skipFts: true, bufferPoolBytes: 64 * 1024 * 1024, threads: 3 };
      await adapter.initLbug(dbPath, options);
      const first = await native.open.mock.results[0].value;
      first[handle].close.mockRejectedValueOnce(new Error('native close failed'));
      await expect(adapter.initLbug(dbPath, { ...options, threads: 2 })).rejects.toThrow(
        'native close failed',
      );
      expect(native.open).toHaveBeenCalledTimes(1);
      // A subsequent successful drain can safely admit the requested allocation.
      await adapter.initLbug(dbPath, options);
      expect(native.open).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps the same allocations when missing-shadow recovery reopens the writer', async () => {
    native.open.mockResolvedValueOnce({
      db: { close: vi.fn(async () => {}) },
      conn: {
        query: vi.fn(async () => {
          throw new Error('missing shadow test');
        }),
        close: vi.fn(async () => {}),
      },
    });
    const options = { skipFts: true, bufferPoolBytes: 32 * 1024 * 1024, threads: 2 };
    await adapter.initLbug(path.join(root, 'lbug'), options);
    expect(native.quarantine).toHaveBeenCalledTimes(1);
    expect(native.open).toHaveBeenCalledTimes(2);
    expect(native.open.mock.calls.map((call) => call[2])).toEqual([
      { bufferPoolBytes: options.bufferPoolBytes, threads: 2 },
      { bufferPoolBytes: options.bufferPoolBytes, threads: 2 },
    ]);
  });

  it.each(['parser', 'embedding'] as const)(
    'refuses %s admission while the main pool cannot close',
    async (phase) => {
      const { resolveAnalysisResourceBudget } =
        await import('../../src/core/analysis-resource-budget.js');
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const { runPublishedEmbeddingJob } =
        await import('../../src/core/embeddings/embedding-job.js');
      const resources = resolveAnalysisResourceBudget({
        effectiveMemoryBytes: 8 * 1024 ** 3,
        availableCpus: 4,
        modelMemoryMb: 0,
      });
      await adapter.initLbug(path.join(root, 'lbug'), {
        skipFts: true,
        bufferPoolBytes: 32 * 1024 * 1024,
        threads: 1,
      });
      const first = await native.open.mock.results[0].value;
      first.db.close.mockRejectedValue(new Error('main pool still allocated'));
      await expect(adapter.closeLbug()).rejects.toThrow('main pool still allocated');
      const loadMetadata = vi.fn(async () => null);
      const provider = vi.fn();
      const onProgress = vi.fn();
      try {
        const run =
          phase === 'parser'
            ? runFullAnalysis(root, { resources }, { onProgress })
            : runPublishedEmbeddingJob(
                {
                  metadataDirectory: root,
                  graphPath: path.join(root, 'lbug'),
                  resources: resources.embedding,
                  metadata: { loadMetadata, saveMetadata: vi.fn() },
                },
                { provider },
              );
        await expect(run).rejects.toThrow('main pool still allocated');
        expect(loadMetadata).not.toHaveBeenCalled();
        expect(provider).not.toHaveBeenCalled();
        expect(onProgress).not.toHaveBeenCalled();
        expect(native.open).toHaveBeenCalledTimes(1);
      } finally {
        first.db.close.mockResolvedValue();
      }
    },
  );

  it('waits for an active session before releasing its native handle', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = adapter.withLbugDb(
      path.join(root, 'lbug'),
      async () => {
        started();
        await wait;
      },
      { skipFts: true },
    );
    await ready;
    const first = await native.open.mock.results[0].value;
    let drained = false;
    const drain = adapter.drainAnalysisNativeResources().then(() => {
      drained = true;
    });
    try {
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(first.conn.close).not.toHaveBeenCalled();
      expect(first.db.close).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.all([operation, drain]);
    }
    expect(first.conn.close).toHaveBeenCalledTimes(1);
    expect(first.db.close).toHaveBeenCalledTimes(1);
  });

  it('does not reopen native storage when an idle phase has nothing to release', async () => {
    await adapter.drainAnalysisNativeResources();
    expect(native.open).not.toHaveBeenCalled();
  });

  it('honors cancellation during admission before reading job metadata', async () => {
    const { resolveAnalysisResourceBudget } =
      await import('../../src/core/analysis-resource-budget.js');
    const { runPublishedEmbeddingJob } = await import('../../src/core/embeddings/embedding-job.js');
    const resources = resolveAnalysisResourceBudget({
      effectiveMemoryBytes: 8 * 1024 ** 3,
      availableCpus: 4,
      modelMemoryMb: 0,
    });
    let started!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = adapter.withLbugDb(
      path.join(root, 'lbug'),
      async () => {
        started();
        await wait;
      },
      { skipFts: true },
    );
    await ready;
    const cancellation = new AbortController();
    const loadMetadata = vi.fn(async () => null);
    const provider = vi.fn();
    const outcome = runPublishedEmbeddingJob(
      {
        metadataDirectory: root,
        graphPath: path.join(root, 'lbug'),
        resources: resources.embedding,
        signal: cancellation.signal,
        metadata: { loadMetadata, saveMetadata: vi.fn() },
      },
      { provider },
    ).catch((error: unknown) => error);
    cancellation.abort();
    release();
    await operation;
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(loadMetadata).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });
});
