import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoMeta } from '../../src/storage/repo-meta.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), embed: vi.fn(), metadata: vi.fn() }));
vi.mock('../../src/core/lbug/pool-adapter.js', async (original) => ({
  ...(await original<typeof import('../../src/core/lbug/pool-adapter.js')>()),
  executeQuery: mocks.query,
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
  ): Promise<unknown[]>;
  lastObservedPoolState: Map<string, { metadata: RepoMeta }>;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([]);
  mocks.metadata.mockResolvedValue(metadata);
});

describe('MCP generation gate', () => {
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
