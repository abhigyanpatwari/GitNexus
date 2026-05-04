import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const mockAccess = vi.fn();
const mockGetStoragePaths = vi.fn();
const mockLoadMeta = vi.fn();
const mockRegisterRepo = vi.fn();
const mockEnsureGitNexusIgnored = vi.fn();
const mockGetGitRoot = vi.fn();
const mockIsGitRepo = vi.fn();

vi.mock('fs/promises', () => ({
  default: {
    access: mockAccess,
  },
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  getStoragePaths: mockGetStoragePaths,
  loadMeta: mockLoadMeta,
  registerRepo: mockRegisterRepo,
  ensureGitNexusIgnored: mockEnsureGitNexusIgnored,
}));

vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: mockGetGitRoot,
  isGitRepo: mockIsGitRepo,
  // `index-repo.ts` calls `getRemoteUrl` to backfill `remoteUrl` on
  // older `.gitnexus/meta.json` files. The unit tests don't care
  // about the remote URL, so a static `undefined` keeps behaviour
  // identical to the pre-feature path.
  getRemoteUrl: vi.fn().mockReturnValue(undefined),
}));

describe('indexCommand', () => {
  const resolvedRepo = path.resolve('/repo');
  const resolvedOutside = path.resolve('/outside/path');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    process.exitCode = undefined;

    mockGetStoragePaths.mockImplementation((repoPath: string) => ({
      storagePath: `${repoPath}/.gitnexus`,
      lbugPath: `${repoPath}/.gitnexus/lbug`,
      metaPath: `${repoPath}/.gitnexus/meta.json`,
    }));
    mockLoadMeta.mockResolvedValue({
      repoPath: resolvedRepo,
      lastCommit: 'abc123',
      indexedAt: '2026-03-20T00:00:00.000Z',
      stats: { nodes: 10, edges: 20 },
    });
    mockAccess.mockResolvedValue(undefined);
    mockEnsureGitNexusIgnored.mockResolvedValue(undefined);
    mockGetGitRoot.mockReturnValue(resolvedRepo);
    mockIsGitRepo.mockReturnValue(true);
  });

  it('fails when target path is not a git repository', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockIsGitRepo.mockReturnValue(false);

    const { indexCommand } = await import('../../src/cli/index-repo.js');
    await indexCommand(['/outside/path']);

    expect(mockRegisterRepo).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(`  Not a git repository: ${resolvedOutside}`);
  });

  it('fails when .gitnexus folder does not exist', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockAccess.mockRejectedValueOnce(new Error('missing .gitnexus'));

    const { indexCommand } = await import('../../src/cli/index-repo.js');
    await indexCommand(['/repo']);

    expect(mockRegisterRepo).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(
      `  No .gitnexus/ folder found at: ${resolvedRepo}/.gitnexus`,
    );
  });

  it('fails when lbug database does not exist', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockAccess.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('missing lbug'));

    const { indexCommand } = await import('../../src/cli/index-repo.js');
    await indexCommand(['/repo']);

    expect(mockRegisterRepo).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(
      '  .gitnexus/ folder exists but contains no LadybugDB index.',
    );
  });

  it('fails when meta.json is missing and --force is not set', async () => {
    mockLoadMeta.mockResolvedValue(null);

    const { indexCommand } = await import('../../src/cli/index-repo.js');
    await indexCommand(['/repo']);

    expect(mockRegisterRepo).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('registers with minimal metadata when meta is missing and --force is set', async () => {
    mockLoadMeta.mockResolvedValue(null);

    const { indexCommand } = await import('../../src/cli/index-repo.js');
    await indexCommand(['/repo'], { force: true });

    expect(mockRegisterRepo).toHaveBeenCalledTimes(1);
    expect(mockRegisterRepo).toHaveBeenCalledWith(
      resolvedRepo,
      expect.objectContaining({
        repoPath: resolvedRepo,
        lastCommit: '',
      }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('registers successfully with existing metadata', async () => {
    const { indexCommand } = await import('../../src/cli/index-repo.js');
    await indexCommand(['/repo']);

    expect(mockRegisterRepo).toHaveBeenCalledTimes(1);
    expect(mockRegisterRepo).toHaveBeenCalledWith(
      resolvedRepo,
      expect.objectContaining({ repoPath: resolvedRepo }),
    );
    expect(mockEnsureGitNexusIgnored).toHaveBeenCalledTimes(1);
    expect(mockEnsureGitNexusIgnored).toHaveBeenCalledWith(resolvedRepo);
    expect(process.exitCode).toBeUndefined();
  });

  it('registers non-git path when --allow-non-git is set', async () => {
    mockIsGitRepo.mockReturnValue(false);

    const { indexCommand } = await import('../../src/cli/index-repo.js');
    await indexCommand(['/outside/path'], { allowNonGit: true });

    expect(mockRegisterRepo).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('fails when called with no path and cwd is not inside a git repo', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGetGitRoot.mockReturnValue(null);

    const { indexCommand } = await import('../../src/cli/index-repo.js');
    await indexCommand(); // no args

    expect(mockRegisterRepo).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledWith('  Not inside a git repository, try to run git init\n');
  });

  it('registers from cwd when no path is provided', async () => {
    // getGitRoot already mocked to return resolvedRepo in beforeEach
    const { indexCommand } = await import('../../src/cli/index-repo.js');
    await indexCommand(); // no args

    expect(mockRegisterRepo).toHaveBeenCalledWith(
      resolvedRepo,
      expect.objectContaining({ repoPath: resolvedRepo }),
    );
    expect(mockEnsureGitNexusIgnored).toHaveBeenCalledWith(resolvedRepo);
    expect(process.exitCode).toBeUndefined();
  });

  it('fails when multiple path parts do not resolve to a single existing path', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ambiguousPath = path.resolve('/repo /other');

    mockAccess.mockImplementation(async (targetPath: string) => {
      if (targetPath === ambiguousPath) {
        throw new Error('missing combined path');
      }
      return undefined;
    });

    const { indexCommand } = await import('../../src/cli/index-repo.js');
    await indexCommand(['/repo', '/other']);

    expect(mockRegisterRepo).not.toHaveBeenCalled();
    expect(mockEnsureGitNexusIgnored).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledWith('  The `index` command accepts a single path only.');
  });

  it('prints node and edge stats after registration', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { indexCommand } = await import('../../src/cli/index-repo.js');
    await indexCommand(['/repo']);

    expect(logSpy).toHaveBeenCalledWith('  Repository registered: repo');
    expect(logSpy).toHaveBeenCalledWith('  10 nodes | 20 edges');
  });
});
