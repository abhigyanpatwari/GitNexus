import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pruneBranchesCommand, type PruneBranchesResult } from '../../src/cli/registry-prune.js';
import { branchSlug } from '../../src/storage/branch-index.js';
import * as gitModule from '../../src/storage/git.js';
import { acquireIndexLock } from '../../src/storage/index-lock.js';
import {
  listRegisteredRepos,
  registerRepo,
  saveMeta,
  unregisterRepo,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import * as staleModule from '../../src/storage/stale-branch-slots.js';
import { CLI_SPAWN_PREFIX } from '../helpers/cli-entry.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';

describe('registry prune-branches (#3332)', () => {
  let home: TestDBHandle;
  let fixture: TestDBHandle;
  let savedHome: string | undefined;
  let savedGitDir: string | undefined;
  let savedExitCode: typeof process.exitCode;

  beforeEach(async () => {
    home = await createTempDir('gitnexus-reg-prune-home-');
    fixture = await createTempDir('gitnexus-reg-prune-repo-');
    savedHome = process.env.GITNEXUS_HOME;
    savedGitDir = process.env.GIT_DIR;
    savedExitCode = process.exitCode;
    process.env.GITNEXUS_HOME = home.dbPath;
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    if (savedGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = savedGitDir;
    process.exitCode = savedExitCode;
    await fixture.cleanup();
    await home.cleanup();
  });

  async function seedBranches(
    opts: { deleted: string[]; live: string[]; unreadable?: string[] },
    repoDir = fixture.dbPath,
  ) {
    initGitRepo(repoDir);
    await fs.writeFile(path.join(repoDir, 'a.ts'), 'export const a = 1;\n');
    commitAll(repoDir, 'init');
    execFileSync('git', ['branch', '-M', 'main'], {
      cwd: repoDir,
      stdio: 'ignore',
      windowsHide: true,
    });

    const storagePath = path.join(repoDir, '.gitnexus');
    const meta = (branch: string): RepoMeta => ({
      repoPath: repoDir,
      lastCommit: 'aaa',
      indexedAt: '2026-10-01T00:00:00.000Z',
      branch,
      stats: { files: 1, nodes: 1 },
    });

    await saveMeta(storagePath, meta('main'));
    await registerRepo(repoDir, meta('main'));

    const dirs: Record<string, string> = {};
    for (const branch of [...opts.deleted, ...opts.live]) {
      execFileSync('git', ['branch', branch], {
        cwd: repoDir,
        stdio: 'ignore',
        windowsHide: true,
      });
      await registerRepo(repoDir, meta(branch), { branch });
      const dir = path.join(storagePath, 'branches', branchSlug(branch));
      await saveMeta(dir, meta(branch));
      dirs[branch] = dir;
    }

    for (const branch of opts.deleted) {
      execFileSync('git', ['branch', '-D', branch], {
        cwd: repoDir,
        stdio: 'ignore',
        windowsHide: true,
      });
    }

    for (const branch of opts.unreadable ?? []) {
      await registerRepo(repoDir, meta(branch), { branch });
      const branchesDir = path.join(storagePath, 'branches');
      await fs.mkdir(branchesDir, { recursive: true });
      const fileSlot = path.join(branchesDir, branchSlug(branch));
      await fs.writeFile(fileSlot, 'not-a-dir');
      dirs[branch] = fileSlot;
    }

    return { repo: repoDir, storagePath, dirs };
  }

  it('dry-run reports stale branches without mutating disk or registry.json', async () => {
    const { repo, dirs } = await seedBranches({
      deleted: ['feat/gone'],
      live: ['feat/live'],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await pruneBranchesCommand({ repo, dryRun: true, json: true });

    expect(result.registered).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.pruned).toEqual(['feat/gone']);
    expect(result.failed).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(result);

    await expect(fs.access(dirs['feat/gone'])).resolves.toBeUndefined();
    const [entry] = await listRegisteredRepos();
    expect(entry.branches?.map((b) => b.branch).sort()).toEqual(['feat/gone', 'feat/live']);
  });

  it('prunes deleted branch slots for --repo while keeping live branches', async () => {
    const { repo, dirs } = await seedBranches({
      deleted: ['feat/gone'],
      live: ['feat/live'],
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await pruneBranchesCommand({ repo, json: true });

    expect(result.registered).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.pruned).toEqual(['feat/gone']);
    expect(result.skippedLive).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(process.exitCode).toBeUndefined();

    await expect(fs.access(dirs['feat/gone'])).rejects.toThrow();
    await expect(fs.access(dirs['feat/live'])).resolves.toBeUndefined();
    const [entry] = await listRegisteredRepos();
    expect(entry.branches?.map((b) => b.branch)).toEqual(['feat/live']);
  });

  it('returns cleanly for an unindexed repository', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await pruneBranchesCommand({ repo: fixture.dbPath, json: true });

    expect(result).toEqual({
      repoPath: path.resolve(fixture.dbPath),
      registered: false,
      dryRun: false,
      pruned: [],
      skippedLive: [],
      failed: [],
      probeFailed: [],
    });
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(result);
  });

  it('ignores inherited GIT_DIR from another repository so live branches in --repo survive', async () => {
    const repoA = await createTempDir('gitnexus-reg-prune-other-');
    try {
      await seedBranches({ deleted: [], live: [] }, repoA.dbPath);
      const { repo: repoB, dirs: dirsB } = await seedBranches({
        deleted: [],
        live: ['feat/keep-b'],
      });
      process.env.GIT_DIR = path.join(repoA.dbPath, '.git');
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await pruneBranchesCommand({ repo: repoB, json: true });

      expect(result.pruned).toEqual([]);
      expect(result.failed).toEqual([]);
      await expect(fs.access(dirsB['feat/keep-b'])).resolves.toBeUndefined();
      const entries = await listRegisteredRepos();
      const entryB = entries.find((e) => e.path === repoB);
      expect(entryB?.branches?.map((b) => b.branch)).toEqual(['feat/keep-b']);
    } finally {
      await repoA.cleanup();
    }
  });

  it.each([true, false])(
    'reports a branch recreated before deletion (registered=%s)',
    async (registered) => {
      const { repo, dirs } = await seedBranches({
        deleted: ['feat/raced'],
        live: [],
      });
      if (!registered) await unregisterRepo(repo);
      const orig = gitModule.listLocalHeads;
      vi.spyOn(gitModule, 'listLocalHeads')
        .mockImplementationOnce((p, o) => orig(p, o))
        .mockReturnValueOnce(['main', 'feat/raced']);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await pruneBranchesCommand({ repo });

      expect(result.registered).toBe(registered);
      expect(result.pruned).toEqual([]);
      expect(result.skippedLive).toEqual(['feat/raced']);
      expect(process.exitCode).toBeUndefined();
      await expect(fs.access(dirs['feat/raced'])).resolves.toBeUndefined();
      const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('Skipped 1 live branch(es): feat/raced');
      expect(output).not.toContain('No stale branch indexes found.');
      expect(output).not.toContain('No GitNexus index found');
    },
  );

  it('records failed removals and sets process.exitCode = 1', async () => {
    const { repo } = await seedBranches({
      deleted: ['feat/fail'],
      live: [],
    });
    vi.spyOn(staleModule, 'removeBranchSlot').mockResolvedValueOnce({
      ok: false,
      emptiedBranchesDir: false,
      keptRegistry: true,
      error: new Error('rm failed'),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await pruneBranchesCommand({ repo, json: true });

    expect(result.pruned).toEqual([]);
    expect(result.failed).toEqual([{ branch: 'feat/fail', error: 'rm failed' }]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(result);
  });

  it('emits valid JSON with incomplete: true when git heads become unavailable mid-loop', async () => {
    const { repo } = await seedBranches({
      deleted: ['feat/a', 'feat/b'],
      live: [],
    });
    vi.spyOn(gitModule, 'listLocalHeads')
      .mockReturnValueOnce(['main'])
      .mockReturnValueOnce(['main'])
      .mockReturnValueOnce(null);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await pruneBranchesCommand({ repo, json: true });

    expect(result.pruned).toEqual(['feat/a']);
    expect(result.incomplete).toBe(true);
    expect(result.error).toBe('heads-unavailable');
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(result);
  });

  it('emits valid JSON and exits 1 when .git is missing pre-loop', async () => {
    const { repo } = await seedBranches({
      deleted: ['feat/gone'],
      live: [],
    });
    await fs.rm(path.join(repo, '.git'), { recursive: true, force: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await pruneBranchesCommand({ repo, json: true });

    expect(result.pruned).toEqual([]);
    expect(result.incomplete).toBe(true);
    expect(result.error).toBe('heads-unavailable');
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(result);
  });

  it('reports probe-failed branch slots in plain output instead of claiming none were found', async () => {
    const { repo } = await seedBranches({
      deleted: [],
      live: [],
      unreadable: ['feat/unreadable'],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await pruneBranchesCommand({ repo });

    expect(result.pruned).toEqual([]);
    expect(result.probeFailed).toEqual(['feat/unreadable']);
    expect(process.exitCode).toBe(1);
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Could not inspect 1 branch slot(s): feat/unreadable');
    expect(output).not.toContain('No stale branch indexes found.');
  });

  it('executes end-to-end via the CLI entrypoint', async () => {
    const { repo, dirs } = await seedBranches({
      deleted: ['feat/cli-gone'],
      live: [],
    });

    const proc = spawnSync(
      process.execPath,
      [...CLI_SPAWN_PREFIX, 'registry', 'prune-branches', '--repo', repo, '--json'],
      {
        encoding: 'utf8',
        env: { ...process.env, GITNEXUS_HOME: home.dbPath },
        windowsHide: true,
      },
    );

    expect(proc.status).toBe(0);
    const parsed = JSON.parse(proc.stdout) as PruneBranchesResult;
    expect(parsed.pruned).toEqual(['feat/cli-gone']);
    expect(parsed.failed).toEqual([]);
    await expect(fs.access(dirs['feat/cli-gone'])).rejects.toThrow();
    const [entry] = await listRegisteredRepos();
    expect(entry.branches).toBeUndefined();
  });

  it('fails closed when registry.json is corrupt instead of treating it as empty', async () => {
    const { repo, dirs } = await seedBranches({
      deleted: ['feat/gone'],
      live: [],
    });
    await fs.writeFile(path.join(home.dbPath, 'registry.json'), '{not-valid-json', 'utf8');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await pruneBranchesCommand({ repo, json: true });

    expect(result.incomplete).toBe(true);
    expect(result.pruned).toEqual([]);
    expect(result.error).toBeTruthy();
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(result);
    await expect(fs.access(dirs['feat/gone'])).resolves.toBeUndefined();
  });

  it('fails closed when storage metadata repoPath does not match the checkout', async () => {
    const { repo, storagePath, dirs } = await seedBranches({
      deleted: ['feat/gone'],
      live: [],
    });
    await saveMeta(storagePath, {
      repoPath: path.join(home.dbPath, 'some-other-repo'),
      lastCommit: 'aaa',
      indexedAt: '2026-10-01T00:00:00.000Z',
      branch: 'main',
      stats: { files: 1, nodes: 1 },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await pruneBranchesCommand({ repo, json: true });

    expect(result.incomplete).toBe(true);
    expect(result.pruned).toEqual([]);
    expect(result.error).toContain('does not match checkout');
    expect(process.exitCode).toBe(1);
    await expect(fs.access(dirs['feat/gone'])).resolves.toBeUndefined();
  });

  it('skips a slot whose index lock is held by an active analyzer', async () => {
    const { repo, dirs } = await seedBranches({
      deleted: ['feat/busy'],
      live: [],
    });
    const lock = await acquireIndexLock(dirs['feat/busy'], { timeoutMs: 100 });
    expect(lock.lockFree).not.toBe(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await pruneBranchesCommand({ repo, json: true });

      expect(result.pruned).toEqual([]);
      expect(result.skippedBusy).toEqual(['feat/busy']);
      expect(process.exitCode).toBe(1);
      await expect(fs.access(dirs['feat/busy'])).resolves.toBeUndefined();
      const [entry] = await listRegisteredRepos();
      expect(entry.branches?.map((b) => b.branch)).toEqual(['feat/busy']);
    } finally {
      lock.release();
    }
  });

  it('resolves and prunes a disposable linked worktree independently of its main checkout', async () => {
    const { repo: mainRepo, dirs: mainDirs } = await seedBranches({
      deleted: ['feat/main-gone'],
      live: [],
    });
    const wtHandle = await createTempDir('gitnexus-reg-prune-wt-');
    try {
      const wtDir = path.join(wtHandle.dbPath, 'wt');
      execFileSync('git', ['worktree', 'add', wtDir, '-b', 'wt-base'], {
        cwd: mainRepo,
        stdio: 'ignore',
        windowsHide: true,
      });
      const wtStorage = path.join(wtDir, '.gitnexus');
      const wtMeta = (branch: string): RepoMeta => ({
        repoPath: wtDir,
        lastCommit: 'bbb',
        indexedAt: '2026-10-01T00:00:00.000Z',
        branch,
        stats: { files: 1, nodes: 1 },
      });
      await saveMeta(wtStorage, wtMeta('wt-base'));
      await registerRepo(wtDir, wtMeta('wt-base'));
      await registerRepo(wtDir, wtMeta('feat/wt-gone'), { branch: 'feat/wt-gone' });
      const wtSlotDir = path.join(wtStorage, 'branches', branchSlug('feat/wt-gone'));
      await saveMeta(wtSlotDir, wtMeta('feat/wt-gone'));

      vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = await pruneBranchesCommand({ repo: wtDir, json: true });

      expect(result.pruned).toEqual(['feat/wt-gone']);
      expect(process.exitCode).toBeUndefined();
      await expect(fs.access(wtSlotDir)).rejects.toThrow();
      // Main checkout's stale slot must remain untouched.
      await expect(fs.access(mainDirs['feat/main-gone'])).resolves.toBeUndefined();
    } finally {
      execFileSync('git', ['worktree', 'prune'], {
        cwd: mainRepo,
        stdio: 'ignore',
        windowsHide: true,
      });
      await wtHandle.cleanup();
    }
  });
});
