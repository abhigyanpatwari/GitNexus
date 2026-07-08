/**
 * Unit tests for branch-aware `list` and `status` rendering (#2106).
 *
 * The data layer (repo-manager / git) is mocked so these assert only the
 * console rendering: branch indexes appear when present, single-branch output
 * is unchanged, and `status` reflects the checked-out branch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn(),
  findRepo: vi.fn(),
  getStoragePaths: vi.fn((repoPath: string, branch?: string) => ({
    storagePath: `${repoPath}/.gitnexus`,
    lbugPath: branch
      ? `${repoPath}/.gitnexus/branches/${branch}/lbug`
      : `${repoPath}/.gitnexus/lbug`,
    metaPath: branch
      ? `${repoPath}/.gitnexus/branches/${branch}/meta.json`
      : `${repoPath}/.gitnexus/meta.json`,
  })),
  loadMeta: vi.fn(),
  hasKuzuIndex: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/storage/git.js', () => ({
  isGitRepo: vi.fn().mockReturnValue(true),
  getCurrentCommit: vi.fn().mockReturnValue('headsha0'),
  getCurrentBranch: vi.fn().mockReturnValue('main'),
  getGitRoot: vi.fn((p: string) => p),
}));

import { listCommand } from '../../src/cli/list.js';
import { statusCommand } from '../../src/cli/status.js';
import { listRegisteredRepos, findRepo, loadMeta } from '../../src/storage/repo-manager.js';
import { getCurrentBranch, getCurrentCommit } from '../../src/storage/git.js';

let logSpy: ReturnType<typeof vi.spyOn>;
const output = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('list branch rendering (#2106)', () => {
  it('renders the primary branch and a Branch indexes section', async () => {
    (listRegisteredRepos as any).mockResolvedValue([
      {
        name: 'multi',
        path: '/repo',
        storagePath: '/repo/.gitnexus',
        indexedAt: '2026-06-10T12:00:00.000Z',
        lastCommit: 'aaaaaaa1',
        branch: 'main',
        branches: [
          { branch: 'feature/x', indexedAt: '2026-06-10T13:00:00.000Z', lastCommit: 'bbbbbbb2' },
        ],
        stats: { files: 1, nodes: 2, edges: 3 },
      },
    ]);

    await listCommand();
    const out = output();
    expect(out).toContain('Branch:  main');
    expect(out).toContain('Branch indexes:');
    expect(out).toContain('feature/x');
    expect(out).toContain('bbbbbbb'); // 7-char short commit of bbbbbbb2
  });

  it('single-branch entry renders no branch lines (unchanged)', async () => {
    (listRegisteredRepos as any).mockResolvedValue([
      {
        name: 'solo',
        path: '/solo',
        storagePath: '/solo/.gitnexus',
        indexedAt: '2026-06-10T12:00:00.000Z',
        lastCommit: 'ccccccc3',
        stats: { files: 1, nodes: 1, edges: 1 },
      },
    ]);

    await listCommand();
    const out = output();
    expect(out).not.toContain('Branch:');
    expect(out).not.toContain('Branch indexes:');
  });
});

describe('status branch rendering (#2106)', () => {
  const baseRepo = {
    repoPath: '/repo',
    storagePath: '/repo/.gitnexus',
    lbugPath: '/repo/.gitnexus/lbug',
    metaPath: '/repo/.gitnexus/meta.json',
    meta: {
      repoPath: '/repo',
      lastCommit: 'headsha0',
      indexedAt: '2026-06-10T12:00:00.000Z',
      branch: 'main',
    },
  };

  it('shows the current branch and up-to-date on the primary', async () => {
    (findRepo as any).mockResolvedValue(baseRepo);
    (getCurrentBranch as any).mockReturnValue('main');
    (getCurrentCommit as any).mockReturnValue('headsha0');

    await statusCommand();
    const out = output();
    expect(out).toContain('Branch: main');
    expect(out).toContain('up-to-date');
  });

  it('falls through to the workspace index when the branch has no pinned index (#2354)', async () => {
    (findRepo as any).mockResolvedValue(baseRepo);
    (getCurrentBranch as any).mockReturnValue('feature/y');
    (getCurrentCommit as any).mockReturnValue('headsha9');
    (loadMeta as any).mockResolvedValue(null); // feature/y has no pinned index

    await statusCommand();
    const out = output();
    expect(out).toContain('Branch: feature/y');
    // The flat workspace index (last analyzed on main) is reported, with the
    // commit comparison saying it lags this branch's tree.
    expect(out).toContain("Workspace index: last analyzed on 'main'");
    expect(out).toContain('stale');
  });

  it('same-commit branch flip reports up-to-date against the workspace index (#2354)', async () => {
    (findRepo as any).mockResolvedValue(baseRepo);
    (getCurrentBranch as any).mockReturnValue('feature/y');
    (getCurrentCommit as any).mockReturnValue('headsha0'); // same commit as flat meta
    (loadMeta as any).mockResolvedValue(null); // feature/y has no pinned index

    await statusCommand();
    const out = output();
    expect(out).toContain("Workspace index: last analyzed on 'main'");
    expect(out).toContain('up-to-date');
  });

  it('compares against the branch index when the current branch has one', async () => {
    (findRepo as any).mockResolvedValue(baseRepo);
    (getCurrentBranch as any).mockReturnValue('feature/z');
    (getCurrentCommit as any).mockReturnValue('zzzzsha0');
    (loadMeta as any).mockResolvedValue({
      repoPath: '/repo',
      lastCommit: 'zzzzsha0',
      indexedAt: '2026-06-10T14:00:00.000Z',
      branch: 'feature/z',
    });

    await statusCommand();
    const out = output();
    expect(out).toContain('Branch: feature/z');
    expect(out).toContain('up-to-date');
  });

  it('shows detached HEAD and compares against the flat index', async () => {
    (findRepo as any).mockResolvedValue(baseRepo);
    (getCurrentBranch as any).mockReturnValue(null); // detached
    (getCurrentCommit as any).mockReturnValue('headsha0');

    await statusCommand();
    const out = output();
    expect(out).toContain('(detached HEAD)');
    expect(out).toContain('up-to-date');
  });

  it('reports stale when the branch index is behind the branch tip', async () => {
    (findRepo as any).mockResolvedValue(baseRepo);
    (getCurrentBranch as any).mockReturnValue('feature/z');
    (getCurrentCommit as any).mockReturnValue('newsha99'); // moved past the index
    (loadMeta as any).mockResolvedValue({
      repoPath: '/repo',
      lastCommit: 'oldsha00',
      indexedAt: '2026-06-10T14:00:00.000Z',
      branch: 'feature/z',
    });

    await statusCommand();
    const out = output();
    expect(out).toContain('Branch: feature/z');
    expect(out).toContain('stale');
  });
});
