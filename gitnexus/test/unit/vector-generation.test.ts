import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertOwnedVectorGeneration,
  embeddingGenerationDirectory,
  selectVectorGeneration,
} from '../../src/storage/vector-generation.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';
import { readIndexCapabilities } from '../../src/storage/index-capabilities.js';

const generation = 'a'.repeat(32);
const identity = 'b'.repeat(64);
const meta = {
  repoPath: '/repo',
  lastCommit: 'abc',
  indexedAt: 'now',
  graphPath: `lbug.generation.${generation}`,
  graphGeneration: { version: 1, id: generation, coveredContent: 'c'.repeat(64) },
  vectorGeneration: {
    version: 1,
    identity,
    graphGeneration: generation,
    vectorIdentity: 'd'.repeat(64),
    inputIdentity: 'e'.repeat(64),
    dimensions: 4,
    nodes: 1,
    chunks: 2,
    indexKind: 'exact',
  },
} satisfies RepoMeta;
const select = (metadata: RepoMeta = meta, graphPath = path.join('/slot', meta.graphPath)) =>
  selectVectorGeneration('/slot', metadata, graphPath, 10000);
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

describe('artifact identity and pending-job routing', () => {
  it('routes a rebased artifact by its storage identity while retaining the graph-bound job identity', () => {
    const artifactIdentity = 'f'.repeat(64);
    const metadata = { ...meta, vectorGeneration: { ...meta.vectorGeneration, artifactIdentity } };
    expect(select(metadata)).toEqual({
      kind: 'ready',
      path: path.join('/slot', 'embeddings', artifactIdentity, 'vectors'),
      generation: metadata.vectorGeneration,
    });
    expect(
      select({
        ...metadata,
        vectorGeneration: { ...metadata.vectorGeneration, artifactIdentity: '../foreign' },
      }),
    ).toMatchObject({ kind: 'unavailable' });
  });
  it('gates a pending job even when its identity equals the last completed pointer', () => {
    expect(
      select({ ...meta, embeddingJob: { version: 1, identity, graphGeneration: generation } }),
    ).toEqual({
      kind: 'unavailable',
      reason: 'embedding-pending',
    });
  });
});

describe('vector generation routing', () => {
  it.each([undefined, 'interrupted', 'partial', 'unverified-count'] as const)(
    'gates legacy checkpoint %s reads and capability receipts independently',
    async (kind) => {
      const legacy: RepoMeta = {
        repoPath: '/repo',
        lastCommit: 'abc',
        indexedAt: 'now',
        stats: { embeddings: 2 },
        embeddingDims: 4,
        capabilities: {
          graph: { provider: 'ladybugdb', status: 'available' },
          fts: { provider: 'ladybugdb-fts', status: 'available' },
          vectorSearch: {
            provider: 'ladybugdb-vector',
            status: 'vector-index',
            exactScanLimit: 10000,
          },
        },
        embeddingCheckpoint: {
          at: 'now',
          nodesProcessed: 1,
          totalNodes: 2,
          chunksProcessed: 2,
          model: 'model',
          provider: 'local',
          dimensions: 4,
          kind,
        },
      };
      for (const base of [
        legacy,
        {
          ...legacy,
          graphPath: meta.graphPath,
          graphGeneration: meta.graphGeneration,
          legacyVectorSource: 'f'.repeat(64),
        },
      ]) {
        const graphPath = path.join('/slot', base.graphPath ?? 'lbug');
        const reason =
          kind === 'unverified-count' ? 'embedding-count-unverified' : 'embedding-pending';
        expect(select(base, graphPath)).toEqual(
          kind === 'unverified-count' ? { kind: 'legacy' } : { kind: 'unavailable', reason },
        );
        expect((await readIndexCapabilities('/slot', base))?.vectorSearch).toMatchObject({
          status: 'unavailable',
          reason,
        });
        expect(select({ ...base, embeddingCheckpoint: undefined }, graphPath)).toEqual({
          kind: 'legacy',
        });
        if (kind === 'unverified-count' && base.graphGeneration) {
          expect(select({ ...base, stats: { embeddings: 0 } }, graphPath)).toMatchObject({
            kind: 'unavailable',
            reason: 'embeddings-unavailable',
          });
        }
        expect(
          select({ ...base, graphWriteCollapsed: { expected: 100, persisted: 1 } }, graphPath),
        ).toEqual({ kind: 'unavailable', reason: 'graph-generation-unverified' });
      }
    },
  );
  it('still validates a sealed generation when only its count checkpoint remains', async () => {
    const metadata: RepoMeta = {
      ...meta,
      embeddingCheckpoint: {
        at: 'now',
        nodesProcessed: 1,
        totalNodes: 1,
        chunksProcessed: 2,
        model: 'model',
        provider: 'local',
        dimensions: 4,
        kind: 'unverified-count',
        pendingNodeIds: [],
      },
    };
    expect(select(metadata)).toMatchObject({ kind: 'ready' });
    expect((await readIndexCapabilities('/slot', metadata))?.vectorSearch).toMatchObject({
      status: 'unavailable',
      reason: 'embedding-count-unverified',
    });
    expect(
      select({
        ...metadata,
        vectorGeneration: { ...meta.vectorGeneration, graphGeneration: 'f'.repeat(32) },
      }),
    ).toEqual({ kind: 'unavailable', reason: 'vector-generation-mismatch' });
    expect(
      (
        await readIndexCapabilities('/slot', {
          ...metadata,
          incrementalInProgress: { startedAt: 1, toWriteCount: 1 },
        })
      )?.vectorSearch,
    ).toMatchObject({ status: 'unavailable', reason: 'graph-generation-unverified' });
  });
  it('keeps preserved monolithic vectors readable when a generation was published but embedding was capped', () => {
    const preserved: RepoMeta = {
      ...meta,
      vectorGeneration: undefined,
      legacyVectorSource: 'f'.repeat(64),
      embeddingDims: 4,
      stats: { embeddings: 2 },
    };
    expect(select(preserved)).toEqual({ kind: 'legacy' });
    for (const changed of [
      { legacyVectorSource: '../foreign' },
      { stats: { embeddings: 0 } },
      { embeddingDims: 0 },
      { embeddingJob: { version: 1 as const, identity, graphGeneration: generation } },
    ])
      expect(select({ ...preserved, ...changed })).toMatchObject({ kind: 'unavailable' });
    expect(select(preserved, '/slot/foreign')).toMatchObject({ kind: 'unavailable' });
  });
  it.each([
    { incrementalInProgress: { startedAt: 1, toWriteCount: 1 } },
    { graphWriteCollapsed: { expected: 100, persisted: 1 } },
  ])('gates incomplete legacy and generation graphs before vector access: %o', (incomplete) => {
    for (const base of [meta, { repoPath: '/repo', lastCommit: '', indexedAt: '' }])
      expect(select({ ...base, ...incomplete })).toEqual({
        kind: 'unavailable',
        reason: 'graph-generation-unverified',
      });
  });
  it('preserves the legacy reader and routes a complete matching artifact', () => {
    expect(select({ repoPath: '/repo', lastCommit: '', indexedAt: '' })).toEqual({
      kind: 'legacy',
    });
    expect(select()).toEqual({
      kind: 'ready',
      path: path.join('/slot', 'embeddings', identity, 'vectors'),
      generation: meta.vectorGeneration,
    });
  });
  it('gates pending, foreign, missing and oversized exact artifacts', () => {
    expect(
      select({
        ...meta,
        vectorGeneration: undefined,
        embeddingJob: { version: 1, identity, graphGeneration: generation },
      }),
    ).toMatchObject({ kind: 'unavailable', reason: 'embedding-pending' });
    expect(select({ ...meta, graphGeneration: undefined })).toMatchObject({ kind: 'unavailable' });
    expect(select(meta, '/slot/lbug')).toMatchObject({ kind: 'unavailable' });
    expect(
      select({
        ...meta,
        vectorGeneration: { ...meta.vectorGeneration, graphGeneration: 'f'.repeat(32) },
      }),
    ).toMatchObject({ kind: 'unavailable' });
    expect(
      select({ ...meta, vectorGeneration: { ...meta.vectorGeneration, chunks: 10001 } }),
    ).toMatchObject({ kind: 'unavailable', reason: 'vector-index-pending' });
    expect(
      select({
        ...meta,
        embeddingJob: { version: 1, identity: 'f'.repeat(64), graphGeneration: generation },
      }),
    ).toMatchObject({ kind: 'unavailable' });
  });
  it('admits completed coverage with excluded inputs but rejects missing healthy chunks', () => {
    const vectorGeneration = {
      ...meta.vectorGeneration,
      nodes: 3,
      chunks: 2,
      excludedNodes: 1,
      exclusionReason: 'input-rejected' as const,
    };
    expect(select({ ...meta, vectorGeneration })).toMatchObject({ kind: 'ready' });
    expect(select({ ...meta, vectorGeneration: { ...vectorGeneration, chunks: 1 } })).toMatchObject(
      {
        kind: 'unavailable',
        reason: 'vector-generation-mismatch',
      },
    );
  });
  it.each([NaN, -1, 0.5, Infinity])('rejects invalid coverage %s', (chunks) => {
    expect(
      select({ ...meta, vectorGeneration: { ...meta.vectorGeneration, chunks } }),
    ).toMatchObject({ kind: 'unavailable' });
  });
  it('rejects traversal and every symlink boundary', async () => {
    expect(() => embeddingGenerationDirectory('/slot', '../foreign')).toThrow('identity');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-vector-path-'));
    directories.push(root);
    const job = embeddingGenerationDirectory(root, identity);
    await fs.mkdir(job, { recursive: true });
    const file = path.join(job, 'vectors');
    await fs.writeFile(file, 'artifact');
    expect(await assertOwnedVectorGeneration(root, identity)).toBe(file);
    await fs.rename(file, file + '.old');
    await fs.symlink(file + '.old', file);
    await expect(assertOwnedVectorGeneration(root, identity)).rejects.toThrow('regular file');
    await fs.unlink(file);
    await fs.rename(job, job + '.old');
    await fs.symlink(job + '.old', job, 'dir');
    await expect(assertOwnedVectorGeneration(root, identity)).rejects.toThrow('directory');
  });
});
