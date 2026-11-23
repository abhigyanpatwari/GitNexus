import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingJobJournal } from '../../src/storage/embedding-job-journal.js';
import { readEmbeddingJobProgress } from '../../src/storage/embedding-job-progress.js';
import { writeEmbeddingJobRecord } from '../../src/storage/embedding-job.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';
import { embeddingProgressFromState } from '../../src/core/analysis-progress.js';
import { readIndexCapabilities } from '../../src/storage/index-capabilities.js';

const identity = 'a'.repeat(64);
const generation = 'b'.repeat(32);
const manifest = {
  version: 1 as const,
  sourceIdentity: 'c'.repeat(64),
  digest: 'd'.repeat(64),
  bytes: 30,
  totalNodes: 6,
  totalUnits: 3,
  maximumUnitBytes: 100,
};
const meta: RepoMeta = {
  repoPath: '/repo',
  lastCommit: 'head',
  indexedAt: '',
  graphGeneration: { version: 1, id: generation, coveredContent: 'e'.repeat(64) },
  embeddingJob: { version: 1, identity, graphGeneration: generation },
};
const unit = (n: number, origin: 'manifest' | 'failed' = 'manifest') => ({
  start: { unit: n, offset: n * 10 },
  next: { unit: n + 1, offset: (n + 1) * 10 },
  nodes: 2,
  origin,
});
const directories: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-job-progress-'));
  directories.push(root);
  const directory = path.join(root, 'embeddings', identity);
  await fs.mkdir(directory, { recursive: true });
  return {
    root,
    directory,
    journal: await EmbeddingJobJournal.create(directory, identity, manifest),
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

describe('bounded durable embedding progress', () => {
  it.each([42, {}, null])('reports malformed graph paths as unverified (%j)', async (graphPath) => {
    const metadata = {
      ...meta,
      embeddingJob: undefined,
      graphPath,
      vectorGeneration: { preservedForGraph: generation },
    } as unknown as RepoMeta;
    expect(await readEmbeddingJobProgress('/missing', metadata)).toEqual({ phase: 'unverified' });
  });

  it.each(['interrupted', 'collapsed'] as const)(
    'rejects a legacy vector capability after an %s graph write',
    async (state) => {
      const legacy: RepoMeta = {
        repoPath: '/repo',
        indexedAt: '',
        lastCommit: '',
        incrementalInProgress:
          state === 'interrupted' ? { startedAt: 1, toWriteCount: 1 } : undefined,
        graphWriteCollapsed: state === 'collapsed' ? { expected: 100, persisted: 1 } : undefined,
        capabilities: {
          graph: { provider: 'ladybugdb', status: 'available' },
          fts: { provider: 'ladybugdb-fts', status: 'available' },
          vectorSearch: {
            provider: 'ladybugdb-vector',
            status: 'vector-index',
            exactScanLimit: 10000,
          },
        },
      };
      expect(await readIndexCapabilities('/missing', legacy)).toMatchObject({
        vectorSearch: { status: 'unavailable' },
      });
    },
  );

  it('gates a persisted vector-index stamp before filesystem work when the new job is pending', async () => {
    const f = await fixture();
    const previous: NonNullable<RepoMeta['capabilities']> = {
      graph: { provider: 'ladybugdb', status: 'available' },
      fts: { provider: 'ladybugdb-fts', status: 'available' },
      vectorSearch: { provider: 'ladybugdb-vector', status: 'vector-index', exactScanLimit: 10000 },
    };
    const stat = vi.spyOn(fs, 'lstat');
    expect(await readIndexCapabilities(f.root, { ...meta, capabilities: previous })).toMatchObject({
      graph: previous.graph,
      fts: previous.fts,
      vectorSearch: { status: 'unavailable', reason: 'embedding-pending' },
    });
    expect(stat).not.toHaveBeenCalled();
    expect(
      await readIndexCapabilities('/missing', {
        repoPath: '/repo',
        indexedAt: '',
        lastCommit: '',
        capabilities: previous,
      }),
    ).toBe(previous);
  });

  it('reports missing published vector artifacts without opening a native database', async () => {
    const f = await fixture();
    const published = {
      ...meta,
      embeddingJob: undefined,
      vectorGeneration: {
        version: 1 as const,
        identity,
        graphGeneration: generation,
        vectorIdentity: 'c'.repeat(64),
        inputIdentity: 'd'.repeat(64),
        dimensions: 3,
        nodes: 6,
        chunks: 7,
        indexKind: 'hnsw' as const,
      },
    };
    expect(await readIndexCapabilities(f.root, published)).toMatchObject({
      vectorSearch: { status: 'unavailable', reason: 'vector-artifact-unavailable' },
    });
    expect(
      await readIndexCapabilities(f.root, {
        ...published,
        vectorGeneration: { ...published.vectorGeneration, graphGeneration: 'f'.repeat(32) },
      }),
    ).toMatchObject({
      vectorSearch: { status: 'unavailable', reason: 'vector-generation-mismatch' },
    });
  });
  it('does no filesystem work for legacy or graph-only metadata', async () => {
    const stat = vi.spyOn(fs, 'lstat');
    expect(await readEmbeddingJobProgress('/missing', null)).toBeUndefined();
    expect(
      await readEmbeddingJobProgress('/missing', { ...meta, embeddingJob: undefined }),
    ).toBeUndefined();
    expect(stat).not.toHaveBeenCalled();
  });

  it('counts durable completions, reuse, failures and active retries without double counting', async () => {
    const f = await fixture();
    await f.journal.begin(unit(0));
    await f.journal.acknowledge({ reusedNodes: 1, chunks: 3 });
    await f.journal.begin(unit(1));
    await f.journal.fail('provider');
    expect(await readEmbeddingJobProgress(f.root, meta)).toEqual({
      phase: 'embedding',
      totalUnits: 3,
      completedUnits: 1,
      reusedUnits: 0,
      pendingUnits: 1,
      failedUnits: 1,
      activeUnit: null,
      totalNodes: 6,
      completedNodes: 1,
      reusedNodes: 1,
      pendingNodes: 2,
      failedNodes: 2,
      chunks: 3,
    });
    await f.journal.begin(unit(1, 'failed'));
    expect(await readEmbeddingJobProgress(f.root, meta)).toMatchObject({
      pendingUnits: 2,
      failedUnits: 0,
      activeUnit: 1,
      pendingNodes: 4,
      failedNodes: 0,
    });
    await f.journal.acknowledge({ reusedNodes: 2, chunks: 2 });
    await f.journal.begin(unit(2));
    await f.journal.acknowledge({ reusedNodes: 0, chunks: 2 });
    await f.journal.indexing();
    await f.journal.ready();
    // Progress never certifies publication merely because the journal says ready.
    expect(await readEmbeddingJobProgress(f.root, meta)).toMatchObject({
      phase: 'indexing',
      completedUnits: 2,
      reusedUnits: 1,
      pendingUnits: 0,
      failedUnits: 0,
      completedNodes: 3,
      reusedNodes: 3,
      pendingNodes: 0,
      failedNodes: 0,
    });
  });

  it('does not scan a manifest or source database to observe progress', async () => {
    const f = await fixture();
    // No manifest.jsonl or vectors file exists. Observing a journal still works.
    const open = vi.spyOn(fs, 'open');
    expect(await readEmbeddingJobProgress(f.root, meta)).toMatchObject({
      totalNodes: 6,
      pendingNodes: 6,
    });
    expect(open.mock.calls.map((call) => path.basename(String(call[0])))).toEqual(['job.json']);
  });

  it('reports missing, corrupt and oversized receipts as unverified, never zero work', async () => {
    const f = await fixture();
    const file = path.join(f.directory, 'job.json');
    await fs.unlink(file);
    expect(await readEmbeddingJobProgress(f.root, meta)).toEqual({ phase: 'unverified' });
    await fs.writeFile(file, '{broken');
    expect(await readEmbeddingJobProgress(f.root, meta)).toEqual({ phase: 'unverified' });
    await fs.writeFile(file, 'x'.repeat(33 * 1024));
    expect(await readEmbeddingJobProgress(f.root, meta)).toEqual({ phase: 'unverified' });
  });

  it('accepts an absent exclusion counter but rejects explicit null accounting', async () => {
    const f = await fixture();
    const state = f.journal.snapshot();
    delete state.excludedNodes;
    await writeEmbeddingJobRecord(f.directory, 'job.json', state);
    expect(await readEmbeddingJobProgress(f.root, meta)).toMatchObject({
      phase: 'embedding',
      pendingNodes: 6,
    });
    await writeEmbeddingJobRecord(f.directory, 'job.json', { ...state, excludedNodes: null });
    expect(await readEmbeddingJobProgress(f.root, meta)).toEqual({ phase: 'unverified' });
  });

  it('refuses foreign graph identities and symlinked job ancestors', async () => {
    const f = await fixture();
    expect(
      await readEmbeddingJobProgress(f.root, {
        ...meta,
        embeddingJob: { version: 1, identity, graphGeneration: 'f'.repeat(32) },
      }),
    ).toEqual({ phase: 'unverified' });
    const moved = path.join(f.root, 'preserved');
    await fs.rename(path.join(f.root, 'embeddings'), moved);
    await fs.symlink(
      moved,
      path.join(f.root, 'embeddings'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(await readEmbeddingJobProgress(f.root, meta)).toEqual({ phase: 'unverified' });
  });

  it('rejects impossible accounting and drops unknown journal fields', async () => {
    const f = await fixture();
    await writeEmbeddingJobRecord(f.directory, 'job.json', {
      ...f.journal.snapshot(),
      completedUnits: 4,
    });
    expect(await readEmbeddingJobProgress(f.root, meta)).toEqual({ phase: 'unverified' });
    await writeEmbeddingJobRecord(f.directory, 'job.json', {
      ...f.journal.snapshot(),
      sourcePath: '/secret',
      token: 'private',
    });
    expect(JSON.stringify(await readEmbeddingJobProgress(f.root, meta))).not.toMatch(
      /secret|private|identity|manifest/,
    );
    expect(() => embeddingProgressFromState({ ...f.journal.snapshot(), phase: 'ready' })).toThrow(
      'unverified',
    );
  });
});
