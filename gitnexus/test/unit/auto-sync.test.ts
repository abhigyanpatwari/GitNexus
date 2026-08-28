import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  extractRepoNameFromRemoteUrl,
  getAutoSyncMutexPath,
  getAutoSyncStatePath,
  getAutoSyncWatchDir,
  getProjectCommitInfoPath,
  loadAutoSyncConfig,
  parseAutoSyncConfig,
  parseBranchCandidates,
  parseDurationMs,
  quarantineAutoSyncPartial,
  resolveConfiguredCloneRoot,
  loadAutoSyncState,
  resetAutoSyncState,
  saveAutoSyncState,
  shouldAnalyzeCommit,
  validateAutoSyncRemoteUrl,
  validateAutoSyncBranchName,
  writeProjectCommitInfo,
} from '../../src/core/auto-sync/index.js';
import { acquireFileLock } from '../../src/storage/file-lock.js';

describe('auto-sync', () => {
  let tempDir: string;
  let gitnexusHome: string;
  let oldHome: string | undefined;

  beforeEach(async () => {
    const base = path.join(process.cwd(), '.tmp-test');
    await fs.mkdir(base, { recursive: true });
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(base, 'gitnexus-auto-sync-')));
    gitnexusHome = path.join(tempDir, '.gitnexus');
    await fs.mkdir(gitnexusHome);
    oldHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = gitnexusHome;
  });

  afterEach(async () => {
    if (oldHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = oldHome;
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('places watch runtime artifacts under the watch directory by default', () => {
    expect(getAutoSyncWatchDir(gitnexusHome)).toBe(path.join(gitnexusHome, 'watch'));
    expect(getAutoSyncMutexPath(gitnexusHome)).toBe(
      path.join(gitnexusHome, 'watch', 'watch.mutex'),
    );
    expect(getAutoSyncStatePath(gitnexusHome)).toBe(
      path.join(gitnexusHome, 'watch', 'auto-sync-state.json'),
    );
    expect(getProjectCommitInfoPath(gitnexusHome)).toBe(
      path.join(gitnexusHome, 'watch', 'project_commit_info.txt'),
    );
  });

  it('refuses to reset state while the watch mutex is held', async () => {
    const statePath = getAutoSyncStatePath(gitnexusHome);
    const infoPath = getProjectCommitInfoPath(gitnexusHome);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, '{"kept":true}\n');
    await fs.writeFile(infoPath, 'kept\n');
    const release = await acquireFileLock(getAutoSyncMutexPath(gitnexusHome));

    try {
      await expect(resetAutoSyncState(gitnexusHome)).resolves.toBe(false);
      await expect(fs.readFile(statePath, 'utf-8')).resolves.toContain('kept');
      await expect(fs.readFile(infoPath, 'utf-8')).resolves.toBe('kept\n');
    } finally {
      await release();
    }
  });

  it('resets derived state while holding the watch mutex', async () => {
    const statePath = getAutoSyncStatePath(gitnexusHome);
    const infoPath = getProjectCommitInfoPath(gitnexusHome);
    const mutexPath = getAutoSyncMutexPath(gitnexusHome);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, '{}\n');
    await fs.writeFile(infoPath, 'derived\n');

    await expect(resetAutoSyncState(gitnexusHome)).resolves.toBe(true);

    await expect(fs.access(statePath)).rejects.toThrow();
    await expect(fs.access(infoPath)).rejects.toThrow();
    await expect(fs.access(mutexPath)).rejects.toThrow();
  });

  it('loads watch_config.yml from GITNEXUS_HOME and normalizes branch candidates', async () => {
    await fs.writeFile(
      path.join(gitnexusHome, 'watch_config.yml'),
      [
        'sync_interval_minutes: 120',
        'max_concurrency: 3',
        'repo_git_timeout: 12s',
        'analyze_timeout: 45m',
        'analyze_failure_threshold: 2',
        'projects:',
        '  - local_path: /tmp/repos',
        '    group_name: back_end',
        '    overwrite_local_changes: true',
        '    branches: [test, master, test]',
        '    remote_urls:',
        '      - git@gitee.com:qts_server/qts_account.git',
      ].join('\n'),
    );

    const loaded = await loadAutoSyncConfig();

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('expected config to load');
    expect(loaded.config.configPath).toBe(path.join(gitnexusHome, 'watch_config.yml'));
    expect(loaded.config.syncIntervalMinutes).toBe(120);
    expect(loaded.config.maxConcurrency).toBe(3);
    expect(loaded.config.repoGitTimeoutMs).toBe(12_000);
    expect(loaded.config.analyzeTimeoutMs).toBe(2_700_000);
    expect(loaded.config.analyzeFailureThreshold).toBe(2);
    expect(loaded.config.projects[0]).toMatchObject({
      localPath: '/tmp/repos',
      groupName: 'back_end',
      overwriteLocalChanges: true,
      branches: ['test', 'master'],
      remoteUrls: ['git@gitee.com:qts_server/qts_account.git'],
    });
  });

  it('defaults repo_git_timeout and max_concurrency and allows empty group_name', async () => {
    await fs.writeFile(
      path.join(gitnexusHome, 'watch_config.yml'),
      [
        'sync_interval_minutes: 10',
        'projects:',
        '  - local_path: /tmp/repos',
        '    group_name: ""',
        '    branch: master',
        '    remote_urls:',
        '      - git@github.com:owner/repo.git',
      ].join('\n'),
    );

    const loaded = await loadAutoSyncConfig();

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('expected config');
    expect(loaded.config.repoGitTimeoutMs).toBe(10_000);
    expect(loaded.config.analyzeTimeoutMs).toBe(300_000);
    expect(loaded.config.maxConcurrency).toBe(1);
    expect(loaded.config.analyzeFailureThreshold).toBe(3);
    expect(loaded.config.projects[0].groupName).toBeUndefined();
    expect(loaded.config.projects[0].overwriteLocalChanges).toBe(false);
  });

  it('rejects repo_git_timeout values above the Node timer limit', () => {
    expect(() =>
      parseAutoSyncConfig(
        [
          'sync_interval_minutes: 10',
          'repo_git_timeout: 2147483648ms',
          'projects:',
          '  - local_path: /tmp/repos',
          '    branch: main',
          '    remote_urls:',
          '      - https://github.com/owner/repo.git',
        ].join('\n'),
        '/tmp/watch_config.yml',
      ),
    ).toThrow('repo_git_timeout must not exceed 2147483647ms');
  });

  it('rejects analyze_timeout values above half the sync interval', async () => {
    await fs.writeFile(
      path.join(gitnexusHome, 'watch_config.yml'),
      [
        'sync_interval_minutes: 10',
        'analyze_timeout: 6m',
        'projects:',
        '  - local_path: /tmp/repos',
        '    branch: master',
        '    remote_urls:',
        '      - git@github.com:owner/repo.git',
      ].join('\n'),
    );

    const loaded = await loadAutoSyncConfig();

    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error('expected invalid config');
    expect(loaded.message).toContain(
      'analyze_timeout must not exceed half of sync_interval_minutes (5m)',
    );
  });

  it('rejects invalid analyze_failure_threshold values', async () => {
    await fs.writeFile(
      path.join(gitnexusHome, 'watch_config.yml'),
      [
        'sync_interval_minutes: 10',
        'analyze_failure_threshold: 1',
        'projects:',
        '  - local_path: /tmp/repos',
        '    branch: master',
        '    remote_urls:',
        '      - git@github.com:owner/repo.git',
      ].join('\n'),
    );

    const loaded = await loadAutoSyncConfig();

    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error('expected invalid config');
    expect(loaded.message).toContain('analyze_failure_threshold must be an integer >= 2');
  });

  it('reports missing config without throwing', async () => {
    const loaded = await loadAutoSyncConfig();

    expect(loaded).toEqual({
      ok: false,
      reason: 'missing',
      message: `[auto-sync] Missing config file: ${path.join(gitnexusHome, 'watch_config.yml')}. Auto sync is skipped.`,
    });
  });

  it('reports invalid config without throwing', async () => {
    await fs.writeFile(path.join(gitnexusHome, 'watch_config.yml'), 'projects: []\n');

    const loaded = await loadAutoSyncConfig();

    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error('expected invalid config');
    expect(loaded.reason).toBe('invalid');
    expect(loaded.message).toContain('[auto-sync] Invalid watch_config.yml:');
    expect(loaded.message).toContain('sync_interval_minutes must be a positive integer');
    expect(loaded.message).toContain('projects must contain at least one project');
  });

  it('rejects missing, relative, and traversal local_path values at config load', async () => {
    await fs.writeFile(
      path.join(gitnexusHome, 'watch_config.yml'),
      [
        'sync_interval_minutes: 10',
        'projects:',
        '  - local_path: ../repos',
        '    branch: master',
        '    remote_urls:',
        '      - git@github.com:team/repo.git',
      ].join('\n'),
    );

    const loaded = await loadAutoSyncConfig();

    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error('expected invalid config');
    expect(loaded.message).toContain('local_path must be an absolute path');
  });

  it('hard-fails unsafe configured clone roots', async () => {
    await expect(resolveConfiguredCloneRoot('/')).rejects.toThrow('unsafe auto-sync clone root');
    await expect(resolveConfiguredCloneRoot(os.homedir())).rejects.toThrow(
      'unsafe auto-sync clone root',
    );
    await expect(
      resolveConfiguredCloneRoot(path.join(await fs.realpath(os.tmpdir()), 'repos')),
    ).rejects.toThrow('unsafe auto-sync clone root');
    const root = path.join(tempDir, 'repos');
    await expect(resolveConfiguredCloneRoot(`${root}/../repos`)).rejects.toThrow('normalized');
  });

  it('rejects GitNexus internal directory descendants as clone roots', async () => {
    for (const internalDir of ['groups', 'indexes', 'quarantine']) {
      const root = path.join(gitnexusHome, internalDir, 'repo-root');
      await fs.mkdir(root, { recursive: true });

      await expect(resolveConfiguredCloneRoot(root)).rejects.toThrow('GitNexus internal directory');
    }
  });

  it('allows the default GitNexus repos directory as an auto-sync clone root', async () => {
    const root = path.join(gitnexusHome, 'repos');
    await fs.mkdir(root, { recursive: true });

    await expect(resolveConfiguredCloneRoot(root)).resolves.toEqual(
      expect.objectContaining({
        root,
        quarantineRoot: path.join(gitnexusHome, 'watch', 'quarantine'),
      }),
    );
  });

  it('rejects symlinks in configured clone root paths', async () => {
    const realRoot = path.join(tempDir, 'real-root');
    const linkRoot = path.join(tempDir, 'link-root');
    await fs.mkdir(realRoot);
    await fs.symlink(realRoot, linkRoot);

    await expect(resolveConfiguredCloneRoot(linkRoot)).rejects.toThrow('symlink');
  });

  it('resolves safe configured clone roots and reports quarantine retention', async () => {
    const root = path.join(tempDir, 'repos');
    await fs.mkdir(root);

    await expect(resolveConfiguredCloneRoot(root)).resolves.toEqual(
      expect.objectContaining({
        root,
        quarantineRoot: path.join(gitnexusHome, 'watch', 'quarantine'),
        quarantineRetentionDays: 14,
      }),
    );
  });

  it('removes expired quarantine entries while preserving recent and unrelated files', async () => {
    const root = path.join(tempDir, 'repos');
    const quarantineRoot = path.join(gitnexusHome, 'watch', 'quarantine');
    const expired = path.join(quarantineRoot, 'auto-sync-expired-repo');
    const recent = path.join(quarantineRoot, 'auto-sync-recent-repo');
    const unrelated = path.join(quarantineRoot, 'operator-note.txt');
    await fs.mkdir(expired, { recursive: true });
    await fs.mkdir(recent);
    await fs.writeFile(unrelated, 'keep');
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1_000);
    await fs.utimes(expired, old, old);

    await resolveConfiguredCloneRoot(root);

    await expect(fs.access(expired)).rejects.toThrow();
    await expect(fs.access(recent)).resolves.toBeUndefined();
    await expect(fs.readFile(unrelated, 'utf-8')).resolves.toBe('keep');
  });

  it('falls back to copy and remove when quarantine crosses filesystems', async () => {
    const target = path.join(tempDir, 'partial-repo');
    const quarantineRoot = path.join(gitnexusHome, 'watch', 'quarantine');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'partial.txt'), 'partial');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('cross-device link'), { code: 'EXDEV' }),
    );

    const destination = await quarantineAutoSyncPartial(target, quarantineRoot);

    await expect(fs.readFile(path.join(destination, 'partial.txt'), 'utf-8')).resolves.toBe(
      'partial',
    );
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('gives concurrent partial clone quarantines unique destinations', async () => {
    const quarantineRoot = path.join(gitnexusHome, 'watch', 'quarantine');
    const first = path.join(tempDir, 'one', 'partial-repo');
    const second = path.join(tempDir, 'two', 'partial-repo');
    await Promise.all([
      fs.mkdir(first, { recursive: true }),
      fs.mkdir(second, { recursive: true }),
    ]);

    const [firstDestination, secondDestination] = await Promise.all([
      quarantineAutoSyncPartial(first, quarantineRoot),
      quarantineAutoSyncPartial(second, quarantineRoot),
    ]);

    expect(firstDestination).not.toBe(secondDestination);
    await expect(fs.access(firstDestination)).resolves.toBeUndefined();
    await expect(fs.access(secondDestination)).resolves.toBeUndefined();
    await expect(fs.access(first)).rejects.toThrow();
    await expect(fs.access(second)).rejects.toThrow();
  });

  it('rejects group-writable configured clone roots', async () => {
    if (process.platform === 'win32') return;
    const root = path.join(tempDir, 'group-writable-repos');
    await fs.mkdir(root, { mode: 0o770 });
    await fs.chmod(root, 0o770);

    await expect(resolveConfiguredCloneRoot(root)).rejects.toThrow('group-writable');
  });

  it('rejects sticky world-writable configured clone roots', async () => {
    if (process.platform === 'win32') return;
    const root = path.join(tempDir, 'sticky-world-writable-repos');
    await fs.mkdir(root);
    await fs.chmod(root, 0o1777);

    await expect(resolveConfiguredCloneRoot(root)).rejects.toThrow('world-writable');
  });

  it('creates missing configured clone roots before watch clone work', async () => {
    const root = path.join(tempDir, 'missing-repos');

    await expect(resolveConfiguredCloneRoot(root)).resolves.toEqual(
      expect.objectContaining({
        root,
        quarantineRoot: path.join(gitnexusHome, 'watch', 'quarantine'),
      }),
    );
    expect((await fs.stat(root)).isDirectory()).toBe(true);
  });

  it('parses branch strings and arrays with trimming and de-duplication', () => {
    expect(parseBranchCandidates('test, master, test')).toEqual(['test', 'master']);
    expect(parseBranchCandidates(['develop,master', 'develop'])).toEqual(['develop', 'master']);
  });

  it('rejects unsafe auto-sync branch names', () => {
    expect(() => validateAutoSyncBranchName('feature/good-branch')).not.toThrow();
    expect(() => validateAutoSyncBranchName('foo./bar')).not.toThrow();
    expect(() => validateAutoSyncBranchName('-upload-pack=evil')).toThrow('must not start');
    expect(() => validateAutoSyncBranchName('feature bad')).toThrow('whitespace');
    expect(() => validateAutoSyncBranchName('feature..bad')).toThrow('must not contain ".."');
    expect(() => validateAutoSyncBranchName('bad:ref')).toThrow('not allowed');
    expect(() => validateAutoSyncBranchName('feature.')).toThrow('must not end');
    expect(() => validateAutoSyncBranchName('feature/')).toThrow('must not end');
    expect(() => validateAutoSyncBranchName('feature//branch')).toThrow('consecutive');
    expect(() => validateAutoSyncBranchName('feature@{x')).toThrow('must not contain "@{"');
    expect(() => validateAutoSyncBranchName('.hidden')).toThrow('hidden');
    expect(() => validateAutoSyncBranchName('foo/bar.lock')).toThrow('hidden or .lock');
  });

  it('extracts safe repository names from remote URLs', () => {
    expect(extractRepoNameFromRemoteUrl('git@gitee.com:qts_server/qts_account.git')).toBe(
      'qts_account',
    );
    expect(extractRepoNameFromRemoteUrl('git@gitlab.com:team/subgroup/repo-name.git')).toBe(
      'repo-name',
    );
  });

  it('rejects unsafe repository names without sanitizing them', () => {
    expect(() => extractRepoNameFromRemoteUrl('git@github.com:team/repo$name.git')).toThrow(
      'valid repository name',
    );
    expect(() => extractRepoNameFromRemoteUrl('git@github.com:team/..')).toThrow('traversal');
  });

  it('allows only github, gitlab, and gitee SSH SCP remote URLs', () => {
    expect(() => validateAutoSyncRemoteUrl('git@github.com:owner/repo')).not.toThrow();
    expect(() => validateAutoSyncRemoteUrl('git@github.com:im-fan/multica.git')).not.toThrow();
    expect(() => validateAutoSyncRemoteUrl('git@gitlab.com:group/subgroup/repo.git')).not.toThrow();
    expect(() =>
      validateAutoSyncRemoteUrl('git@gitee.com:qts-ops/qts-code-engineering.git'),
    ).not.toThrow();
    expect(() => validateAutoSyncRemoteUrl('https://github.com/owner/repo.git')).toThrow(
      'must use',
    );
    expect(() => validateAutoSyncRemoteUrl('ssh://git@github.com/owner/repo.git')).toThrow(
      'must use',
    );
    expect(() => validateAutoSyncRemoteUrl('user@github.com:owner/repo.git')).toThrow('must use');
    expect(() => validateAutoSyncRemoteUrl('git@example.com:owner/repo.git')).toThrow(
      'host must be',
    );
    expect(() => validateAutoSyncRemoteUrl('git@github.com:owner/repo.git?ref=main')).toThrow(
      'must not include query strings or fragments',
    );
    expect(() => validateAutoSyncRemoteUrl('git@github.com:owner/repo.git#main')).toThrow(
      'must not include query strings or fragments',
    );
    expect(() => validateAutoSyncRemoteUrl('git@github.com:owner/')).toThrow('path must include');
    expect(() => validateAutoSyncRemoteUrl('git@github.com:owner//repo')).toThrow(
      'path must include',
    );
  });

  it('parses repo git timeout durations', () => {
    expect(parseDurationMs('10s')).toBe(10_000);
    expect(parseDurationMs('2m')).toBe(120_000);
    expect(parseDurationMs('5000ms')).toBe(5000);
    expect(parseDurationMs('10')).toBe(10_000);
    expect(parseDurationMs(10)).toBe(10_000);
  });

  it('keeps branch compatibility but rejects branch and branches together', async () => {
    await fs.writeFile(
      path.join(gitnexusHome, 'watch_config.yml'),
      [
        'sync_interval_minutes: 10',
        'projects:',
        '  - local_path: /tmp/repos',
        '    branch: master',
        '    branches: [develop]',
        '    remote_urls:',
        '      - git@github.com:owner/repo.git',
      ].join('\n'),
    );

    const loaded = await loadAutoSyncConfig();

    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error('expected invalid config');
    expect(loaded.message).toContain('must not set both branch and branches');
  });

  it('uses commit ids to skip unchanged analyses and retry failed prior analyses', () => {
    expect(shouldAnalyzeCommit({ currentCommit: 'abc', previousAnalyzedCommit: 'abc' })).toBe(
      false,
    );
    expect(
      shouldAnalyzeCommit({
        currentCommit: 'abc',
        previousAnalyzedCommit: 'abc',
        previousStatus: 'failed',
      }),
    ).toBe(true);
    expect(shouldAnalyzeCommit({ currentCommit: 'def', previousAnalyzedCommit: 'abc' })).toBe(true);
  });

  it('saves state atomically and reloads it', async () => {
    const statePath = path.join(tempDir, 'auto-sync-state.json');

    await saveAutoSyncState(
      {
        '/tmp/repos/qts_account|master': {
          codeCommitId: 'abc',
          analyzedCommitId: 'abc',
          lastAnalyzeStatus: 'success',
          analyzeConsecutiveFailures: 2,
          lastAnalyzeError: 'old error',
          lastSyncTime: '2026-06-30T00:00:00.000Z',
        },
      },
      statePath,
    );

    await expect(fs.readdir(tempDir)).resolves.not.toContain(
      expect.stringContaining('auto-sync-state.json.tmp'),
    );
    await expect(loadAutoSyncState(statePath)).resolves.toEqual({
      '/tmp/repos/qts_account|master': {
        codeCommitId: 'abc',
        analyzedCommitId: 'abc',
        lastAnalyzeStatus: 'success',
        analyzeConsecutiveFailures: 2,
        lastAnalyzeError: 'old error',
        lastSyncTime: '2026-06-30T00:00:00.000Z',
      },
    });
  });

  it('returns empty state and reports corrupt state files', async () => {
    const statePath = path.join(tempDir, 'auto-sync-state.json');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await fs.writeFile(statePath, '{not-json', 'utf-8');

    await expect(loadAutoSyncState(statePath)).resolves.toEqual({});

    expect(stderr).toHaveBeenCalledWith(
      `[auto-sync] Ignoring unreadable or corrupt state file: ${statePath}. State will be rebuilt.\n`,
    );
  });

  it('drops malformed state entries while preserving valid entries', async () => {
    const statePath = path.join(tempDir, 'auto-sync-state.json');
    await fs.writeFile(
      statePath,
      JSON.stringify({
        '/tmp/repos/valid|main': {
          codeCommitId: 'abc',
          analyzedCommitId: 'abc',
          lastAnalyzeStatus: 'success',
          analyzeConsecutiveFailures: 0,
          lastSyncTime: '2026-06-30T00:00:00.000Z',
        },
        '/tmp/repos/invalid|main': {
          codeCommitId: 123,
          analyzeConsecutiveFailures: -1,
          lastSyncTime: null,
        },
      }),
    );

    await expect(loadAutoSyncState(statePath)).resolves.toEqual({
      '/tmp/repos/valid|main': {
        codeCommitId: 'abc',
        analyzedCommitId: 'abc',
        lastAnalyzeStatus: 'success',
        analyzeConsecutiveFailures: 0,
        lastSyncTime: '2026-06-30T00:00:00.000Z',
      },
    });
  });

  it('writes project_commit_info.txt atomically', async () => {
    const infoPath = path.join(tempDir, 'project_commit_info.txt');

    await writeProjectCommitInfo(
      [
        {
          remoteUrl: 'git@github.com:owner/repo.git',
          localPath: '/tmp/repos/repo',
          branch: 'master',
          codeCommitId: 'abc',
          analyzedCommitId: 'abc',
          status: 'success',
          analyzeConsecutiveFailures: 0,
          analyzeFailureThreshold: 3,
          lastSyncTime: '2026-06-30T00:00:00.000Z',
        },
        {
          remoteUrl: 'git@github.com:owner/bad.git',
          localPath: '/tmp/repos/bad',
          branch: 'master',
          codeCommitId: 'def',
          analyzedCommitId: 'abc',
          status: 'threshold_skipped',
          analyzeConsecutiveFailures: 3,
          analyzeFailureThreshold: 3,
          lastAnalyzeError: 'parser crashed',
          lastSyncTime: '2026-06-30T00:00:00.000Z',
        },
      ],
      infoPath,
    );

    const content = await fs.readFile(infoPath, 'utf-8');
    expect(content).toContain('remote: git@github.com:owner/repo.git');
    expect(content).toContain('code_commit: abc');
    expect(content).toContain('analyze_consecutive_failures: 0');
    expect(content).toContain('analyze_failure_threshold: 3');
    expect(content).toContain('status: threshold_skipped');
    expect(content).toContain('last_analyze_error: parser crashed');
    await expect(fs.readdir(tempDir)).resolves.not.toContain(
      expect.stringContaining('project_commit_info.txt.tmp'),
    );
  });
});
