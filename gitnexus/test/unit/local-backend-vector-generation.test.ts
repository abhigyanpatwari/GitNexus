import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoMeta } from '../../src/storage/repo-meta.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  parameterized: vi.fn(),
  embed: vi.fn(),
  metadata: vi.fn(),
}));
vi.mock('../../src/core/lbug/pool-adapter.js', async (original) => ({
  ...(await original<typeof import('../../src/core/lbug/pool-adapter.js')>()),
  executeQuery: mocks.query,
  executeParameterized: mocks.parameterized,
  ensureVectorExtension: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/storage/repo-manager.js', async (original) => ({
  ...(await original<typeof import('../../src/storage/repo-manager.js')>()),
  loadMeta: mocks.metadata,
}));
vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: mocks.embed,
  getEmbeddingDims: () => 4,
}));
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const generation = 'a'.repeat(32);
const graphPath = path.join('/repo/.gitnexus', `lbug.generation.${generation}`);
const metadata: RepoMeta = {
  repoPath: '/repo',
  lastCommit: 'abc',
  indexedAt: 'now',
  graphPath: path.basename(graphPath),
  graphGeneration: { version: 1, id: generation, coveredContent: 'b'.repeat(64) },
  embeddingJob: { version: 1, identity: 'c'.repeat(64), graphGeneration: generation },
};
interface Reader {
  semanticSearch(
    repo: { lbugPath: string; generationUnknown?: boolean },
    query: string,
    limit: number,
    degraded?: { reason?: string; embeddingDims?: number },
  ): Promise<unknown[]>;
  lastObservedPoolState: Map<string, { metadata: RepoMeta }>;
  readToolMetadata(repo: { generationUnknown?: boolean }): Promise<RepoMeta>;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReset().mockResolvedValue([]);
  mocks.parameterized.mockResolvedValue([]);
  mocks.metadata.mockResolvedValue(metadata);
});

describe('MCP generation gate', () => {
  it.each([undefined, 'interrupted', 'partial'] as const)(
    'retains bounded legacy checkpoint %s metadata and skips query embedding',
    async (kind) => {
      const backend = new LocalBackend() as unknown as Reader;
      const checkpoint: NonNullable<RepoMeta['embeddingCheckpoint']> = {
        at: 'now',
        nodesProcessed: 1,
        totalNodes: 2,
        chunksProcessed: 1,
        model: 'model',
        provider: 'local',
        dimensions: 4,
        kind,
        pendingNodeIds: ['pending'],
        recovery: {} as NonNullable<NonNullable<RepoMeta['embeddingCheckpoint']>['recovery']>,
      };
      mocks.metadata.mockResolvedValue({
        repoPath: '/repo',
        lastCommit: 'abc',
        indexedAt: 'now',
        stats: { embeddings: 1 },
        embeddingDims: 4,
        embeddingCheckpoint: checkpoint,
      });
      const repo = { lbugPath: path.join('/repo/.gitnexus', 'lbug'), generationUnknown: false };
      const snapshot = await backend.readToolMetadata(repo);
      expect(snapshot.embeddingCheckpoint).toMatchObject({ model: 'model', dimensions: 4, kind });
      expect(snapshot.embeddingCheckpoint?.pendingNodeIds).toBeUndefined();
      expect(snapshot.embeddingCheckpoint?.recovery).toBeUndefined();
      const degraded: { reason?: string; embeddingDims?: number } = {};
      expect(await backend.semanticSearch(repo, 'hello', 5, degraded)).toEqual([]);
      expect(degraded.reason).toContain('embeddings are pending');
      expect(mocks.embed).not.toHaveBeenCalled();
      expect(mocks.query).not.toHaveBeenCalled();
    },
  );
  it.each(['present', 'empty', 'failed'] as const)(
    'checks live vectors before embedding with an unverified count: %s',
    async (count) => {
      const backend = new LocalBackend() as unknown as Reader;
      mocks.metadata.mockResolvedValue({
        repoPath: '/repo',
        lastCommit: 'abc',
        indexedAt: 'now',
        stats: { embeddings: 0 },
        embeddingDims: 4,
        embeddingCheckpoint: {
          at: 'now',
          nodesProcessed: 1,
          totalNodes: 1,
          chunksProcessed: 1,
          model: 'model',
          provider: 'local',
          dimensions: 4,
          kind: 'unverified-count',
          pendingNodeIds: [],
        },
      });
      if (count === 'failed') mocks.query.mockRejectedValueOnce(new Error('Count failed'));
      else mocks.query.mockResolvedValueOnce([{ cnt: count === 'present' ? 1 : 0 }]);
      const nodeId = 'Function:src/example.ts:hello';
      mocks.query.mockResolvedValueOnce([
        { nodeId, chunkIndex: 0, startLine: 1, endLine: 2, embedding: [1, 0, 0, 0] },
      ]);
      mocks.embed.mockResolvedValue([1, 0, 0, 0]);
      mocks.parameterized.mockResolvedValue([{ name: 'hello', filePath: 'src/example.ts' }]);
      const repo = { lbugPath: path.join('/repo/.gitnexus', 'lbug'), generationUnknown: false };
      const snapshot = await backend.readToolMetadata(repo);
      expect(snapshot.embeddingCheckpoint?.kind).toBe('unverified-count');
      expect(snapshot.embeddingCheckpoint?.pendingNodeIds).toBeUndefined();
      const results = await backend.semanticSearch(repo, 'hello', 5);
      expect(mocks.query.mock.calls[0][1]).toContain('COUNT(*)');
      if (count === 'present') {
        expect(results).toMatchObject([{ nodeId, name: 'hello', filePath: 'src/example.ts' }]);
        expect(mocks.embed).toHaveBeenCalledOnce();
      } else {
        expect(results).toEqual([]);
        expect(mocks.embed).not.toHaveBeenCalled();
        expect(mocks.query).toHaveBeenCalledOnce();
      }
    },
  );
  it.each([
    'graph-generation-unverified',
    'vector-generation-mismatch',
    'vector-index-pending',
    'embeddings-empty',
    'embeddings-unavailable',
  ])('reports semantic unavailability for %s except a never-embedded index', async (reason) => {
    const backend = new LocalBackend() as unknown as Reader;
    const meta: RepoMeta = {
      ...metadata,
      embeddingJob: undefined,
      vectorGeneration: {
        version: 1,
        identity: 'a'.repeat(64),
        graphGeneration: generation,
        vectorIdentity: 'b'.repeat(64),
        inputIdentity: 'c'.repeat(64),
        dimensions: 4,
        nodes: 1,
        chunks: 1,
        indexKind: 'exact',
      },
    };
    if (reason === 'graph-generation-unverified') meta.graphGeneration = undefined;
    if (reason === 'vector-generation-mismatch')
      meta.vectorGeneration!.graphGeneration = 'd'.repeat(32);
    if (reason === 'vector-index-pending') meta.vectorGeneration!.chunks = 1_000_000_000;
    if (reason === 'embeddings-empty')
      Object.assign(meta.vectorGeneration!, { nodes: 0, chunks: 0 });
    if (reason === 'embeddings-unavailable') meta.vectorGeneration = undefined;
    vi.spyOn(backend, 'readToolMetadata').mockResolvedValue(meta);
    const degraded: { reason?: string; embeddingDims?: number } = {};
    expect(await backend.semanticSearch({ lbugPath: graphPath }, 'hello', 5, degraded)).toEqual([]);
    if (reason === 'embeddings-unavailable') expect(degraded.reason).toBeUndefined();
    else {
      expect(degraded.reason).toContain(reason);
      expect(degraded.reason).toContain('gitnexus analyze');
    }
    expect(mocks.embed).not.toHaveBeenCalled();
  });
  it('explains the temporary keyword-only lane while vectors are pending', async () => {
    const backend = new LocalBackend() as unknown as Reader;
    const degraded: { reason?: string; embeddingDims?: number } = {};
    expect(await backend.semanticSearch({ lbugPath: graphPath }, 'hello', 5, degraded)).toEqual([]);
    expect(degraded.reason).toContain('embeddings are pending');
    expect(mocks.embed).not.toHaveBeenCalled();
  });
  it.each(['before-read', 'during-read'])(
    'records no query width when ownership is lost %s',
    async (when) => {
      const backend = new LocalBackend() as unknown as Reader;
      const repo = { lbugPath: graphPath, generationUnknown: when === 'before-read' };
      if (when === 'during-read') {
        vi.spyOn(backend, 'readToolMetadata').mockImplementation(async (handle) => {
          handle.generationUnknown = true;
          return metadata;
        });
      }
      const degraded: { reason?: string; embeddingDims?: number } = {};
      expect(await backend.semanticSearch(repo, 'hello', 5, degraded)).toEqual([]);
      expect(degraded.reason).toContain('graph generation is unverified');
      expect(degraded.reason).toContain('gitnexus analyze');
      expect(degraded.embeddingDims).toBeUndefined();
      expect(mocks.embed).not.toHaveBeenCalled();
      expect(mocks.query).not.toHaveBeenCalled();
    },
  );

  it.each(['pending', 'foreign-metadata', 'unknown-handle'])(
    'skips model and table access for %s',
    async (state) => {
      const backend = new LocalBackend() as unknown as Reader;
      if (state === 'foreign-metadata')
        mocks.metadata.mockResolvedValue({
          ...metadata,
          graphPath: `lbug.generation.${'d'.repeat(32)}`,
        });
      expect(
        await backend.semanticSearch(
          { lbugPath: graphPath, generationUnknown: state === 'unknown-handle' },
          'hello',
          5,
        ),
      ).toEqual([]);
      expect(mocks.query).not.toHaveBeenCalled();
      expect(mocks.embed).not.toHaveBeenCalled();
    },
  );
  it('keeps a warm reader on its own metadata when publication advances', async () => {
    const backend = new LocalBackend() as unknown as Reader;
    backend.lastObservedPoolState.set(graphPath, { metadata });
    mocks.metadata.mockResolvedValue({
      ...metadata,
      graphPath: `lbug.generation.${'d'.repeat(32)}`,
      graphGeneration: { ...metadata.graphGeneration, id: 'd'.repeat(32) },
    });
    const repo = { lbugPath: graphPath, generationUnknown: false };
    expect(await backend.semanticSearch(repo, 'hello', 5)).toEqual([]);
    expect(repo.generationUnknown).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
  });
});
