import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runPublishedEmbeddingJob,
  type PublishedEmbeddingJobOptions,
} from '../../src/core/embeddings/embedding-job.js';
import { VectorStore } from '../../src/core/lbug/vector-store.js';
import { LegacyVectorSource } from '../../src/core/lbug/legacy-vector-source.js';
import { contentHashForNode } from '../../src/core/embeddings/embedding-pipeline.js';
import { resolveEmbeddingConfig } from '../../src/core/embeddings/config.js';
import { openLbugConnection, closeLbugConnection } from '../../src/core/lbug/lbug-config.js';
import { recordLegacyEmbeddingSource } from '../../src/storage/legacy-embedding-source.js';
import { loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';
import type { EmbeddableNode } from '../../src/core/embeddings/types.js';
import { readEmbeddingJobRecord } from '../../src/storage/embedding-job.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(count = 130, unsafe: string[] = [], knownProvider = true) {
  vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'never');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-legacy-controller-'));
  roots.push(root);
  const identity = { provider: 'local', model: 'test', dimensions: 4 };
  const config = resolveEmbeddingConfig({ threads: 1, subBatchSize: 8 });
  const sourceFile = 'lbug.generation.' + 'a'.repeat(32);
  const sourcePath = path.join(root, sourceFile);
  const id = (i: number) => `Const:a.ts:n${String(i).padStart(5, '0')}`;
  const node = (key: string): EmbeddableNode => ({
    id: key,
    name: key.split(':').at(-1) ?? key,
    label: 'Const',
    filePath: 'a.ts',
    content: 'const value = 1;',
    startLine: 1,
    endLine: 1,
  });
  const handle = await openLbugConnection(lbug, sourcePath, {
    bufferPoolBytes: 16 * 1024 * 1024,
    threads: 1,
  });
  const close = (result: lbug.QueryResult | lbug.QueryResult[]) => {
    for (const r of Array.isArray(result) ? result : [result]) r.close();
  };
  try {
    close(
      await handle.conn.query(
        'CREATE NODE TABLE CodeEmbedding (id STRING, nodeId STRING, chunkIndex INT32, startLine INT64, endLine INT64, embedding FLOAT[4], contentHash STRING, PRIMARY KEY(id))',
      ),
    );
    const insert = await handle.conn.prepare(
      'CREATE (:CodeEmbedding {id:$id,nodeId:$nodeId,chunkIndex:0,startLine:1,endLine:1,embedding:$embedding,contentHash:$hash})',
    );
    for (let i = 0; i < count; i++)
      close(
        await handle.conn.execute(insert, {
          id: id(i) + ':0',
          nodeId: id(i),
          embedding: [1, 0, 0, 0],
          hash: contentHashForNode(node(id(i)), config),
        }),
      );
    close(await handle.conn.query('CHECKPOINT'));
  } finally {
    await closeLbugConnection(handle, { strict: true, databasePath: sourcePath });
  }
  const legacyIdentity = await recordLegacyEmbeddingSource(
    root,
    {
      sourceFile,
      schemaFingerprint: 'schema',
      recordedIdentity: knownProvider ? identity : { dimensions: 4 },
    },
    unsafe,
  );
  let generation = 1;
  const graphFile = () => 'lbug.generation.' + String(generation).padStart(32, '0');
  const graphGeneration = () => ({
    version: 1 as const,
    id: String(generation).padStart(32, '0'),
    coveredContent: 'b'.repeat(64),
  });
  const meta: RepoMeta = {
    repoPath: root,
    lastCommit: 'commit',
    indexedAt: '2026-11-04T00:00:00Z',
    graphPath: graphFile(),
    graphGeneration: graphGeneration(),
    legacyVectorSource: legacyIdentity,
    schemaFingerprint: 'schema',
    parseCacheIdentity: { base: 'parser' },
    scopeExtractionReceipt: 1,
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
      invokedArtifact: { path: 'test', digest: 'test' },
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
  };
  await fs.writeFile(path.join(root, graphFile()), 'graph opened by the deterministic test source');
  await saveMeta(root, meta);
  const changed = new Map<string, string>();
  const events: string[] = [];
  const provider = vi.fn(async (texts: string[]) => {
    events.push('provider');
    return texts.map(() => new Float32Array([1, 0, 0, 0]));
  });
  const initializeProvider = vi.fn(async () => {});
  const source = {
    scan: async function* (label: string) {
      if (label === 'Const')
        for (let i = 0; i < count; i++)
          yield {
            id: id(i),
            contentBytes: Buffer.byteLength(changed.get(id(i)) ?? node(id(i)).content),
            metadataBytes: 1024,
          };
    },
    fetch: async (_label: string, ids: readonly string[]) =>
      ids.map((key) => ({ ...node(key), content: changed.get(key) ?? node(key).content })),
    close: async () => {},
  };
  const options = (): PublishedEmbeddingJobOptions => ({
    metadataDirectory: root,
    graphPath: path.join(root, graphFile()),
    config,
    resources: {
      graphPoolBytes: 16 * 1024 * 1024,
      vectorPoolBytes: 64 * 1024 * 1024,
      queueBytes: 16 * 1024 * 1024,
      nativeThreads: 1,
      modelBytes: 0,
      modelHeapMb: 0,
      reservedBytes: 96 * 1024 * 1024,
    },
    metadata: {
      loadMetadata: () => loadMeta(root),
      saveMetadata: (value) => saveMeta(root, value),
    },
    log: (message) => events.push(message),
  });
  const run = (extra: Partial<PublishedEmbeddingJobOptions> = {}) =>
    runPublishedEmbeddingJob(
      { ...options(), ...extra },
      { identity: () => identity, openSource: async () => source, provider, initializeProvider },
    );
  const nextGraph = async () => {
    const previous = await loadMeta(root);
    if (!previous) throw new Error('missing metadata');
    generation++;
    await fs.writeFile(path.join(root, graphFile()), 'new graph');
    await saveMeta(root, {
      ...previous,
      graphPath: graphFile(),
      graphGeneration: graphGeneration(),
      legacyVectorSource: undefined,
    });
  };
  return {
    root,
    run,
    options,
    nextGraph,
    provider,
    initializeProvider,
    changed,
    events,
    id,
    sourcePath,
    legacyIdentity,
  };
}

describe('legacy migration through the published job controller', () => {
  it('keeps provider batches full when legacy groups are ineligible for reuse', async () => {
    const f = await fixture(
      16,
      Array.from({ length: 16 }, (_, i) => `Const:a.ts:n${String(i).padStart(5, '0')}`),
    );
    expect((await f.run()).phase).toBe('ready');
    expect(f.provider.mock.calls.map(([texts]) => texts.length)).toEqual([8, 8]);
  });
  it('retains one legacy source and pending store across two crashes and graph changes with zero paid replay', async () => {
    const f = await fixture();
    const before = await fs.stat(f.sourcePath);
    let scans = 0;
    const prepare = VectorStore.prototype.prepareLegacyReuseIndex;
    vi.spyOn(VectorStore.prototype, 'prepareLegacyReuseIndex').mockImplementation(function (
      this: VectorStore,
      source,
      groups,
      excluded,
      signal,
    ) {
      return prepare.call(
        this,
        source,
        async function* () {
          scans++;
          yield* groups();
        },
        excluded,
        signal,
      );
    });
    await expect(
      f.run({
        onProgress: (state) => {
          if (state.reusedNodes === 64) throw new Error('first stop');
        },
      }),
    ).rejects.toThrow('first stop');
    const first = (await loadMeta(f.root))?.embeddingJob;
    expect(first?.artifactIdentity).toBeDefined();
    expect((await fs.stat(f.sourcePath)).ino).toBe(before.ino);
    expect((await fs.stat(f.sourcePath)).mtimeMs).toBe(before.mtimeMs);
    await f.nextGraph();
    await expect(
      f.run({
        onProgress: (state) => {
          if (state.reusedNodes === 128) throw new Error('second stop');
        },
      }),
    ).rejects.toThrow('second stop');
    expect((await loadMeta(f.root))?.embeddingJob?.artifactIdentity).toBe(first?.artifactIdentity);
    expect((await fs.stat(f.sourcePath)).ino).toBe(before.ino);
    expect((await fs.stat(f.sourcePath)).mtimeMs).toBe(before.mtimeMs);
    await f.nextGraph();
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.state?.reusedNodes).toBe(130);
    expect(result.metadata.vectorGeneration?.artifactIdentity).toBe(first?.artifactIdentity);
    expect(scans).toBe(1);
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.initializeProvider).not.toHaveBeenCalled();
    await expect(fs.stat(f.sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const owner = (await readEmbeddingJobRecord(
      path.join(f.root, 'embeddings', 'spaces', first?.spaceKey ?? ''),
      'space.json',
    )) as { owner: { fallbackLegacy?: string } };
    expect(owner.owner.fallbackLegacy).toBeUndefined();
  });
  it('regenerates only changed inputs and groups in the unsafe checkpoint window', async () => {
    const f = await fixture(5, ['Const:a.ts:n00002']);
    f.changed.set(f.id(1), 'const changed = 2;');
    const result = await f.run();
    expect(result.metadata.legacyVectorSource).toBeUndefined();
    expect((await loadMeta(f.root))?.legacyVectorSource).toBeUndefined();
    await expect(fs.stat(f.sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.state?.reusedNodes).toBe(3);
    expect(f.provider.mock.calls.flatMap(([texts]) => texts)).toHaveLength(2);
    expect(f.events[0]).toContain('chunk size/overlap');
    expect(f.events.indexOf('provider')).toBeGreaterThan(0);
  });
  it('retires the migrated legacy source after publication is interrupted with a sealed owner', async () => {
    const f = await fixture(3);
    await expect(
      f.run({
        metadata: {
          loadMetadata: () => loadMeta(f.root),
          saveMetadata: async (metadata) => {
            if (metadata.vectorGeneration && !metadata.embeddingJob)
              throw new Error('interrupted metadata publication');
            await saveMeta(f.root, metadata);
          },
        },
      }),
    ).rejects.toThrow('interrupted metadata publication');
    const pending = await loadMeta(f.root);
    expect(pending?.legacyVectorSource).toBe(f.legacyIdentity);
    const owner = (await readEmbeddingJobRecord(
      path.join(f.root, 'embeddings', 'spaces', pending?.embeddingJob?.spaceKey ?? ''),
      'space.json',
    )) as { owner: { phase: string; fallbackLegacy?: string } };
    expect(owner.owner).toMatchObject({ phase: 'sealed' });
    expect(owner.owner.fallbackLegacy).toBeUndefined();
    const result = await f.run();
    expect(result.phase).toBe('ready');
    expect(result.metadata.legacyVectorSource).toBeUndefined();
    await expect(fs.stat(f.sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.provider).not.toHaveBeenCalled();
  });
  it('reports unknown provider provenance before requests and retains its source without opening it', async () => {
    const f = await fixture(3, [], false);
    const open = vi.spyOn(LegacyVectorSource, 'open');
    expect((await f.run()).phase).toBe('ready');
    expect(open).not.toHaveBeenCalled();
    expect(f.events[0]).toContain('provider/model/dimensions provenance is unknown');
    expect(f.events.indexOf('provider')).toBeGreaterThan(0);
    expect((await fs.stat(f.sourcePath)).isFile()).toBe(true);
    expect(f.provider.mock.calls.flatMap(([texts]) => texts)).toHaveLength(3);
  });
  it('rejects changed receipts before model initialization or requests', async () => {
    const f = await fixture(3);
    await fs.writeFile(
      path.join(f.root, 'embeddings', 'legacy', f.legacyIdentity, 'legacy.json'),
      '{}',
    );
    await expect(f.run()).rejects.toThrow('Malformed');
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.initializeProvider).not.toHaveBeenCalled();
  });
  it('rejects a hard-linked live graph as a legacy source before paid work', async () => {
    const f = await fixture(3);
    const graph = f.options().graphPath;
    await fs.unlink(graph);
    await fs.link(f.sourcePath, graph);
    // Refresh the fixture receipt after link creation changes ctime, so this
    // still exercises the separate live-graph alias guard.
    const legacyVectorSource = await recordLegacyEmbeddingSource(
      f.root,
      {
        sourceFile: path.basename(f.sourcePath),
        schemaFingerprint: 'schema',
        recordedIdentity: { provider: 'local', model: 'test', dimensions: 4 },
      },
      [],
    );
    const metadata = await loadMeta(f.root);
    if (!metadata) throw new Error('Missing fixture metadata');
    await saveMeta(f.root, { ...metadata, legacyVectorSource });
    await expect(f.run()).rejects.toThrow('distinct from the mutable graph');
    expect(f.provider).not.toHaveBeenCalled();
  });
});
