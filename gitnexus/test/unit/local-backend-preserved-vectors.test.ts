import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoMeta } from '../../src/storage/repo-meta.js';

const mocks = vi.hoisted(() => ({ metadata: vi.fn(), search: vi.fn(), hydrate: vi.fn() }));
vi.mock('../../src/storage/repo-manager.js', async (original) => ({
  ...(await original<typeof import('../../src/storage/repo-manager.js')>()),
  loadMeta: mocks.metadata,
}));
vi.mock('../../src/core/lbug/pool-adapter.js', async (original) => ({
  ...(await original<typeof import('../../src/core/lbug/pool-adapter.js')>()),
  executeParameterized: mocks.hydrate,
}));
vi.mock('../../src/core/embeddings/vector-generation-search.js', () => ({
  searchVectorGeneration: mocks.search,
}));
import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const current = 'a'.repeat(32);
const source = 'b'.repeat(32);
const graph = path.join('/repo/.gitnexus', `lbug.generation.${current}`);
const metadata: RepoMeta = {
  repoPath: '/repo',
  lastCommit: 'new',
  indexedAt: '',
  graphPath: path.basename(graph),
  graphGeneration: { version: 1, id: current, coveredContent: 'c'.repeat(64) },
  vectorGeneration: {
    version: 1,
    identity: 'd'.repeat(64),
    artifactIdentity: 'e'.repeat(64),
    graphGeneration: source,
    preservedForGraph: current,
    vectorIdentity: 'f'.repeat(64),
    inputIdentity: '0'.repeat(64),
    dimensions: 4,
    nodes: 3,
    chunks: 3,
    indexKind: 'exact',
  },
};
interface Reader {
  semanticSearch(repo: { lbugPath: string }, query: string, limit: number): Promise<unknown[]>;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.metadata.mockResolvedValue(metadata);
  mocks.search.mockResolvedValue(
    ['deleted', 'kept', 'second'].map((name, i) => ({
      nodeId: `Function:a.ts:${name}`,
      chunkIndex: 0,
      startLine: 1,
      endLine: 2,
      distance: i / 10,
    })),
  );
  mocks.hydrate.mockImplementation(async (file, _query, { nodeId }) => {
    expect(file).toBe(graph);
    return nodeId.endsWith(':deleted')
      ? []
      : [{ name: nodeId.split(':').at(-1), filePath: 'current/a.ts' }];
  });
});

describe('preserved semantic hits', () => {
  it('hydrates only the current graph, drops deleted IDs and keeps surviving rank order', async () => {
    const backend = new LocalBackend() as unknown as Reader;
    const hits = await backend.semanticSearch({ lbugPath: graph }, 'example', 3);
    expect(hits).toEqual([
      {
        nodeId: 'Function:a.ts:kept',
        name: 'kept',
        type: 'Function',
        filePath: 'current/a.ts',
        distance: 0.1,
        startLine: 1,
        endLine: 2,
      },
      {
        nodeId: 'Function:a.ts:second',
        name: 'second',
        type: 'Function',
        filePath: 'current/a.ts',
        distance: 0.2,
        startLine: 1,
        endLine: 2,
      },
    ]);
    expect(mocks.search.mock.calls[0][0]).toEqual({
      metadataDirectory: path.dirname(graph),
      metadata,
      graphPath: graph,
    });
    expect(mocks.hydrate).toHaveBeenCalledTimes(3);
  });
  it('does not open the old vector artifact when a new job is pending', async () => {
    mocks.metadata.mockResolvedValue({
      ...metadata,
      embeddingJob: { version: 1, identity: '1'.repeat(64), graphGeneration: current },
    });
    const backend = new LocalBackend() as unknown as Reader;
    expect(await backend.semanticSearch({ lbugPath: graph }, 'example', 3)).toEqual([]);
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.hydrate).not.toHaveBeenCalled();
  });
});
