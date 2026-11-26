import fs from 'node:fs/promises';
import path from 'node:path';
import { after, afterEach, describe, it, mock } from 'node:test';
import { expect } from 'expect';
import { createTestEnvironment } from '../support/environment.js';
import { createTempDir, type TestDBHandle } from '../../../../test/helpers/test-db.js';
import { saveMeta, loadMeta } from '../../../../dist/storage/repo-manager.js';
import type { RepoMeta } from '../../../../dist/storage/repo-meta.js';
import type { EmbeddableNode } from '../../../../dist/core/embeddings/types.js';
import { VectorStore } from '../../../../dist/core/lbug/vector-store.js';
import { resolveAnalysisResourceBudget } from '../../../../dist/core/analysis-resource-budget.js';
import { EmbeddingJobJournal } from '../../../../dist/storage/embedding-job-journal.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { EmbeddingSourceReader } from '../../../../dist/core/embeddings/source-reader.js';

import * as artifact from '../../../../dist/storage/embedding-artifact.js';
import * as sidecar from '../../../../dist/core/embeddings/embedding-sidecar-client.js';
const adoptArtifact = mock.fn(artifact.adoptEmbeddingArtifact);
const drainSidecar = mock.fn(sidecar.drainEmbeddingSidecarForAnalysis);
const reserveSidecar = mock.fn(sidecar.reserveEmbeddingSidecar);
const ownershipModule = mock.module(
  new URL('../../../../dist/storage/embedding-artifact.js', import.meta.url).href,
  {
    namedExports: { ...artifact, adoptEmbeddingArtifact: adoptArtifact },
  },
);
const sidecarModule = mock.module(
  new URL('../../../../dist/core/embeddings/embedding-sidecar-client.js', import.meta.url).href,
  {
    namedExports: {
      ...sidecar,
      drainEmbeddingSidecarForAnalysis: drainSidecar,
      reserveEmbeddingSidecar: reserveSidecar,
    },
  },
);
after(() => {
  ownershipModule.restore();
  sidecarModule.restore();
});
const { runPublishedEmbeddingJob } =
  await import('../../../../dist/core/embeddings/embedding-job.js');
const environment = createTestEnvironment();

let temporary: TestDBHandle | undefined;
afterEach(async () => {
  adoptArtifact.mock.mockImplementation(artifact.adoptEmbeddingArtifact);
  drainSidecar.mock.mockImplementation(sidecar.drainEmbeddingSidecarForAnalysis);
  reserveSidecar.mock.mockImplementation(sidecar.reserveEmbeddingSidecar);
  drainSidecar.mock.resetCalls();
  reserveSidecar.mock.resetCalls();
  environment.restore();
  await temporary?.cleanup();
  temporary = undefined;
});

async function fixture(count = 130) {
  temporary = await createTempDir();
  environment.set('GITNEXUS_LBUG_EXTENSION_INSTALL', 'never');
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
  const scan = mock.fn(async function* (label: string) {
    if (label !== 'Const') return;
    for (let i = 0; i < count; i++)
      yield {
        id: `Const:a.ts:n${String(i).padStart(5, '0')}`,
        contentBytes: Buffer.byteLength('const value = 1;'),
        metadataBytes: 1024,
      };
  });
  const fetchNodes = async (_label: string, ids: readonly string[]) => ids.map(node);
  const fetch = mock.fn(fetchNodes);
  const close = mock.fn(async () => {});
  const openSource = mock.fn(async (_graphPath: string, _poolBytes: number, _threads: number) => ({
    scan,
    fetch,
    close,
  }));
  const initializeProvider = mock.fn(async () => {});
  const provider = mock.fn(async (texts: string[]) => {
    expect((await loadMeta(root))?.embeddingJob).toBeDefined();
    return texts.map(() => new Float32Array([1, 0, 0, 0]));
  });
  const identity = mock.fn(() => ({ provider: 'local', model: 'test', dimensions: 4 }));
  const resources = {
    graphPoolBytes: 16 * 1024 * 1024,
    vectorPoolBytes: 64 * 1024 * 1024,
    modelBytes: 0,
    modelHeapMb: 0,
    queueBytes: 16 * 1024 * 1024,
    nativeThreads: 1,
    indexThreads: 1,
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
    fetchNodes,
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
  for (const provider of ['local', `http:${'a'.repeat(64)}`]) {
    it(`keeps an injected ${provider} provider serial despite the HTTP setting`, async () => {
      const f = await fixture(64);
      environment.set('GITNEXUS_EMBEDDING_CONCURRENCY', '4');
      f.dependencies.identity.mock.mockImplementation(() => ({
        provider,
        model: 'test',
        dimensions: 4,
      }));
      let active = 0;
      let peak = 0;
      f.provider.mock.mockImplementation(async (texts) => {
        peak = Math.max(peak, ++active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active--;
        return texts.map(() => Float32Array.of(1, 0, 0, 0));
      });
      await f.run();
      expect(peak).toBe(1);
      expect(f.provider.mock.callCount()).toBe(8);
    });
  }
  for (const retention of ['full', 'symbol', 'none'] as const) {
    it(`uses published repository source policy (${retention}), then resumes without source or provider work`, async (t) => {
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
      f.scan.mock.mockImplementation(async function* (label) {
        if (label === 'Function')
          yield { id: node.id, contentBytes: Buffer.byteLength(node.content), metadataBytes: 1024 };
      });
      f.fetch.mock.mockImplementation(async () => [node]);
      const meta = await loadMeta(f.root);
      if (!meta) throw new Error('Missing fixture metadata');
      await saveMeta(f.root, {
        ...meta,
        repoPath: repo,
        contentRetention: retention,
        fileHashes: { 'sample.ts': createHash('sha256').update(content).digest('hex') },
      });
      const read = t.mock.method(EmbeddingSourceReader.prototype, 'read');
      const result = await f.run();
      const texts = f.provider.mock.calls.flatMap(({ arguments: [texts] }) => texts).join('\n');
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
        f.provider.mock.resetCalls();
        read.mock.resetCalls();
        expect((await f.run()).state?.reusedNodes).toBe(1);
        expect(f.provider.mock.callCount()).toBe(0);
        expect(read.mock.callCount()).toBe(0);
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
        f.provider.mock.resetCalls();
        read.mock.resetCalls();
        await advance(content + '\n// unrelated sibling edit');
        expect((await f.run()).state?.reusedNodes).toBe(1);
        expect(f.provider.mock.callCount()).toBe(0);
        expect(read.mock.callCount()).toBeGreaterThan(0);
        await advance(content.replace('RECOVERED_TAIL', 'CHANGED_TAIL'));
        await f.run();
        expect(
          f.provider.mock.calls.flatMap(({ arguments: [texts] }) => texts).join('\n'),
        ).toContain('CHANGED_TAIL');
      }
      await fs.rm(repo, { recursive: true });
      f.provider.mock.resetCalls();
      read.mock.resetCalls();
      expect((await f.run()).alreadyComplete).toBe(true);
      expect(f.provider.mock.callCount()).toBe(0);
      expect(read.mock.callCount()).toBe(0);
    });
  }

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
    f.scan.mock.mockImplementation(async function* (label) {
      if (label === 'Function')
        yield { id: node.id, contentBytes: Buffer.byteLength(node.content), metadataBytes: 1024 };
    });
    f.fetch.mock.mockImplementation(async () => [node]);
    const meta = await loadMeta(f.root);
    if (!meta) throw new Error('Missing fixture metadata');
    await saveMeta(f.root, {
      ...meta,
      fileHashes: { 'sample.ts': createHash('sha256').update(content).digest('hex') },
    });
    await expect(f.run()).rejects.toThrow('larger resource budget');
    expect(f.provider.mock.callCount()).toBe(0);
    expect(f.initializeProvider.mock.callCount()).toBe(0);
    const result = await f.run({
      resources: { ...f.options().resources, queueBytes: 32 * 1024 * 1024 },
    });
    expect(result.phase).toBe('ready');
    expect(result.peakQueueBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(f.provider.mock.calls.flatMap(({ arguments: [texts] }) => texts).join('\n')).toContain(
      'TAIL',
    );
  });

  it('recovers native sealing before the ownership phase was recorded, then reuses read-only', async () => {
    const f = await fixture(5);
    adoptArtifact.mock.mockImplementation(async (...args) => {
      if (args[3].phase === 'sealed') throw new Error('stopped after native seal');
      return artifact.adoptEmbeddingArtifact(...args);
    });
    await expect(f.run()).rejects.toThrow('stopped after native seal');
    adoptArtifact.mock.mockImplementation(artifact.adoptEmbeddingArtifact);
    const first = (await loadMeta(f.root))?.embeddingJob;
    await f.nextGeneration();
    f.provider.mock.resetCalls();
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.state?.reusedNodes).toBe(5);
    expect(result.metadata.vectorGeneration?.artifactIdentity).not.toBe(first?.artifactIdentity);
    expect(f.provider.mock.callCount()).toBe(0);
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
    f.provider.mock.resetCalls();
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
    expect(f.provider.mock.callCount()).toBe(0);
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.metadata.vectorGeneration?.artifactIdentity).toBe(first?.artifactIdentity);
    expect(result.state?.reusedNodes).toBe(64);
    expect(f.provider.mock.calls.flatMap(({ arguments: [texts] }) => texts)).toHaveLength(66);
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
    expect(f.provider.mock.calls.flatMap(({ arguments: [texts] }) => texts)).toHaveLength(64);
    const first = (await loadMeta(f.root))?.embeddingJob;
    if (!first?.artifactIdentity) throw new Error('Expected owned pending artifact');
    const file = path.join(f.root, 'embeddings', first.artifactIdentity, 'vectors');
    const inode = (await fs.stat(file)).ino;
    const fetch = f.fetchNodes;
    const changed = new Set(['Const:a.ts:n00000']);
    f.fetch.mock.mockImplementation(async (label, ids) =>
      (await fetch(label, ids)).map((node) =>
        changed.has(node.id) ? { ...node, content: 'const value = 2;' } : node,
      ),
    );
    await f.nextGeneration();
    f.provider.mock.resetCalls();
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
    expect(f.provider.mock.calls.flatMap(({ arguments: [texts] }) => texts)).toHaveLength(65);
    changed.add('Const:a.ts:n00001');
    await f.nextGeneration();
    f.provider.mock.resetCalls();
    const final = await f.run();
    expect(final.phase).toBe('ready');
    expect(final.state).toMatchObject({ completedNodes: 3, reusedNodes: 127, totalNodes: 130 });
    expect(f.provider.mock.calls.flatMap(({ arguments: [texts] }) => texts)).toHaveLength(3);
    expect(final.metadata.vectorGeneration?.artifactIdentity).toBe(first.artifactIdentity);
    expect(final.metadata.vectorGeneration?.graphGeneration).toBe(
      final.metadata.graphGeneration?.id,
    );
    expect((await fs.stat(file)).ino).toBe(inode);
    const { searchVectorGeneration } =
      await import('../../../../dist/core/embeddings/vector-generation-search.js');
    const pool = await import('../../../../dist/core/lbug/pool-adapter.js');
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
    f.provider.mock.resetCalls();
    f.openSource.mock.resetCalls();
    expect((await f.run()).alreadyComplete).toBe(true);
    expect(f.provider.mock.callCount()).toBe(0);
    expect(f.openSource.mock.callCount()).toBe(0);
  });

  it('retains both pending paid groups and its completed fallback across another graph edit', async () => {
    const f = await fixture(130);
    const completed = await f.run();
    const fallback = completed.metadata.vectorGeneration;
    if (!fallback?.artifactIdentity) throw new Error('Expected completed artifact');
    const fetch = f.fetchNodes;
    const changed = new Set(['Const:a.ts:n00000']);
    f.fetch.mock.mockImplementation(async (label, ids) =>
      (await fetch(label, ids)).map((node) =>
        changed.has(node.id) ? { ...node, content: 'const value = 2;' } : node,
      ),
    );
    await f.nextGeneration();
    f.provider.mock.resetCalls();
    await expect(
      f.run({
        onProgress: (state) => {
          if (state.completedNodes + state.reusedNodes === 64) throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');
    expect(f.provider.mock.calls.flatMap(({ arguments: [texts] }) => texts)).toHaveLength(1);
    const pending = (await loadMeta(f.root))?.embeddingJob;
    expect(pending?.artifactIdentity).not.toBe(fallback.artifactIdentity);
    expect(
      (
        await fs.stat(path.join(f.root, 'embeddings', fallback.artifactIdentity, 'vectors'))
      ).isFile(),
    ).toBe(true);
    changed.add('Const:a.ts:n00001');
    await f.nextGeneration();
    f.provider.mock.resetCalls();
    const final = await f.run();
    expect(final.state).toMatchObject({ completedNodes: 1, reusedNodes: 129 });
    expect(f.provider.mock.calls.flatMap(({ arguments: [texts] }) => texts)).toHaveLength(1);
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
    f.provider.mock.resetCalls();
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.state?.reusedNodes).toBe(5);
    expect(result.metadata.vectorGeneration?.artifactIdentity).not.toBe(first?.artifactIdentity);
    expect(f.provider.mock.callCount()).toBe(0);
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
    f.dependencies.identity.mock.mockImplementation(() => ({
      provider: 'local',
      model: 'other',
      dimensions: 4,
    }));
    await f.run();
    f.dependencies.identity.mock.mockImplementation(() => ({
      provider: 'local',
      model: 'test',
      dimensions: 4,
    }));
    f.provider.mock.resetCalls();
    f.openSource.mock.resetCalls();
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.metadata.vectorGeneration?.artifactIdentity).toBe(first?.artifactIdentity);
    expect(f.provider.mock.callCount()).toBe(0);
    expect(f.openSource.mock.callCount()).toBe(0);
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
    f.provider.mock.resetCalls();
    f.openSource.mock.resetCalls();
    f.initializeProvider.mock.resetCalls();
    await expect(f.run()).rejects.toThrow('checksum mismatch');
    expect(f.provider.mock.callCount()).toBe(0);
    expect(f.openSource.mock.callCount()).toBe(0);
    expect(f.initializeProvider.mock.callCount()).toBe(0);
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
  it('resumes an interrupted bootstrap without rescanning the manifest or losing the pending job', async (t) => {
    const f = await fixture(3);
    const original = VectorStore.open.bind(VectorStore);
    const open = t.mock.method(VectorStore, 'open');
    open.mock.mockImplementationOnce(async (options) => {
      await expect(
        promisify(execFile)(process.execPath, [
          fileURLToPath(
            new URL('../../../../test/helpers/interrupted-vector-bootstrap.mjs', import.meta.url),
          ),
          JSON.stringify(options),
        ]),
      ).rejects.toMatchObject({ code: 73 });
      throw new Error('interrupted bootstrap');
    });
    await expect(f.run()).rejects.toThrow('interrupted bootstrap');
    expect(f.provider.mock.callCount()).toBe(0);
    const pending = (await loadMeta(f.root))?.embeddingJob;
    expect(pending).toBeDefined();
    f.scan.mock.resetCalls();
    open.mock.mockImplementation(original);
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.metadata.vectorGeneration?.identity).toBe(pending?.identity);
    expect(f.scan.mock.callCount()).toBe(0);
    expect(f.provider.mock.calls.flatMap(({ arguments: [texts] }) => texts)).toHaveLength(3);
  });
  it('drains an earlier local runtime before admitting an HTTP job with no model reservation', async (t) => {
    const f = await fixture(3);
    environment.set('GITNEXUS_EMBEDDING_URL', 'https://embedding.test/v1');
    environment.set('GITNEXUS_EMBEDDING_MODEL', 'test-model');
    environment.set('GITNEXUS_EMBEDDING_DIMS', '4');
    const order: string[] = [];
    drainSidecar.mock.mockImplementation(async () => {
      order.push('drain');
    });
    const openSource = async (...args: Parameters<typeof f.openSource>) => {
      order.push('open');
      return f.openSource(...args);
    };
    t.mock.method(
      globalThis,
      'fetch',
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        return new Response(
          JSON.stringify({
            data: body.input.map((_text, index) => ({ index, embedding: [1, 0, 0, 0] })),
          }),
        );
      },
    );
    const result = await runPublishedEmbeddingJob(f.options(), { openSource });
    expect(result.phase).toBe('ready');
    expect(drainSidecar.mock.callCount()).toBe(1);
    expect(order[0]).toBe('drain');
    expect(order).toContain('open');
  });

  it('uses and releases the admitted local runtime, including initialization failure', async () => {
    const f = await fixture(3);
    const initialize = mock.fn(async () => {});
    const embedBatch = mock.fn(async (texts: string[]) =>
      texts.map(() => new Float32Array([1, 0, 0, 0])),
    );
    const release = mock.fn();
    const reserve = reserveSidecar;
    reserve.mock.mockImplementation(async () => ({ initialize, embedBatch, release }));
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
    expect(reserve.mock.callCount()).toBe(0);
    expect((await loadMeta(f.root))?.embeddingJob).toBeUndefined();
    initialize.mock.mockImplementationOnce(async () => {
      throw new Error('model init unavailable');
    });
    await expect(runPublishedEmbeddingJob(options, dependencies)).rejects.toThrow(
      'model init unavailable',
    );
    expect(embedBatch.mock.callCount()).toBe(0);
    expect(release.mock.callCount()).toBe(1);
    expect((await loadMeta(f.root))?.embeddingJob).toBeDefined();
    const result = await runPublishedEmbeddingJob(options, dependencies);
    expect(result.phase).toBe('ready');
    expect(reserve.mock.calls.map((call) => call.arguments)).toContainEqual([
      expect.objectContaining({ threads: 1 }),
      256,
    ]);
    expect(release.mock.callCount()).toBe(2);
    expect(embedBatch.mock.calls.flatMap(({ arguments: [texts] }) => texts)).toHaveLength(3);
    reserve.mock.resetCalls();
    expect((await runPublishedEmbeddingJob(options, dependencies)).alreadyComplete).toBe(true);
    expect(reserve.mock.callCount()).toBe(0);
  });

  it('rejects a split vector pool below the native minimum before changing metadata', async () => {
    const f = await fixture(3);
    await f.run();
    await f.nextGeneration();
    const before = await loadMeta(f.root);
    f.openSource.mock.resetCalls();
    await expect(
      f.run({ resources: { ...f.options().resources, vectorPoolBytes: 8 * 1024 * 1024 } }),
    ).rejects.toThrow('reuse reader do not fit');
    expect(await loadMeta(f.root)).toEqual(before);
    expect(f.openSource.mock.callCount()).toBe(0);
  });

  it('publishes complete vectors, then takes a no-model/no-writer fast path', async (t) => {
    const f = await fixture();
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.metadata.vectorGeneration?.nodes).toBe(130);
    expect(result.metadata.embeddingJob).toBeUndefined();
    expect(result.state?.completedUnits).toBe(3);
    expect(f.initializeProvider.mock.callCount()).toBe(1);
    f.provider.mock.resetCalls();
    f.openSource.mock.resetCalls();
    const open = t.mock.method(VectorStore, 'open');
    expect((await f.run()).alreadyComplete).toBe(true);
    expect(open.mock.callCount()).toBe(0);
    expect(f.provider.mock.callCount()).toBe(0);
    expect(f.openSource.mock.callCount()).toBe(0);
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
    expect(f.provider.mock.calls.flatMap(({ arguments: [texts] }) => texts)).toHaveLength(64);
    f.provider.mock.resetCalls();
    f.scan.mock.resetCalls();
    const result = await f.run({
      config: { threads: 1, subBatchSize: 1 },
      resources: { ...f.options().resources, queueBytes: 8 * 1024 * 1024 },
    });
    expect(result.phase).toBe('ready');
    expect(f.provider.mock.calls.flatMap(({ arguments: [texts] }) => texts)).toHaveLength(66);
    expect(f.scan.mock.callCount()).toBe(0);
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
    f.provider.mock.resetCalls();
    f.openSource.mock.resetCalls();
    f.initializeProvider.mock.resetCalls();
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(f.provider.mock.callCount()).toBe(0);
    expect(f.openSource.mock.callCount()).toBe(0);
    expect(f.initializeProvider.mock.callCount()).toBe(0);
  });

  it('copies compatible paid vectors to the next graph with no provider call', async () => {
    const f = await fixture(5);
    const first = await f.run();
    await f.nextGeneration();
    f.provider.mock.resetCalls();
    f.initializeProvider.mock.resetCalls();
    const next = await f.run();
    expect(next.phase).toBe('ready');
    expect(next.metadata.vectorGeneration?.identity).not.toBe(
      first.metadata.vectorGeneration?.identity,
    );
    expect(next.state?.reusedNodes).toBe(5);
    expect(f.provider.mock.callCount()).toBe(0);
    expect(f.initializeProvider.mock.callCount()).toBe(0);
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

  it('does no paid replay if the process stops after publishing the vector pointer', async (t) => {
    const f = await fixture(5);
    const ready = t.mock.method(EmbeddingJobJournal.prototype, 'ready');
    ready.mock.mockImplementationOnce(async () => {
      throw new Error('stopped after pointer');
    });
    await expect(f.run()).rejects.toThrow('stopped after pointer');
    expect((await loadMeta(f.root))?.vectorGeneration).toBeDefined();
    f.provider.mock.resetCalls();
    f.openSource.mock.resetCalls();
    expect((await f.run()).alreadyComplete).toBe(true);
    expect(f.provider.mock.callCount()).toBe(0);
    expect(f.openSource.mock.callCount()).toBe(0);
    ready.mock.restore();
  });

  it('recovers an interrupted manifest preflight before any provider or vector mutation', async () => {
    const f = await fixture(5);
    f.scan.mock.mockImplementationOnce(async function* () {
      throw new Error('preflight stopped');
    });
    await expect(f.run()).rejects.toThrow('preflight stopped');
    expect(f.provider.mock.callCount()).toBe(0);
    expect((await f.run()).phase).toBe('ready');
    expect(f.provider.mock.calls.flatMap(({ arguments: [texts] }) => texts)).toHaveLength(5);
  });

  it('publishes empty coverage without a model request', async () => {
    const f = await fixture(0);
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.metadata.vectorGeneration?.chunks).toBe(0);
    expect(result.metadata.capabilities?.vectorSearch.status).toBe('unavailable');
    expect(f.provider.mock.callCount()).toBe(0);
  });

  it(
    'admits a 10 MiB fallback file and embeds its final marker without truncation',
    { timeout: 60_000 },
    async () => {
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
    },
  );

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
    f.provider.mock.resetCalls();
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.state?.reusedNodes).toBe(64);
    expect(f.provider.mock.calls.flatMap(({ arguments: [texts] }) => texts)).toHaveLength(66);
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
    f.provider.mock.resetCalls();
    await expect(f.run()).rejects.toThrow('vectors are missing');
    expect(f.provider.mock.callCount()).toBe(0);
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
    expect(f.openSource.mock.calls.map((call) => call.arguments)).toContainEqual([
      path.join(await fs.realpath(f.root), graphFile),
      f.options().resources.graphPoolBytes,
      f.options().resources.nativeThreads,
    ]);
  });

  it('refuses a symlink job root before writing metadata or requesting vectors', async () => {
    const f = await fixture(5);
    await fs.mkdir(path.join(f.root, 'other'));
    await fs.symlink(path.join(f.root, 'other'), path.join(f.root, 'embeddings'), 'dir');
    await expect(f.run()).rejects.toThrow('owned directory');
    expect((await loadMeta(f.root))?.embeddingJob).toBeUndefined();
    expect(f.provider.mock.callCount()).toBe(0);
  });
});
