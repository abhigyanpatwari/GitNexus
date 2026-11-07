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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { EmbeddingSourceReader } from '../../src/core/embeddings/source-reader.js';

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

describe('pending artifacts across graph generations', () => {
  it.each(['full', 'symbol', 'none'] as const)(
    'uses published repository source policy (%s), then resumes without source or provider work',
    async (retention) => {
      const f = await fixture(1);
      const repo = path.join(f.root, 'checkout');
      await fs.mkdir(repo);
      const content = `function sample() {\n${'  consume("padding");\n'.repeat(300)}  return "RECOVERED_TAIL";\n}`;
      await fs.writeFile(path.join(repo, 'sample.ts'), content);
      const node: EmbeddableNode = {
        id: 'Function:sample.ts:sample',
        label: 'Function',
        name: 'sample',
        filePath: 'sample.ts',
        content: content.slice(0, 5000) + '... [truncated]',
        startLine: 0,
        endLine: content.split('\n').length - 1,
      };
      f.scan.mockImplementation(async function* (label) {
        if (label === 'Function')
          yield { id: node.id, contentBytes: Buffer.byteLength(node.content), metadataBytes: 1024 };
      });
      f.fetch.mockImplementation(async () => [node]);
      const meta = await loadMeta(f.root);
      if (!meta) throw new Error('Missing fixture metadata');
      await saveMeta(f.root, {
        ...meta,
        repoPath: repo,
        contentRetention: retention,
        fileHashes: { 'sample.ts': createHash('sha256').update(content).digest('hex') },
      });
      const read = vi.spyOn(EmbeddingSourceReader.prototype, 'read');
      const result = await f.run();
      const texts = f.provider.mock.calls.flatMap(([texts]) => texts).join('\n');
      expect(texts.includes('RECOVERED_TAIL')).toBe(retention === 'full');
      expect(read.mock.calls.length > 0).toBe(retention === 'full');
      expect(result.peakQueueBytes).toBeLessThanOrEqual(f.options().resources.queueBytes);
      expect(node.content).toContain('[truncated]');
      if (retention === 'full') {
        await fs.writeFile(
          path.join(repo, 'sample.ts'),
          content.replace('RECOVERED_TAIL', 'UNINDEXED_TAIL'),
        );
        await f.nextGeneration();
        const unchanged = await loadMeta(f.root);
        if (!unchanged) throw new Error('Missing fixture metadata');
        await saveMeta(f.root, {
          ...unchanged,
          repoPath: repo,
          contentRetention: retention,
          fileHashes: { 'sample.ts': createHash('sha256').update(content).digest('hex') },
        });
        f.provider.mockClear();
        read.mockClear();
        expect((await f.run()).state?.reusedNodes).toBe(1);
        expect(f.provider).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
        const advance = async (source: string) => {
          await fs.writeFile(path.join(repo, 'sample.ts'), source);
          await f.nextGeneration();
          const current = await loadMeta(f.root);
          if (!current) throw new Error('Missing fixture metadata');
          await saveMeta(f.root, {
            ...current,
            repoPath: repo,
            contentRetention: retention,
            fileHashes: { 'sample.ts': createHash('sha256').update(source).digest('hex') },
          });
        };
        f.provider.mockClear();
        read.mockClear();
        await advance(content + '\n// unrelated sibling edit');
        expect((await f.run()).state?.reusedNodes).toBe(1);
        expect(f.provider).not.toHaveBeenCalled();
        expect(read).toHaveBeenCalled();
        await advance(content.replace('RECOVERED_TAIL', 'CHANGED_TAIL'));
        await f.run();
        expect(f.provider.mock.calls.flatMap(([texts]) => texts).join('\n')).toContain(
          'CHANGED_TAIL',
        );
      }
      await fs.rm(repo, { recursive: true });
      f.provider.mockClear();
      read.mockClear();
      expect((await f.run()).alreadyComplete).toBe(true);
      expect(f.provider).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('rejects oversized original source before paid work and retries with a larger reservation', async () => {
    const f = await fixture(1);
    const content = `function sample() {\n${' '.repeat(1024 * 1024)}return "TAIL";\n}`;
    await fs.writeFile(path.join(f.root, 'sample.ts'), content);
    const node: EmbeddableNode = {
      id: 'Function:sample.ts:sample',
      label: 'Function',
      name: 'sample',
      filePath: 'sample.ts',
      content: 'function sample() ... [truncated]',
      startLine: 0,
      endLine: 2,
    };
    f.scan.mockImplementation(async function* (label) {
      if (label === 'Function')
        yield { id: node.id, contentBytes: Buffer.byteLength(node.content), metadataBytes: 1024 };
    });
    f.fetch.mockImplementation(async () => [node]);
    const meta = await loadMeta(f.root);
    if (!meta) throw new Error('Missing fixture metadata');
    await saveMeta(f.root, {
      ...meta,
      fileHashes: { 'sample.ts': createHash('sha256').update(content).digest('hex') },
    });
    await expect(f.run()).rejects.toThrow('larger resource budget');
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.initializeProvider).not.toHaveBeenCalled();
    const result = await f.run({
      resources: { ...f.options().resources, queueBytes: 32 * 1024 * 1024 },
    });
    expect(result.phase).toBe('ready');
    expect(result.peakQueueBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(f.provider.mock.calls.flatMap(([texts]) => texts).join('\n')).toContain('TAIL');
  });

  it('recovers native sealing before the ownership phase was recorded, then reuses read-only', async () => {
    const f = await fixture(5);
    const ownership = await import('../../src/storage/embedding-artifact.js');
    const adopt = ownership.adoptEmbeddingArtifact;
    const interrupted = vi
      .spyOn(ownership, 'adoptEmbeddingArtifact')
      .mockImplementation(async (...args) => {
        if (args[3].phase === 'sealed') throw new Error('stopped after native seal');
        return adopt(...args);
      });
    await expect(f.run()).rejects.toThrow('stopped after native seal');
    interrupted.mockRestore();
    const first = (await loadMeta(f.root))?.embeddingJob;
    await f.nextGeneration();
    f.provider.mockClear();
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.state?.reusedNodes).toBe(5);
    expect(result.metadata.vectorGeneration?.artifactIdentity).not.toBe(first?.artifactIdentity);
    expect(f.provider).not.toHaveBeenCalled();
  });

  it('recovers an adopted artifact when metadata persistence fails before any new paid work', async () => {
    const f = await fixture(130);
    await expect(
      f.run({
        onProgress: (state) => {
          if (state.completedNodes === 64) throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');
    const first = (await loadMeta(f.root))?.embeddingJob;
    await f.nextGeneration();
    f.provider.mockClear();
    await expect(
      f.run({
        metadata: {
          ...f.options().metadata,
          saveMetadata: async () => {
            throw new Error('metadata unavailable');
          },
        },
      }),
    ).rejects.toThrow('metadata unavailable');
    expect(f.provider).not.toHaveBeenCalled();
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.metadata.vectorGeneration?.artifactIdentity).toBe(first?.artifactIdentity);
    expect(result.state?.reusedNodes).toBe(64);
    expect(f.provider.mock.calls.flatMap(([texts]) => texts)).toHaveLength(66);
  });

  it('retains the first paid groups across two interrupted rebases with a fresh cursor each time', async () => {
    const f = await fixture(130);
    await expect(
      f.run({
        onProgress: (state) => {
          if (state.completedNodes === 64) throw new Error('first interruption');
        },
      }),
    ).rejects.toThrow('first interruption');
    expect(f.provider.mock.calls.flatMap(([texts]) => texts)).toHaveLength(64);
    const first = (await loadMeta(f.root))?.embeddingJob;
    if (!first?.artifactIdentity) throw new Error('Expected owned pending artifact');
    const file = path.join(f.root, 'embeddings', first.artifactIdentity, 'vectors');
    const inode = (await fs.stat(file)).ino;
    const fetch = f.fetch.getMockImplementation();
    if (!fetch) throw new Error('Missing fixture fetch');
    const changed = new Set(['Const:a.ts:n00000']);
    f.fetch.mockImplementation(async (label, ids) =>
      (await fetch(label, ids)).map((node) =>
        changed.has(node.id) ? { ...node, content: 'const value = 2;' } : node,
      ),
    );
    await f.nextGeneration();
    f.provider.mockClear();
    await expect(
      f.run({
        onProgress: (state) => {
          if (state.completedNodes + state.reusedNodes === 128)
            throw new Error('second interruption');
        },
      }),
    ).rejects.toThrow('second interruption');
    const second = (await loadMeta(f.root))?.embeddingJob;
    expect(second?.identity).not.toBe(first.identity);
    expect(second?.artifactIdentity).toBe(first.artifactIdentity);
    expect(f.provider.mock.calls.flatMap(([texts]) => texts)).toHaveLength(65);
    changed.add('Const:a.ts:n00001');
    await f.nextGeneration();
    f.provider.mockClear();
    const final = await f.run();
    expect(final.phase).toBe('ready');
    expect(final.state).toMatchObject({ completedNodes: 3, reusedNodes: 127, totalNodes: 130 });
    expect(f.provider.mock.calls.flatMap(([texts]) => texts)).toHaveLength(3);
    expect(final.metadata.vectorGeneration?.artifactIdentity).toBe(first.artifactIdentity);
    expect(final.metadata.vectorGeneration?.graphGeneration).toBe(
      final.metadata.graphGeneration?.id,
    );
    expect((await fs.stat(file)).ino).toBe(inode);
    const { searchVectorGeneration } =
      await import('../../src/core/embeddings/vector-generation-search.js');
    const pool = await import('../../src/core/lbug/pool-adapter.js');
    try {
      const hits = await searchVectorGeneration(
        { metadataDirectory: f.root, metadata: final.metadata, graphPath: f.options().graphPath },
        async () => [1, 0, 0, 0],
        2,
        1,
        async () => f.dependencies.identity(),
      );
      expect(hits).toHaveLength(2);
      expect(hits?.every((hit) => hit.nodeId.startsWith('Const:a.ts:'))).toBe(true);
    } finally {
      await pool.closeLbug();
    }
    f.provider.mockClear();
    f.openSource.mockClear();
    expect((await f.run()).alreadyComplete).toBe(true);
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.openSource).not.toHaveBeenCalled();
  });

  it('retains both pending paid groups and its completed fallback across another graph edit', async () => {
    const f = await fixture(130);
    const completed = await f.run();
    const fallback = completed.metadata.vectorGeneration;
    if (!fallback?.artifactIdentity) throw new Error('Expected completed artifact');
    const fetch = f.fetch.getMockImplementation();
    if (!fetch) throw new Error('Missing fixture fetch');
    const changed = new Set(['Const:a.ts:n00000']);
    f.fetch.mockImplementation(async (label, ids) =>
      (await fetch(label, ids)).map((node) =>
        changed.has(node.id) ? { ...node, content: 'const value = 2;' } : node,
      ),
    );
    await f.nextGeneration();
    f.provider.mockClear();
    await expect(
      f.run({
        onProgress: (state) => {
          if (state.completedNodes + state.reusedNodes === 64) throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');
    expect(f.provider.mock.calls.flatMap(([texts]) => texts)).toHaveLength(1);
    const pending = (await loadMeta(f.root))?.embeddingJob;
    expect(pending?.artifactIdentity).not.toBe(fallback.artifactIdentity);
    expect(
      (
        await fs.stat(path.join(f.root, 'embeddings', fallback.artifactIdentity, 'vectors'))
      ).isFile(),
    ).toBe(true);
    changed.add('Const:a.ts:n00001');
    await f.nextGeneration();
    f.provider.mockClear();
    const final = await f.run();
    expect(final.state).toMatchObject({ completedNodes: 1, reusedNodes: 129 });
    expect(f.provider.mock.calls.flatMap(([texts]) => texts)).toHaveLength(1);
    expect(final.metadata.vectorGeneration?.artifactIdentity).toBe(pending?.artifactIdentity);
    await expect(
      fs.stat(path.join(f.root, 'embeddings', fallback.artifactIdentity, 'vectors')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses a sealed but unpublished artifact as a read-only fallback after a graph edit', async () => {
    const f = await fixture(5);
    const metadata = f.options().metadata;
    await expect(
      f.run({
        metadata: {
          ...metadata,
          saveMetadata: async (value) => {
            if (value.vectorGeneration) throw new Error('publication interrupted');
            await metadata.saveMetadata(value);
          },
        },
      }),
    ).rejects.toThrow('publication interrupted');
    const first = (await loadMeta(f.root))?.embeddingJob;
    expect(first?.artifactIdentity).toBeDefined();
    await f.nextGeneration();
    f.provider.mockClear();
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.state?.reusedNodes).toBe(5);
    expect(result.metadata.vectorGeneration?.artifactIdentity).not.toBe(first?.artifactIdentity);
    expect(f.provider).not.toHaveBeenCalled();
  });

  it('returns directly to retained compatible work after using another vector space', async () => {
    const f = await fixture(10);
    await expect(
      f.run({
        onProgress: (state) => {
          if (state.completedNodes === 10) throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');
    const first = (await loadMeta(f.root))?.embeddingJob;
    f.dependencies.identity.mockReturnValue({ provider: 'local', model: 'other', dimensions: 4 });
    await f.run();
    f.dependencies.identity.mockReturnValue({ provider: 'local', model: 'test', dimensions: 4 });
    f.provider.mockClear();
    f.openSource.mockClear();
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.metadata.vectorGeneration?.artifactIdentity).toBe(first?.artifactIdentity);
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.openSource).not.toHaveBeenCalled();
  });

  it('fails before source/model work when the directly keyed ownership receipt is corrupt', async () => {
    const f = await fixture(5);
    await expect(
      f.run({
        onProgress: (state) => {
          if (state.completedNodes) throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');
    const pending = (await loadMeta(f.root))?.embeddingJob;
    if (!pending?.spaceKey || !pending.artifactIdentity)
      throw new Error('Missing ownership receipt');
    const receipt = path.join(f.root, 'embeddings', 'spaces', pending.spaceKey, 'space.json');
    await fs.writeFile(receipt, '{"checksum":"bad","payload":{}}');
    f.provider.mockClear();
    f.openSource.mockClear();
    f.initializeProvider.mockClear();
    await expect(f.run()).rejects.toThrow('checksum mismatch');
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.openSource).not.toHaveBeenCalled();
    expect(f.initializeProvider).not.toHaveBeenCalled();
    await expect(
      fs.stat(path.join(f.root, 'embeddings', pending.artifactIdentity, 'vectors')),
    ).resolves.toBeDefined();
  });
});

describe('published graph embedding job controller', () => {
  it('reclaims the prior rebased artifact after a third generation seals', async () => {
    const f = await fixture(3);
    await f.run();
    await f.nextGeneration();
    const second = await f.run();
    const previous = second.metadata.vectorGeneration!;
    expect(previous.artifactIdentity).not.toBe(previous.identity);
    const oldDirectory = path.join(f.root, 'embeddings', previous.artifactIdentity!);
    expect(
      JSON.parse(await fs.readFile(path.join(oldDirectory, 'artifact.json'), 'utf8')).payload
        .identity,
    ).toBe(previous.artifactIdentity);
    await f.nextGeneration();
    const third = await f.run();
    expect(third.phase).toBe('ready');
    await expect(fs.stat(oldDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('resumes an interrupted bootstrap without rescanning the manifest or losing the pending job', async () => {
    const f = await fixture(3);
    const original = VectorStore.open.bind(VectorStore);
    const open = vi.spyOn(VectorStore, 'open').mockImplementationOnce(async (options) => {
      await expect(
        promisify(execFile)(process.execPath, [
          fileURLToPath(new URL('../helpers/interrupted-vector-bootstrap.mjs', import.meta.url)),
          JSON.stringify(options),
        ]),
      ).rejects.toMatchObject({ code: 73 });
      throw new Error('interrupted bootstrap');
    });
    await expect(f.run()).rejects.toThrow('interrupted bootstrap');
    expect(f.provider).not.toHaveBeenCalled();
    const pending = (await loadMeta(f.root))?.embeddingJob;
    expect(pending).toBeDefined();
    f.scan.mockClear();
    open.mockImplementation(original);
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.metadata.vectorGeneration?.identity).toBe(pending?.identity);
    expect(f.scan).not.toHaveBeenCalled();
    expect(f.provider.mock.calls.flatMap(([texts]) => texts)).toHaveLength(3);
  });
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
    await expect(
      fs.stat(path.join(f.root, 'embeddings', first.metadata.vectorGeneration.identity, 'vectors')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (
        await fs.stat(
          path.join(
            f.root,
            'embeddings',
            next.metadata.vectorGeneration!.artifactIdentity!,
            'vectors',
          ),
        )
      ).isFile(),
    ).toBe(true);
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

  it('binds graph paths through an aliased ancestor to the canonical job root', async () => {
    const f = await fixture(1);
    const alias = path.join(f.root, 'alias');
    await fs.symlink(
      path.dirname(f.root),
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const graphFile = path.basename(f.options().graphPath);
    const result = await f.run({
      graphPath: path.join(alias, path.basename(f.root), graphFile),
    });
    expect(result.phase).toBe('ready');
    expect(f.openSource).toHaveBeenCalledWith(
      path.join(await fs.realpath(f.root), graphFile),
      f.options().resources.graphPoolBytes,
      f.options().resources.nativeThreads,
    );
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
