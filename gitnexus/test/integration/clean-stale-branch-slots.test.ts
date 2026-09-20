import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanCommand } from '../../src/cli/clean.js';
import { branchSlug } from '../../src/storage/branch-index.js';
import {
  listRegisteredRepos,
  registerRepo,
  saveMeta,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';

/**
 * Issue #3331 repro: a pinned per-branch slot survives deleting the git
 * branch; `clean --stale --force` reclaims it without naming the branch.
 */
describe('clean --stale leftover branch slots (#3331)', () => {
  let home: TestDBHandle;
  let fixture: TestDBHandle;
  let savedHome: string | undefined;

  beforeEach(async () => {
    home = await createTempDir('gitnexus-clean-stale-home-');
    fixture = await createTempDir('gitnexus-clean-stale-repo-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = home.dbPath;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await fixture.cleanup();
    await home.cleanup();
  });

  it('reclaims a slot after the git branch is deleted', async () => {
    const repo = fixture.dbPath;
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    commitAll(repo, 'init');
    execSync('git branch -M main', { cwd: repo, stdio: 'ignore', windowsHide: true });
    execSync('git branch feature/x', { cwd: repo, stdio: 'ignore', windowsHide: true });

    const storagePath = path.join(repo, '.gitnexus');
    const meta = (branch: string): RepoMeta => ({
      repoPath: repo,
      lastCommit: 'aaa',
      indexedAt: '2026-09-20T00:00:00.000Z',
      branch,
      stats: { files: 1, nodes: 1 },
    });
    await saveMeta(storagePath, meta('main'));
    await registerRepo(repo, meta('main'));
    await registerRepo(repo, meta('feature/x'), { branch: 'feature/x' });
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await saveMeta(dir, meta('feature/x'));
    await fs.writeFile(path.join(storagePath, 'parse-cache.json'), '{}');

    execSync('git branch -D feature/x', { cwd: repo, stdio: 'ignore', windowsHide: true });
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await cleanCommand({ stale: true, force: true });

    await expect(fs.access(dir)).rejects.toThrow();
    await expect(fs.access(path.join(storagePath, 'branches'))).rejects.toThrow();
    await expect(fs.readFile(path.join(storagePath, 'parse-cache.json'), 'utf8')).resolves.toBe(
      '{}',
    );
    const [entry] = await listRegisteredRepos();
    expect(entry.branches).toBeUndefined();
  });

  it('keeps a live slot when a tag shares the branch name', async () => {
    const repo = fixture.dbPath;
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    commitAll(repo, 'init');
    execSync('git branch -M main', { cwd: repo, stdio: 'ignore', windowsHide: true });
    execSync('git branch feature/x', { cwd: repo, stdio: 'ignore', windowsHide: true });
    execSync('git tag feature/x', { cwd: repo, stdio: 'ignore', windowsHide: true });

    const storagePath = path.join(repo, '.gitnexus');
    const meta = (branch: string): RepoMeta => ({
      repoPath: repo,
      lastCommit: 'aaa',
      indexedAt: '2026-09-20T00:00:00.000Z',
      branch,
      stats: { files: 1, nodes: 1 },
    });
    await saveMeta(storagePath, meta('main'));
    await registerRepo(repo, meta('main'));
    await registerRepo(repo, meta('feature/x'), { branch: 'feature/x' });
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await saveMeta(dir, meta('feature/x'));

    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await cleanCommand({ stale: true, force: true });

    await expect(fs.access(dir)).resolves.toBeUndefined();
    const [entry] = await listRegisteredRepos();
    expect(entry.branches?.map((row) => row.branch)).toContain('feature/x');
  });

  it('reclaims a slot after the branch is deleted even if a tag keeps the name', async () => {
    const repo = fixture.dbPath;
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    commitAll(repo, 'init');
    execSync('git branch -M main', { cwd: repo, stdio: 'ignore', windowsHide: true });
    execSync('git branch feature/x', { cwd: repo, stdio: 'ignore', windowsHide: true });
    execSync('git tag feature/x', { cwd: repo, stdio: 'ignore', windowsHide: true });

    const storagePath = path.join(repo, '.gitnexus');
    const meta = (branch: string): RepoMeta => ({
      repoPath: repo,
      lastCommit: 'aaa',
      indexedAt: '2026-09-20T00:00:00.000Z',
      branch,
      stats: { files: 1, nodes: 1 },
    });
    await saveMeta(storagePath, meta('main'));
    await registerRepo(repo, meta('main'));
    await registerRepo(repo, meta('feature/x'), { branch: 'feature/x' });
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await saveMeta(dir, meta('feature/x'));

    execSync('git branch -D feature/x', { cwd: repo, stdio: 'ignore', windowsHide: true });
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await cleanCommand({ stale: true, force: true });

    await expect(fs.access(dir)).rejects.toThrow();
    const [entry] = await listRegisteredRepos();
    expect(entry.branches).toBeUndefined();
  });
});
