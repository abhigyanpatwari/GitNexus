import { beforeEach, describe, expect, it, vi } from 'vitest';

const { lbugMocks, repoMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn(),
    executeParameterized: vi.fn(),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
  repoMocks: {
    listRegisteredRepos: vi.fn(),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: repoMocks.listRegisteredRepos,
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  canonicalizePath: vi.fn((value: string) => value),
  RegistryAmbiguousTargetError: class RegistryAmbiguousTargetError extends Error {},
}));

vi.mock('../../src/storage/git.js', () => ({
  parseDiffHunks: vi.fn(),
  getCanonicalRepoRoot: vi.fn().mockReturnValue(null),
  getGitRoot: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/core/git-staleness.js', () => ({
  checkStalenessAsync: vi.fn().mockResolvedValue({ isStale: false, commitsBehind: 0 }),
  checkCwdMatch: vi.fn().mockResolvedValue({ match: 'none' }),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const MOCK_REPO_ENTRY = {
  name: 'test-repo',
  path: '/tmp/test',
  storagePath: '/tmp/test/.gitnexus',
  indexedAt: '2026-06-02T00:00:00Z',
  lastCommit: 'abc1234',
};

async function makeBackend(): Promise<LocalBackend> {
  const backend = new LocalBackend();
  await backend.init();
  return backend;
}

describe('LocalBackend init readiness retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lbugMocks.initLbug.mockResolvedValue(undefined);
    lbugMocks.closeLbug.mockResolvedValue(undefined);
    lbugMocks.isLbugReady.mockReturnValue(true);
    lbugMocks.executeQuery.mockResolvedValue([]);
    lbugMocks.executeParameterized.mockResolvedValue([]);
    repoMocks.listRegisteredRepos.mockResolvedValue([MOCK_REPO_ENTRY]);
  });

  it('retries once when the first pooled readiness probe hits read-only shadow replay', async () => {
    const backend = await makeBackend();

    lbugMocks.executeQuery
      .mockRejectedValueOnce(new Error("Couldn't replay shadow pages under read-only mode"))
      .mockResolvedValueOnce([]);
    lbugMocks.executeParameterized.mockResolvedValueOnce([{ id: 'symbol-1' }]);

    const result = await backend.callTool('cypher', {
      repo: 'test-repo',
      query: 'MATCH (n) RETURN n.id AS id LIMIT 1',
    });

    expect(lbugMocks.initLbug).toHaveBeenCalledTimes(2);
    expect(lbugMocks.closeLbug).toHaveBeenCalledWith('test-repo');
    expect(lbugMocks.executeQuery).toHaveBeenCalledTimes(2);
    expect(lbugMocks.executeParameterized).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ row_count: 1 });
  });

  it('does not retry unrelated readiness failures', async () => {
    const backend = await makeBackend();

    lbugMocks.executeQuery.mockRejectedValueOnce(new Error('Permission denied'));

    await expect(
      backend.callTool('cypher', {
        repo: 'test-repo',
        query: 'MATCH (n) RETURN n.id AS id LIMIT 1',
      }),
    ).rejects.toThrow('Permission denied');
    expect(lbugMocks.initLbug).toHaveBeenCalledTimes(1);
    expect(lbugMocks.closeLbug).not.toHaveBeenCalled();
  });
});
