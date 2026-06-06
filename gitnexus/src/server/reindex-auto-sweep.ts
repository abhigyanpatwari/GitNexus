import type { StalenessInfo } from '../core/git-staleness.js';
import type { ReindexQueueAction, ReindexTarget, ReindexRequestOptions } from './reindex-control.js';

export interface AutoReindexSweepRepo extends ReindexTarget {
  lastCommit?: string;
}

export interface AutoReindexSweepEntry {
  repo: AutoReindexSweepRepo;
  staleness: StalenessInfo;
}

export interface AutoReindexSweepPlan {
  stale: AutoReindexSweepEntry[];
  fresh: AutoReindexSweepEntry[];
}

export interface AutoReindexSweepResult extends AutoReindexSweepPlan {
  dryRun: AutoReindexSweepEntry[];
  started: AutoReindexSweepEntry[];
}

export interface AutoReindexSweepPlannerOptions {
  loadRepos: () => Promise<AutoReindexSweepRepo[]>;
  checkStaleness: (repoPath: string, lastCommit: string) => Promise<StalenessInfo>;
}

export const planAutoReindexSweep = async (
  options: AutoReindexSweepPlannerOptions,
): Promise<AutoReindexSweepPlan> => {
  const repos = await options.loadRepos();
  const stale: AutoReindexSweepEntry[] = [];
  const fresh: AutoReindexSweepEntry[] = [];

  for (const repo of repos) {
    const lastCommit = repo.lastCommit ?? '';
    const staleness = await options.checkStaleness(repo.path, lastCommit);
    const entry = { repo, staleness };
    if (staleness.isStale) {
      stale.push(entry);
    } else {
      fresh.push(entry);
    }
  }

  return { stale, fresh };
};

export interface AutoReindexSweepRunnerOptions extends AutoReindexSweepPlannerOptions {
  dryRun: boolean;
  embeddings: boolean;
  requestQueue: (repoKey: string) => ReindexQueueAction;
  startReindex: (
    repo: AutoReindexSweepRepo,
    repoKey: string,
    options: ReindexRequestOptions,
  ) => void | Promise<void>;
}

export const runAutoReindexSweep = async (
  options: AutoReindexSweepRunnerOptions,
): Promise<AutoReindexSweepResult> => {
  const plan = await planAutoReindexSweep(options);
  const result: AutoReindexSweepResult = {
    ...plan,
    dryRun: [],
    started: [],
  };

  for (const entry of plan.stale) {
    if (options.dryRun) {
      result.dryRun.push(entry);
      continue;
    }

    const repoKey = entry.repo.id ?? entry.repo.name;
    const queueAction = options.requestQueue(repoKey);
    if (queueAction.action !== 'start') continue;

    await options.startReindex(entry.repo, repoKey, {
      force: true,
      embeddings: options.embeddings,
    });
    result.started.push(entry);
  }

  return result;
};
