import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';
import { saveMeta, loadMeta } from '../../src/storage/repo-manager.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';
import { runPublishedEmbeddingJob } from '../../src/core/embeddings/embedding-job.js';
import type { EmbeddableNode } from '../../src/core/embeddings/types.js';
import { VectorStore } from '../../src/core/lbug/vector-store.js';
import { resolveAnalysisResourceBudget } from '../../src/core/analysis-resource-budget.js';
import { EmbeddingJobJournal } from '../../src/storage/embedding-job-journal.js';

let temporary: TestDBHandle | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await temporary?.cleanup();
  temporary = undefined;
});

async function fixture(count = 130) {
  temporary = await createTempDir();
  vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'never');
  const root = temporary.dbPath;
  let generation = 1;
  const makeMeta = (): RepoMeta => ({
    repoPath: root,
    lastCommit: 'commit',
    indexedAt: new Date().toISOString(),
    graphPath: `lbug.generation.${String(generation).padStart(32, '0')}`,
    graphGeneration: {
      version: 1,
      id: String(generation).padStart(32, '0'),
      coveredContent: 'a'.repeat(64),
    },
    schemaFingerprint: 'graph-schema',
    parseCacheIdentity: { base: 'parser' },
    runnerIdentity: {
      schemaVersion: 4,
      cliVersion: 'test',
      runtime: {
        executablePath: process.execPath,
        version: process.version,
        platform: process.platform,
        architecture: process.arch,
        modulesAbi: '127',
        libc: 'glibc',
      },
      invokedArtifact: { path: 'analyze', digest: 'cli' },
      build: {
        kind: 'distribution',
        rootPath: root,
        canonicalization: 'gitnexus-analyzer-build-v2',
        digest: 'build',
      },
      dependencyRuntime: {
        manifestPath: 'package.json',
        lockfilePath: null,
        canonicalization: 'gitnexus-analyzer-dependency-runtime-v4',
        packageCount: 1,
        artifactCount: 1,
        digest: 'runtime',
      },
    },
    scopeExtractionReceipt: 1,
  });
  await saveMeta(root, makeMeta());
  const node = (id: string): EmbeddableNode => ({
    id,
    name: id.split(':').at(-1) ?? id,
    label: 'Const',
    filePath: 'a.ts',
    content: 'const value = 1;',
    startLine: 1,
    endLine: 1,
  });
  const scan = vi.fn(async function* (label: string) {
    if (label !== 'Const') return;
    for (let i = 0; i < count; i++)
      yield {
        id: `Const:a.ts:n${String(i).padStart(5, '0')}`,
        contentBytes: Buffer.byteLength('const value = 1;'),
        metadataBytes: 1024,
      };
  });
  const fetch = vi.fn(async (_label: string, ids: readonly string[]) => ids.map(node));
  const close = vi.fn(async () => {});
  const openSource = vi.fn(async () => ({ scan, fetch, close }));
  const initializeProvider = vi.fn(async () => {});
  const provider = vi.fn(async (texts: string[]) => {
    expect((await loadMeta(root))?.embeddingJob).toBeDefined();
    return texts.map(() => new Float32Array([1, 0, 0, 0]));
  });
  const identity = vi.fn(() => ({ provider: 'local', model: 'test', dimensions: 4 }));
  const resources = {
    graphPoolBytes: 16 * 1024 * 1024,
    vectorPoolBytes: 64 * 1024 * 1024,
    modelBytes: 0,
    modelHeapMb: 0,
    queueBytes: 16 * 1024 * 1024,
    nativeThreads: 1,
    reservedBytes: 96 * 1024 * 1024,
  };
  const metadata = {
    loadMetadata: () => loadMeta(root),
    saveMetadata: (meta: RepoMeta) => saveMeta(root, meta),
  };
  const options = () => ({
    metadataDirectory: root,
    graphPath: path.join(root, `lbug.generation.${String(generation).padStart(32, '0')}`),
    resources,
    config: { threads: 1, subBatchSize: 8 },
    metadata,
  });
  const dependencies = { openSource, provider, initializeProvider, identity };
  const run = (extra: Partial<Parameters<typeof runPublishedEmbeddingJob>[0]> = {}) =>
    runPublishedEmbeddingJob({ ...options(), ...extra }, dependencies);
  return {
    root,
    run,
    options,
    dependencies,
    provider,
    initializeProvider,
    openSource,
    scan,
    fetch,
    close,
    nextGeneration: async () => {
      const prior = await loadMeta(root);
      generation++;
      await saveMeta(root, { ...makeMeta(), vectorGeneration: prior?.vectorGeneration });
    },
  };
}

describe('published graph embedding job controller', () => {
  it('drains an earlier local runtime before admitting an HTTP job with no model reservation', async () => {
    const f = await fixture(3);
    vi.stubEnv('GITNEXUS_EMBEDDING_URL', 'https://embedding.test/v1');
    vi.stubEnv('GITNEXUS_EMBEDDING_MODEL', 'test-model');
    vi.stubEnv('GITNEXUS_EMBEDDING_DIMS', '4');
    const sidecar = await import('../../src/core/embeddings/embedding-sidecar-client.js');
    const drain = vi.spyOn(sidecar, 'drainEmbeddingSidecarForAnalysis').mockResolvedValue();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(
        JSON.stringify({
          data: body.input.map((_text, index) => ({ index, embedding: [1, 0, 0, 0] })),
        }),
      );
    });
    const result = await runPublishedEmbeddingJob(f.options(), { openSource: f.openSource });
    expect(result.phase).toBe('ready');
    expect(drain).toHaveBeenCalledTimes(1);
    expect(drain.mock.invocationCallOrder[0]).toBeLessThan(
      f.openSource.mock.invocationCallOrder[0],
    );
  });

  it('uses and releases the admitted local runtime, including initialization failure', async () => {
    const f = await fixture(3);
    const sidecar = await import('../../src/core/embeddings/embedding-sidecar-client.js');
    const initialize = vi.fn(async () => {});
    const embedBatch = vi.fn(async (texts: string[]) =>
      texts.map(() => new Float32Array([1, 0, 0, 0])),
    );
    const release = vi.fn();
    const reserve = vi
      .spyOn(sidecar, 'reserveEmbeddingSidecar')
      .mockResolvedValue({ initialize, embedBatch, release });
    const options = {
      ...f.options(),
      resources: { ...f.options().resources, modelBytes: 1024 * 1024 * 1024, modelHeapMb: 256 },
    };
    const dependencies = { identity: f.dependencies.identity, openSource: f.openSource };
    await expect(
      runPublishedEmbeddingJob(
        { ...options, resources: { ...options.resources, modelBytes: NaN } },
        dependencies,
      ),
    ).rejects.toThrow('resource reservation');
    expect(reserve).not.toHaveBeenCalled();
    expect((await loadMeta(f.root))?.embeddingJob).toBeUndefined();
    initialize.mockRejectedValueOnce(new Error('model init unavailable'));
    await expect(runPublishedEmbeddingJob(options, dependencies)).rejects.toThrow(
      'model init unavailable',
    );
    expect(embedBatch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect((await loadMeta(f.root))?.embeddingJob).toBeDefined();
    const result = await runPublishedEmbeddingJob(options, dependencies);
    expect(result.phase).toBe('ready');
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ threads: 1 }), 256);
    expect(release).toHaveBeenCalledTimes(2);
    expect(embedBatch.mock.calls.flatMap(([texts]) => texts)).toHaveLength(3);
    reserve.mockClear();
    expect((await runPublishedEmbeddingJob(options, dependencies)).alreadyComplete).toBe(true);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('rejects a split vector pool below the native minimum before changing metadata', async () => {
    const f = await fixture(3);
    await f.run();
    await f.nextGeneration();
    const before = await loadMeta(f.root);
    f.openSource.mockClear();
    await expect(
      f.run({ resources: { ...f.options().resources, vectorPoolBytes: 8 * 1024 * 1024 } }),
    ).rejects.toThrow('reuse reader do not fit');
    expect(await loadMeta(f.root)).toEqual(before);
    expect(f.openSource).not.toHaveBeenCalled();
  });

  it('publishes complete vectors, then takes a no-model/no-writer fast path', async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.metadata.vectorGeneration?.nodes).toBe(130);
    expect(result.metadata.embeddingJob).toBeUndefined();
    expect(result.state?.completedUnits).toBe(3);
    expect(f.initializeProvider).toHaveBeenCalledOnce();
    f.provider.mockClear();
    f.openSource.mockClear();
    const open = vi.spyOn(VectorStore, 'open');
    expect((await f.run()).alreadyComplete).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.openSource).not.toHaveBeenCalled();
  });

  it('resumes acknowledged work with a smaller batch and queue without rescanning keys', async () => {
    const f = await fixture();
    await expect(
      f.run({
        onProgress: (state) => {
          if (state.completedUnits === 1) throw new Error('stop after acknowledgement');
        },
      }),
    ).rejects.toThrow('stop after acknowledgement');
    expect(f.provider.mock.calls.flatMap(([texts]) => texts)).toHaveLength(64);
    f.provider.mockClear();
    f.scan.mockClear();
    const result = await f.run({
      config: { threads: 1, subBatchSize: 1 },
      resources: { ...f.options().resources, queueBytes: 8 * 1024 * 1024 },
    });
    expect(result.phase).toBe('ready');
    expect(f.provider.mock.calls.flatMap(([texts]) => texts)).toHaveLength(66);
    expect(f.scan).not.toHaveBeenCalled();
    expect(result.peakQueueBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('retries pointer publication without source or provider work', async () => {
    const f = await fixture(5);
    const metadata = f.options().metadata;
    await expect(
      f.run({
        metadata: {
          ...metadata,
          saveMetadata: async (meta) => {
            if (meta.vectorGeneration) throw new Error('disk unavailable for pointer');
            await metadata.saveMetadata(meta);
          },
        },
      }),
    ).rejects.toThrow('disk unavailable');
    f.provider.mockClear();
    f.openSource.mockClear();
    f.initializeProvider.mockClear();
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.openSource).not.toHaveBeenCalled();
    expect(f.initializeProvider).not.toHaveBeenCalled();
  });

  it('copies compatible paid vectors to the next graph with no provider call', async () => {
    const f = await fixture(5);
    const first = await f.run();
    await f.nextGeneration();
    f.provider.mockClear();
    f.initializeProvider.mockClear();
    const next = await f.run();
    expect(next.phase).toBe('ready');
    expect(next.metadata.vectorGeneration?.identity).not.toBe(
      first.metadata.vectorGeneration?.identity,
    );
    expect(next.state?.reusedNodes).toBe(5);
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.initializeProvider).not.toHaveBeenCalled();
    if (!first.metadata.vectorGeneration) throw new Error('Expected published vectors');
    expect(
      await fs.stat(
        path.join(f.root, 'embeddings', first.metadata.vectorGeneration.identity, 'vectors'),
      ),
    ).toBeDefined();
  });

  it('does no paid replay if the process stops after publishing the vector pointer', async () => {
    const f = await fixture(5);
    const ready = vi
      .spyOn(EmbeddingJobJournal.prototype, 'ready')
      .mockRejectedValueOnce(new Error('stopped after pointer'));
    await expect(f.run()).rejects.toThrow('stopped after pointer');
    expect((await loadMeta(f.root))?.vectorGeneration).toBeDefined();
    f.provider.mockClear();
    f.openSource.mockClear();
    expect((await f.run()).alreadyComplete).toBe(true);
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.openSource).not.toHaveBeenCalled();
    ready.mockRestore();
  });

  it('recovers an interrupted manifest preflight before any provider or vector mutation', async () => {
    const f = await fixture(5);
    f.scan.mockImplementationOnce(async function* () {
      throw new Error('preflight stopped');
    });
    await expect(f.run()).rejects.toThrow('preflight stopped');
    expect(f.provider).not.toHaveBeenCalled();
    expect((await f.run()).phase).toBe('ready');
    expect(f.provider.mock.calls.flatMap(([texts]) => texts)).toHaveLength(5);
  });

  it('publishes empty coverage without a model request', async () => {
    const f = await fixture(0);
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.metadata.vectorGeneration?.chunks).toBe(0);
    expect(result.metadata.capabilities?.vectorSearch.status).toBe('unavailable');
    expect(f.provider).not.toHaveBeenCalled();
  });

  it('admits a 10 MiB fallback file and embeds its final marker without truncation', async () => {
    const f = await fixture(0);
    const content = 'a'.repeat(10 * 1024 * 1024 - 30) + '\nFINAL_UNTRUNCATED_MARKER';
    const id = 'File:large.txt';
    let sawEnd = false;
    let requests = 0;
    const result = await runPublishedEmbeddingJob(
      {
        ...f.options(),
        resources: resolveAnalysisResourceBudget({
          effectiveMemoryBytes: 16 * 1024 ** 3,
          availableCpus: 4,
          totalMb: 8192,
          modelMemoryMb: 0,
          includeParsing: false,
        }).embedding,
      },
      {
        ...f.dependencies,
        openSource: async () => ({
          async *scan(label) {
            if (label === 'File')
              yield { id, contentBytes: Buffer.byteLength(content), metadataBytes: 1024 };
          },
          fetch: async () => [
            {
              id,
              label: 'File',
              name: 'large.txt',
              filePath: 'large.txt',
              content,
              startLine: 1,
              endLine: 2,
            },
          ],
          close: async () => {},
        }),
        // Count inputs without retaining the complete test corpus in spy history.
        provider: async (texts) => {
          requests++;
          sawEnd ||= texts.some((text) => text.includes('FINAL_UNTRUNCATED_MARKER'));
          return texts.map(() => new Float32Array([1, 0, 0, 0]));
        },
      },
    );
    expect(result.phase).toBe('ready');
    expect(sawEnd).toBe(true);
    expect(requests).toBeGreaterThan(100);
    expect(result.peakQueueBytes).toBeLessThanOrEqual(256 * 1024 * 1024);
  }, 60000);

  it('reconstructs a corrupt journal only from verified native complete groups', async () => {
    const f = await fixture();
    await expect(
      f.run({
        onProgress: (state) => {
          if (state.completedUnits === 1) throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');
    const meta = await loadMeta(f.root);
    if (!meta?.embeddingJob) throw new Error('Expected pending job');
    const job = path.join(f.root, 'embeddings', meta.embeddingJob.identity);
    await fs.writeFile(path.join(job, 'job.json'), '{broken');
    f.provider.mockClear();
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.state?.reusedNodes).toBe(64);
    expect(f.provider.mock.calls.flatMap(([texts]) => texts)).toHaveLength(66);
    expect((await fs.readdir(job)).some((name) => name.startsWith('job.json.preserved-'))).toBe(
      true,
    );
  });

  it('rejects a missing paid artifact before model or fresh-store creation', async () => {
    const f = await fixture(5);
    await expect(
      f.run({
        onProgress: (state) => {
          if (state.completedUnits) throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');
    const meta = await loadMeta(f.root);
    if (!meta?.embeddingJob) throw new Error('Expected pending job');
    const job = path.join(f.root, 'embeddings', meta.embeddingJob.identity);
    await fs.rename(path.join(job, 'vectors'), path.join(job, 'vectors.retained'));
    f.provider.mockClear();
    await expect(f.run()).rejects.toThrow('vectors are missing');
    expect(f.provider).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(job, 'vectors'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a symlink job root before writing metadata or requesting vectors', async () => {
    const f = await fixture(5);
    await fs.mkdir(path.join(f.root, 'other'));
    await fs.symlink(path.join(f.root, 'other'), path.join(f.root, 'embeddings'), 'dir');
    await expect(f.run()).rejects.toThrow('owned directory');
    expect((await loadMeta(f.root))?.embeddingJob).toBeUndefined();
    expect(f.provider).not.toHaveBeenCalled();
  });
});
