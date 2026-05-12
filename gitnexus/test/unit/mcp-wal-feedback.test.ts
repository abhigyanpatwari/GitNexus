/**
 * Tests for WAL corruption feedback in MCP error responses (#1402).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { lbugMocks, platformMocks, repoMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn(),
    executeParameterized: vi.fn(),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
    isWriteQuery: vi.fn().mockReturnValue(false),
  },
  platformMocks: {
    isVectorExtensionSupportedByPlatform: vi.fn().mockReturnValue(true),
  },
  repoMocks: {
    listRegisteredRepos: vi.fn(),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: repoMocks.listRegisteredRepos,
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/core/git-staleness.js', () => ({
  checkStaleness: vi.fn().mockReturnValue({ isStale: false, commitsBehind: 0 }),
  checkCwdMatch: vi.fn().mockResolvedValue({ match: 'none' }),
}));

vi.mock('../../src/core/platform/capabilities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/platform/capabilities.js')>();
  return {
    ...actual,
    isVectorExtensionSupportedByPlatform: platformMocks.isVectorExtensionSupportedByPlatform,
  };
});

vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const MOCK_REPO_ENTRY = {
  name: 'test-repo',
  path: '/tmp/test',
  storagePath: '/tmp/test/.gitnexus',
  indexedAt: '2026-05-01T00:00:00Z',
  lastCommit: 'abc1234',
};

async function makeBackend(): Promise<LocalBackend> {
  const backend = new LocalBackend();
  await backend.init();
  return backend;
}

describe('WAL corruption feedback in MCP responses (#1402)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lbugMocks.initLbug.mockResolvedValue(undefined);
    lbugMocks.executeQuery.mockResolvedValue([]);
    lbugMocks.executeParameterized.mockResolvedValue([]);
    lbugMocks.isLbugReady.mockReturnValue(true);
    lbugMocks.isWriteQuery.mockReturnValue(false);
    repoMocks.listRegisteredRepos.mockResolvedValue([MOCK_REPO_ENTRY]);
  });

  it('impact returns WAL suggestion on corrupted WAL error', async () => {
    const backend = await makeBackend();
    lbugMocks.executeParameterized.mockRejectedValueOnce(
      new Error('Runtime exception: Corrupted wal file. Read out invalid WAL record type.'),
    );

    const result = await backend.callTool('impact', {
      repo: 'test-repo',
      target: 'MyClass',
      direction: 'upstream',
    });

    expect(result.error).toBeDefined();
    expect(result.suggestion).toBe(
      'The graph query failed — try gitnexus context <symbol> as a fallback',
    );
    expect(result.recoverySuggestion).toBeDefined();
  });

  it('cypher returns WAL recoverySuggestion on corrupted WAL error', async () => {
    const backend = await makeBackend();
    lbugMocks.executeQuery.mockRejectedValueOnce(new Error('Corrupted wal file'));

    const result = await backend.callTool('cypher', {
      repo: 'test-repo',
      query: 'MATCH (n) RETURN n LIMIT 1',
    });

    expect(result.error).toBe('Corrupted wal file');
    expect(result.recoverySuggestion).toBeDefined();
  });

  it('context returns WAL recoverySuggestion on corrupted WAL error', async () => {
    const backend = await makeBackend();
    lbugMocks.executeParameterized.mockRejectedValueOnce(new Error('Corrupted wal file'));

    const result = await backend.callTool('context', {
      repo: 'test-repo',
      name: 'MyClass',
    });

    expect(result.error).toBe('Corrupted wal file');
    expect(result.recoverySuggestion).toBeDefined();
  });

  it('non-WAL errors do not include WAL suggestion', async () => {
    const backend = await makeBackend();
    lbugMocks.executeParameterized.mockRejectedValueOnce(new Error('Some other error'));

    const result = await backend.callTool('impact', {
      repo: 'test-repo',
      target: 'MyClass',
      direction: 'upstream',
    });

    expect(result.error).toBeDefined();
    expect(result.suggestion).toBe(
      'The graph query failed — try gitnexus context <symbol> as a fallback',
    );
  });

  it('context preserves non-WAL throw behavior', async () => {
    const backend = await makeBackend();
    lbugMocks.executeParameterized.mockRejectedValueOnce(new Error('Some other error'));

    await expect(
      backend.callTool('context', {
        repo: 'test-repo',
        name: 'MyClass',
      }),
    ).rejects.toThrow('Some other error');
  });
});
