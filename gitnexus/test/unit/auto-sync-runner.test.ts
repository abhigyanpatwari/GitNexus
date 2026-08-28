import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  addRepoToGroup,
  getAutoSyncRepoIdentity,
  getConfiguredRepoPath,
  getAutoSyncWatchPaths,
  readAutoSyncWatchStatus,
  resolveActualConcurrency,
  runAutoSyncOnce,
  startAutoSyncWatch,
  stopAutoSyncWatch,
} from '../../src/core/auto-sync/index.js';
import type {
  AutoSyncConfig,
  AutoSyncRunDeps,
  AutoSyncWatchPaths,
} from '../../src/core/auto-sync/index.js';

const config: AutoSyncConfig = {
  configPath: '/tmp/.gitnexus/watch_config.yml',
  syncIntervalMinutes: 10,
  repoGitTimeoutMs: 10_000,
  analyzeTimeoutMs: 1_800_000,
  maxConcurrency: 1,
  analyzeFailureThreshold: 3,
  projects: [
    {
      localPath: '/tmp/repos',
      groupName: 'back_end',
      overwriteLocalChanges: false,
      branches: ['master'],
      remoteUrls: ['git@gitee.com:qts_server/qts_account.git'],
    },
  ],
};

const cloneRoot = {
  root: '/tmp/repos',
  quarantineRoot: '/tmp/.gitnexus/watch/quarantine',
  quarantineRetentionDays: 14,
};
const verifiedWatchCommand = 'node /gitnexus/dist/cli/index.js watch';
const verifiedProcessStartTime = 'Tue Aug  4 12:00:00 2026';

function withCloneRoot(deps: Partial<AutoSyncRunDeps>): Partial<AutoSyncRunDeps> {
  return {
    resolveCloneRoot: vi.fn(async () => cloneRoot),
    ...deps,
  };
}

async function writeWatchOwner(
  paths: AutoSyncWatchPaths,
  pid: number,
  ownerId = `owner-${pid}`,
): Promise<string> {
  await fs.mkdir(path.dirname(paths.pidPath), { recursive: true });
  await fs.writeFile(paths.pidPath, `${pid}\n`);
  await fs.writeFile(
    paths.mutexPath,
    `${JSON.stringify({ pid, ownerId: `mutex-${ownerId}`, processStartTime: verifiedProcessStartTime, hostname: os.hostname() })}\n`,
  );
  await fs.writeFile(
    paths.ownerPath,
    `${JSON.stringify({ pid, ownerId, processStartTime: verifiedProcessStartTime, createdAt: '2026-06-30T00:00:00.000Z' })}\n`,
  );
  await fs.writeFile(
    paths.statusPath,
    `${JSON.stringify({
      state: 'running',
      pid,
      ownerId,
      updatedAt: '2026-06-30T00:00:00.000Z',
    })}\n`,
  );
  return ownerId;
}

describe('auto-sync runner', () => {
  it('runs clone, analyzes changed commits, registers the repo, and syncs changed groups', async () => {
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/gitee.com/qts_server/qts_account'),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runAnalysis: vi.fn(async () => ({ stats: { files: 1 } }) as any),
      registerRepo: vi.fn(async () => 'qts_account'),
      loadState: vi.fn(async () => ({
        '/tmp/repos/gitee.com/qts_server/qts_account|master': {
          codeCommitId: 'commit-1',
          analyzedCommitId: 'commit-1',
          lastAnalyzeStatus: 'success',
          lastSyncTime: '2026-01-01T00:00:00.000Z',
        },
      })),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => true),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    const result = await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => new Date('2026-06-30T00:00:00.000Z'),
    });

    expect(result).toEqual({ synced: 1, analyzed: 1, skippedAnalysis: 0, failed: 0 });
    expect(deps.cloneOrPull).toHaveBeenCalledWith(
      'git@gitee.com:qts_server/qts_account.git',
      '/tmp/repos/gitee.com/qts_server/qts_account',
      undefined,
      {
        allowedCloneRoot: '/tmp/repos',
        expectedRepoName: 'qts_account',
        quarantineRoot: '/tmp/.gitnexus/watch/quarantine',
        allowAutoSyncSsh: true,
        timeoutMs: 10_000,
        branch: 'master',
        overwriteLocalChanges: false,
      },
    );
    expect(deps.getCurrentBranch).toHaveBeenCalledWith(
      '/tmp/repos/gitee.com/qts_server/qts_account',
      10_000,
    );
    expect(deps.runAnalysis).toHaveBeenCalledWith(
      '/tmp/repos/gitee.com/qts_server/qts_account',
      { branch: 'master', skipAgentsMd: true, skipSkills: true },
      1_800_000,
      undefined,
      undefined,
      1,
    );
    expect(deps.registerRepo).toHaveBeenCalledWith(
      '/tmp/repos/gitee.com/qts_server/qts_account',
      expect.objectContaining({
        lastCommit: 'commit-2',
        branch: 'master',
        remoteUrl: 'git@gitee.com:qts_server/qts_account.git',
      }),
      { name: 'gitee.com/qts_server/qts_account' },
    );
    expect(deps.syncGroupByName).toHaveBeenCalledWith('back_end');
    expect(deps.writeCommitInfo).toHaveBeenCalledWith([
      expect.objectContaining({
        remoteUrl: 'git@gitee.com:qts_server/qts_account.git',
        codeCommitId: 'commit-2',
        analyzedCommitId: 'commit-2',
        status: 'success',
      }),
    ]);
  });

  it('registers into the branch slot the analyze worker placed the index in', async () => {
    // Without this the parent always takes the primary/flat arm and relabels a
    // pinned branch entry with whatever this tick happened to sync.
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/gitee.com/qts_server/qts_account'),
      getCurrentBranch: vi.fn(async () => 'master'),
      getCurrentCommit: vi.fn(async () => 'commit-2'),
      runAnalysis: vi.fn(async () => ({ stats: { files: 1 } }) as any),
      registerRepo: vi.fn(async () => 'qts_account'),
      resolveBranchPlacement: vi.fn(async () => ({ branch: 'master' })),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => true),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => new Date('2026-06-30T00:00:00.000Z'),
    });

    expect(deps.resolveBranchPlacement).toHaveBeenCalledWith(
      '/tmp/repos/gitee.com/qts_server/qts_account',
      'master',
    );
    expect(deps.registerRepo).toHaveBeenCalledWith(
      '/tmp/repos/gitee.com/qts_server/qts_account',
      expect.anything(),
      { name: 'gitee.com/qts_server/qts_account', branch: 'master' },
    );
  });

  it('syncs a group when a repo is newly added to the group', async () => {
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/gitee.com/qts_server/qts_account'),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runAnalysis: vi.fn(async () => ({ stats: { files: 1 } }) as any),
      registerRepo: vi.fn(async () => 'qts_account'),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => true),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(deps.addRepoToGroup).toHaveBeenCalledWith(
      config.projects[0],
      'gitee.com/qts_server/qts_account',
      'gitee.com/qts_server/qts_account',
    );
    expect(deps.syncGroupByName).toHaveBeenCalledWith('back_end');
  });

  it('syncs a group after successful re-analysis even when membership already exists', async () => {
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/gitee.com/qts_server/qts_account'),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-3'),
      runAnalysis: vi.fn(async () => ({ stats: { files: 2 } }) as any),
      registerRepo: vi.fn(async () => 'qts_account'),
      loadState: vi.fn(async () => ({
        '/tmp/repos/gitee.com/qts_server/qts_account|master': {
          codeCommitId: 'commit-2',
          analyzedCommitId: 'commit-2',
          lastAnalyzeStatus: 'success',
          lastSyncTime: '2026-01-01T00:00:00.000Z',
        },
      })),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    const result = await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(result.analyzed).toBe(1);
    expect(deps.addRepoToGroup).toHaveBeenCalledWith(
      config.projects[0],
      'gitee.com/qts_server/qts_account',
      'gitee.com/qts_server/qts_account',
    );
    expect(deps.syncGroupByName).toHaveBeenCalledWith('back_end');
  });

  it('uses distinct registry and group identities for repositories with the same basename', async () => {
    const duplicateConfig: AutoSyncConfig = {
      ...config,
      projects: [
        {
          localPath: '/tmp/repos-a',
          groupName: 'back_end',
          branches: ['main'],
          remoteUrls: ['git@github.com:team-a/service.git'],
        },
        {
          localPath: '/tmp/repos-b',
          groupName: 'back_end',
          branches: ['main'],
          remoteUrls: ['git@gitlab.com:team-b/service.git'],
        },
      ],
    };
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      resolveCloneRoot: vi.fn(async (localPath: string) => ({
        ...cloneRoot,
        root: localPath,
      })),
      cloneOrPull: vi.fn(async (_url, targetDir) => targetDir),
      getCurrentBranch: vi.fn(() => 'main'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runAnalysis: vi.fn(async () => ({ stats: { files: 1 } }) as any),
      registerRepo: vi.fn(async () => 'service'),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => true),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    await runAutoSyncOnce(duplicateConfig, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(deps.registerRepo).toHaveBeenNthCalledWith(
      1,
      '/tmp/repos-a/github.com/team-a/service',
      expect.anything(),
      { name: 'github.com/team-a/service' },
    );
    expect(deps.registerRepo).toHaveBeenNthCalledWith(
      2,
      '/tmp/repos-b/gitlab.com/team-b/service',
      expect.anything(),
      { name: 'gitlab.com/team-b/service' },
    );
    expect(deps.addRepoToGroup).toHaveBeenCalledWith(
      duplicateConfig.projects[0],
      'github.com/team-a/service',
      'github.com/team-a/service',
    );
    expect(deps.addRepoToGroup).toHaveBeenCalledWith(
      duplicateConfig.projects[1],
      'gitlab.com/team-b/service',
      'gitlab.com/team-b/service',
    );
  });

  it('normalizes the .git suffix case in auto-sync repository identities', () => {
    expect(getAutoSyncRepoIdentity('git@GitHub.com:team/service.GIT')).toBe(
      'github.com/team/service',
    );
  });

  it('skips analysis when commit id has not changed', async () => {
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/gitee.com/qts_server/qts_account'),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-1'),
      runAnalysis: vi.fn(),
      registerRepo: vi.fn(),
      loadState: vi.fn(async () => ({
        '/tmp/repos/gitee.com/qts_server/qts_account|master': {
          codeCommitId: 'commit-1',
          analyzedCommitId: 'commit-1',
          lastAnalyzeStatus: 'success',
          lastSyncTime: '2026-01-01T00:00:00.000Z',
        },
      })),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => true),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    const result = await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(result.analyzed).toBe(0);
    expect(result.skippedAnalysis).toBe(1);
    expect(deps.runAnalysis).not.toHaveBeenCalled();
    expect(deps.syncGroupByName).toHaveBeenCalledWith('back_end');
  });

  it('retries a failed group sync on the next unchanged commit without re-analysis', async () => {
    let persistedState: any = {
      '/tmp/repos/gitee.com/qts_server/qts_account|master': {
        codeCommitId: 'commit-1',
        analyzedCommitId: 'commit-1',
        lastAnalyzeStatus: 'success',
        groupSyncPending: true,
        lastSyncTime: '2026-01-01T00:00:00.000Z',
      },
    };
    const syncGroupByName = vi
      .fn()
      .mockRejectedValueOnce(new Error('group temporarily unavailable'))
      .mockResolvedValueOnce(undefined);
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/gitee.com/qts_server/qts_account'),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-1'),
      runAnalysis: vi.fn(),
      registerRepo: vi.fn(),
      loadState: vi.fn(async () => structuredClone(persistedState)),
      saveState: vi.fn(async (state) => {
        persistedState = structuredClone(state);
      }),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName,
      getAvailableMemoryGB: vi.fn(() => 8),
    });
    const runOptions = {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    const first = await runAutoSyncOnce(config, runOptions);
    const second = await runAutoSyncOnce(config, runOptions);

    expect(first.failed).toBe(1);
    expect(second.failed).toBe(0);
    expect(deps.runAnalysis).not.toHaveBeenCalled();
    expect(syncGroupByName).toHaveBeenCalledTimes(2);
    expect(
      persistedState['/tmp/repos/gitee.com/qts_server/qts_account|master'].groupSyncPending,
    ).toBe(false);
  });

  it('uses remote identity under local_path as the clone target', async () => {
    expect(
      getConfiguredRepoPath(
        config.projects[0],
        'qts_account',
        'git@gitee.com:qts_server/qts_account.git',
      ),
    ).toBe('/tmp/repos/gitee.com/qts_server/qts_account');

    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/gitee.com/qts_server/qts_account'),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runAnalysis: vi.fn(async () => ({ stats: { files: 1 } }) as any),
      registerRepo: vi.fn(async () => 'qts_account'),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(deps.cloneOrPull).toHaveBeenCalledWith(
      'git@gitee.com:qts_server/qts_account.git',
      '/tmp/repos/gitee.com/qts_server/qts_account',
      undefined,
      {
        allowedCloneRoot: '/tmp/repos',
        expectedRepoName: 'qts_account',
        quarantineRoot: '/tmp/.gitnexus/watch/quarantine',
        allowAutoSyncSsh: true,
        timeoutMs: 10_000,
        branch: 'master',
        overwriteLocalChanges: false,
      },
    );
  });

  it('passes watch cancellation controls to the isolated analysis runner', async () => {
    const controller = new AbortController();
    const onAnalysisCancellationRequested = vi.fn();
    const runAnalysis = vi.fn(async () => ({ stats: { files: 1 } }) as any);
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/gitee.com/qts_server/qts_account'),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runAnalysis,
      registerRepo: vi.fn(async () => 'qts_account'),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      signal: controller.signal,
      onAnalysisCancellationRequested,
    });

    expect(runAnalysis).toHaveBeenCalledWith(
      '/tmp/repos/gitee.com/qts_server/qts_account',
      { branch: 'master', skipAgentsMd: true, skipSkills: true },
      1_800_000,
      controller.signal,
      onAnalysisCancellationRequested,
      1,
    );
  });

  it('falls back through configured branches and analyzes the first pullable branch', async () => {
    const warnLogger = vi.fn();
    const errorLogger = vi.fn();
    const branchConfig: AutoSyncConfig = {
      ...config,
      projects: [{ ...config.projects[0], branches: ['missing', 'develop'] }],
    };
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async (_remoteUrl, _targetDir, _progress, options) => {
        if (options?.branch === 'missing') throw new Error('remote branch not found');
        return '/tmp/repos/gitee.com/qts_server/qts_account';
      }),
      getCurrentBranch: vi.fn(() => 'develop'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runAnalysis: vi.fn(async () => ({ stats: { files: 1 } }) as any),
      registerRepo: vi.fn(async () => 'qts_account'),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    const result = await runAutoSyncOnce(branchConfig, {
      deps,
      logger: { info: vi.fn(), warn: warnLogger, error: errorLogger },
    });

    expect(result).toEqual({ synced: 1, analyzed: 1, skippedAnalysis: 0, failed: 0 });
    expect(deps.cloneOrPull).toHaveBeenNthCalledWith(
      1,
      'git@gitee.com:qts_server/qts_account.git',
      '/tmp/repos/gitee.com/qts_server/qts_account',
      undefined,
      expect.objectContaining({ branch: 'missing' }),
    );
    expect(deps.cloneOrPull).toHaveBeenNthCalledWith(
      2,
      'git@gitee.com:qts_server/qts_account.git',
      '/tmp/repos/gitee.com/qts_server/qts_account',
      undefined,
      expect.objectContaining({ branch: 'develop' }),
    );
    expect(deps.runAnalysis).toHaveBeenCalledWith(
      '/tmp/repos/gitee.com/qts_server/qts_account',
      { branch: 'develop', skipAgentsMd: true, skipSkills: true },
      1_800_000,
      undefined,
      undefined,
      1,
    );
    expect(warnLogger).toHaveBeenCalledWith(
      '[auto-sync] Branch missing unavailable for git@gitee.com:qts_server/qts_account.git: remote branch not found',
    );
    expect(errorLogger).not.toHaveBeenCalled();
  });

  it('records branch_unavailable when all configured branches fail', async () => {
    const warnLogger = vi.fn();
    const errorLogger = vi.fn();
    const branchConfig: AutoSyncConfig = {
      ...config,
      projects: [{ ...config.projects[0], branches: ['missing', 'develop'] }],
    };
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => {
        throw new Error('remote branch not found');
      }),
      getCurrentBranch: vi.fn(),
      getCurrentCommit: vi.fn(),
      runAnalysis: vi.fn(),
      registerRepo: vi.fn(),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    const result = await runAutoSyncOnce(branchConfig, {
      deps,
      logger: { info: vi.fn(), warn: warnLogger, error: errorLogger },
      now: () => new Date('2026-06-30T00:00:00.000Z'),
    });

    expect(result).toEqual({ synced: 0, analyzed: 0, skippedAnalysis: 0, failed: 1 });
    expect(deps.cloneOrPull).toHaveBeenCalledTimes(2);
    expect(deps.writeCommitInfo).toHaveBeenCalledWith([
      expect.objectContaining({
        branch: 'missing',
        status: 'branch_unavailable',
      }),
    ]);
    expect(deps.getCurrentCommit).not.toHaveBeenCalled();
    expect(warnLogger).toHaveBeenCalledTimes(2);
    expect(warnLogger).toHaveBeenCalledWith(
      '[auto-sync] Branch missing unavailable for git@gitee.com:qts_server/qts_account.git: remote branch not found',
    );
    expect(warnLogger).toHaveBeenCalledWith(
      '[auto-sync] Branch develop unavailable for git@gitee.com:qts_server/qts_account.git: remote branch not found',
    );
    expect(errorLogger).toHaveBeenCalledTimes(1);
    expect(errorLogger).toHaveBeenCalledWith(
      '[auto-sync] Repository sync failed for git@gitee.com:qts_server/qts_account.git; no configured branch could be pulled: missing: remote branch not found; develop: remote branch not found',
    );
  });

  it('records branch_unavailable when checkout ends on an unexpected branch', async () => {
    const warnLogger = vi.fn();
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/gitee.com/qts_server/qts_account'),
      getCurrentBranch: vi.fn(() => 'develop'),
      getCurrentCommit: vi.fn(),
      runAnalysis: vi.fn(),
      registerRepo: vi.fn(),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => true),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    const result = await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: warnLogger, error: vi.fn() },
    });

    expect(result).toEqual({ synced: 0, analyzed: 0, skippedAnalysis: 0, failed: 1 });
    expect(deps.getCurrentCommit).not.toHaveBeenCalled();
    expect(deps.runAnalysis).not.toHaveBeenCalled();
    expect(deps.addRepoToGroup).not.toHaveBeenCalled();
    expect(warnLogger).toHaveBeenCalledWith(
      '[auto-sync] Branch master for git@gitee.com:qts_server/qts_account.git synced but current branch is develop; trying next branch.',
    );
  });

  it('records branch_unavailable when the checked out repository is detached', async () => {
    const warnLogger = vi.fn();
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/gitee.com/qts_server/qts_account'),
      getCurrentBranch: vi.fn(() => undefined),
      getCurrentCommit: vi.fn(),
      runAnalysis: vi.fn(),
      registerRepo: vi.fn(),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => true),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    const result = await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: warnLogger, error: vi.fn() },
    });

    expect(result).toEqual({ synced: 0, analyzed: 0, skippedAnalysis: 0, failed: 1 });
    expect(deps.getCurrentCommit).not.toHaveBeenCalled();
    expect(deps.runAnalysis).not.toHaveBeenCalled();
    expect(deps.addRepoToGroup).not.toHaveBeenCalled();
    expect(warnLogger).toHaveBeenCalledWith(
      '[auto-sync] Branch master for git@gitee.com:qts_server/qts_account.git synced but current branch is <detached>; trying next branch.',
    );
  });

  it('isolates repository and analysis failures without syncing groups for failed analysis', async () => {
    const errorLogger = vi.fn();
    const failingConfig: AutoSyncConfig = {
      ...config,
      projects: [
        {
          ...config.projects[0],
          remoteUrls: [
            'git@gitee.com:qts_server/failing_sync.git',
            'git@gitee.com:qts_server/qts_account.git',
          ],
        },
      ],
    };
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async (remoteUrl) => {
        if (remoteUrl.includes('failing_sync')) throw new Error('sync failed');
        return '/tmp/repos/gitee.com/qts_server/qts_account';
      }),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runAnalysis: vi.fn(async () => {
        throw new Error('analysis failed');
      }),
      registerRepo: vi.fn(),
      loadState: vi.fn(async () => ({
        '/tmp/repos/gitee.com/qts_server/qts_account|master': {
          codeCommitId: 'commit-1',
          analyzedCommitId: 'commit-1',
          lastAnalyzeStatus: 'success',
          groupSyncPending: true,
          lastSyncTime: '2026-06-29T00:00:00.000Z',
        },
      })),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => true),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    const result = await runAutoSyncOnce(failingConfig, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: errorLogger },
      now: () => new Date('2026-06-30T00:00:00.000Z'),
    });

    expect(result).toEqual({ synced: 1, analyzed: 0, skippedAnalysis: 0, failed: 2 });
    expect(deps.cloneOrPull).toHaveBeenCalledTimes(2);
    expect(deps.registerRepo).not.toHaveBeenCalled();
    expect(deps.addRepoToGroup).toHaveBeenCalledWith(
      failingConfig.projects[0],
      'gitee.com/qts_server/qts_account',
      'gitee.com/qts_server/qts_account',
    );
    expect(deps.syncGroupByName).not.toHaveBeenCalled();
    expect(deps.saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        '/tmp/repos/gitee.com/qts_server/qts_account|master': expect.objectContaining({
          codeCommitId: 'commit-2',
          lastAnalyzeStatus: 'failed',
        }),
      }),
    );
    expect(errorLogger).toHaveBeenCalledWith(
      expect.stringContaining(
        'Repository sync failed for git@gitee.com:qts_server/failing_sync.git',
      ),
    );
    expect(errorLogger).toHaveBeenCalledWith(
      expect.stringContaining('Analysis failed for /tmp/repos/gitee.com/qts_server/qts_account'),
    );
  });

  it('records the resolved target directory when a post-sync operation fails', async () => {
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async (_url, targetDir) => targetDir),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => {
        throw new Error('git log failed');
      }),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    await expect(
      runAutoSyncOnce(config, {
        deps,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      }),
    ).resolves.toEqual({ synced: 0, analyzed: 0, skippedAnalysis: 0, failed: 1 });

    expect(deps.writeCommitInfo).toHaveBeenCalledWith([
      expect.objectContaining({
        remoteUrl: 'git@gitee.com:qts_server/qts_account.git',
        localPath: '/tmp/repos/gitee.com/qts_server/qts_account',
        status: 'sync_failed',
      }),
    ]);
  });

  it('isolates clone-root resolution failures to the affected project', async () => {
    const isolatedConfig: AutoSyncConfig = {
      ...config,
      projects: [
        { ...config.projects[0], localPath: '/bad/repos' },
        { ...config.projects[0], localPath: '/tmp/repos' },
      ],
    };
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      resolveCloneRoot: vi.fn(async (localPath: string) => {
        if (localPath === '/bad/repos') throw new Error('unsafe clone root');
        return cloneRoot;
      }),
      cloneOrPull: vi.fn(async (_url, targetDir) => targetDir),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runAnalysis: vi.fn(async () => ({ stats: { files: 1 } }) as any),
      registerRepo: vi.fn(async () => 'repo'),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    await expect(
      runAutoSyncOnce(isolatedConfig, {
        deps,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      }),
    ).resolves.toEqual({ synced: 1, analyzed: 1, skippedAnalysis: 0, failed: 1 });
    expect(deps.cloneOrPull).toHaveBeenCalledTimes(1);
    expect(deps.saveState).toHaveBeenCalledTimes(1);
    expect(deps.writeCommitInfo).toHaveBeenCalledTimes(1);
  });

  it('persists state and commit info when repository registration fails', async () => {
    const errorLogger = vi.fn();
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async (_url, targetDir) => targetDir),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runAnalysis: vi.fn(async () => ({ stats: { files: 1 } }) as any),
      registerRepo: vi.fn(async () => {
        throw new Error('registry busy');
      }),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    const result = await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: errorLogger },
      now: () => new Date('2026-06-30T00:00:00.000Z'),
    });

    expect(result).toEqual({ synced: 1, analyzed: 0, skippedAnalysis: 0, failed: 1 });
    expect(deps.saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        '/tmp/repos/gitee.com/qts_server/qts_account|master': expect.objectContaining({
          lastAnalyzeStatus: 'failed',
          analyzedCommitId: undefined,
          lastAnalyzeError: 'Repository registration failed: registry busy',
        }),
      }),
    );
    expect(deps.writeCommitInfo).toHaveBeenCalledTimes(1);
    expect(errorLogger).toHaveBeenCalledWith(
      '[auto-sync] Repository registration failed: registry busy',
    );
  });

  it('reports group sync failures after successful analysis', async () => {
    const errorLogger = vi.fn();
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/gitee.com/qts_server/qts_account'),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runAnalysis: vi.fn(async () => ({ stats: { files: 1 } }) as any),
      registerRepo: vi.fn(async () => 'qts_account'),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName: vi.fn(async () => {
        throw new Error('group sync failed');
      }),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    const result = await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: errorLogger },
    });

    expect(result).toEqual({ synced: 1, analyzed: 1, skippedAnalysis: 0, failed: 1 });
    expect(deps.addRepoToGroup).toHaveBeenCalledWith(
      config.projects[0],
      'gitee.com/qts_server/qts_account',
      'gitee.com/qts_server/qts_account',
    );
    expect(deps.syncGroupByName).toHaveBeenCalledWith('back_end');
    expect(errorLogger).toHaveBeenCalledWith(
      expect.stringContaining('Group sync failed for back_end'),
    );
  });

  it('caps actual concurrency by available memory and runs clone/analyze work concurrently', async () => {
    const events: string[] = [];
    let releaseFirstClone: (() => void) | undefined;
    const concurrentConfig: AutoSyncConfig = {
      ...config,
      maxConcurrency: 4,
      projects: [
        {
          ...config.projects[0],
          groupName: undefined,
          remoteUrls: ['git@github.com:owner/one.git', 'git@gitlab.com:owner/two.git'],
        },
      ],
    };
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async (remoteUrl) => {
        events.push(`clone-start:${remoteUrl}`);
        if (remoteUrl.includes('/one.git')) {
          await new Promise<void>((resolve) => {
            releaseFirstClone = resolve;
            setTimeout(resolve, 0);
          });
        } else {
          releaseFirstClone?.();
        }
        events.push(`clone-end:${remoteUrl}`);
        return remoteUrl.includes('/one.git') ? '/tmp/repos/one' : '/tmp/repos/two';
      }),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn((repoPath) =>
        repoPath.endsWith('/one') ? 'one-commit' : 'two-commit',
      ),
      runAnalysis: vi.fn(async () => ({ stats: { files: 1 } }) as any),
      registerRepo: vi.fn(async () => 'repo'),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 4),
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await runAutoSyncOnce(concurrentConfig, { deps, logger });

    expect(result.synced).toBe(2);
    expect(logger.info).toHaveBeenCalledWith(
      '[auto-sync] Starting sync loop with max_concurrency=2 analyze_failure_threshold=3.',
    );
    expect(events.slice(0, 2)).toEqual([
      'clone-start:git@github.com:owner/one.git',
      'clone-start:git@gitlab.com:owner/two.git',
    ]);
    expect(deps.registerRepo).toHaveBeenCalledTimes(2);
    expect(deps.saveState).toHaveBeenCalledTimes(1);
    expect(deps.writeCommitInfo).toHaveBeenCalledTimes(1);
  });

  it('keeps same-basename remotes in distinct clone directories', async () => {
    const duplicateConfig: AutoSyncConfig = {
      ...config,
      maxConcurrency: 2,
      projects: [
        {
          ...config.projects[0],
          branches: ['main'],
          remoteUrls: ['git@github.com:owner/repo.git', 'git@gitlab.com:group/repo.git'],
        },
      ],
    };
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async (_url, targetDir) => targetDir),
      getCurrentBranch: vi.fn(() => 'main'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runAnalysis: vi.fn(async () => ({ stats: { files: 1 } }) as any),
      registerRepo: vi.fn(async (_path, _meta, options) => options?.name ?? 'repo'),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    await expect(
      runAutoSyncOnce(duplicateConfig, {
        deps,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      }),
    ).resolves.toEqual({ synced: 2, analyzed: 2, skippedAnalysis: 0, failed: 0 });

    expect(deps.cloneOrPull).toHaveBeenNthCalledWith(
      1,
      'git@github.com:owner/repo.git',
      '/tmp/repos/github.com/owner/repo',
      undefined,
      expect.any(Object),
    );
    expect(deps.cloneOrPull).toHaveBeenNthCalledWith(
      2,
      'git@gitlab.com:group/repo.git',
      '/tmp/repos/gitlab.com/group/repo',
      undefined,
      expect.any(Object),
    );
    expect(deps.saveState).toHaveBeenCalledTimes(1);
    expect(deps.writeCommitInfo).toHaveBeenCalledTimes(1);
  });

  it('rejects non auto-sync SSH URLs at runner boundary', async () => {
    const invalidConfig: AutoSyncConfig = {
      ...config,
      projects: [{ ...config.projects[0], remoteUrls: ['https://github.com/owner/repo.git'] }],
    };
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    const result = await runAutoSyncOnce(invalidConfig, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(result.failed).toBe(1);
    expect(deps.cloneOrPull).not.toHaveBeenCalled();
  });

  it('increments analyze failure count and writes threshold details', async () => {
    const errorLogger = vi.fn();
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/gitee.com/qts_server/qts_account'),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runAnalysis: vi.fn(async () => {
        throw new Error('parser crashed\nwith stack');
      }),
      registerRepo: vi.fn(),
      loadState: vi.fn(async () => ({
        '/tmp/repos/gitee.com/qts_server/qts_account|master': {
          codeCommitId: 'commit-1',
          analyzedCommitId: 'commit-1',
          lastAnalyzeStatus: 'failed',
          analyzeConsecutiveFailures: 1,
          lastAnalyzeError: 'old error',
          lastSyncTime: '2026-01-01T00:00:00.000Z',
        },
      })),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    const result = await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: errorLogger },
      now: () => new Date('2026-06-30T00:00:00.000Z'),
    });

    expect(result).toEqual({ synced: 1, analyzed: 0, skippedAnalysis: 0, failed: 1 });
    expect(deps.saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        '/tmp/repos/gitee.com/qts_server/qts_account|master': expect.objectContaining({
          analyzeConsecutiveFailures: 1,
          lastAnalyzeError: 'parser crashed with stack',
          lastAnalyzeStatus: 'failed',
        }),
      }),
    );
    expect(deps.writeCommitInfo).toHaveBeenCalledWith([
      expect.objectContaining({
        status: 'failed',
        analyzeConsecutiveFailures: 1,
        analyzeFailureThreshold: 3,
        lastAnalyzeError: 'parser crashed with stack',
      }),
    ]);
    expect(errorLogger).toHaveBeenCalledWith(
      '[auto-sync] Analysis failed for /tmp/repos/gitee.com/qts_server/qts_account; consecutive failures 1/3: parser crashed with stack',
    );
  });

  it('records a null analysis failure without masking it with a TypeError', async () => {
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/gitee.com/qts_server/qts_account'),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runAnalysis: vi.fn(async () => {
        throw null;
      }),
      registerRepo: vi.fn(),
      loadState: vi.fn(async () => ({})),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    await expect(
      runAutoSyncOnce(config, {
        deps,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        now: () => new Date('2026-06-30T00:00:00.000Z'),
      }),
    ).resolves.toEqual({ synced: 1, analyzed: 0, skippedAnalysis: 0, failed: 1 });

    expect(deps.saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        '/tmp/repos/gitee.com/qts_server/qts_account|master': expect.objectContaining({
          lastAnalyzeError: 'null',
        }),
      }),
    );
  });

  it('retries analysis on a new commit after consecutive failures reached the threshold', async () => {
    const errorLogger = vi.fn();
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/gitee.com/qts_server/qts_account'),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runAnalysis: vi.fn(async () => ({ stats: { files: 1 } }) as any),
      registerRepo: vi.fn(async () => 'qts_account'),
      loadState: vi.fn(async () => ({
        '/tmp/repos/gitee.com/qts_server/qts_account|master': {
          codeCommitId: 'commit-1',
          analyzedCommitId: 'commit-1',
          lastAnalyzeStatus: 'failed',
          analyzeConsecutiveFailures: 3,
          lastAnalyzeError: 'parser crashed',
          lastSyncTime: '2026-01-01T00:00:00.000Z',
        },
      })),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    const result = await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: errorLogger },
      now: () => new Date('2026-06-30T00:00:00.000Z'),
    });

    expect(result).toEqual({ synced: 1, analyzed: 1, skippedAnalysis: 0, failed: 0 });
    expect(deps.runAnalysis).toHaveBeenCalledTimes(1);
    expect(deps.saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        '/tmp/repos/gitee.com/qts_server/qts_account|master': expect.objectContaining({
          analyzeConsecutiveFailures: 0,
          lastAnalyzeError: undefined,
          lastAnalyzeStatus: 'success',
        }),
      }),
    );
    expect(deps.writeCommitInfo).toHaveBeenCalledWith([
      expect.objectContaining({
        status: 'success',
        analyzeConsecutiveFailures: 0,
        analyzeFailureThreshold: 3,
        lastAnalyzeError: undefined,
      }),
    ]);
    expect(errorLogger).not.toHaveBeenCalled();
  });

  it('clears prior analyze failure count after a successful analyze', async () => {
    const deps: Partial<AutoSyncRunDeps> = withCloneRoot({
      cloneOrPull: vi.fn(async () => '/tmp/repos/gitee.com/qts_server/qts_account'),
      getCurrentBranch: vi.fn(() => 'master'),
      getCurrentCommit: vi.fn(() => 'commit-2'),
      runAnalysis: vi.fn(async () => ({ stats: { files: 1 } }) as any),
      registerRepo: vi.fn(async () => 'qts_account'),
      loadState: vi.fn(async () => ({
        '/tmp/repos/gitee.com/qts_server/qts_account|master': {
          codeCommitId: 'commit-1',
          analyzedCommitId: 'commit-1',
          lastAnalyzeStatus: 'failed',
          analyzeConsecutiveFailures: 2,
          lastAnalyzeError: 'old error',
          lastSyncTime: '2026-01-01T00:00:00.000Z',
        },
      })),
      saveState: vi.fn(async () => {}),
      writeCommitInfo: vi.fn(async () => {}),
      addRepoToGroup: vi.fn(async () => false),
      syncGroupByName: vi.fn(async () => {}),
      getAvailableMemoryGB: vi.fn(() => 8),
    });

    const result = await runAutoSyncOnce(config, {
      deps,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => new Date('2026-06-30T00:00:00.000Z'),
    });

    expect(result.analyzed).toBe(1);
    expect(deps.saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        '/tmp/repos/gitee.com/qts_server/qts_account|master': expect.objectContaining({
          analyzeConsecutiveFailures: 0,
          lastAnalyzeError: undefined,
          lastAnalyzeStatus: 'success',
        }),
      }),
    );
  });

  it('resolves actual concurrency from configured value and memory', () => {
    expect(resolveActualConcurrency(8, 10)).toBe(5);
    expect(resolveActualConcurrency(8, 1)).toBe(1);
    expect(resolveActualConcurrency(2, 10)).toBe(2);
  });

  it('detects existing groupPath to registryName mappings as already joined', async () => {
    const previousHome = process.env.GITNEXUS_HOME;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-group-'));
    try {
      process.env.GITNEXUS_HOME = tempDir;
      const groupDir = path.join(tempDir, 'groups', 'back_end');
      await fs.mkdir(groupDir, { recursive: true });
      await fs.writeFile(
        path.join(groupDir, 'group.yaml'),
        ['version: 1', 'name: back_end', 'repos:', '  hr/hiring/backend: qts_account'].join('\n'),
      );

      await expect(
        addRepoToGroup({ groupName: 'back_end' }, 'hr/hiring/backend', 'qts_account'),
      ).resolves.toBe(false);

      await expect(fs.readFile(path.join(groupDir, 'group.yaml'), 'utf-8')).resolves.toContain(
        'hr/hiring/backend: qts_account',
      );
    } finally {
      if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = previousHome;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('auto-sync starter', () => {
  it('registers a clearable timer with a valid fixed config', async () => {
    const previousHome = process.env.GITNEXUS_HOME;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-starter-'));
    const timer = { unref: vi.fn() };
    const setIntervalFn = vi.fn(() => timer) as unknown as typeof setInterval;
    const clearIntervalFn = vi.fn() as unknown as typeof clearInterval;
    const runOnce = vi.fn(async () => ({ synced: 0, analyzed: 0, skippedAnalysis: 0, failed: 0 }));
    const stderr = { write: vi.fn() };

    try {
      process.env.GITNEXUS_HOME = tempDir;
      await fs.writeFile(
        path.join(tempDir, 'watch_config.yml'),
        [
          'sync_interval_minutes: 5',
          'projects:',
          '  - local_path: /tmp/repos',
          '    group_name: back_end',
          '    branch: master',
          '    remote_urls:',
          '      - git@gitee.com:qts_server/qts_account.git',
        ].join('\n'),
      );

      const handle = await startAutoSyncWatch({
        setIntervalFn,
        clearIntervalFn,
        runOnce,
        stderr,
        keepAlive: false,
        deps: { isProcessAlive: vi.fn(() => false) },
      });

      expect(handle).not.toBeNull();
      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 300_000);
      expect(timer.unref).toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(stderr.write).toHaveBeenCalledWith(
          expect.stringContaining('[auto-sync] Watch loop started at '),
        );
        expect(stderr.write).toHaveBeenCalledWith(
          '[auto-sync] Watch loop finished: synced=0 analyzed=0 skipped=0 failed=0.\n',
        );
      });

      await handle?.stop();

      expect(clearIntervalFn).toHaveBeenCalledWith(timer);
    } finally {
      if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = previousHome;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('skips overlapping scheduled runs while a previous run is active', async () => {
    const previousHome = process.env.GITNEXUS_HOME;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-starter-'));
    const timer = { unref: vi.fn() };
    let scheduled: (() => void) | undefined;
    const setIntervalFn = vi.fn((fn: () => void) => {
      scheduled = fn;
      return timer;
    }) as unknown as typeof setInterval;
    const stderr = { write: vi.fn() };
    const releaseRuns: Array<() => void> = [];
    const runOnce = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          releaseRuns.push(() =>
            resolve({ synced: 0, analyzed: 0, skippedAnalysis: 0, failed: 0 }),
          );
        }),
    );
    let handle: Awaited<ReturnType<typeof startAutoSyncWatch>> | undefined;

    try {
      process.env.GITNEXUS_HOME = tempDir;
      await fs.writeFile(
        path.join(tempDir, 'watch_config.yml'),
        [
          'sync_interval_minutes: 5',
          'projects:',
          '  - local_path: /tmp/repos',
          '    branch: master',
          '    remote_urls:',
          '      - git@github.com:team/repo.git',
        ].join('\n'),
      );

      handle = await startAutoSyncWatch({ setIntervalFn, runOnce, stderr });
      scheduled?.();

      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(stderr.write).toHaveBeenCalledWith(
        '[auto-sync] Previous run is still active; skipping overlapping run.\n',
      );

      releaseRuns.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      scheduled?.();

      expect(runOnce).toHaveBeenCalledTimes(2);
      releaseRuns.shift()?.();
      await handle?.stop();
      handle = undefined;
    } finally {
      releaseRuns.splice(0).forEach((release) => release());
      await handle?.stop();
      if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = previousHome;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('cancels the active run before removing watch ownership files', async () => {
    const previousHome = process.env.GITNEXUS_HOME;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-starter-'));
    const cancelled = vi.fn();
    const runOnce = vi.fn(
      (_config, options) =>
        new Promise<any>((resolve) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              cancelled();
              resolve({ synced: 0, analyzed: 0, skippedAnalysis: 0, failed: 0 });
            },
            { once: true },
          );
        }),
    );
    try {
      process.env.GITNEXUS_HOME = tempDir;
      await fs.writeFile(
        path.join(tempDir, 'watch_config.yml'),
        [
          'sync_interval_minutes: 5',
          'projects:',
          '  - local_path: /tmp/repos',
          '    branch: master',
          '    remote_urls:',
          '      - git@github.com:team/repo.git',
        ].join('\n'),
      );
      const handle = await startAutoSyncWatch({
        runOnce,
        keepAlive: false,
        deps: { isProcessAlive: vi.fn(() => false) },
      });
      const paths = getAutoSyncWatchPaths(tempDir);
      await handle!.stop();

      expect(cancelled).toHaveBeenCalledTimes(1);
      await expect(fs.access(paths.pidPath)).rejects.toThrow();
      await expect(fs.access(paths.ownerPath)).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = previousHome;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses a second running watch for the same GITNEXUS_HOME', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-watch-'));
    const paths = getAutoSyncWatchPaths(tempDir);
    const stderr = { write: vi.fn() };
    try {
      await writeWatchOwner(paths, 12345);
      const handle = await startAutoSyncWatch({
        paths,
        stderr,
        deps: {
          isProcessAlive: vi.fn(() => true),
          readProcessCommand: vi.fn(() => verifiedWatchCommand),
          readProcessStartTime: vi.fn(() => verifiedProcessStartTime),
        },
      });

      expect(handle).toBeNull();
      expect(stderr.write).toHaveBeenCalledWith(
        '[auto-sync] Watch is already running with pid 12345.\n',
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('recovers an abandoned watch mutex after the owner exits', async () => {
    const previousHome = process.env.GITNEXUS_HOME;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-watch-'));
    const paths = getAutoSyncWatchPaths(tempDir);
    const stderr = { write: vi.fn() };
    try {
      process.env.GITNEXUS_HOME = tempDir;
      await writeWatchOwner(paths, 12345, 'abandoned-owner');
      await fs.writeFile(
        path.join(tempDir, 'watch_config.yml'),
        [
          'sync_interval_minutes: 5',
          'projects:',
          '  - local_path: /tmp/repos',
          '    branch: master',
          '    remote_urls:',
          '      - git@github.com:team/repo.git',
        ].join('\n'),
      );

      const handle = await startAutoSyncWatch({
        paths,
        stderr,
        runOnce: vi.fn(async () => ({ synced: 0, analyzed: 0, skippedAnalysis: 0, failed: 0 })),
        keepAlive: false,
        deps: { isProcessAlive: vi.fn(() => false) },
      });

      expect(handle).not.toBeNull();
      expect(await fs.readFile(paths.pidPath, 'utf-8')).toBe(`${process.pid}\n`);
      expect(await fs.readFile(paths.ownerPath, 'utf-8')).not.toContain('abandoned-owner');
      await handle?.stop();
      await expect(fs.access(paths.mutexPath)).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = previousHome;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not delete a half-initialized lease when pid has not been written yet', async () => {
    const previousHome = process.env.GITNEXUS_HOME;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-watch-'));
    const paths = getAutoSyncWatchPaths(tempDir);
    const stderr = { write: vi.fn() };
    try {
      process.env.GITNEXUS_HOME = tempDir;
      await fs.mkdir(path.dirname(paths.pidPath), { recursive: true });
      await fs.mkdir(paths.mutexPath);
      await fs.writeFile(
        paths.ownerPath,
        `${JSON.stringify({ pid: 12345, ownerId: 'starting-owner', processStartTime: verifiedProcessStartTime, createdAt: '2026-06-30T00:00:00.000Z' })}\n`,
      );
      await fs.writeFile(
        path.join(tempDir, 'watch_config.yml'),
        [
          'sync_interval_minutes: 5',
          'projects:',
          '  - local_path: /tmp/repos',
          '    branch: master',
          '    remote_urls:',
          '      - git@github.com:team/repo.git',
        ].join('\n'),
      );

      const handle = await startAutoSyncWatch({
        paths,
        stderr,
        runOnce: vi.fn(async () => ({ synced: 0, analyzed: 0, skippedAnalysis: 0, failed: 0 })),
        deps: {
          isProcessAlive: vi.fn(() => true),
          readProcessCommand: vi.fn(() => verifiedWatchCommand),
          readProcessStartTime: vi.fn(() => verifiedProcessStartTime),
        },
      });

      expect(handle).toBeNull();
      expect(stderr.write).toHaveBeenCalledWith(
        '[auto-sync] Watch is already running with pid 12345.\n',
      );
      expect(await fs.readFile(paths.ownerPath, 'utf-8')).toContain('starting-owner');
      await expect(fs.access(paths.mutexPath)).resolves.toBeUndefined();
      await expect(fs.access(paths.pidPath)).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = previousHome;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not delete a live half-initialized lease when stop runs before pid is written', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-watch-'));
    const paths = getAutoSyncWatchPaths(tempDir);
    const stderr = { write: vi.fn() };
    try {
      await fs.mkdir(path.dirname(paths.pidPath), { recursive: true });
      await fs.mkdir(paths.mutexPath);
      await fs.writeFile(
        paths.ownerPath,
        `${JSON.stringify({ pid: 12345, ownerId: 'starting-owner', processStartTime: verifiedProcessStartTime, createdAt: '2026-06-30T00:00:00.000Z' })}\n`,
      );

      await expect(
        stopAutoSyncWatch({
          paths,
          stderr,
          deps: { isProcessAlive: vi.fn(() => true) },
        }),
      ).resolves.toBe('refused');

      expect(stderr.write).toHaveBeenCalledWith(
        '[auto-sync] Watch appears to be starting with pid 12345; pid file is not ready.\n',
      );
      expect(await fs.readFile(paths.ownerPath, 'utf-8')).toContain('starting-owner');
      await expect(fs.access(paths.mutexPath)).resolves.toBeUndefined();
      await expect(fs.access(paths.statusPath)).rejects.toThrow();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not delete a stale half-initialized lease from the stopper', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-watch-'));
    const paths = getAutoSyncWatchPaths(tempDir);
    try {
      await fs.mkdir(path.dirname(paths.pidPath), { recursive: true });
      await fs.mkdir(paths.mutexPath);
      await fs.writeFile(
        paths.ownerPath,
        `${JSON.stringify({ pid: 12345, ownerId: 'stale-owner', processStartTime: verifiedProcessStartTime, createdAt: '2026-06-30T00:00:00.000Z' })}\n`,
      );

      await expect(
        stopAutoSyncWatch({
          paths,
          stderr: { write: vi.fn() },
          deps: { isProcessAlive: vi.fn(() => false) },
        }),
      ).resolves.toBe('refused');

      expect(await fs.readFile(paths.ownerPath, 'utf-8')).toContain('stale-owner');
      await expect(fs.access(paths.mutexPath)).resolves.toBeUndefined();
      await expect(fs.access(paths.statusPath)).rejects.toThrow();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports not_running when no watch lease exists', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-watch-'));
    try {
      await expect(
        stopAutoSyncWatch({
          paths: getAutoSyncWatchPaths(tempDir),
          stderr: { write: vi.fn() },
        }),
      ).resolves.toBe('not_running');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('writes an owner-fenced stop request without deleting a live watch lease', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-watch-'));
    const paths = getAutoSyncWatchPaths(tempDir);
    try {
      const ownerId = await writeWatchOwner(paths, 12345, 'verified-owner');

      await expect(
        stopAutoSyncWatch({
          paths,
          timeoutMs: 0,
          stderr: { write: vi.fn() },
          deps: {
            isProcessAlive: vi.fn(() => true),
            readProcessCommand: vi.fn(() => verifiedWatchCommand),
            readProcessStartTime: vi.fn(() => verifiedProcessStartTime),
          },
        }),
      ).resolves.toBe('timeout');

      expect(
        JSON.parse(
          await fs.readFile(
            path.join(path.dirname(paths.pidPath), `watch.stop.${ownerId}.json`),
            'utf-8',
          ),
        ),
      ).toMatchObject({
        pid: 12345,
        ownerId,
        processStartTime: verifiedProcessStartTime,
        requestedAt: expect.any(String),
      });
      await expect(fs.readFile(paths.pidPath, 'utf-8')).resolves.toBe('12345\n');
      await expect(fs.access(paths.ownerPath)).resolves.toBeUndefined();
      await expect(fs.access(paths.mutexPath)).resolves.toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses to request stop for a reused pid', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-watch-'));
    const paths = getAutoSyncWatchPaths(tempDir);
    try {
      await writeWatchOwner(paths, 12345);

      await expect(
        stopAutoSyncWatch({
          paths,
          stderr: { write: vi.fn() },
          deps: {
            isProcessAlive: vi.fn(() => true),
            readProcessCommand: vi.fn(() => 'node unrelated-service.js'),
            readProcessStartTime: vi.fn(() => verifiedProcessStartTime),
          },
        }),
      ).resolves.toBe('refused');

      await expect(
        readAutoSyncWatchStatus(paths, {
          isProcessAlive: vi.fn(() => true),
          readProcessCommand: vi.fn(() => 'node unrelated-service.js'),
          readProcessStartTime: vi.fn(() => verifiedProcessStartTime),
        }),
      ).resolves.toMatchObject({
        state: 'error',
        pid: 12345,
        message: expect.stringContaining('not a GitNexus watch process'),
      });
      await expect(fs.readdir(path.dirname(paths.pidPath))).resolves.not.toContainEqual(
        expect.stringMatching(/^watch\.stop\./),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('stops a watch only when its own owner-fenced request is polled', async () => {
    const previousHome = process.env.GITNEXUS_HOME;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-watch-'));
    const paths = getAutoSyncWatchPaths(tempDir);
    const callbacks: Array<() => void> = [];
    const timer = { unref: vi.fn() };
    try {
      process.env.GITNEXUS_HOME = tempDir;
      await fs.writeFile(
        path.join(tempDir, 'watch_config.yml'),
        [
          'sync_interval_minutes: 5',
          'projects:',
          '  - local_path: /tmp/repos',
          '    branch: master',
          '    remote_urls:',
          '      - git@github.com:team/repo.git',
        ].join('\n'),
      );
      const handle = await startAutoSyncWatch({
        paths,
        keepAlive: false,
        setIntervalFn: vi.fn((callback: () => void) => {
          callbacks.push(callback);
          return timer;
        }) as unknown as typeof setInterval,
        clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
        runOnce: vi.fn(async () => ({ synced: 0, analyzed: 0, skippedAnalysis: 0, failed: 0 })),
        deps: { readProcessStartTime: vi.fn(() => verifiedProcessStartTime) },
      });
      expect(handle).not.toBeNull();
      const owner = JSON.parse(await fs.readFile(paths.ownerPath, 'utf-8'));
      await fs.writeFile(
        path.join(path.dirname(paths.pidPath), `watch.stop.${owner.ownerId}.json`),
        `${JSON.stringify({
          pid: process.pid,
          ownerId: owner.ownerId,
          processStartTime: verifiedProcessStartTime,
          requestedAt: new Date().toISOString(),
        })}\n`,
      );

      callbacks[0]!();
      await vi.waitFor(async () => expect(fs.access(paths.pidPath)).rejects.toThrow());
      await expect(fs.access(paths.ownerPath)).rejects.toThrow();
      await expect(fs.access(paths.mutexPath)).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = previousHome;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports cancelling until a timed-out analysis run settles', async () => {
    const previousHome = process.env.GITNEXUS_HOME;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-watch-'));
    const paths = getAutoSyncWatchPaths(tempDir);
    let releaseRun!: () => void;
    let requestCancellation!: () => void;
    try {
      process.env.GITNEXUS_HOME = tempDir;
      await fs.writeFile(
        path.join(tempDir, 'watch_config.yml'),
        [
          'sync_interval_minutes: 5',
          'projects:',
          '  - local_path: /tmp/repos',
          '    branch: master',
          '    remote_urls:',
          '      - git@github.com:team/repo.git',
        ].join('\n'),
      );
      const handle = await startAutoSyncWatch({
        paths,
        keepAlive: false,
        runOnce: vi.fn(
          (_config, options) =>
            new Promise<any>((resolve) => {
              requestCancellation = options.onAnalysisCancellationRequested;
              releaseRun = () => resolve({ synced: 0, analyzed: 0, skippedAnalysis: 0, failed: 0 });
            }),
        ),
        deps: { readProcessStartTime: vi.fn(() => verifiedProcessStartTime) },
      });
      requestCancellation();
      await vi.waitFor(async () => {
        await expect(
          readAutoSyncWatchStatus(paths, {
            isProcessAlive: vi.fn(() => true),
            readProcessCommand: vi.fn(() => verifiedWatchCommand),
            readProcessStartTime: vi.fn(() => verifiedProcessStartTime),
          }),
        ).resolves.toMatchObject({ state: 'cancelling' });
      });

      releaseRun();
      await vi.waitFor(async () => {
        await expect(
          readAutoSyncWatchStatus(paths, {
            isProcessAlive: vi.fn(() => true),
            readProcessCommand: vi.fn(() => verifiedWatchCommand),
            readProcessStartTime: vi.fn(() => verifiedProcessStartTime),
          }),
        ).resolves.toMatchObject({ state: 'running' });
      });
      await handle?.stop();
    } finally {
      if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = previousHome;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps watch ownership while stop waits for an active run to settle', async () => {
    const previousHome = process.env.GITNEXUS_HOME;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auto-sync-watch-'));
    const paths = getAutoSyncWatchPaths(tempDir);
    let releaseRun!: () => void;
    try {
      process.env.GITNEXUS_HOME = tempDir;
      await fs.writeFile(
        path.join(tempDir, 'watch_config.yml'),
        [
          'sync_interval_minutes: 5',
          'projects:',
          '  - local_path: /tmp/repos',
          '    branch: master',
          '    remote_urls:',
          '      - git@github.com:team/repo.git',
        ].join('\n'),
      );
      const handle = await startAutoSyncWatch({
        paths,
        keepAlive: false,
        runOnce: vi.fn(
          () =>
            new Promise<any>((resolve) => {
              releaseRun = () => resolve({ synced: 0, analyzed: 0, skippedAnalysis: 0, failed: 0 });
            }),
        ),
        deps: { readProcessStartTime: vi.fn(() => verifiedProcessStartTime) },
      });
      const stopping = handle!.stop();

      await vi.waitFor(async () => {
        await expect(
          readAutoSyncWatchStatus(paths, {
            isProcessAlive: vi.fn(() => true),
            readProcessCommand: vi.fn(() => verifiedWatchCommand),
            readProcessStartTime: vi.fn(() => verifiedProcessStartTime),
          }),
        ).resolves.toMatchObject({ state: 'stopping' });
      });
      await expect(fs.access(paths.pidPath)).resolves.toBeUndefined();
      await expect(fs.access(paths.ownerPath)).resolves.toBeUndefined();
      await expect(fs.access(paths.mutexPath)).resolves.toBeUndefined();

      releaseRun();
      await stopping;
      await expect(fs.access(paths.pidPath)).rejects.toThrow();
      await expect(fs.access(paths.ownerPath)).rejects.toThrow();
      await expect(fs.access(paths.mutexPath)).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = previousHome;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
