import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronUp, Heart, X } from '@/lib/lucide-icons';
import { useAppState } from '../hooks/useAppState';
import type { GroupStatus, IndexEventsSnapshot, IndexingWarning } from '../services/backend-client';
import { GroupStatusNotice } from './GroupStatusNotice';

interface StatusBarProps {
  activeRepoName?: string;
  groupStatuses?: GroupStatus[];
  graphSyncStatus?: 'stale' | 'syncing' | 'synced' | 'failed';
  graphSyncMessage?: string;
  indexSnapshot?: IndexEventsSnapshot | null;
}

const syncStatusStyle = {
  stale: { dot: 'bg-yellow-400', label: 'Stale' },
  syncing: { dot: 'bg-accent animate-pulse', label: 'Syncing' },
  synced: { dot: 'bg-node-function', label: 'Synced' },
  failed: { dot: 'bg-red-400', label: 'Sync failed' },
} as const;

const PHASE_LABELS: Record<string, string> = {
  queued: 'Queued',
  cloning: 'Queued',
  pulling: 'Queued',
  extracting: 'Scanning',
  structure: 'Scanning',
  parsing: 'Parsing',
  imports: 'Parsing',
  calls: 'Parsing',
  heritage: 'Parsing',
  lbug: 'Writing graph',
  fts: 'Writing graph',
  embeddings: 'Writing graph',
  groups: 'Refreshing UI',
  done: 'Refreshing UI',
  retrying: 'Queued',
};

const formatRelativeTime = (iso?: string): string => {
  if (!iso) return 'never';
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 'unknown';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const toLockWarning = (
  lock: NonNullable<IndexEventsSnapshot['locks']>[number],
): IndexingWarning => ({
  id: `lock:${lock.jobId || lock.repoPath}:${lock.startedAt}`,
  kind: 'lock_conflict',
  severity: 'warning',
  message: `Repository "${lock.repoName || lock.repoPath}" is locked by ${lock.operation}.`,
  repoName: lock.repoName,
  repoPath: lock.repoPath,
  action: 'Close other GitNexus processes that are indexing this repo, then retry.',
  timestamp: lock.startedAt,
});

const compactNumber = (value?: number): string => {
  if (value === undefined || value === null) return '0';
  return Intl.NumberFormat(undefined, { notation: value >= 10000 ? 'compact' : 'standard' }).format(
    value,
  );
};

const warningLabel = (warning: IndexingWarning): string =>
  warning.kind
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

export const StatusBar = ({
  activeRepoName,
  groupStatuses = [],
  graphSyncStatus = 'synced',
  graphSyncMessage,
  indexSnapshot,
}: StatusBarProps) => {
  const { graph, progress } = useAppState();
  const [warningDrawerOpen, setWarningDrawerOpen] = useState(false);

  const nodeCount = graph?.nodes.length ?? 0;
  const edgeCount = graph?.relationships.length ?? 0;
  const activeRepo = indexSnapshot?.repos.find((repo) => repo.name === activeRepoName);
  const activeJob = indexSnapshot?.activeJobs?.find((job) => {
    const jobRepoName = job.repoName || (job.repoPath || '').split(/[/\\]/).filter(Boolean).pop();
    return activeRepoName
      ? jobRepoName?.toLowerCase() === activeRepoName.toLowerCase()
      : Boolean(jobRepoName);
  });
  const activePhase = activeJob
    ? (PHASE_LABELS[activeJob.progress.phase] ?? activeJob.progress.phase)
    : 'Watching';
  const counts = activeJob?.progress.counts;
  const warnings = useMemo(() => {
    const combined = [
      ...(indexSnapshot?.warnings ?? []),
      ...(indexSnapshot?.locks ?? []).map(toLockWarning),
    ];
    const unique = new Map<string, IndexingWarning>();
    combined.forEach((warning) => unique.set(warning.id, warning));
    return Array.from(unique.values()).sort((a, b) => b.timestamp - a.timestamp);
  }, [indexSnapshot]);

  const primaryLanguage = useMemo(() => {
    if (!graph) return null;
    const languages = graph.nodes.map((n) => n.properties.language).filter(Boolean);
    if (languages.length === 0) return null;

    const countsByLanguage = languages.reduce(
      (acc, lang) => {
        acc[lang!] = (acc[lang!] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    return Object.entries(countsByLanguage).sort((a, b) => b[1] - a[1])[0]?.[0];
  }, [graph]);

  const lastIndexed = formatRelativeTime(activeRepo?.indexedAt);
  const currentIndexing = activeJob
    ? `${activePhase}${activeJob.progress.percent ? ` ${Math.round(activeJob.progress.percent)}%` : ''}`
    : 'Watching';
  const warningCount = Math.max(warnings.length, counts?.warnings ?? 0);

  return (
    <>
      {warningDrawerOpen && warnings.length > 0 && (
        <section className="absolute right-4 bottom-12 z-40 w-[420px] max-w-[calc(100vw-2rem)] rounded-lg border border-yellow-400/25 bg-elevated/98 shadow-2xl backdrop-blur-sm">
          <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-yellow-300" />
              <span className="text-xs font-semibold text-text-primary">Indexing warnings</span>
              <span className="rounded border border-yellow-400/25 px-1.5 py-0.5 text-[10px] text-yellow-200">
                {warningCount}
              </span>
            </div>
            <button
              className="rounded p-1 text-text-muted transition-colors hover:bg-hover hover:text-text-primary"
              onClick={() => setWarningDrawerOpen(false)}
              title="Close warnings"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="max-h-72 overflow-auto p-2">
            {warnings.slice(0, 12).map((warning) => (
              <article
                key={warning.id}
                className="mb-2 rounded-md border border-border-subtle bg-deep/70 p-2 last:mb-0"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold text-text-primary">
                    {warningLabel(warning)}
                  </span>
                  <span className="shrink-0 text-[10px] text-text-muted">
                    {formatRelativeTime(new Date(warning.timestamp).toISOString())}
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-4 text-text-secondary">{warning.message}</p>
                {(warning.repoName || warning.filePath) && (
                  <p className="mt-1 truncate font-mono text-[10px] text-text-muted">
                    {warning.repoName || warning.repoPath}
                    {warning.filePath ? ` | ${warning.filePath}` : ''}
                  </p>
                )}
                {warning.action && (
                  <p className="mt-1 text-[10px] leading-4 text-yellow-200">{warning.action}</p>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      <footer className="flex items-center justify-between gap-4 border-t border-dashed border-border-subtle bg-deep px-5 py-2 text-[11px] text-text-muted">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {progress && progress.phase !== 'complete' ? (
            <>
              <div className="h-1 w-24 overflow-hidden rounded-full bg-elevated">
                <div
                  className="to-node-interface h-full rounded-full bg-gradient-to-r from-accent transition-all duration-300"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
              <span className="truncate">{progress.message}</span>
            </>
          ) : (
            <div className="flex shrink-0 items-center gap-1.5" data-testid="status-ready">
              <span
                className={`h-1.5 w-1.5 rounded-full ${syncStatusStyle[graphSyncStatus].dot}`}
              />
              <span>{graphSyncMessage ?? syncStatusStyle[graphSyncStatus].label}</span>
            </div>
          )}

          <GroupStatusNotice groupStatuses={groupStatuses} />

          <span className="hidden text-border-default md:inline">|</span>
          <span className="hidden truncate md:inline">Last indexed {lastIndexed}</span>
          <span className="hidden text-border-default lg:inline">|</span>
          <span className="hidden truncate lg:inline">Currently indexing: {currentIndexing}</span>

          {activeJob && (
            <div className="hidden min-w-0 items-center gap-2 xl:flex">
              <span className="text-border-default">|</span>
              <span>{compactNumber(counts?.filesChanged)} changed</span>
              <span>{compactNumber(counts?.filesProcessed)} processed</span>
              <span>{compactNumber(counts?.symbolsUpdated)} symbols</span>
              <span>{compactNumber(warningCount)} warnings</span>
            </div>
          )}
        </div>

        <a
          href="https://github.com/sponsors/abhigyanpatwari"
          target="_blank"
          rel="noopener noreferrer"
          className="group hidden shrink-0 cursor-pointer items-center gap-2 rounded-full border border-pink-500/20 bg-pink-500/10 px-3 py-1 transition-all duration-200 hover:scale-[1.02] hover:border-pink-500/40 hover:bg-pink-500/20 lg:flex"
        >
          <Heart className="h-3.5 w-3.5 animate-pulse fill-pink-500/40 text-pink-500 transition-all duration-200 group-hover:scale-110 group-hover:fill-pink-500" />
          <span className="text-[11px] font-medium text-pink-400 transition-colors group-hover:text-pink-300">
            Sponsor
          </span>
        </a>

        <div className="flex shrink-0 items-center gap-3" data-testid="graph-stats">
          {warningCount > 0 && (
            <button
              className="flex items-center gap-1 rounded border border-yellow-400/25 bg-yellow-500/10 px-2 py-1 text-yellow-200 transition-colors hover:bg-yellow-500/15"
              onClick={() => setWarningDrawerOpen((open) => !open)}
              title="Open indexing warnings"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              {compactNumber(warningCount)}
              <ChevronUp
                className={`h-3 w-3 transition-transform ${warningDrawerOpen ? 'rotate-180' : ''}`}
              />
            </button>
          )}
          {graph && (
            <>
              <span>{nodeCount} nodes</span>
              <span className="text-border-default">|</span>
              <span>{edgeCount} edges</span>
              {primaryLanguage && (
                <>
                  <span className="text-border-default">|</span>
                  <span>{primaryLanguage}</span>
                </>
              )}
            </>
          )}
        </div>
      </footer>
    </>
  );
};
