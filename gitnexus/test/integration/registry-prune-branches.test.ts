import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pruneBranchesCommand } from '../../src/cli/registry.js';
import { branchSlug } from '../../src/storage/branch-index.js';
import {
  listRegisteredRepos,
  registerRepo,
  saveMeta,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';

describe('registry prune-branches (#3332)', () => {
  let home: TestDBHandle;
  let fixture: TestDBHandle;
  let savedHome: string | undefined;

  beforeEach(async () => {
    home = await createTempDir('gitnexus-reg-prune-home-');
    fixture = await createTempDir('gitnexus-reg-prune-repo-');
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

  async function seedBranches(opts: { deleted: string[]; live: string[] }) {
    const repo = fixture.dbPath;
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    commitAll(repo, 'init');
    execFileSync('git', ['branch', '-M', 'main'], {
      cwd: repo,
      stdio: 'ignore',
      windowsHide: true,
    });

    const storagePath = path.join(repo, '.gitnexus');
    const meta = (branch: string): RepoMeta => ({
      repoPath: repo,
      lastCommit: 'aaa',
      indexedAt: '2026-10-01T00:00:00.000Z',
      branch,
      stats: { files: 1, nodes: 1 },
    });

    await saveMeta(storagePath, meta('main'));
    await registerRepo(repo, meta('main'));

    const dirs: Record<string, string> = {};
    for (const branch of [...opts.deleted, ...opts.live]) {
      execFileSync('git', ['branch', branch], { cwd: repo, stdio: 'ignore', windowsHide: true });
      await registerRepo(repo, meta(branch), { branch });
      const dir = path.join(storagePath, 'branches', branchSlug(branch));
      await saveMeta(dir, meta(branch));
      dirs[branch] = dir;
    }

    for (const branch of opts.deleted) {
      execFileSync('git', ['branch', '-D', branch], {
        cwd: repo,
        stdio: 'ignore',
        windowsHide: true,
      });
    }

    return { repo, storagePath, dirs };
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
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(result);

    // Slot directory and registry entry must both remain untouched on dry-run.
    await expect(fs.access(dirs['feat/gone'])).resolves.toBeUndefined();
    const [entry] = await listRegisteredRepos();
    expect(entry.branches?.map((b) => b.branch).sort()).toEqual(['feat/gone', 'feat/live']);
  });

  it('prunes deleted branch slots under the registry lock while keeping live branches', async () => {
    const { repo, dirs } = await seedBranches({
      deleted: ['feat/gone'],
      live: ['feat/live'],
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Run from outside the repo (via --repo) to verify explicit repo targeting.
    const result = await pruneBranchesCommand({ repo, json: true });

    expect(result.registered).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.pruned).toEqual(['feat/gone']);
    expect(result.skippedLive).toEqual([]);
    expect(result.failed).toEqual([]);

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
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(result);
  });

  it('executes end-to-end via the built CLI binary', async () => {
    const { repo, dirs } = await seedBranches({
      deleted: ['feat/cli-gone'],
      live: [],
    });
    const cliPath = path.resolve(import.meta.dirname, '../../dist/cli/index.js');

    const stdout = execFileSync(
      process.execPath,
      [cliPath, 'registry', 'prune-branches', '--repo', repo, '--json'],
      {
        encoding: 'utf8',
        env: { ...process.env, GITNEXUS_HOME: home.dbPath },
        windowsHide: true,
      },
    );

    const parsed = JSON.parse(stdout);
    expect(parsed.pruned).toEqual(['feat/cli-gone']);
    expect(parsed.failed).toEqual([]);
    await expect(fs.access(dirs['feat/cli-gone'])).rejects.toThrow();
    const [entry] = await listRegisteredRepos();
    expect(entry.branches).toBeUndefined();
  });

  it('reports probe-failed branch slots in plain output instead of claiming none were found', async () => {
    const repo = fixture.dbPath;
    initGitRepo(repo);
    await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    commitAll(repo, 'init');
    execFileSync('git', ['branch', '-M', 'main'], {
      cwd: repo,
      stdio: 'ignore',
      windowsHide: true,
    });

    const storagePath = path.join(repo, '.gitnexus');
    const meta = (branch: string): RepoMeta => ({
      repoPath: repo,
      lastCommit: 'aaa',
      indexedAt: '2026-10-01T00:00:00.000Z',
      branch,
      stats: { files: 1, nodes: 1 },
    });

    await saveMeta(storagePath, meta('main'));
    await registerRepo(repo, meta('main'));
    await registerRepo(repo, meta('feat/unreadable'), { branch: 'feat/unreadable' });

    // Place a regular file at the slot path so probeDirectory classifies it as 'probe-failed'.
    const branchesDir = path.join(storagePath, 'branches');
    await fs.mkdir(branchesDir, { recursive: true });
    await fs.writeFile(path.join(branchesDir, branchSlug('feat/unreadable')), 'not-a-dir');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await pruneBranchesCommand({ repo });

    expect(result.pruned).toEqual([]);
    expect(result.probeFailed).toEqual(['feat/unreadable']);
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Could not inspect 1 branch slot(s): feat/unreadable');
    expect(output).not.toContain('No stale branch indexes found.');
  });
});
