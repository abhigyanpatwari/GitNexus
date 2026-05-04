import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeQueryMock = vi.fn();

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>();
  return {
    ...actual,
    initLbug: vi.fn(),
    executeQuery: (...args: any[]) => executeQueryMock(...args),
    executeParameterized: vi.fn(),
    closeLbug: vi.fn(),
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

describe('LocalBackend queryClusters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes numeric Community fields before aggregating modules', async () => {
    const backend = new LocalBackend();
    const repoHandle = {
      id: 'repo',
      name: 'repo',
      repoPath: '/tmp/repo',
      storagePath: '/tmp/repo/.gitnexus',
      lbugPath: '/tmp/repo/.gitnexus/lbug',
      indexedAt: 'now',
      lastCommit: 'c',
      stats: {},
    };
    (backend as any).repos.set(repoHandle.id, repoHandle);
    (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);

    executeQueryMock.mockResolvedValue([
      {
        id: 'comm_1',
        label: 'Auth',
        heuristicLabel: 'Auth',
        cohesion: 0.75,
        symbolCount: 4n,
      },
      {
        id: 'comm_2',
        label: 'Auth',
        heuristicLabel: 'Auth',
        cohesion: 0.5,
        symbolCount: 3n,
      },
    ]);

    const result = await backend.queryClusters('repo', 10);

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]).toMatchObject({
      label: 'Auth',
      heuristicLabel: 'Auth',
      symbolCount: 7,
      subCommunities: 2,
    });
    expect(result.clusters[0].cohesion).toBeCloseTo((0.75 * 4 + 0.5 * 3) / 7);
  });
});
