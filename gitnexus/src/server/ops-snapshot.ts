/**
 * Ops / execution dashboard snapshot helpers.
 *
 * Pure serialization + metrics over in-memory JobManager state so the
 * HTTP route stays thin and unit tests do not boot Express.
 */

import {
  isTerminalJobStatus,
  type AnalyzeJob,
  type AnalyzeJobStatus,
} from './analyze-job.js';

export interface OpsJobView {
  id: string;
  lane: 'analyze' | 'embed';
  status: AnalyzeJobStatus;
  repoUrl?: string;
  repoPath?: string;
  repoName?: string;
  branch?: string;
  progress: AnalyzeJob['progress'];
  error?: string;
  partial?: AnalyzeJob['partial'];
  startedAt: number;
  completedAt?: number;
  retryCount: number;
  /** Elapsed wall time; uses completedAt when terminal, else `now`. */
  durationMs: number;
}

export interface OpsLaneMetrics {
  total: number;
  active: number;
  queued: number;
  complete: number;
  failed: number;
  byStatus: Record<AnalyzeJobStatus, number>;
  /** Mean duration of terminal jobs that have completedAt; null when none. */
  avgDurationMs: number | null;
  /** Max duration among terminal jobs; null when none. */
  maxDurationMs: number | null;
  /** Sum of progress.percent across non-terminal jobs (0–100 each). */
  activeProgressSum: number;
}

export interface OpsSnapshot {
  generatedAt: number;
  uptimeMs: number;
  health: 'ok';
  server: {
    version: string;
    launchContext: string;
    nodeVersion: string;
    latestVersion?: string;
    updateAvailable?: boolean;
  };
  analyze: {
    jobs: OpsJobView[];
    metrics: OpsLaneMetrics;
  };
  embed: {
    jobs: OpsJobView[];
    metrics: OpsLaneMetrics;
  };
  totals: {
    jobs: number;
    active: number;
    failed: number;
    complete: number;
  };
}

const emptyByStatus = (): Record<AnalyzeJobStatus, number> => ({
  queued: 0,
  cloning: 0,
  analyzing: 0,
  loading: 0,
  complete: 0,
  failed: 0,
});

export const serializeOpsJob = (
  job: AnalyzeJob,
  lane: 'analyze' | 'embed',
  now: number = Date.now(),
): OpsJobView => {
  const end = job.completedAt ?? now;
  return {
    id: job.id,
    lane,
    status: job.status,
    repoUrl: job.repoUrl,
    repoPath: job.repoPath,
    repoName: job.repoName,
    branch: job.branch,
    progress: job.progress,
    error: job.error,
    partial: job.partial,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    retryCount: job.retryCount,
    durationMs: Math.max(0, end - job.startedAt),
  };
};

export const summarizeOpsLane = (jobs: OpsJobView[]): OpsLaneMetrics => {
  const byStatus = emptyByStatus();
  let active = 0;
  let queued = 0;
  let complete = 0;
  let failed = 0;
  let durationSum = 0;
  let durationCount = 0;
  let maxDurationMs: number | null = null;
  let activeProgressSum = 0;

  for (const job of jobs) {
    byStatus[job.status] += 1;
    if (job.status === 'queued') queued += 1;
    if (job.status === 'complete') complete += 1;
    if (job.status === 'failed') failed += 1;
    if (!isTerminalJobStatus(job.status)) {
      active += 1;
      activeProgressSum += Math.max(0, Math.min(100, job.progress.percent));
    } else if (job.completedAt !== undefined) {
      durationSum += job.durationMs;
      durationCount += 1;
      maxDurationMs =
        maxDurationMs === null ? job.durationMs : Math.max(maxDurationMs, job.durationMs);
    }
  }

  return {
    total: jobs.length,
    active,
    queued,
    complete,
    failed,
    byStatus,
    avgDurationMs: durationCount === 0 ? null : Math.round(durationSum / durationCount),
    maxDurationMs,
    activeProgressSum,
  };
};

export const buildOpsSnapshot = (input: {
  analyzeJobs: AnalyzeJob[];
  embedJobs: AnalyzeJob[];
  serverStartedAt: number;
  server: OpsSnapshot['server'];
  now?: number;
}): OpsSnapshot => {
  const now = input.now ?? Date.now();
  const analyzeJobs = input.analyzeJobs
    .map((j) => serializeOpsJob(j, 'analyze', now))
    .sort((a, b) => b.startedAt - a.startedAt);
  const embedJobs = input.embedJobs
    .map((j) => serializeOpsJob(j, 'embed', now))
    .sort((a, b) => b.startedAt - a.startedAt);
  const analyze = { jobs: analyzeJobs, metrics: summarizeOpsLane(analyzeJobs) };
  const embed = { jobs: embedJobs, metrics: summarizeOpsLane(embedJobs) };

  return {
    generatedAt: now,
    uptimeMs: Math.max(0, now - input.serverStartedAt),
    health: 'ok',
    server: input.server,
    analyze,
    embed,
    totals: {
      jobs: analyze.metrics.total + embed.metrics.total,
      active: analyze.metrics.active + embed.metrics.active,
      failed: analyze.metrics.failed + embed.metrics.failed,
      complete: analyze.metrics.complete + embed.metrics.complete,
    },
  };
};

/** True when Origin is a first-party GitNexus Vercel deployment host. */
export const isGitNexusVercelOrigin = (origin: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (host === 'gitnexus.vercel.app') return true;
  // Project deployments: gitnexus-web.vercel.app and preview
  // gitnexus-web-git-<branch>-<team>.vercel.app / gitnexus-web-<hash>-<team>.vercel.app
  if (!host.endsWith('.vercel.app')) return false;
  return host === 'gitnexus-web.vercel.app' || host.startsWith('gitnexus-web-');
};
