import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/storage/repo-manager.js', () => ({
  findRepo: vi.fn(),
}));

vi.mock('../../src/storage/git.js', () => ({
  getCurrentCommit: vi.fn(),
  isGitRepo: vi.fn(),
}));

vi.mock('../../src/mcp/staleness.js', () => ({
  checkStaleness: vi.fn(),
}));

import { statusCommand } from '../../src/cli/status.js';
import { findRepo } from '../../src/storage/repo-manager.js';
import { getCurrentCommit, isGitRepo } from '../../src/storage/git.js';
import { checkStaleness } from '../../src/mcp/staleness.js';

describe('statusCommand', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    logSpy.mockClear();
  });

  it('preserves empty indexed commit in staleness check', async () => {
    vi.mocked(isGitRepo).mockReturnValue(true);
    vi.mocked(getCurrentCommit).mockReturnValue('abc1234');
    vi.mocked(findRepo).mockResolvedValue({
      name: 'repo',
      repoPath: '/tmp/repo',
      meta: {
        indexedAt: new Date().toISOString(),
        lastCommit: '',
        ignoreConfig: { ignoreFile: null, ignoreProfile: null },
      },
    } as any);
    vi.mocked(checkStaleness).mockReturnValue({ isStale: true, commitsBehind: 1 });

    await statusCommand();

    expect(checkStaleness).toHaveBeenCalledWith(
      '/tmp/repo',
      '',
      { ignoreFile: null, ignoreProfile: null },
    );
  });
});
