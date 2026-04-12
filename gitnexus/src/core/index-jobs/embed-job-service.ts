import path from 'path';
import { executeQuery, executeWithReusedStatement, withLbugDb } from '../lbug/lbug-adapter.js';
import {
  loadCLIConfig,
  saveCLIConfig,
  type CLIEmbeddingConfig,
} from '../../storage/repo-manager.js';
import { JobManager, type AnalyzeJob } from './job-manager.js';
import { RepoLockManager } from './repo-lock-manager.js';

export interface StartEmbedJobParams {
  repoName: string;
  storagePath: string;
  embedding?: CLIEmbeddingConfig;
  saveConfig?: boolean;
}

export interface EmbedJobServiceOptions {
  repoLocks: RepoLockManager;
  jobManager?: JobManager;
}

export class EmbedJobService {
  readonly jobManager: JobManager;

  private readonly repoLocks: RepoLockManager;

  constructor(options: EmbedJobServiceOptions) {
    this.repoLocks = options.repoLocks;
    this.jobManager = options.jobManager ?? new JobManager();
  }

  async startJob(params: StartEmbedJobParams): Promise<AnalyzeJob> {
    if (params.saveConfig && params.embedding) {
      const existing = await loadCLIConfig();
      await saveCLIConfig({
        ...existing,
        embedding: {
          ...(existing.embedding ?? {}),
          ...params.embedding,
        },
      });
    }

    const job = this.jobManager.createJob({ repoPath: params.storagePath });
    if (job.status !== 'queued') {
      return job;
    }

    const repoLockPath = params.storagePath;
    const lockErr = this.repoLocks.acquire(repoLockPath);
    if (lockErr) {
      this.jobManager.updateJob(job.id, { status: 'failed', error: lockErr });
      return job;
    }

    this.jobManager.updateJob(job.id, {
      repoName: params.repoName,
      status: 'analyzing',
      progress: { phase: 'analyzing', percent: 0, message: 'Starting embedding generation...' },
    });

    const EMBED_TIMEOUT_MS = 30 * 60 * 1000;
    const embedTimeout = setTimeout(() => {
      const current = this.jobManager.getJob(job.id);
      if (current && current.status !== 'complete' && current.status !== 'failed') {
        this.repoLocks.release(repoLockPath);
        this.jobManager.updateJob(job.id, {
          status: 'failed',
          error: 'Embedding timed out (30 minute limit)',
        });
      }
    }, EMBED_TIMEOUT_MS);

    void (async () => {
      try {
        const lbugPath = path.join(params.storagePath, 'lbug');
        await withLbugDb(lbugPath, async () => {
          const { runEmbeddingPipeline } = await import('../embeddings/embedding-pipeline.js');
          await runEmbeddingPipeline(executeQuery, executeWithReusedStatement, (progress) => {
            this.jobManager.updateJob(job.id, {
              progress: {
                phase:
                  progress.phase === 'ready'
                    ? 'complete'
                    : progress.phase === 'error'
                      ? 'failed'
                      : progress.phase,
                percent: progress.percent,
                message:
                  progress.phase === 'loading-model'
                    ? 'Loading embedding model...'
                    : progress.phase === 'embedding'
                      ? `Embedding nodes (${progress.percent}%)...`
                      : progress.phase === 'indexing'
                        ? 'Creating vector index...'
                        : progress.phase === 'ready'
                          ? 'Embeddings complete'
                          : `${progress.phase} (${progress.percent}%)`,
              },
            });
          });
        });

        clearTimeout(embedTimeout);
        this.repoLocks.release(repoLockPath);
        const current = this.jobManager.getJob(job.id);
        if (!current || current.status !== 'failed') {
          this.jobManager.updateJob(job.id, { status: 'complete' });
        }
      } catch (err: any) {
        clearTimeout(embedTimeout);
        this.repoLocks.release(repoLockPath);
        const current = this.jobManager.getJob(job.id);
        if (!current || current.status !== 'failed') {
          this.jobManager.updateJob(job.id, {
            status: 'failed',
            error: err.message || 'Embedding generation failed',
          });
        }
      }
    })();

    return job;
  }

  getJob(jobId: string): AnalyzeJob | undefined {
    return this.jobManager.getJob(jobId);
  }

  cancelJob(jobId: string, reason?: string): boolean {
    return this.jobManager.cancelJob(jobId, reason);
  }

  dispose(): void {
    this.jobManager.dispose();
  }
}
