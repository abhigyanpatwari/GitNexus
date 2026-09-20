import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanCommand } from '../../src/cli/clean.js';
import { t } from '../../src/cli/i18n/index.js';
import { branchSlug } from '../../src/storage/branch-index.js';
import * as git from '../../src/storage/git.js';
import {
  getStoragePaths,
  listRegisteredRepos,
  registerRepo,
  saveMeta,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { INDEX_METADATA_FILE } from '../../src/storage/storage-constants.js';
import { initGitRepo, commitAll } from '../helpers/temp-git-repo.js';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';

describe('cleanCommand --stale (#3331)', () => {
  let home: TestDBHandle;
  let fixture: TestDBHandle;
  let repo: string;
  let storagePath: string;
  let savedHome: string | undefined;
  let logs: string[];

  const metaFor = (branch: string, repoPath: string): RepoMeta => ({
    repoPath,
    lastCommit: 'aaa',
    indexedAt: '2026-09-20T00:00:00.000Z',
    branch,
    stats: { files: 1, nodes: 1 },
  });

  async function writeOwnedFlat(repoPath: string, dest: string): Promise<void> {
    await saveMeta(dest, metaFor('main', repoPath));
  }

  beforeEach(async () => {
    home = await createTempDir();
    fixture = await createTempDir();
    repo = path.join(fixture.dbPath, 'repo');
    storagePath = path.join(repo, '.gitnexus');
    await fs.mkdir(repo, { recursive: true });
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = home.dbPath;
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await fixture.cleanup();
    await home.cleanup();
  });

  it('previews leftover slots with reason and does not delete without --force', async () => {
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'README.md'), 'hi\n');
    commitAll(repo, 'init');
    await writeOwnedFlat(repo, storagePath);
    await registerRepo(repo, metaFor('main', repo));
    await registerRepo(repo, metaFor('feature/x', repo), { branch: 'feature/x' });
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await saveMeta(dir, metaFor('feature/x', repo));
    vi.spyOn(process, 'cwd').mockReturnValue(repo);

    await cleanCommand({ stale: true });

    const output = logs.join('\n');
    expect(output).toContain(t('clean.stale.reason.refMissing'));
    expect(output).toContain('feature/x');
    expect(output).toContain(t('common.runForceConfirm'));
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it('removes a leftover slot and empty branches/ with --force', async () => {
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'README.md'), 'hi\n');
    commitAll(repo, 'init');
    await writeOwnedFlat(repo, storagePath);
    await registerRepo(repo, metaFor('main', repo));
    await registerRepo(repo, metaFor('feature/x', repo), { branch: 'feature/x' });
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await saveMeta(dir, metaFor('feature/x', repo));
    vi.spyOn(process, 'cwd').mockReturnValue(repo);

    await cleanCommand({ stale: true, force: true });

    expect(logs.join('\n')).toContain(t('clean.stale.deleted', { branch: 'feature/x' }));
    await expect(fs.access(dir)).rejects.toThrow();
    await expect(fs.access(path.join(storagePath, 'branches'))).rejects.toThrow();
    await expect(fs.access(path.join(storagePath, INDEX_METADATA_FILE))).resolves.toBeUndefined();
  });

  it('skips a leftover slot that is a local head again on force re-check', async () => {
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'README.md'), 'hi\n');
    commitAll(repo, 'init');
    await writeOwnedFlat(repo, storagePath);
    await registerRepo(repo, metaFor('main', repo));
    await registerRepo(repo, metaFor('feature/x', repo), { branch: 'feature/x' });
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await saveMeta(dir, metaFor('feature/x', repo));
    const realListLocalHeads = git.listLocalHeads;
    let calls = 0;
    vi.spyOn(git, 'listLocalHeads').mockImplementation((repoPath: string) => {
      calls += 1;
      if (calls === 1) return realListLocalHeads(repoPath);
      return ['main', 'feature/x'];
    });
    vi.spyOn(process, 'cwd').mockReturnValue(repo);

    await cleanCommand({ stale: true, force: true });

    const output = logs.join('\n');
    expect(output).toContain(t('clean.stale.skippedLive', { branch: 'feature/x' }));
    expect(output).not.toContain(t('clean.stale.deleted', { branch: 'feature/x' }));
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it('still deletes when force re-check returns an empty head list', async () => {
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'README.md'), 'hi\n');
    commitAll(repo, 'init');
    await writeOwnedFlat(repo, storagePath);
    await registerRepo(repo, metaFor('main', repo));
    await registerRepo(repo, metaFor('feature/x', repo), { branch: 'feature/x' });
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await saveMeta(dir, metaFor('feature/x', repo));
    const realListLocalHeads = git.listLocalHeads;
    let calls = 0;
    vi.spyOn(git, 'listLocalHeads').mockImplementation((repoPath: string) => {
      calls += 1;
      if (calls === 1) return realListLocalHeads(repoPath);
      return [];
    });
    vi.spyOn(process, 'cwd').mockReturnValue(repo);

    await cleanCommand({ stale: true, force: true });

    expect(logs.join('\n')).toContain(t('clean.stale.deleted', { branch: 'feature/x' }));
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it('does not delete when force re-check cannot list local heads', async () => {
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'README.md'), 'hi\n');
    commitAll(repo, 'init');
    await writeOwnedFlat(repo, storagePath);
    await registerRepo(repo, metaFor('main', repo));
    await registerRepo(repo, metaFor('feature/x', repo), { branch: 'feature/x' });
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await saveMeta(dir, metaFor('feature/x', repo));
    const realListLocalHeads = git.listLocalHeads;
    let calls = 0;
    vi.spyOn(git, 'listLocalHeads').mockImplementation((repoPath: string) => {
      calls += 1;
      if (calls === 1) return realListLocalHeads(repoPath);
      return null;
    });
    vi.spyOn(process, 'cwd').mockReturnValue(repo);

    await cleanCommand({ stale: true, force: true });

    const output = logs.join('\n');
    expect(output).toContain(t('clean.stale.headsUnavailable'));
    expect(output).not.toContain(t('clean.stale.deleted', { branch: 'feature/x' }));
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it('does not treat an obstructed slot path as none or delete it', async () => {
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'README.md'), 'hi\n');
    commitAll(repo, 'init');
    await writeOwnedFlat(repo, storagePath);
    await registerRepo(repo, metaFor('main', repo));
    await registerRepo(repo, metaFor('feature/x', repo), { branch: 'feature/x' });
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.writeFile(dir, 'not-a-directory');
    vi.spyOn(process, 'cwd').mockReturnValue(repo);

    await cleanCommand({ stale: true, force: true });

    const output = logs.join('\n');
    expect(output).toContain(t('clean.stale.probeFailed'));
    expect(output).not.toContain(t('clean.stale.none'));
    expect(output).not.toContain(t('clean.stale.deleted', { branch: 'feature/x' }));
    await expect(fs.readFile(dir, 'utf8')).resolves.toBe('not-a-directory');
  });

  it('does not delete when leftover directories cannot be listed', async () => {
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'README.md'), 'hi\n');
    commitAll(repo, 'init');
    await writeOwnedFlat(repo, storagePath);
    await registerRepo(repo, metaFor('main', repo));
    await registerRepo(repo, metaFor('feature/x', repo), { branch: 'feature/x' });
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await saveMeta(dir, metaFor('feature/x', repo));
    const branchesRoot = path.join(storagePath, 'branches');
    const realReaddir = fs.readdir.bind(fs);
    vi.spyOn(fs, 'readdir').mockImplementation((async (target: unknown, options?: unknown) => {
      if (path.resolve(String(target)) === path.resolve(branchesRoot)) {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return realReaddir(
        target as Parameters<typeof realReaddir>[0],
        options as Parameters<typeof realReaddir>[1],
      );
    }) as typeof fs.readdir);
    vi.spyOn(process, 'cwd').mockReturnValue(repo);

    await cleanCommand({ stale: true, force: true });

    expect(logs.join('\n')).toContain(t('clean.stale.listingFailed'));
    expect(logs.join('\n')).not.toContain(t('clean.stale.deleted', { branch: 'feature/x' }));
    expect(logs.join('\n')).not.toContain(t('clean.stale.none'));
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it('does not delete when local heads cannot be listed', async () => {
    await writeOwnedFlat(repo, storagePath);
    await registerRepo(repo, metaFor('main', repo));
    await registerRepo(repo, metaFor('feature/x', repo), { branch: 'feature/x' });
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await saveMeta(dir, metaFor('feature/x', repo));
    vi.spyOn(process, 'cwd').mockReturnValue(repo);

    await cleanCommand({ stale: true, force: true });

    expect(logs.join('\n')).toContain(t('clean.stale.headsUnavailable'));
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it('removes a disk-only leftover directory', async () => {
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'README.md'), 'hi\n');
    commitAll(repo, 'init');
    await writeOwnedFlat(repo, storagePath);
    await registerRepo(repo, metaFor('main', repo));
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await saveMeta(dir, metaFor('feature/x', repo));
    vi.spyOn(process, 'cwd').mockReturnValue(repo);

    await cleanCommand({ stale: true, force: true });

    await expect(fs.access(dir)).rejects.toThrow();
  });

  it('does not drop a recorded branch when a stray disk-only dir claims its name', async () => {
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'README.md'), 'hi\n');
    commitAll(repo, 'init');
    await writeOwnedFlat(repo, storagePath);
    await registerRepo(repo, metaFor('main', repo));
    await registerRepo(repo, metaFor('feature/x', repo), { branch: 'feature/x' });
    const branchesRoot = path.join(storagePath, 'branches');
    await fs.mkdir(branchesRoot, { recursive: true });
    const canonical = path.join(branchesRoot, branchSlug('feature/x'));
    await fs.writeFile(canonical, 'not-a-directory');
    const stray = path.join(branchesRoot, 'mystery-deadbeef');
    await saveMeta(stray, metaFor('feature/x', repo));
    vi.spyOn(process, 'cwd').mockReturnValue(repo);

    await cleanCommand({ stale: true, force: true });

    expect(logs.join('\n')).toContain(t('clean.stale.deleted', { branch: 'feature/x' }));
    expect(logs.join('\n')).toContain(t('clean.stale.probeFailed'));
    await expect(fs.access(stray)).rejects.toThrow();
    await expect(fs.readFile(canonical, 'utf8')).resolves.toBe('not-a-directory');
    const [entry] = await listRegisteredRepos();
    expect(entry.branches?.map((row) => row.branch)).toEqual(['feature/x']);
  });

  it('drops a registry-only row without requiring a directory', async () => {
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'README.md'), 'hi\n');
    commitAll(repo, 'init');
    await writeOwnedFlat(repo, storagePath);
    await registerRepo(repo, metaFor('main', repo));
    await registerRepo(repo, metaFor('feature/x', repo), { branch: 'feature/x' });
    vi.spyOn(process, 'cwd').mockReturnValue(repo);

    await cleanCommand({ stale: true, force: true });

    expect(logs.join('\n')).toContain(t('clean.stale.deleted', { branch: 'feature/x' }));
  });

  it('prints a none-found message when there are no leftover slots', async () => {
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'README.md'), 'hi\n');
    commitAll(repo, 'init');
    await writeOwnedFlat(repo, storagePath);
    await registerRepo(repo, metaFor('main', repo));
    vi.spyOn(process, 'cwd').mockReturnValue(repo);

    await cleanCommand({ stale: true });

    expect(logs.join('\n')).toContain(t('clean.stale.none'));
  });

  it('prefers the --stale arm when --branch is also set', async () => {
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'README.md'), 'hi\n');
    commitAll(repo, 'init');
    await writeOwnedFlat(repo, storagePath);
    await registerRepo(repo, metaFor('main', repo));
    vi.spyOn(process, 'cwd').mockReturnValue(repo);

    await cleanCommand({ stale: true, branch: 'feature/x' });

    expect(logs.join('\n')).toContain(t('clean.stale.none'));
    expect(logs.join('\n')).not.toContain('feature/x');
  });

  it('refuses --stale on a non-owned external storage path', async () => {
    const foreign = path.join(fixture.dbPath, 'foreign-index');
    const other = path.join(fixture.dbPath, 'other');
    await fs.mkdir(foreign, { recursive: true });
    await fs.mkdir(other, { recursive: true });
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'README.md'), 'hi\n');
    commitAll(repo, 'init');
    await saveMeta(foreign, {
      ...metaFor('main', other),
      storagePath: foreign,
    });
    await registerRepo(
      repo,
      { ...metaFor('main', repo), storagePath: foreign },
      {
        storagePath: foreign,
      },
    );
    const leftover = path.join(foreign, 'branches', branchSlug('feature/x'));
    await saveMeta(leftover, metaFor('feature/x', other));
    vi.spyOn(process, 'cwd').mockReturnValue(repo);

    await cleanCommand({ stale: true, force: true });

    await expect(fs.access(leftover)).resolves.toBeUndefined();
    expect(getStoragePaths(repo, undefined, foreign).storagePath).toBe(foreign);
    expect(logs.join('\n')).toMatch(/No indexed repository|Refusing to clean leftover/);
  });
});
