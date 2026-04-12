import { JobManager, type AnalyzeJob } from './job-manager.js';

export type IndexJobKind = 'analyze' | 'embed';

export interface IndexJobSnapshot extends AnalyzeJob {
  kind: IndexJobKind;
}

/**
 * Read-only facade across multiple in-memory job managers.
 *
 * Keeps HTTP and future MCP write tools on a single query surface without
 * forcing them to understand where each job is stored.
 */
export class IndexJobQueryService {
  private readonly managers = new Map<IndexJobKind, JobManager>();

  register(kind: IndexJobKind, manager: JobManager): this {
    this.managers.set(kind, manager);
    return this;
  }

  getJob(jobId: string): IndexJobSnapshot | undefined {
    for (const [kind, manager] of this.managers) {
      const job = manager.getJob(jobId);
      if (job) {
        return { kind, ...job };
      }
    }

    return undefined;
  }

  listJobs(kind?: IndexJobKind): IndexJobSnapshot[] {
    if (kind) {
      return this.snapshotJobs(kind, this.managers.get(kind));
    }

    return Array.from(this.managers.entries())
      .flatMap(([currentKind, manager]) => this.snapshotJobs(currentKind, manager))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  private snapshotJobs(kind: IndexJobKind, manager?: JobManager): IndexJobSnapshot[] {
    if (!manager) return [];
    return manager
      .listJobs()
      .map((job: AnalyzeJob) => ({ kind, ...job }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }
}
