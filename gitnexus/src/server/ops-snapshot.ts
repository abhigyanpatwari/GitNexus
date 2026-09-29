/**
 * Ops / execution dashboard snapshot helpers.
 *
 * Pure serialization + metrics over in-memory JobManager state so the
 * HTTP route stays thin and unit tests do not boot Express.
 */

import {
  isTerminalJobStatus,
  type AnalyzeJob,
  type AnalyzeJobProgress,
  type AnalyzeJobStatus,
} from './analyze-job.js';
import { publicRepoId } from './public-repo-id.js';
import { escapeRegExp } from './validation.js';

export interface OpsJobView {
  id: string;
  lane: 'analyze' | 'embed';
  status: AnalyzeJobStatus;
  repoName?: string;
  /** Opaque `GET /api/repos` entry id; set once the job is complete. */
  repoId?: string;
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

/** Basename for ops UI — strip query/fragment so tokens never leak into repoName. */
export const publicRepoNameFromUrl = (repoUrl: string | undefined): string | undefined => {
  if (!repoUrl) return undefined;
  try {
    const parsed = new URL(repoUrl);
    // new URL accepts Windows drive paths as `c:` URLs; split on `\` too so we
    // never emit a full filesystem pathname on the unauthenticated ops feed.
    const segments = parsed.pathname
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .filter(Boolean);
    const last = segments.pop();
    if (!last) return undefined;
    return last.replace(/\.git$/i, '') || undefined;
  } catch {
    // Non-URL fallbacks (scp-like git@host:org/repo.git) — drop query/hash then basename.
    const cleaned = repoUrl
      .split(/[?#]/, 1)[0]!
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '');
    const last = cleaned.split(/[/\\]/).pop();
    return last || undefined;
  }
};

const publicRepoNameFromPath = (repoPath: string | undefined): string | undefined => {
  if (!repoPath) return undefined;
  return (
    repoPath
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() || undefined
  );
};

const preserveTrailingPunct = (raw: string, token: string): string => {
  const trailing = raw.match(/(\.{2,}|[),;]+)$/);
  return trailing ? `${token}${trailing[0]}` : token;
};

/**
 * Display name for public payloads. A branch-pinned URL clone registers under
 * its clone-directory name (`<repo>__<branch slug>`), which would put the
 * requested branch on the unauthenticated feed — use the URL's repo name.
 * Reconnect goes through {@link publicJobRepoId}, not this label.
 */
export const publicJobRepoName = (job: AnalyzeJob): string | undefined =>
  (job.branch ? publicRepoNameFromUrl(job.repoUrl) : undefined) ||
  job.repoName ||
  publicRepoNameFromUrl(job.repoUrl) ||
  publicRepoNameFromPath(job.repoPath);

/** Opaque registry handle, only once the job's index is published. */
export const publicJobRepoId = (job: AnalyzeJob): string | undefined =>
  job.status === 'complete' && job.repoPath ? publicRepoId(job.repoPath) : undefined;

export const knownJobLocations = (
  job?: Pick<AnalyzeJob, 'repoPath' | 'repoUrl'> | null,
): Array<string | undefined> => [job?.repoPath, job?.repoUrl];

/** HTTP(S)/ssh URLs and scp-like remotes redact as `[repo]`; filesystem paths as `[path]`. */
const knownRedactionToken = (value: string): '[repo]' | '[path]' =>
  /^(https?:\/\/|ssh:\/\/)/i.test(value) || /^[\w.-]+@[\w.-]+:/.test(value) ? '[repo]' : '[path]';

/**
 * After a path separator, consume a single space only when another `/` or `\`
 * still follows — so `/home/Jane Doe/.gitnexus/foo` is one path, but
 * `/home/alice/src/private-repo has no remote.origin` keeps the sentence.
 */
const PATH_WITH_INTERNAL_SPACE = String.raw`[^\s"')]+(?: [^\s"')]*[\\/][^\s"')]*)*`;

const redactKnownLocations = (text: string, known?: Array<string | undefined>): string => {
  const values = (known ?? [])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort((a, b) => b.length - a.length);
  const seen = new Set<string>();
  let out = text;
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    // Consume a descendant tail too (`<repoPath>/src/secret.ts`): once the
    // prefix became `[path]`, the absolute-path scrub below could no longer see
    // the rest. The lookahead keeps `<repoPath>2/…` (a sibling) for that scrub.
    out = out.replace(
      new RegExp(
        `${escapeRegExp(value)}(?:[/\\\\]${PATH_WITH_INTERNAL_SPACE}|[/\\\\]+)?(?![\\w-]|\\.\\w)`,
        'g',
      ),
      (raw) => preserveTrailingPunct(raw, knownRedactionToken(value)),
    );
  }
  return out;
};

/**
 * Mid-string scrub for unauthenticated ops/poll payloads. Clone progress and
 * worker errors embed the URL after a prefix ("Cloning https://…") and also
 * embed local clone paths ("Existing clone at /home/alice/…"). Replace the
 * whole HTTP(S) URL — host, path, and query — not only userinfo, replace
 * scp-like `user@host:path` and `ssh://` remotes, and replace absolute POSIX /
 * Windows / UNC filesystem paths so a LAN or official-Vercel origin cannot
 * recover home-directory layout or private org/repo names from /api/ops.
 *
 * Remote URL forms are replaced first. Known `repoPath` / `repoUrl` literals
 * then run (longest first) so a clone dir with spaces cannot leak around
 * `[^\s]+`, then the filesystem path regexes.
 */
const redactRemoteUrls = (text: string): string =>
  text
    .replace(/https?:\/\/[^\s]+/gi, (raw) => preserveTrailingPunct(raw, '[repo]'))
    .replace(/ssh:\/\/[^\s]+/gi, (raw) => preserveTrailingPunct(raw, '[repo]'))
    .replace(/file:\/\/[^\s"']+/gi, (raw) => preserveTrailingPunct(raw, '[path]'))
    .replace(/[\w.-]+@[\w.-]+:[^\s"')]+/g, (raw) => preserveTrailingPunct(raw, '[repo]'));

const redactFilesystemPaths = (text: string): string =>
  text
    .replace(new RegExp(`[A-Za-z]:[\\\\/]${PATH_WITH_INTERNAL_SPACE}`, 'g'), (raw) =>
      preserveTrailingPunct(raw, '[path]'),
    )
    .replace(new RegExp(`\\\\\\\\${PATH_WITH_INTERNAL_SPACE}`, 'g'), (raw) =>
      preserveTrailingPunct(raw, '[path]'),
    )
    .replace(
      new RegExp(`(^|[\\s"'=(])(/${PATH_WITH_INTERNAL_SPACE})`, 'g'),
      (_m, prefix: string, absPath: string) =>
        `${prefix}${preserveTrailingPunct(absPath, '[path]')}`,
    );

/**
 * Remote URL forms first so a known `repoUrl` that is a prefix of a longer
 * URL cannot punch a hole (`[repo]/other?token=`) before the URL scrubber
 * runs. Known filesystem literals still run before the path regexes so a
 * clone dir with spaces cannot leak around `[^\s]+`.
 */
export const redactPublicText = (text: string, known?: Array<string | undefined>): string =>
  redactFilesystemPaths(redactKnownLocations(redactRemoteUrls(text), known));

/**
 * Ops feed is unauthenticated — never emit raw repo URLs (or userinfo) via
 * progress.message even when the in-memory job still holds them for cloning.
 */
export const publicOpsProgress = (
  progress: AnalyzeJobProgress,
  known?: Array<string | undefined>,
): AnalyzeJobProgress => ({
  phase: progress.phase,
  percent: progress.percent,
  message: redactPublicText(progress.message, known),
});

export const serializeOpsJob = (
  job: AnalyzeJob,
  lane: 'analyze' | 'embed',
  now: number = Date.now(),
): OpsJobView => {
  const end = job.completedAt ?? now;
  const known = knownJobLocations(job);
  // Never emit raw repoUrl/repoPath or the requested branch on the
  // unauthenticated ops feed (a ref can name a private project the same way a
  // path would).
  return {
    id: job.id,
    lane,
    status: job.status,
    repoName: publicJobRepoName(job),
    repoId: publicJobRepoId(job),
    progress: publicOpsProgress(job.progress, known),
    error: job.error ? redactPublicText(job.error, known) : undefined,
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

/** True when Origin is an exact first-party GitNexus Vercel production host. */
export const isGitNexusVercelOrigin = (origin: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  // Browsers omit the default port; non-default ports such as :8443 are not
  // documented production Origin strings. Explicit :443 is the same origin as the bare host.
  if (parsed.port) return false;
  const host = parsed.hostname.toLowerCase();
  // Exact hosts only — a prefix like `gitnexus-web-` would also match any
  // attacker-controlled Vercel project named `gitnexus-web-*`. Preview
  // deployments should set GITNEXUS_PUBLIC_ORIGIN instead.
  return host === 'gitnexus.vercel.app' || host === 'gitnexus-web.vercel.app';
};
