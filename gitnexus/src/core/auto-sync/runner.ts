import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadGroupConfig } from '../group/config-parser.js';
import { getDefaultGitnexusDir, getGroupDir } from '../group/storage.js';
import { syncGroup } from '../group/sync.js';
import { registerRepo, type RepoMeta } from '../../storage/repo-manager.js';
import { extractRepoNameFromRemoteUrl } from './repo.js';
import { cloneOrPull, runGit } from '../../server/git-clone.js';
import { resolveConfiguredCloneRoot } from './path-security.js';
import {
  buildStateKey,
  loadAutoSyncState,
  saveAutoSyncState,
  shouldAnalyzeCommit,
  writeProjectCommitInfo,
  type AutoSyncAnalyzeStatus,
  type AutoSyncCommitStateEntry,
  type ProjectCommitInfoEntry,
} from './state.js';
import type { AutoSyncConfig, AutoSyncProjectConfig } from './config.js';
import { validateAutoSyncRemoteUrl } from './config.js';
import { runAutoSyncAnalysis, type AutoSyncAnalysisRunner } from './analysis-worker-launch.js';

export interface AutoSyncLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface AutoSyncRunDeps {
  cloneOrPull: typeof cloneOrPull;
  getCurrentBranch: (repoPath: string, timeoutMs: number) => Promise<string | undefined>;
  getCurrentCommit: (repoPath: string, timeoutMs: number) => Promise<string>;
  runAnalysis: AutoSyncAnalysisRunner;
  registerRepo: typeof registerRepo;
  loadState: typeof loadAutoSyncState;
  saveState: typeof saveAutoSyncState;
  writeCommitInfo: typeof writeProjectCommitInfo;
  addRepoToGroup: typeof addRepoToGroup;
  syncGroupByName: typeof syncGroupByName;
  resolveCloneRoot: typeof resolveConfiguredCloneRoot;
  getAvailableMemoryGB: () => number;
}

export interface AutoSyncRunResult {
  synced: number;
  analyzed: number;
  skippedAnalysis: number;
  failed: number;
}

const _require = createRequire(import.meta.url);
const yaml = _require('js-yaml') as typeof import('js-yaml');

const DEFAULT_LOGGER: AutoSyncLogger = {
  info: (message) => process.stderr.write(`${message}\n`),
  warn: (message) => process.stderr.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`),
};

const DEFAULT_DEPS: AutoSyncRunDeps = {
  cloneOrPull,
  getCurrentBranch: async (repoPath, timeoutMs) => {
    const branch = (await runGit(['branch', '--show-current'], repoPath, { timeoutMs })).trim();
    return branch || undefined;
  },
  getCurrentCommit: async (repoPath, timeoutMs) =>
    (await runGit(['rev-parse', 'HEAD'], repoPath, { timeoutMs })).trim(),
  runAnalysis: runAutoSyncAnalysis,
  registerRepo,
  loadState: loadAutoSyncState,
  saveState: saveAutoSyncState,
  writeCommitInfo: writeProjectCommitInfo,
  addRepoToGroup,
  syncGroupByName,
  resolveCloneRoot: resolveConfiguredCloneRoot,
  getAvailableMemoryGB: () => Math.floor(process.availableMemory?.() ?? 0) / 1024 / 1024 / 1024,
};

export async function runAutoSyncOnce(
  config: AutoSyncConfig,
  options: {
    deps?: Partial<AutoSyncRunDeps>;
    logger?: AutoSyncLogger;
    now?: () => Date;
    signal?: AbortSignal;
    onAnalysisCancellationRequested?: () => void;
  } = {},
): Promise<AutoSyncRunResult> {
  const deps = { ...DEFAULT_DEPS, ...options.deps };
  const logger = options.logger ?? DEFAULT_LOGGER;
  const now = options.now ?? (() => new Date());
  throwIfAborted(options.signal);
  const state = await deps.loadState();
  throwIfAborted(options.signal);
  const groupsToSync = new Set<string>();
  const groupStateKeys = new Map<string, string[]>();
  const result: AutoSyncRunResult = { synced: 0, analyzed: 0, skippedAnalysis: 0, failed: 0 };
  const commitInfoEntries: ProjectCommitInfoEntry[] = [];
  const actualConcurrency = resolveActualConcurrency(
    config.maxConcurrency,
    deps.getAvailableMemoryGB(),
  );
  logger.info(
    `[auto-sync] Starting sync loop with max_concurrency=${actualConcurrency} analyze_failure_threshold=${config.analyzeFailureThreshold}.`,
  );

  const workItems = await buildWorkItems(config, deps);
  const repoResults = await mapWithConcurrency(
    workItems,
    actualConcurrency,
    options.signal,
    async (item) => {
      const lastSyncTime = now().toISOString();
      try {
        throwIfAborted(options.signal);
        if (!item.cloneRoot || !item.repoName || !item.targetDir) {
          throw new Error(item.error ?? 'Invalid auto-sync work item');
        }
        const repoName = item.repoName;
        const targetDir = item.targetDir;
        const syncResult = await syncFirstAvailableBranch({
          item,
          repoName,
          targetDir,
          timeoutMs: config.repoGitTimeoutMs,
          deps,
          logger,
        });
        throwIfAborted(options.signal);
        if (syncResult.ok === false) {
          logger.error(
            `[auto-sync] Repository sync failed for ${item.remoteUrl}; no configured branch could be pulled: ${syncResult.message}`,
          );
          return {
            kind: 'failed' as const,
            project: item.project,
            remoteUrl: item.remoteUrl,
            targetDir,
            branch: item.project.branches[0],
            status: syncResult.status,
            analyzeConsecutiveFailures: 0,
            lastSyncTime,
          };
        }

        const currentBranch = syncResult.branch;

        const currentCommit = await deps.getCurrentCommit(targetDir, config.repoGitTimeoutMs);
        const stateKey = buildStateKey(targetDir, currentBranch);
        const previous = state[stateKey];
        let analyzeStatus: AutoSyncAnalyzeStatus = 'skipped';
        let analyzedCommitId = previous?.analyzedCommitId;
        let analyzeConsecutiveFailures = previous?.analyzeConsecutiveFailures ?? 0;
        let lastAnalyzeError = previous?.lastAnalyzeError;
        const groupSyncPending = previous?.groupSyncPending === true;
        let stats: RepoMeta['stats'] | undefined;

        if (previous && previous.codeCommitId !== currentCommit) {
          analyzeConsecutiveFailures = 0;
          lastAnalyzeError = undefined;
        }

        if (analyzeConsecutiveFailures >= config.analyzeFailureThreshold) {
          analyzeStatus = 'threshold_skipped';
          logger.error(
            `[auto-sync] Skip analysis for ${targetDir}; analyze consecutive failures ${analyzeConsecutiveFailures}/${config.analyzeFailureThreshold} reached threshold. Fix the repository or clear auto-sync state before retrying.`,
          );
        } else if (
          shouldAnalyzeCommit({
            currentCommit,
            previousAnalyzedCommit: previous?.analyzedCommitId,
            previousStatus: previous?.lastAnalyzeStatus,
          })
        ) {
          try {
            const analysis = await (options.onAnalysisCancellationRequested
              ? deps.runAnalysis(
                  targetDir,
                  { branch: currentBranch, skipAgentsMd: true, skipSkills: true },
                  config.analyzeTimeoutMs,
                  options.signal,
                  options.onAnalysisCancellationRequested,
                )
              : deps.runAnalysis(
                  targetDir,
                  { branch: currentBranch, skipAgentsMd: true, skipSkills: true },
                  config.analyzeTimeoutMs,
                  options.signal,
                ));
            throwIfAborted(options.signal);
            stats = analysis.stats;
            analyzeStatus = 'success';
            analyzedCommitId = currentCommit;
            analyzeConsecutiveFailures = 0;
            lastAnalyzeError = undefined;
          } catch (err: unknown) {
            if (options.signal?.aborted) throw err;
            analyzeStatus = 'failed';
            analyzeConsecutiveFailures += 1;
            lastAnalyzeError = shortErrorMessage(err);
            logger.error(
              `[auto-sync] Analysis failed for ${targetDir}; consecutive failures ${analyzeConsecutiveFailures}/${config.analyzeFailureThreshold}: ${lastAnalyzeError}`,
            );
          }
        } else {
          logger.info(`[auto-sync] Skip analysis for ${targetDir}; commit unchanged.`);
        }
        throwIfAborted(options.signal);

        return {
          kind: 'synced' as const,
          project: item.project,
          repoName,
          remoteUrl: item.remoteUrl,
          targetDir,
          branch: currentBranch,
          currentCommit,
          analyzedCommitId,
          analyzeStatus,
          analyzeConsecutiveFailures,
          lastAnalyzeError,
          groupSyncPending,
          stats,
          stateKey,
          lastSyncTime,
        };
      } catch (err: unknown) {
        if (options.signal?.aborted) throw err;
        logger.error(
          `[auto-sync] Repository sync failed for ${item.remoteUrl}: ${(err as Error).message}`,
        );
        return {
          kind: 'failed' as const,
          project: item.project,
          remoteUrl: item.remoteUrl,
          targetDir: item.targetDir ?? '',
          status: 'sync_failed' as const,
          lastSyncTime,
        };
      }
    },
  );

  for (const repoResult of repoResults) {
    if (repoResult.kind === 'failed') {
      result.failed += 1;
      commitInfoEntries.push({
        remoteUrl: repoResult.remoteUrl,
        localPath: repoResult.targetDir,
        branch: repoResult.branch,
        status: repoResult.status,
        lastSyncTime: repoResult.lastSyncTime,
      });
      continue;
    }

    result.synced += 1;
    let analyzeStatus = repoResult.analyzeStatus;
    let analyzeConsecutiveFailures = repoResult.analyzeConsecutiveFailures;
    let lastAnalyzeError = repoResult.lastAnalyzeError;
    let analyzedCommitId = repoResult.analyzedCommitId;
    if (analyzeStatus === 'success') {
      const meta: RepoMeta = {
        repoPath: repoResult.targetDir,
        lastCommit: repoResult.currentCommit,
        indexedAt: repoResult.lastSyncTime,
        stats: repoResult.stats!,
        branch: repoResult.branch,
        remoteUrl: repoResult.remoteUrl,
      };
      try {
        await deps.registerRepo(repoResult.targetDir, meta, {
          name: getAutoSyncRepoIdentity(repoResult.remoteUrl),
        });
        result.analyzed += 1;
      } catch (err: unknown) {
        analyzeStatus = 'failed';
        analyzedCommitId = undefined;
        analyzeConsecutiveFailures += 1;
        lastAnalyzeError = `Repository registration failed: ${shortErrorMessage(err)}`;
        result.failed += 1;
        logger.error(`[auto-sync] ${lastAnalyzeError}`);
      }
    } else if (analyzeStatus === 'failed') {
      result.failed += 1;
    } else {
      result.skippedAnalysis += 1;
    }

    const stateEntry: AutoSyncCommitStateEntry = {
      codeCommitId: repoResult.currentCommit,
      analyzedCommitId,
      lastAnalyzeStatus: analyzeStatus,
      analyzeConsecutiveFailures,
      lastAnalyzeError,
      groupSyncPending: repoResult.groupSyncPending,
      lastSyncTime: repoResult.lastSyncTime,
    };
    state[repoResult.stateKey] = stateEntry;

    commitInfoEntries.push({
      remoteUrl: repoResult.remoteUrl,
      localPath: repoResult.targetDir,
      branch: repoResult.branch,
      codeCommitId: repoResult.currentCommit,
      analyzedCommitId,
      status: analyzeStatus,
      analyzeConsecutiveFailures,
      analyzeFailureThreshold: config.analyzeFailureThreshold,
      lastAnalyzeError,
      lastSyncTime: repoResult.lastSyncTime,
    });

    if (repoResult.project.groupName) {
      let groupMembershipOk = false;
      let membershipAdded = false;
      try {
        membershipAdded = await deps.addRepoToGroup(
          repoResult.project,
          getAutoSyncRepoIdentity(repoResult.remoteUrl),
          getAutoSyncRepoIdentity(repoResult.remoteUrl),
        );
        groupMembershipOk = true;
      } catch (err: unknown) {
        result.failed += 1;
        logger.error(
          `[auto-sync] Group update failed for ${repoResult.project.groupName}: ${(err as Error).message}`,
        );
      }
      if (
        groupMembershipOk &&
        (analyzeStatus === 'success' ||
          (membershipAdded && analyzeStatus === 'skipped') ||
          (analyzeStatus === 'skipped' && repoResult.groupSyncPending))
      ) {
        const groupName = repoResult.project.groupName;
        groupsToSync.add(groupName);
        const keys = groupStateKeys.get(groupName) ?? [];
        keys.push(repoResult.stateKey);
        groupStateKeys.set(groupName, keys);
      }
    }
  }

  await deps.saveState(state);
  await deps.writeCommitInfo(commitInfoEntries);
  let groupStateChanged = false;
  for (const groupName of groupsToSync) {
    try {
      await deps.syncGroupByName(groupName);
      for (const stateKey of groupStateKeys.get(groupName) ?? []) {
        if (state[stateKey].groupSyncPending) {
          state[stateKey].groupSyncPending = false;
          groupStateChanged = true;
        }
      }
    } catch (err: unknown) {
      result.failed += 1;
      for (const stateKey of groupStateKeys.get(groupName) ?? []) {
        if (!state[stateKey].groupSyncPending) {
          state[stateKey].groupSyncPending = true;
          groupStateChanged = true;
        }
      }
      logger.error(`[auto-sync] Group sync failed for ${groupName}: ${(err as Error).message}`);
    }
  }
  if (groupStateChanged) await deps.saveState(state);
  return result;
}

function shortErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').slice(0, 240);
}

export function getConfiguredRepoPath(
  project: Pick<AutoSyncProjectConfig, 'localPath'>,
  repoName: string,
  remoteUrl?: string,
): string {
  if (!remoteUrl) return path.resolve(project.localPath, repoName);
  const identity = getAutoSyncRepoIdentity(remoteUrl);
  return path.resolve(project.localPath, ...identity.split('/').slice(0, -1), repoName);
}

export async function addRepoToGroup(
  project: Pick<AutoSyncProjectConfig, 'groupName'>,
  groupPath: string,
  registryName = groupPath,
): Promise<boolean> {
  if (!project.groupName) return false;
  const groupDir = getGroupDir(getDefaultGitnexusDir(), project.groupName);
  const config = await loadGroupConfig(groupDir);
  if (config.repos[groupPath] === registryName) return false;
  if (config.repos[groupPath] !== undefined) {
    throw new Error(`group path ${groupPath} is already mapped to ${config.repos[groupPath]}`);
  }
  config.repos[groupPath] = registryName;
  await writeGroupConfigAtomic(path.join(groupDir, 'group.yaml'), config);
  return true;
}

export function getAutoSyncRepoIdentity(remoteUrl: string): string {
  validateAutoSyncRemoteUrl(remoteUrl);
  const [, host, remotePath] = /^git@([^:\s/]+):([^\s]+)$/.exec(remoteUrl.trim())!;
  return `${host.toLowerCase()}/${remotePath.replace(/\.git$/i, '')}`;
}

export async function syncGroupByName(groupName: string): Promise<void> {
  const groupDir = getGroupDir(getDefaultGitnexusDir(), groupName);
  const config = await loadGroupConfig(groupDir);
  await syncGroup(config, { groupDir });
}

async function writeGroupConfigAtomic(filePath: string, config: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, yaml.dump(config), 'utf-8');
  await fs.rename(tmpPath, filePath);
}

export function resolveActualConcurrency(configured: number, availableMemoryGB: number): number {
  const memoryLimit = Math.max(1, Math.floor(availableMemoryGB / 2));
  return Math.max(1, Math.min(configured, memoryLimit));
}

async function buildWorkItems(
  config: AutoSyncConfig,
  deps: AutoSyncRunDeps,
): Promise<AutoSyncWorkItem[]> {
  const items: AutoSyncWorkItem[] = [];
  const targetOwners = new Map<string, string>();
  for (const project of config.projects) {
    let cloneRoot: AutoSyncWorkItem['cloneRoot'];
    try {
      cloneRoot = await deps.resolveCloneRoot(project.localPath);
    } catch (err: unknown) {
      for (const remoteUrl of project.remoteUrls) {
        items.push({ project, remoteUrl, error: shortErrorMessage(err) });
      }
      continue;
    }
    for (const remoteUrl of project.remoteUrls) {
      try {
        const repoName = extractRepoNameFromRemoteUrl(remoteUrl);
        const targetDir = getConfiguredRepoPath({ localPath: cloneRoot.root }, repoName, remoteUrl);
        const previous = targetOwners.get(targetDir);
        if (previous !== undefined) {
          throw new Error(
            `Duplicate auto-sync targetDir ${targetDir} for ${previous} and ${remoteUrl}`,
          );
        }
        targetOwners.set(targetDir, remoteUrl);
        items.push({ project, remoteUrl, cloneRoot, repoName, targetDir });
      } catch (err: unknown) {
        items.push({ project, remoteUrl, error: shortErrorMessage(err) });
      }
    }
  }
  return items;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  signal: AbortSignal | undefined,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      throwIfAborted(signal);
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex]);
      throwIfAborted(signal);
    }
  });
  await Promise.all(runners);
  return results;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Auto-sync run cancelled.');
}

interface AutoSyncWorkItem {
  project: AutoSyncProjectConfig;
  remoteUrl: string;
  cloneRoot?: Awaited<ReturnType<typeof resolveConfiguredCloneRoot>>;
  repoName?: string;
  targetDir?: string;
  error?: string;
}

async function syncFirstAvailableBranch(input: {
  item: AutoSyncWorkItem;
  repoName: string;
  targetDir: string;
  timeoutMs: number;
  deps: AutoSyncRunDeps;
  logger: AutoSyncLogger;
}): Promise<
  | { ok: true; branch: string }
  | { ok: false; status: 'branch_unavailable' | 'sync_timeout'; message: string }
> {
  const failures: string[] = [];
  let sawTimeout = false;
  for (const branch of input.item.project.branches) {
    try {
      await input.deps.cloneOrPull(input.item.remoteUrl, input.targetDir, undefined, {
        allowedCloneRoot: input.item.cloneRoot!.root,
        expectedRepoName: input.repoName,
        quarantineRoot: input.item.cloneRoot!.quarantineRoot,
        allowAutoSyncSsh: true,
        timeoutMs: input.timeoutMs,
        branch,
        overwriteLocalChanges: input.item.project.overwriteLocalChanges,
      });
      const currentBranch = await input.deps.getCurrentBranch(input.targetDir, input.timeoutMs);
      if (currentBranch === branch) return { ok: true, branch };
      failures.push(`${branch}: checked out ${currentBranch ?? '<detached>'}`);
      input.logger.warn(
        `[auto-sync] Branch ${branch} for ${input.item.remoteUrl} synced but current branch is ${currentBranch ?? '<detached>'}; trying next branch.`,
      );
    } catch (err: unknown) {
      const message = (err as Error).message;
      if (message.includes('timed out')) sawTimeout = true;
      failures.push(`${branch}: ${message}`);
      input.logger.warn(
        `[auto-sync] Branch ${branch} unavailable for ${input.item.remoteUrl}: ${message}`,
      );
    }
  }
  return {
    ok: false,
    status: sawTimeout ? 'sync_timeout' : 'branch_unavailable',
    message: failures.join('; '),
  };
}
