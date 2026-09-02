import path from 'node:path';
import fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'chokidar';
import { createWatchIgnorePredicate } from '../config/ignore-service.js';
import {
  analyzeFailureMayHaveMutatedLiveIndex,
  runFullAnalysis,
  type AnalyzeOptions as CoreAnalyzeOptions,
  type AnalyzeResult,
} from '../core/run-analyze.js';
import { getGitRoot, hasGitDir } from '../storage/git.js';
import type { AnalyzerRunnerIdentity } from '../storage/repo-manager.js';
import { GITNEXUS_DIR } from '../storage/repo-meta.js';
import {
  loadAnalyzeConfigStrict,
  mergeAnalyzeOptions,
  validateBranchName,
} from './analyze-config.js';
import type { AnalyzeOptions } from './analyze-options.js';
import { ensureHeap } from './analyze.js';
import { cliError, cliInfo, cliWarn } from './cli-message.js';
import {
  WATCH_FULL_REFRESH_PATH,
  WatchRefreshQueue,
  type WatchRefreshError,
} from './watch-queue.js';

const DEFAULT_DEBOUNCE_MS = 300;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_FILE_SIZE_KB = 32 * 1024;
const TRANSIENT_WATCH_ERROR_CODES = new Set(['EACCES', 'ENOENT', 'ENOTDIR', 'EPERM']);

export type WatchCliOptions = AnalyzeOptions;

function posixWatchPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

export function isRelevantWatchPath(filePath: string): boolean {
  const normalized = posixWatchPath(filePath);
  return (
    normalized.length > 0 &&
    normalized !== '.' &&
    !normalized.startsWith('../') &&
    !path.posix.isAbsolute(normalized) &&
    !path.win32.isAbsolute(filePath)
  );
}

function isIgnoreControlPath(filePath: string): boolean {
  const normalized = posixWatchPath(filePath);
  return normalized === '.gitignore' || normalized === '.gitnexusignore';
}

function isConfigControlPath(filePath: string): boolean {
  return posixWatchPath(filePath) === '.gitnexusrc';
}

function isAnalyzerOwnedWatchPath(filePath: string): boolean {
  const normalized = posixWatchPath(filePath).replace(/\/+$/, '');
  return normalized === GITNEXUS_DIR || normalized.startsWith(`${GITNEXUS_DIR}/`);
}

function repoRelativeWatchPath(repoPath: string, candidate: string): string | null {
  const relative = path.relative(repoPath, candidate).replace(/\\/g, '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  return relative;
}

export interface WatchEnvironmentBaseline {
  readonly maxFileSize: string | undefined;
  readonly workerTimeout: string | undefined;
  readonly verbose: string | undefined;
}

function setEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function positiveInteger(
  value: string | undefined,
  flag: string,
  maximum?: number,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${flag} must be a positive integer`);
  if (maximum !== undefined && parsed > maximum) {
    throw new Error(`${flag} must not exceed ${maximum}`);
  }
  return parsed;
}

export async function resolveWatchOptions(
  repoPath: string,
  cli: WatchCliOptions,
  baseline: WatchEnvironmentBaseline,
  reportIgnoredConfig: (names: readonly string[]) => void = () => {},
): Promise<CoreAnalyzeOptions> {
  const config = (await loadAnalyzeConfigStrict(repoPath)) ?? {};
  const merged = mergeAnalyzeOptions(cli, config);
  const unsupported = [
    ['--force', cli.force],
    ['--repair-fts', cli.repairFts],
    ['--embeddings', cli.embeddings],
    ['--drop-embeddings', cli.dropEmbeddings],
    ['--skills', cli.skills],
    ['--default-branch', cli.defaultBranch],
    ['--skip-agents-md', cli.skipAgentsMd],
    ['--skip-skills', cli.skipSkills],
    ['--no-stats', cli.stats === false],
    ['--self-commit', cli.selfCommit],
    ['--index-only', cli.indexOnly],
    ['--skip-git', cli.skipGit],
    ['--spring-actuator', cli.springActuator],
    // Rejected under --watch for the same reason as --spring-actuator: the
    // watcher reacts to source changes, and nothing watches an out-of-band
    // document directory. Honouring the flag here would read the documents once
    // and then quietly serve a stale answer for the rest of the session.
    ['--asyncapi-spec', cli.asyncapiSpec],
    ['walCheckpointThreshold', cli.walCheckpointThreshold],
    ['embeddingThreads', cli.embeddingThreads],
    ['embeddingBatchSize', cli.embeddingBatchSize],
    ['embeddingSubBatchSize', cli.embeddingSubBatchSize],
    ['embeddingDevice', cli.embeddingDevice],
    ['embeddingBaseUrl', cli.embeddingBaseUrl],
    ['embeddingModel', cli.embeddingModel],
    ['--embedding-auth-token', cli.embeddingAuthToken],
    ['--embedding-dims', cli.embeddingDims],
  ].filter(([, value]) => value !== undefined && value !== false);
  if (unsupported.length > 0) {
    throw new Error(
      `analyze --watch does not support ${unsupported.map(([name]) => name).join(', ')}`,
    );
  }
  reportIgnoredConfig(
    [
      ['embeddings', config.embeddings],
      ['dropEmbeddings', config.dropEmbeddings],
      ['defaultBranch', config.defaultBranch],
      ['skipAgentsMd', config.skipAgentsMd !== undefined],
      ['skipSkills', config.skipSkills !== undefined],
      ['stats', config.stats !== undefined],
      ['springActuator', config.springActuator],
      ['walCheckpointThreshold', config.walCheckpointThreshold],
      ['embeddingThreads', config.embeddingThreads],
      ['embeddingBatchSize', config.embeddingBatchSize],
      ['embeddingSubBatchSize', config.embeddingSubBatchSize],
      ['embeddingDevice', config.embeddingDevice],
      ['embeddingBaseUrl', config.embeddingBaseUrl],
      ['embeddingModel', config.embeddingModel],
    ]
      .filter(([, value]) => value !== undefined && value !== false)
      .map(([name]) => String(name)),
  );
  const branch =
    merged.branch === undefined ? undefined : validateBranchName(merged.branch, '--branch');
  const workerPoolSize = positiveInteger(merged.workers, '--workers');
  const workerTimeoutSeconds = positiveInteger(merged.workerTimeout, 'workerTimeout');
  const maxFileSize = positiveInteger(merged.maxFileSize, 'maxFileSize', MAX_FILE_SIZE_KB);

  setEnvironment(
    'GITNEXUS_MAX_FILE_SIZE',
    maxFileSize === undefined ? baseline.maxFileSize : String(maxFileSize),
  );
  if (workerTimeoutSeconds !== undefined) {
    process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS = String(workerTimeoutSeconds * 1000);
  } else {
    setEnvironment('GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS', baseline.workerTimeout);
  }
  setEnvironment('GITNEXUS_VERBOSE', merged.verbose ? '1' : baseline.verbose);

  return {
    pdg: merged.pdg,
    branch,
    registryName: merged.name,
    allowDuplicateName: merged.allowDuplicateName,
    workerPoolSize,
    fetchWrappers: merged.fetchWrappers,
    skipAgentsMd: true,
    skipSkills: true,
    noStats: true,
    atomicIncremental: process.platform !== 'win32',
  };
}

function refreshSummary(
  result: AnalyzeResult,
  observedPaths: readonly string[],
  durationMs: number,
  lastSuccessfulRefreshAt: string,
): string {
  const measured = result.incrementalStats;
  const changed = measured?.changedFiles ?? (result.alreadyUpToDate ? 0 : observedPaths.length);
  const reparsed =
    measured?.reparsedFiles ??
    (typeof result.pipelineResult?.reparsedFileCount === 'number'
      ? result.pipelineResult.reparsedFileCount
      : 0);
  const dependents = measured?.affectedDependents ?? 0;
  const mode = measured?.writeMode ?? (result.alreadyUpToDate ? 'no-op' : 'full');
  return (
    `Refresh complete: ${changed} changed, ${reparsed} re-parsed, ` +
    `${dependents} affected dependent(s), ${durationMs}ms, ${mode}; ` +
    `last success ${lastSuccessfulRefreshAt}`
  );
}

async function waitUntilReady(watcher: FSWatcher): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ready = () => {
      watcher.off('error', failed);
      resolve();
    };
    const failed = (error: unknown) => {
      watcher.off('ready', ready);
      reject(error);
    };
    watcher.once('ready', ready);
    watcher.once('error', failed);
  });
}

export interface WatchFileLoop {
  readonly waitForIdle: () => Promise<void>;
  readonly close: () => Promise<void>;
}

class WatchControlReloadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'WatchControlReloadError';
  }
}

export function shouldStopAfterWatchRefreshFailure(
  error: unknown,
  paths: readonly string[],
): boolean {
  return (
    paths.length > 0 &&
    !(error instanceof WatchControlReloadError) &&
    analyzeFailureMayHaveMutatedLiveIndex(error)
  );
}

/** Start the real filesystem watcher with bounded, serialized refreshes. */
export async function startWatchFileLoop(
  repoPath: string,
  debounceMs: number,
  refresh: (paths: readonly string[]) => Promise<void>,
  onError: WatchRefreshError,
  onWatcherError: (error: unknown) => void = (error) => onError(error, []),
): Promise<WatchFileLoop> {
  let ignorePath = await createWatchIgnorePredicate(repoPath);
  let ignoreControlValid = true;
  const queue = new WatchRefreshQueue(
    async (paths) => {
      if (paths.some(isIgnoreControlPath) || !ignoreControlValid) {
        const retryingInvalidControls = !ignoreControlValid;
        try {
          ignorePath = await createWatchIgnorePredicate(repoPath);
          ignoreControlValid = true;
          watcher.add(repoPath);
        } catch (error) {
          ignoreControlValid = false;
          throw new WatchControlReloadError(
            retryingInvalidControls
              ? new Error(
                  'Ignore controls remain invalid; fix them before indexing more changes.',
                  {
                    cause: error,
                  },
                )
              : error,
          );
        }
      }
      await refresh(paths);
    },
    onError,
    debounceMs,
    {
      maxWaitMs: Math.max(2_000, debounceMs * 10),
      maxPendingPaths: 1_000,
      holdEventsUntilInitialRefresh: true,
      isPriorityPath: (filePath) => isIgnoreControlPath(filePath) || isConfigControlPath(filePath),
    },
  );

  const watcher: FSWatcher = watch(repoPath, {
    ignoreInitial: true,
    atomic: true,
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
    ignored: (candidate, stats) => {
      const relative = repoRelativeWatchPath(repoPath, candidate);
      if (relative !== null && isAnalyzerOwnedWatchPath(relative)) return true;
      if (relative !== null && (isIgnoreControlPath(relative) || isConfigControlPath(relative))) {
        return false;
      }
      return ignorePath(candidate, stats?.isDirectory() ?? false);
    },
  });
  watcher.on('all', (event, changedPath) => {
    if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
    const relative = repoRelativeWatchPath(repoPath, changedPath);
    if (relative && isRelevantWatchPath(relative) && !isAnalyzerOwnedWatchPath(relative)) {
      queue.enqueue(relative);
    }
  });
  watcher.on('error', (error) => {
    // Chokidar can surface a transient EPERM on Windows while an ignored
    // analyzer-owned path is replaced. Re-arm the root and force one bounded
    // catch-up refresh so a missed event cannot leave the graph stale. Other
    // watcher errors may mean coverage was lost and remain fatal.
    if (TRANSIENT_WATCH_ERROR_CODES.has((error as NodeJS.ErrnoException).code ?? '')) {
      watcher.add(repoPath);
      queue.enqueue(WATCH_FULL_REFRESH_PATH);
      return;
    }
    onWatcherError(error);
  });

  try {
    await waitUntilReady(watcher);
    await queue.runInitial();
  } catch (error) {
    await watcher.close();
    await queue.close();
    throw error;
  }

  return {
    waitForIdle: () => queue.waitForIdle(),
    close: async () => {
      await watcher.close();
      await queue.close();
    },
  };
}

export async function watchCommandWithRunnerIdentity(
  runnerIdentityAtBootstrap: AnalyzerRunnerIdentity,
  inputPath?: string,
  cliOptions: WatchCliOptions = {},
): Promise<void> {
  if (await ensureHeap({ cleanForwardedTermination: true })) return;

  const requestedRepoPath = inputPath ? path.resolve(inputPath) : getGitRoot(process.cwd());
  if (requestedRepoPath === null || !hasGitDir(requestedRepoPath)) {
    cliError('  gitnexus analyze --watch requires a Git repository.');
    process.exitCode = 1;
    return;
  }
  const repoPath = await fs.realpath(requestedRepoPath);
  const baselineEnvironment: WatchEnvironmentBaseline = {
    maxFileSize: process.env.GITNEXUS_MAX_FILE_SIZE,
    workerTimeout: process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS,
    verbose: process.env.GITNEXUS_VERBOSE,
  };
  try {
    let ignoredConfigSignature: string | undefined;
    const reportIgnoredConfig = (names: readonly string[]) => {
      const signature = [...names].sort().join(',');
      if (signature === ignoredConfigSignature) return;
      ignoredConfigSignature = signature;
      if (names.length > 0) {
        cliWarn(`Watch mode ignores unsupported .gitnexusrc settings: ${names.join(', ')}.`);
      }
    };
    let debounceMs: number;
    let analyzeOptions: CoreAnalyzeOptions;
    try {
      debounceMs =
        positiveInteger(
          cliOptions.debounce ?? String(DEFAULT_DEBOUNCE_MS),
          '--debounce',
          MAX_TIMER_DELAY_MS,
        ) ?? DEFAULT_DEBOUNCE_MS;
      analyzeOptions = await resolveWatchOptions(
        repoPath,
        cliOptions,
        baselineEnvironment,
        reportIgnoredConfig,
      );
    } catch (error) {
      cliError(`  ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }

    let stopWatching!: () => void;
    const stopped = new Promise<void>((resolve) => {
      stopWatching = resolve;
    });
    const stop = () => stopWatching();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      let loop: WatchFileLoop;
      let fatalRefreshError: unknown;
      let configControlValid = true;
      let lastSuccessfulRefreshAt: string | undefined;
      try {
        loop = await startWatchFileLoop(
          repoPath,
          debounceMs,
          async (paths) => {
            if (paths.some(isConfigControlPath) || !configControlValid) {
              const retryingInvalidConfig = !configControlValid;
              try {
                analyzeOptions = await resolveWatchOptions(
                  repoPath,
                  cliOptions,
                  baselineEnvironment,
                  reportIgnoredConfig,
                );
                configControlValid = true;
              } catch (error) {
                configControlValid = false;
                throw new WatchControlReloadError(
                  retryingInvalidConfig
                    ? new Error(
                        'Configuration remains invalid; fix it before indexing more changes.',
                        {
                          cause: error,
                        },
                      )
                    : error,
                );
              }
            }
            const startedAt = Date.now();
            const result = await runFullAnalysis(
              repoPath,
              analyzeOptions,
              {
                onProgress: () => {},
                onLog:
                  process.env.GITNEXUS_VERBOSE === '1'
                    ? (message) => cliInfo(`  ${message}`)
                    : undefined,
              },
              runnerIdentityAtBootstrap,
            );
            lastSuccessfulRefreshAt = new Date().toISOString();
            if (paths.length === 0) {
              cliInfo(
                result.alreadyUpToDate
                  ? `Watching ${repoPath}; index is up to date.`
                  : `Watching ${repoPath}; initial index ready in ${Date.now() - startedAt}ms.`,
              );
            } else {
              cliInfo(
                refreshSummary(result, paths, Date.now() - startedAt, lastSuccessfulRefreshAt),
              );
            }
          },
          (error, paths) => {
            const detail = paths.length > 0 ? ` (${paths.length} queued path(s))` : '';
            if (shouldStopAfterWatchRefreshFailure(error, paths)) {
              fatalRefreshError = error;
              cliError(
                `Refresh failed${detail}: ${error instanceof Error ? error.message : String(error)}. ` +
                  'Watch mode is stopping because the live index may have been updated in place.',
              );
              stopWatching();
              return;
            }
            const lastSuccess = lastSuccessfulRefreshAt ?? 'none yet';
            cliWarn(
              `Refresh failed${detail}: ${error instanceof Error ? error.message : String(error)}. ` +
                `Retry scheduled; last success ${lastSuccess}.`,
            );
          },
          (error) => {
            fatalRefreshError = error;
            cliError(
              `Watcher failed: ${error instanceof Error ? error.message : String(error)}. ` +
                'Watch mode is stopping.',
            );
            stopWatching();
          },
        );
      } catch (error) {
        cliError(
          `  Unable to start watcher: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
        return;
      }

      await stopped;
      await loop.close();
      if (fatalRefreshError !== undefined) process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } finally {
    setEnvironment('GITNEXUS_MAX_FILE_SIZE', baselineEnvironment.maxFileSize);
    setEnvironment('GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS', baselineEnvironment.workerTimeout);
    setEnvironment('GITNEXUS_VERBOSE', baselineEnvironment.verbose);
  }
}
