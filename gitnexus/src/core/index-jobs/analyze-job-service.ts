import path from 'path';
import { fork } from 'child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'url';
import { getStoragePath } from '../../storage/repo-manager.js';
import { cloneOrPull, extractRepoName, getCloneDir } from '../../server/git-clone.js';
import { type AnalyzeOptions } from '../run-analyze.js';
import { JobManager, type AnalyzeJob } from './job-manager.js';
import { RepoLockManager } from './repo-lock-manager.js';

const _require = createRequire(import.meta.url);
const MAX_WORKER_RETRIES = 2;

interface StartMessage {
  type: 'start';
  repoPath: string;
  options: AnalyzeOptions;
}

interface ProgressMessage {
  type: 'progress';
  phase: string;
  percent: number;
  message: string;
}

interface CompleteMessage {
  type: 'complete';
  result: { repoName: string };
}

interface ErrorMessage {
  type: 'error';
  message: string;
}

type WorkerMessage = ProgressMessage | CompleteMessage | ErrorMessage;

export interface StartAnalyzeJobParams {
  repoUrl?: string;
  repoPath?: string;
  force?: boolean;
  embeddings?: boolean;
}

export interface AnalyzeJobServiceOptions {
  backendInit: () => Promise<void>;
  repoLocks: RepoLockManager;
  jobManager?: JobManager;
  logger?: Pick<Console, 'warn' | 'error'>;
}

export class AnalyzeJobService {
  readonly jobManager: JobManager;

  private readonly backendInit: () => Promise<void>;
  private readonly repoLocks: RepoLockManager;
  private readonly logger: Pick<Console, 'warn' | 'error'>;
  private readonly workerPath: string;
  private readonly tsxHookArgs: string[];

  constructor(options: AnalyzeJobServiceOptions) {
    this.backendInit = options.backendInit;
    this.repoLocks = options.repoLocks;
    this.jobManager = options.jobManager ?? new JobManager();
    this.logger = options.logger ?? console;

    const callerPath = fileURLToPath(import.meta.url);
    const isDev = callerPath.endsWith('.ts');
    const workerFile = isDev ? 'analyze-worker.ts' : 'analyze-worker.js';
    this.workerPath = path.join(path.dirname(callerPath), '..', '..', 'server', workerFile);
    this.tsxHookArgs = isDev ? ['--import', pathToFileURL(_require.resolve('tsx/esm')).href] : [];
  }

  startJob(params: StartAnalyzeJobParams): AnalyzeJob {
    const job = this.jobManager.createJob({
      repoUrl: params.repoUrl,
      repoPath: params.repoPath,
    });

    if (job.status !== 'queued') {
      return job;
    }

    this.jobManager.updateJob(job.id, { status: 'cloning' });
    void this.runJob(job.id, params);

    return job;
  }

  getJob(jobId: string): AnalyzeJob | undefined {
    return this.jobManager.getJob(jobId);
  }

  listJobs(): AnalyzeJob[] {
    return this.jobManager.listJobs();
  }

  cancelJob(jobId: string, reason?: string): boolean {
    return this.jobManager.cancelJob(jobId, reason);
  }

  dispose(): void {
    this.jobManager.dispose();
  }

  private async runJob(jobId: string, params: StartAnalyzeJobParams): Promise<void> {
    let targetPath = params.repoPath;
    let repoLockKey: string | null = null;

    const releaseRepoLock = () => {
      if (repoLockKey) {
        this.repoLocks.release(repoLockKey);
        repoLockKey = null;
      }
    };

    try {
      if (params.repoUrl && !params.repoPath) {
        const repoName = extractRepoName(params.repoUrl);
        targetPath = getCloneDir(repoName);

        this.jobManager.updateJob(jobId, {
          status: 'cloning',
          repoName,
          progress: { phase: 'cloning', percent: 0, message: `Cloning ${params.repoUrl}...` },
        });

        await cloneOrPull(params.repoUrl, targetPath, (progress) => {
          this.jobManager.updateJob(jobId, {
            progress: { phase: progress.phase, percent: 5, message: progress.message },
          });
        });
      }

      if (!targetPath) {
        throw new Error('No target path resolved');
      }

      repoLockKey = getStoragePath(targetPath);
      const lockErr = this.repoLocks.acquire(repoLockKey);
      if (lockErr) {
        this.jobManager.updateJob(jobId, { status: 'failed', error: lockErr });
        return;
      }

      this.jobManager.updateJob(jobId, { repoPath: targetPath, status: 'analyzing' });
      this.forkWorker(jobId, targetPath, repoLockKey, {
        force: !!params.force,
        embeddings: !!params.embeddings,
      });
    } catch (err: any) {
      releaseRepoLock();
      this.jobManager.updateJob(jobId, {
        status: 'failed',
        error: err.message || 'Analysis failed',
      });
    }
  }

  private forkWorker(
    jobId: string,
    targetPath: string,
    repoLockKey: string,
    options: AnalyzeOptions,
  ) {
    const currentJob = this.jobManager.getJob(jobId);
    if (!currentJob || this.isTerminal(currentJob.status)) {
      return;
    }

    const child = fork(this.workerPath, [], {
      execArgv: [...this.tsxHookArgs, '--max-old-space-size=8192'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let stderrChunks = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks += chunk.toString();
      if (stderrChunks.length > 4096) {
        stderrChunks = stderrChunks.slice(-4096);
      }
    });

    child.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'progress') {
        this.jobManager.updateJob(jobId, {
          status: 'analyzing',
          progress: { phase: msg.phase, percent: msg.percent, message: msg.message },
        });
        return;
      }

      this.repoLocks.release(repoLockKey);

      if (msg.type === 'complete') {
        this.backendInit()
          .then(() => {
            this.jobManager.updateJob(jobId, {
              status: 'complete',
              repoName: msg.result.repoName,
            });
          })
          .catch((err) => {
            this.logger.error('backend.init() failed after analyze:', err);
            this.jobManager.updateJob(jobId, {
              status: 'failed',
              error: 'Server failed to reload after analysis. Try again.',
            });
          });
        return;
      }

      this.jobManager.updateJob(jobId, {
        status: 'failed',
        error: msg.message,
      });
    });

    child.on('error', (err) => {
      this.repoLocks.release(repoLockKey);
      this.jobManager.updateJob(jobId, {
        status: 'failed',
        error: `Worker process error: ${err.message}`,
      });
    });

    child.on('exit', (code) => {
      const job = this.jobManager.getJob(jobId);
      if (!job || this.isTerminal(job.status)) {
        return;
      }

      if (job.retryCount < MAX_WORKER_RETRIES) {
        job.retryCount++;
        const delay = 1000 * Math.pow(2, job.retryCount - 1);
        const lastErr = stderrChunks.trim().split('\n').pop() || '';
        this.logger.warn(
          `Analyze worker crashed (code ${code}), retry ${job.retryCount}/${MAX_WORKER_RETRIES} in ${delay}ms` +
            (lastErr ? `: ${lastErr}` : ''),
        );
        this.jobManager.updateJob(jobId, {
          status: 'analyzing',
          progress: {
            phase: 'retrying',
            percent: job.progress.percent,
            message: `Worker crashed, retrying (${job.retryCount}/${MAX_WORKER_RETRIES})...`,
          },
        });
        stderrChunks = '';
        setTimeout(() => this.forkWorker(jobId, targetPath, repoLockKey, options), delay);
        return;
      }

      this.repoLocks.release(repoLockKey);
      this.jobManager.updateJob(jobId, {
        status: 'failed',
        error: `Worker crashed ${MAX_WORKER_RETRIES + 1} times (code ${code})${stderrChunks ? ': ' + stderrChunks.trim().split('\n').pop() : ''}`,
      });
    });

    this.jobManager.registerChild(jobId, child);

    const startMessage: StartMessage = {
      type: 'start',
      repoPath: targetPath,
      options,
    };
    child.send(startMessage);
  }

  private isTerminal(status: AnalyzeJob['status']): boolean {
    return status === 'complete' || status === 'failed';
  }
}
