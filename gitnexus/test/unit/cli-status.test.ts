import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsGitRepo = vi.fn();
const mockGetGitRoot = vi.fn();
const mockGetCurrentCommit = vi.fn();
const mockFindRepo = vi.fn();
const mockGetStoragePaths = vi.fn();
const mockHasKuzuIndex = vi.fn();

vi.mock('../../src/storage/git.js', () => ({
  isGitRepo: mockIsGitRepo,
  getGitRoot: mockGetGitRoot,
  getCurrentCommit: mockGetCurrentCommit,
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  findRepo: mockFindRepo,
  getStoragePaths: mockGetStoragePaths,
  hasKuzuIndex: mockHasKuzuIndex,
}));

describe('statusCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGetStoragePaths.mockReturnValue({ storagePath: '/repo/.gitnexus' });
  });

  it('prints "Not a git repository" when cwd is not a git repo', async () => {
    mockIsGitRepo.mockReturnValue(false);

    const { statusCommand } = await import('../../src/cli/status.js');
    await statusCommand();

    expect(logSpy).toHaveBeenCalledWith('Not a git repository.');
    expect(mockFindRepo).not.toHaveBeenCalled();
  });

  it('prompts for migration when a stale KuzuDB index exists', async () => {
    mockIsGitRepo.mockReturnValue(true);
    mockFindRepo.mockResolvedValue(null);
    mockGetGitRoot.mockReturnValue('/repo');
    mockHasKuzuIndex.mockResolvedValue(true);

    const { statusCommand } = await import('../../src/cli/status.js');
    await statusCommand();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('stale KuzuDB index'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('rebuilds the index'));
  });

  it('prompts to analyze when no index exists at all', async () => {
    mockIsGitRepo.mockReturnValue(true);
    mockFindRepo.mockResolvedValue(null);
    mockGetGitRoot.mockReturnValue('/repo');
    mockHasKuzuIndex.mockResolvedValue(false);

    const { statusCommand } = await import('../../src/cli/status.js');
    await statusCommand();

    expect(logSpy).toHaveBeenCalledWith('Repository not indexed.');
    expect(logSpy).toHaveBeenCalledWith('Run: gitnexus analyze');
  });

  it('falls back to cwd when getGitRoot returns null', async () => {
    mockIsGitRepo.mockReturnValue(true);
    mockFindRepo.mockResolvedValue(null);
    mockGetGitRoot.mockReturnValue(null);
    mockHasKuzuIndex.mockResolvedValue(false);

    const { statusCommand } = await import('../../src/cli/status.js');
    await statusCommand();

    expect(mockGetStoragePaths).toHaveBeenCalledWith(process.cwd());
  });

  it('reports up-to-date when current commit matches indexed commit', async () => {
    mockIsGitRepo.mockReturnValue(true);
    mockFindRepo.mockResolvedValue({
      repoPath: '/repo',
      meta: {
        lastCommit: 'abc1234567',
        indexedAt: '2026-04-01T00:00:00Z',
      },
    });
    mockGetCurrentCommit.mockReturnValue('abc1234567');

    const { statusCommand } = await import('../../src/cli/status.js');
    await statusCommand();

    expect(logSpy).toHaveBeenCalledWith('Repository: /repo');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('abc1234'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('up-to-date'));
  });

  it('reports stale when current commit diverges from indexed commit', async () => {
    mockIsGitRepo.mockReturnValue(true);
    mockFindRepo.mockResolvedValue({
      repoPath: '/repo',
      meta: {
        lastCommit: 'old12345',
        indexedAt: '2026-04-01T00:00:00Z',
      },
    });
    mockGetCurrentCommit.mockReturnValue('new67890');

    const { statusCommand } = await import('../../src/cli/status.js');
    await statusCommand();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('stale'));
  });
});
