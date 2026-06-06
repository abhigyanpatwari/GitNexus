import { describe, expect, it, vi } from 'vitest';
import { planAutoReindexSweep, runAutoReindexSweep } from '../../src/server/reindex-auto-sweep.js';
import type { AutoReindexSweepRepo } from '../../src/server/reindex-auto-sweep.js';

const repos: AutoReindexSweepRepo[] = [
  {
    id: 'repo-stale',
    name: 'repo-stale',
    path: '/workspace/repo-stale',
    storagePath: '/data/gitnexus/repos/repo-stale',
    lastCommit: 'abc123',
  },
  {
    id: 'repo-fresh',
    name: 'repo-fresh',
    path: '/workspace/repo-fresh',
    storagePath: '/data/gitnexus/repos/repo-fresh',
    lastCommit: 'def456',
  },
];

describe('auto reindex sweep planning', () => {
  it('selects stale registered repos and skips fresh repos', async () => {
    const loadRepos = vi.fn(async () => repos);
    const checkStaleness = vi.fn(async (repoPath: string) => ({
      isStale: repoPath.endsWith('repo-stale'),
      commitsBehind: repoPath.endsWith('repo-stale') ? 2 : 0,
    }));

    const plan = await planAutoReindexSweep({ loadRepos, checkStaleness });

    expect(loadRepos).toHaveBeenCalledTimes(1);
    expect(checkStaleness).toHaveBeenCalledTimes(2);
    expect(checkStaleness).toHaveBeenNthCalledWith(1, '/workspace/repo-stale', 'abc123');
    expect(checkStaleness).toHaveBeenNthCalledWith(2, '/workspace/repo-fresh', 'def456');
    expect(plan.stale).toEqual([
      {
        repo: repos[0],
        staleness: { isStale: true, commitsBehind: 2 },
      },
    ]);
    expect(plan.fresh).toEqual([
      {
        repo: repos[1],
        staleness: { isStale: false, commitsBehind: 0 },
      },
    ]);
  });

  it('dry-run reports stale repos without starting reindex work', async () => {
    const startReindex = vi.fn();
    const result = await runAutoReindexSweep({
      dryRun: true,
      embeddings: true,
      loadRepos: async () => [repos[0]],
      checkStaleness: async () => ({ isStale: true, commitsBehind: 3 }),
      requestQueue: vi.fn(() => ({ action: 'start' })),
      startReindex,
    });

    expect(startReindex).not.toHaveBeenCalled();
    expect(result.started).toEqual([]);
    expect(result.dryRun).toEqual([
      {
        repo: repos[0],
        staleness: { isStale: true, commitsBehind: 3 },
      },
    ]);
  });

  it('starts stale repos through the queue when dry-run is disabled', async () => {
    const requestQueue = vi.fn(() => ({ action: 'start' as const }));
    const startReindex = vi.fn();

    const result = await runAutoReindexSweep({
      dryRun: false,
      embeddings: true,
      loadRepos: async () => [repos[0]],
      checkStaleness: async () => ({ isStale: true, commitsBehind: 1 }),
      requestQueue,
      startReindex,
    });

    expect(requestQueue).toHaveBeenCalledWith('repo-stale');
    expect(startReindex).toHaveBeenCalledWith(
      repos[0],
      'repo-stale',
      expect.objectContaining({ force: true, embeddings: true }),
    );
    expect(result.started.map((entry) => entry.repo.name)).toEqual(['repo-stale']);
  });

  it('does not start reindex work when the queue rejects or coalesces the request', async () => {
    const startReindex = vi.fn();

    const result = await runAutoReindexSweep({
      dryRun: false,
      embeddings: true,
      loadRepos: async () => repos,
      checkStaleness: async () => ({ isStale: true, commitsBehind: 1 }),
      requestQueue: vi
        .fn()
        .mockReturnValueOnce({ action: 'dedupe-pending-rerun' })
        .mockReturnValueOnce({ action: 'reject-active-other-repo', activeRepoKey: 'repo-stale' }),
      startReindex,
    });

    expect(startReindex).not.toHaveBeenCalled();
    expect(result.started).toEqual([]);
  });
});
