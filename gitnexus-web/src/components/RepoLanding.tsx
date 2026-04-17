/**
 * RepoLanding
 *
 * Unified landing screen shown when the backend is connected and at least one
 * repository is indexed. Displays pre-indexed repos as selectable cards, plus
 * an "Analyze a New Repository" section powered by RepoAnalyzer.
 *
 * Rendering context:
 *   DropZone (Crossfade, phase="landing")
 *     └─ RepoLanding
 *          ├─ RepoCard (× N)
 *          └─ RepoAnalyzer (variant="onboarding")
 */

import { Sparkles, ArrowRight, GitBranch, FileCode, Layers, FolderOpen } from '@/lib/lucide-icons';
import { useState, useEffect } from 'react';
import { RepoAnalyzer } from './RepoAnalyzer';
import { fetchGroups, fetchGroupStatus, type BackendRepo, type GroupStatus } from '../services/backend-client';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// ── Repo card ────────────────────────────────────────────────────────────────

function RepoCard({ repo, onClick }: { repo: BackendRepo; onClick: () => void }) {
  const stats = repo.stats;

  return (
    <button
      onClick={onClick}
      data-testid="landing-repo-card"
      className="group w-full cursor-pointer rounded-xl border border-transparent bg-elevated p-4 text-left transition-all duration-200 hover:border-accent/30 hover:bg-hover hover:shadow-glow-soft"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 shrink-0 text-accent" />
            <h3 className="truncate text-sm font-semibold text-text-primary transition-colors group-hover:text-accent">
              {repo.name}
            </h3>
          </div>
          {repo.indexedAt && (
            <p className="mt-1 pl-6 text-xs text-text-muted">
              Indexed {formatRelativeTime(repo.indexedAt)}
            </p>
          )}
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-text-muted opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-accent group-hover:opacity-100" />
      </div>

      {stats && (stats.files != null || stats.nodes != null) && (
        <div className="mt-3 flex flex-wrap gap-2 pl-6">
          {stats.files != null && (
            <span className="inline-flex items-center gap-1 rounded-md bg-void px-2 py-0.5 text-[11px] text-text-muted">
              <FileCode className="h-3 w-3" /> {stats.files.toLocaleString()} files
            </span>
          )}
          {stats.nodes != null && (
            <span className="inline-flex items-center gap-1 rounded-md bg-void px-2 py-0.5 text-[11px] text-text-muted">
              <Layers className="h-3 w-3" /> {stats.nodes.toLocaleString()} symbols
            </span>
          )}
          {stats.processes != null && stats.processes > 0 && (
            <span className="inline-flex items-center gap-1 rounded-md bg-void px-2 py-0.5 text-[11px] text-text-muted">
              <Sparkles className="h-3 w-3" /> {stats.processes} flows
            </span>
          )}
        </div>
      )}
    </button>
  );
}

// ── Group card ──────────────────────────────────────────────────────────────

function GroupCard({
  name,
  status,
  onClick,
}: {
  name: string;
  status: GroupStatus | null;
  onClick: () => void;
}) {
  const repoCount = status ? Object.keys(status.repos).length : 0;
  const lastSync = status?.lastSync;

  return (
    <button
      onClick={onClick}
      data-testid="landing-group-card"
      className="group w-full cursor-pointer rounded-xl border border-transparent bg-elevated p-4 text-left transition-all duration-200 hover:border-amber-500/30 hover:bg-hover hover:shadow-glow-soft"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 shrink-0 text-amber-400" />
            <h3 className="truncate text-sm font-semibold text-text-primary transition-colors group-hover:text-amber-400">
              {name}
            </h3>
          </div>
          <div className="mt-1 flex items-center gap-3 pl-6">
            {repoCount > 0 && (
              <span className="text-xs text-text-muted">{repoCount} repos</span>
            )}
            {lastSync && (
              <span className="text-xs text-text-muted">
                synced {formatRelativeTime(lastSync)}
              </span>
            )}
          </div>
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-text-muted opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-amber-400 group-hover:opacity-100" />
      </div>
    </button>
  );
}

// ── RepoLanding ──────────────────────────────────────────────────────────────

type LandingTab = 'repos' | 'groups';

interface RepoLandingProps {
  repos: BackendRepo[];
  onSelectRepo: (repoName: string) => void;
  onSelectGroup?: (groupName: string) => void;
  onAnalyzeComplete: (repoName: string) => void;
  /** When set, only that tab is shown and the tab bar is hidden — used as a
   *  mode-switch picker where the user must choose a repo or a group. */
  only?: 'repos' | 'groups';
}

export const RepoLanding = ({
  repos,
  onSelectRepo,
  onSelectGroup,
  onAnalyzeComplete,
  only,
}: RepoLandingProps) => {
  const [activeTab, setActiveTab] = useState<LandingTab>(only ?? 'repos');
  const [groups, setGroups] = useState<string[]>([]);
  const [groupStatuses, setGroupStatuses] = useState<Record<string, GroupStatus | null>>({});

  useEffect(() => {
    fetchGroups()
      .then((g) => setGroups(g))
      .catch(() => setGroups([]));
  }, []);

  useEffect(() => {
    if (activeTab !== 'groups' || groups.length === 0) return;
    for (const name of groups) {
      if (groupStatuses[name] !== undefined) continue;
      setGroupStatuses((prev) => ({ ...prev, [name]: null }));
      fetchGroupStatus(name)
        .then((s) => setGroupStatuses((prev) => ({ ...prev, [name]: s })))
        .catch(() => {});
    }
  }, [activeTab, groups, groupStatuses]);

  return (
    <div className="relative max-h-[80vh] animate-fade-in overflow-y-auto rounded-3xl bg-surface p-7 shadow-2xl shadow-black/60 ring-1 ring-border-subtle">
      {/* Ambient glows */}
      <div className="pointer-events-none absolute -top-28 -right-28 h-72 w-72 rounded-full bg-accent/6 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-24 h-56 w-56 rounded-full bg-node-function/6 blur-3xl" />

      {/* Header */}
      <div className="relative mb-6">
        <div className="text-center">
          <div className="mb-2 inline-flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-accent/70" />
            <span className="text-[11px] font-medium tracking-widest text-accent/80 uppercase">
              GitNexus
            </span>
          </div>

          <h2 className="text-lg leading-snug font-semibold text-text-primary">
            {activeTab === 'repos' ? 'Choose a repository' : 'Choose a group'}
          </h2>
          <p className="mx-auto mt-1.5 max-w-xs text-sm leading-relaxed text-text-secondary">
            {activeTab === 'repos'
              ? 'Select an indexed repository to explore, or analyze a new one.'
              : 'Select a group to view the combined knowledge graph across repos.'}
          </p>
        </div>
      </div>

      {/* Tab bar */}
      {!only && groups.length > 0 && (
        <div className="relative mb-5 flex items-center justify-center gap-1 rounded-lg bg-void p-1">
          <button
            onClick={() => setActiveTab('repos')}
            className={`flex-1 rounded-md px-4 py-1.5 text-xs font-medium transition-all ${
              activeTab === 'repos'
                ? 'bg-elevated text-text-primary shadow-sm'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            Repos
          </button>
          <button
            onClick={() => setActiveTab('groups')}
            className={`flex-1 rounded-md px-4 py-1.5 text-xs font-medium transition-all ${
              activeTab === 'groups'
                ? 'bg-elevated text-text-primary shadow-sm'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            Groups
          </button>
        </div>
      )}

      {/* Repos tab content */}
      {activeTab === 'repos' && (
        <>
          <div className="relative mb-5 space-y-2">
            {repos.map((repo) => (
              <RepoCard key={repo.name} repo={repo} onClick={() => onSelectRepo(repo.name)} />
            ))}
          </div>

          <div className="mb-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-border-subtle" />
            <span className="text-[11px] tracking-widest text-text-muted uppercase">
              or analyze new
            </span>
            <div className="h-px flex-1 bg-border-subtle" />
          </div>

          <div className="relative">
            <RepoAnalyzer variant="onboarding" onComplete={onAnalyzeComplete} />
          </div>
        </>
      )}

      {/* Groups tab content */}
      {activeTab === 'groups' && (
        <div className="relative space-y-2">
          {groups.length === 0 ? (
            <div className="py-8 text-center">
              <FolderOpen className="mx-auto mb-3 h-8 w-8 text-text-muted/50" />
              <p className="text-sm text-text-muted">No groups configured yet.</p>
              <p className="mt-1 text-xs text-text-muted/70">
                Run <code className="rounded bg-void px-1.5 py-0.5">gitnexus group auto-discover</code> to create one.
              </p>
            </div>
          ) : (
            groups.map((name) => (
              <GroupCard
                key={name}
                name={name}
                status={groupStatuses[name] ?? null}
                onClick={() => onSelectGroup?.(name)}
              />
            ))
          )}
        </div>
      )}

      {/* Footer hint */}
      <p className="mt-5 text-center text-[11px] leading-relaxed text-text-muted">
        Public &amp; private repos &middot; Cloned locally by the server &middot; No data leaves
        your machine
      </p>
    </div>
  );
};
