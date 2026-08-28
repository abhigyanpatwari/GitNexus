import path from 'node:path';
import fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'chokidar';
import { getLanguageFromFilename } from 'gitnexus-shared';
import { createWatchIgnorePredicate } from '../config/ignore-service.js';
import { isTemplateRouteCandidate } from '../core/ingestion/pipeline-phases/routes.js';
import { classifySpringAutoConfigurationMetadata } from '../core/ingestion/pipeline-phases/spring-auto-configuration.js';
import { classifySpringConfigFile } from '../core/ingestion/pipeline-phases/spring-config.js';
import {
  analyzeFailureMayHaveMutatedLiveIndex,
  runFullAnalysis,
  type AnalyzeOptions as CoreAnalyzeOptions,
  type AnalyzeResult,
} from '../core/run-analyze.js';
import { getGitRoot, hasGitDir } from '../storage/git.js';
import type { AnalyzerRunnerIdentity } from '../storage/repo-manager.js';
import { loadAnalyzeConfig, mergeAnalyzeOptions, validateBranchName } from './analyze-config.js';
import type { AnalyzeOptions } from './analyze-options.js';
import { ensureHeap } from './analyze.js';
import { cliError, cliInfo, cliWarn } from './cli-message.js';
import {
  WATCH_FULL_REFRESH_PATH,
  WatchRefreshQueue,
  type WatchRefreshError,
} from './watch-queue.js';

const DEFAULT_DEBOUNCE_MS = 300;
const WATCH_CONFIG_NAMES = new Set([
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'composer.json',
  'Gemfile',
  'pubspec.yaml',
]);
const WATCH_CONFIG_SUFFIXES = ['.csproj', '.fsproj', '.vbproj', '.sln', '.vcxproj'];

export type WatchCliOptions = AnalyzeOptions;

export function isRelevantWatchPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const base = path.posix.basename(normalized);
  const lower = normalized.toLowerCase();
  return (
    isIgnoreControlPath(normalized) ||
    isConfigControlPath(normalized) ||
    getLanguageFromFilename(normalized) !== null ||
    lower.endsWith('.md') ||
    lower.endsWith('.mdx') ||
    isTemplateRouteCandidate(normalized) ||
    classifySpringConfigFile(normalized) !== null ||
    classifySpringAutoConfigurationMetadata(normalized) !== null ||
    WATCH_CONFIG_NAMES.has(base) ||
    WATCH_CONFIG_SUFFIXES.some((suffix) => base.endsWith(suffix))
  );
}

function isIgnoreControlPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  return normalized === '.gitignore' || normalized === '.gitnexusignore';
}

function isConfigControlPath(filePath: string): boolean {
  return filePath.replace(/\\/g, '/').replace(/^\.\/+/, '') === '.gitnexusrc';
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

function positiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

export function resolveWatchOptions(
  repoPath: string,
  cli: WatchCliOptions,
  baseline: WatchEnvironmentBaseline,
): CoreAnalyzeOptions {
  const merged = mergeAnalyzeOptions(
    cli,
    loadAnalyzeConfig(repoPath, { strictRepoControlFile: true }),
  );
  const unsupported = [
    ['--force', merged.force],
    ['--repair-fts', merged.repairFts],
    ['--embeddings', merged.embeddings],
    ['--drop-embeddings', merged.dropEmbeddings],
    ['--skills', merged.skills],
    ['--self-commit', merged.selfCommit],
    ['--index-only', merged.indexOnly],
    ['--skip-git', merged.skipGit],
    ['walCheckpointThreshold', merged.walCheckpointThreshold],
    ['embeddingThreads', merged.embeddingThreads],
    ['embeddingBatchSize', merged.embeddingBatchSize],
    ['embeddingSubBatchSize', merged.embeddingSubBatchSize],
    ['embeddingDevice', merged.embeddingDevice],
    ['embeddingBaseUrl', merged.embeddingBaseUrl],
    ['embeddingModel', merged.embeddingModel],
    ['--embedding-auth-token', merged.embeddingAuthToken],
    ['--embedding-dims', merged.embeddingDims],
  ].filter(([, value]) => value !== undefined && value !== false);
  if (unsupported.length > 0) {
    throw new Error(
      `analyze --watch does not support ${unsupported.map(([name]) => name).join(', ')}`,
    );
  }
  const branch =
    merged.branch === undefined ? undefined : validateBranchName(merged.branch, '--branch');
  const workerPoolSize = positiveInteger(merged.workers, '--workers');
  const workerTimeoutSeconds = positiveInteger(merged.workerTimeout, 'workerTimeout');
  positiveInteger(merged.maxFileSize, 'maxFileSize');

  setEnvironment('GITNEXUS_MAX_FILE_SIZE', merged.maxFileSize ?? baseline.maxFileSize);
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
    `last success ${new Date().toISOString()}`
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
      if (paths.some(isIgnoreControlPath)) {
        try {
          ignorePath = await createWatchIgnorePredicate(repoPath);
          ignoreControlValid = true;
          watcher.add(repoPath);
        } catch (error) {
          ignoreControlValid = false;
          throw new WatchControlReloadError(error);
        }
      }
      if (!ignoreControlValid) {
        throw new WatchControlReloadError(
          new Error('Ignore controls remain invalid; fix them before indexing more changes.'),
        );
      }
      await refresh(paths);
    },
    onError,
    debounceMs,
    {
      maxWaitMs: Math.max(2_000, debounceMs * 10),
      maxPendingPaths: 1_000,
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
      if (relative !== null && (isIgnoreControlPath(relative) || isConfigControlPath(relative))) {
        return false;
      }
      return ignorePath(candidate, stats?.isDirectory() ?? false);
    },
  });
  watcher.on('all', (event, changedPath) => {
    if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
    const relative = path.relative(repoPath, changedPath).replace(/\\/g, '/');
    if (
      relative &&
      !relative.startsWith('../') &&
      !path.isAbsolute(relative) &&
      isRelevantWatchPath(relative)
    ) {
      queue.enqueue(relative);
    }
  });
  watcher.on('error', (error) => {
    // Chokidar can surface a transient EPERM on Windows while an ignored
    // analyzer-owned path is replaced. Re-arm the root and force one bounded
    // catch-up refresh so a missed event cannot leave the graph stale. Other
    // watcher errors may mean coverage was lost and remain fatal.
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
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
  if (await ensureHeap()) return;

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

  let debounceMs: number;
  let analyzeOptions: CoreAnalyzeOptions;
  try {
    debounceMs =
      positiveInteger(cliOptions.debounce ?? String(DEFAULT_DEBOUNCE_MS), '--debounce') ??
      DEFAULT_DEBOUNCE_MS;
    analyzeOptions = resolveWatchOptions(repoPath, cliOptions, baselineEnvironment);
  } catch (error) {
    cliError(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  let loop: WatchFileLoop;
  let stopWatching: (() => void) | undefined;
  let fatalRefreshError: unknown;
  let configControlValid = true;
  try {
    loop = await startWatchFileLoop(
      repoPath,
      debounceMs,
      async (paths) => {
        if (paths.some(isConfigControlPath)) {
          try {
            analyzeOptions = resolveWatchOptions(repoPath, cliOptions, baselineEnvironment);
            configControlValid = true;
          } catch (error) {
            configControlValid = false;
            throw new WatchControlReloadError(error);
          }
        }
        if (!configControlValid) {
          throw new WatchControlReloadError(
            new Error('Configuration remains invalid; fix .gitnexusrc before indexing changes.'),
          );
        }
        const startedAt = Date.now();
        const result = await runFullAnalysis(
          repoPath,
          analyzeOptions,
          {
            onProgress: () => {},
            onLog: cliOptions.verbose ? (message) => cliInfo(`  ${message}`) : undefined,
          },
          runnerIdentityAtBootstrap,
        );
        if (paths.length === 0) {
          cliInfo(
            result.alreadyUpToDate
              ? `Watching ${repoPath}; index is up to date.`
              : `Watching ${repoPath}; initial index ready in ${Date.now() - startedAt}ms.`,
          );
        } else {
          cliInfo(refreshSummary(result, paths, Date.now() - startedAt));
        }
      },
      (error, paths) => {
        const detail = paths.length > 0 ? ` (${paths.length} queued path(s))` : '';
        if (
          paths.length > 0 &&
          (analyzeOptions.atomicIncremental === false ||
            analyzeFailureMayHaveMutatedLiveIndex(error)) &&
          !(error instanceof WatchControlReloadError)
        ) {
          fatalRefreshError = error;
          cliError(
            `Refresh failed${detail}: ${error instanceof Error ? error.message : String(error)}. ` +
              'Watch mode is stopping because this platform updates the live index in place.',
          );
          stopWatching?.();
          return;
        }
        cliWarn(
          `Refresh failed${detail}: ${error instanceof Error ? error.message : String(error)}. ` +
            'Watching continues; the next change will retry.',
        );
      },
      (error) => {
        fatalRefreshError = error;
        cliError(
          `Watcher failed: ${error instanceof Error ? error.message : String(error)}. ` +
            'Watch mode is stopping.',
        );
        stopWatching?.();
      },
    );
  } catch (error) {
    cliError(
      `  Unable to start watcher: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  await new Promise<void>((resolve) => {
    stopWatching = resolve;
    if (fatalRefreshError !== undefined) {
      resolve();
      return;
    }
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await loop.close();
  if (fatalRefreshError !== undefined) process.exitCode = 1;
}
