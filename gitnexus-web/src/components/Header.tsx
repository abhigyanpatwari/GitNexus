import {
  Search,
  Settings,
  HelpCircle,
  Sparkles,
  Github,
  Star,
  FolderOpen,
  ChevronDown,
  Trash2,
  RefreshCw,
  Loader2,
} from '@/lib/lucide-icons';
import { useAppState } from '../hooks/useAppState';
import {
  deleteRepo,
  fetchRepos,
  repoIdentity,
  startAnalyze,
  streamAnalyzeProgress,
  type BackendRepo,
  type JobProgress,
} from '../services/backend-client';
import { useState, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { GraphNode } from 'gitnexus-shared';
import { EmbeddingStatus } from './EmbeddingStatus';
import { RepoAnalyzer } from './RepoAnalyzer';
import { LanguageSwitcher } from './LanguageSwitcher';
import { translateProgressMessage } from '../i18n/progress';
import { formatBackendError } from '../i18n/error-messages';

// Color mapping for node types in search results
const NODE_TYPE_COLORS: Record<string, string> = {
  Folder: '#6366f1',
  File: '#3b82f6',
  Function: '#10b981',
  Class: '#f59e0b',
  Method: '#14b8a6',
  Interface: '#ec4899',
  Variable: '#64748b',
  Import: '#475569',
  Type: '#a78bfa',
};

interface HeaderProps {
  onFocusNode?: (nodeId: string) => void;
  availableRepos?: BackendRepo[];
  onSwitchRepo?: (repoName: string) => void;
  /** Called when a newly-analyzed repo is ready; triggers connectToServer. */
  onAnalyzeComplete?: (repoName: string) => void;
  /** Called after a repo is deleted or list needs refresh. */
  onReposChanged?: (repos: BackendRepo[]) => void;
}

export const Header = ({
  onFocusNode,
  availableRepos = [],
  onSwitchRepo,
  onAnalyzeComplete,
  onReposChanged,
}: HeaderProps) => {
  const { t } = useTranslation(['common', 'header', 'errors']);
  const {
    projectName,
    currentRepo,
    graph,
    graphMode,
    openChatPanel,
    isRightPanelOpen,
    rightPanelTab,
    setSettingsPanelOpen,
    setHelpDialogBoxOpen,
  } = useAppState();
  const [searchQuery, setSearchQuery] = useState('');
  const [repoSearchQuery, setRepoSearchQuery] = useState('');
  const [isRepoDropdownOpen, setIsRepoDropdownOpen] = useState(false);
  const [showAnalyzer, setShowAnalyzer] = useState(false);
  const [reanalyzing, setReanalyzing] = useState<string | null>(null); // repo identity being re-analyzed
  const [deleteError, setDeleteError] = useState<string | null>(null); // surfaced when a delete is rejected (e.g. origin-blocked 403)
  const [reanalyzeProgress, setReanalyzeProgress] = useState<JobProgress | null>(null);
  const reanalyzeSseRef = useRef<AbortController | null>(null);
  const repoDropdownRef = useRef<HTMLDivElement>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const nodeCount = graph?.nodes.length ?? 0;
  const edgeCount = graph?.relationships.length ?? 0;

  // Search results - filter nodes by name
  const searchResults = useMemo(() => {
    if (!graph || !searchQuery.trim()) return [];

    const query = searchQuery.toLowerCase();
    return graph.nodes
      .filter((node) => node.properties.name.toLowerCase().includes(query))
      .slice(0, 10); // Limit to 10 results
  }, [graph, searchQuery]);

  const filteredRepos = useMemo(() => {
    const query = repoSearchQuery.trim().toLowerCase();
    if (!query) return availableRepos;

    return availableRepos.filter((repo) => repo.name.toLowerCase().includes(query));
  }, [availableRepos, repoSearchQuery]);

  const activeRepoIdentity = currentRepo ?? projectName;

  // Handle clicking outside search or repo dropdown to close them
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setIsSearchOpen(false);
      }
      if (repoDropdownRef.current && !repoDropdownRef.current.contains(e.target as Node)) {
        setIsRepoDropdownOpen(false);
        setShowAnalyzer(false);
        setRepoSearchQuery('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Cleanup re-analyze SSE on unmount
  useEffect(() => {
    return () => {
      reanalyzeSseRef.current?.abort();
    };
  }, []);

  // Keyboard shortcut (Cmd+K / Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setIsSearchOpen(true);
      }
      if (e.key === 'Escape') {
        setIsSearchOpen(false);
        inputRef.current?.blur();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Handle keyboard navigation in results
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isSearchOpen || searchResults.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, searchResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = searchResults[selectedIndex];
      if (selected) {
        handleSelectNode(selected);
      }
    }
  };

  const handleSelectNode = (node: GraphNode) => {
    // onFocusNode handles both camera focus AND selection in useSigma
    onFocusNode?.(node.id);
    setSearchQuery('');
    setIsSearchOpen(false);
    setSelectedIndex(0);
  };

  return (
    <header className="flex items-center justify-between border-b border-dashed border-border-subtle bg-deep px-5 py-3">
      {/* Left section */}
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-accent to-node-interface text-sm font-bold text-white shadow-glow">
            ◇
          </div>
          <span className="text-[15px] font-semibold tracking-tight">GitNexus</span>
        </div>

        {/* Project badge + repo dropdown */}
        {projectName && (
          <div className="relative" ref={repoDropdownRef}>
            <button
              data-testid="repo-switcher-trigger"
              onClick={() => {
                const nextOpen = !isRepoDropdownOpen;
                setIsRepoDropdownOpen(nextOpen);
                setShowAnalyzer(false);
                if (!nextOpen) setRepoSearchQuery('');
              }}
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-all ${
                isRepoDropdownOpen
                  ? 'border-accent/40 bg-accent/10 text-text-primary'
                  : 'border-border-subtle bg-surface text-text-secondary hover:border-border-default hover:bg-hover'
              } `}
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-node-function" />
              <span className="max-w-[160px] truncate">{projectName}</span>
              <ChevronDown
                className={`h-3 w-3 text-text-muted transition-transform duration-200 ${isRepoDropdownOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {isRepoDropdownOpen && (
              <div className="absolute top-full left-0 z-50 mt-1.5 flex max-h-[calc(100vh-4.5rem)] w-80 animate-slide-up flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-xl">
                {showAnalyzer ? (
                  <div className="scrollbar-thin overflow-y-auto p-4">
                    <RepoAnalyzer
                      variant="sheet"
                      onComplete={(repoName) => {
                        setShowAnalyzer(false);
                        setIsRepoDropdownOpen(false);
                        setRepoSearchQuery('');
                        onAnalyzeComplete?.(repoName);
                      }}
                      onCancel={() => setShowAnalyzer(false)}
                    />
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col">
                    {/* Repo list */}
                    {availableRepos.length > 0 && (
                      <div className="flex min-h-0 flex-1 flex-col">
                        <div className="shrink-0 px-3 pt-2.5 pb-1.5 text-[10px] font-medium tracking-wider text-text-muted uppercase">
                          {t('header:repositories')}
                        </div>
                        <div className="shrink-0 px-3 pb-2">
                          <div className="flex items-center gap-2 rounded-md border border-border-subtle bg-deep/70 px-2.5 py-1.5 transition-colors focus-within:border-accent/60">
                            <Search className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                            <input
                              type="text"
                              aria-label={t('header:searchRepositories')}
                              placeholder={t('header:searchRepositories')}
                              value={repoSearchQuery}
                              onChange={(e) => setRepoSearchQuery(e.target.value)}
                              className="min-w-0 flex-1 border-none bg-transparent text-xs text-text-primary outline-none placeholder:text-text-muted"
                            />
                          </div>
                        </div>
                        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pb-1">
                          {filteredRepos.length === 0 ? (
                            <div className="px-4 py-3 text-sm text-text-muted">
                              {t('header:noRepositoriesFound', { query: repoSearchQuery })}
                            </div>
                          ) : (
                            filteredRepos.map((repo) => {
                              const identity = repoIdentity(repo);
                              const isActive = identity === activeRepoIdentity;

                              return (
                                <div
                                  key={identity}
                                  data-testid="repo-switcher-row"
                                  data-active={isActive}
                                  className={`group flex items-center gap-2 px-4 py-2 transition-colors ${
                                    isActive
                                      ? 'border-l-2 border-accent bg-accent/10'
                                      : 'hover:bg-hover'
                                  }`}
                                >
                                  <button
                                    onClick={() => {
                                      if (!isActive) onSwitchRepo?.(identity);
                                      setIsRepoDropdownOpen(false);
                                      setRepoSearchQuery('');
                                    }}
                                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
                                  >
                                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-node-folder" />
                                    <span className="flex-1 truncate font-mono text-sm text-text-primary">
                                      {repo.name}
                                    </span>
                                    {isActive && (
                                      <span className="shrink-0 font-mono text-[10px] text-accent">
                                        {t('header:active')}
                                      </span>
                                    )}
                                  </button>
                                  {/* Re-analyze */}
                                  <button
                                    data-testid="repo-switcher-reanalyze"
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      if (reanalyzing) return; // already running
                                      setReanalyzing(identity);
                                      setReanalyzeProgress({
                                        phase: 'queued',
                                        percent: 0,
                                        message: t('common:progress.starting'),
                                      });
                                      try {
                                        const { jobId } = await startAnalyze({
                                          path: repo.path,
                                          force: true,
                                        });
                                        reanalyzeSseRef.current = streamAnalyzeProgress(
                                          jobId,
                                          (p) => setReanalyzeProgress(p),
                                          () => {
                                            setReanalyzing(null);
                                            setReanalyzeProgress(null);
                                            reanalyzeSseRef.current = null;
                                            onAnalyzeComplete?.(identity);
                                          },
                                          (errMsg) => {
                                            console.error('Re-analyze failed:', errMsg);
                                            setReanalyzing(null);
                                            setReanalyzeProgress(null);
                                            reanalyzeSseRef.current = null;
                                          },
                                        );
                                      } catch (err) {
                                        console.error('Failed to start re-analysis:', err);
                                        setReanalyzing(null);
                                        setReanalyzeProgress(null);
                                      }
                                    }}
                                    disabled={!!reanalyzing}
                                    className={`cursor-pointer rounded p-1 transition-all ${
                                      reanalyzing === identity
                                        ? 'text-accent'
                                        : 'text-text-muted/0 group-hover:text-text-muted hover:!text-accent'
                                    }`}
                                    title={
                                      reanalyzing === identity
                                        ? t('header:reanalyzing')
                                        : t('header:reanalyzeRepo', { repoName: repo.name })
                                    }
                                  >
                                    <RefreshCw
                                      className={`h-3.5 w-3.5 ${reanalyzing === identity ? 'animate-spin' : ''}`}
                                    />
                                  </button>
                                  {/* Delete */}
                                  <button
                                    data-testid="repo-switcher-delete"
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      // Abort any running re-analysis for this repo
                                      if (reanalyzing === identity) {
                                        reanalyzeSseRef.current?.abort();
                                        setReanalyzing(null);
                                        setReanalyzeProgress(null);
                                        reanalyzeSseRef.current = null;
                                      }
                                      setDeleteError(null);
                                      try {
                                        await deleteRepo(identity);
                                        const updated = await fetchRepos();
                                        onReposChanged?.(updated);
                                        // If we deleted the active repo, switch to first available
                                        if (isActive && updated.length > 0) {
                                          // Strip the deleted repo's identity from the URL before
                                          // the fallback switch: the switch success path rewrites
                                          // them, and if it fails nothing stale must remain that
                                          // would restore the deleted repo on refresh (#2419).
                                          const urlObj = new URL(window.location.href);
                                          urlObj.searchParams.delete('repo');
                                          urlObj.searchParams.delete('project');
                                          window.history.replaceState(null, '', urlObj.toString());
                                          onSwitchRepo?.(repoIdentity(updated[0]));
                                        } else if (updated.length === 0) {
                                          // No repos left — go back to onboarding. Strip the
                                          // restore params first so the reload lands on
                                          // onboarding instead of deterministically 404-flashing
                                          // on the just-deleted repo (#2419).
                                          const urlObj = new URL(window.location.href);
                                          urlObj.searchParams.delete('repo');
                                          urlObj.searchParams.delete('project');
                                          urlObj.searchParams.delete('skipGraph');
                                          window.history.replaceState(null, '', urlObj.toString());
                                          window.location.reload();
                                        }
                                      } catch (err) {
                                        // Surface the failure instead of silently no-opping —
                                        // e.g. an origin-blocked 403 when driving a local
                                        // backend from the hosted UI.
                                        console.error('Failed to delete repo:', err);
                                        setDeleteError(formatBackendError(err, t));
                                      }
                                    }}
                                    className="cursor-pointer rounded p-1 text-text-muted/0 transition-all group-hover:text-text-muted hover:!text-red-400"
                                    title={t('header:deleteRepo', { repoName: repo.name })}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    )}

                    {/* Surfaced delete failure (e.g. origin-blocked 403) */}
                    {deleteError && (
                      <div className="px-3 py-2 text-xs text-red-400" role="alert">
                        {deleteError}
                      </div>
                    )}

                    {/* Re-analyze progress bar */}
                    {reanalyzing && reanalyzeProgress && (
                      <div className="border-t border-border-subtle bg-accent/5 px-4 py-2.5">
                        <div className="mb-1.5 flex items-center gap-2">
                          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent" />
                          <span className="truncate text-xs text-text-secondary">
                            {t('header:reanalyzingRepo', {
                              // `reanalyzing` holds the path identity (#2419) —
                              // resolve the display name for the label, falling
                              // back to the path basename.
                              repoName:
                                availableRepos.find((r) => repoIdentity(r) === reanalyzing)?.name ??
                                reanalyzing.split(/[/\\]/).filter(Boolean).at(-1) ??
                                reanalyzing,
                              message: translateProgressMessage(reanalyzeProgress.message, t),
                            })}
                          </span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-elevated">
                          <div
                            className="h-full rounded-full bg-accent transition-all duration-300"
                            style={{ width: `${Math.max(2, reanalyzeProgress.percent)}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Analyze new */}
                    <div
                      className={
                        availableRepos.length > 0 || reanalyzing
                          ? 'border-t border-border-subtle'
                          : ''
                      }
                    >
                      <button
                        onClick={() => {
                          setRepoSearchQuery('');
                          setShowAnalyzer(true);
                        }}
                        disabled={!!reanalyzing}
                        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" />
                        <span className="text-sm text-text-secondary">
                          {t('header:analyzeNew')}
                        </span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Center - Search */}
      <div className="relative mx-6 max-w-md flex-1" ref={searchRef}>
        <div className="flex items-center gap-2.5 rounded-lg border border-border-subtle bg-surface px-3.5 py-2 transition-all focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
          <Search className="h-4 w-4 flex-shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            type="text"
            placeholder={t('header:searchNodes')}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setIsSearchOpen(true);
              setSelectedIndex(0);
            }}
            onFocus={() => setIsSearchOpen(true)}
            onKeyDown={handleKeyDown}
            className="flex-1 border-none bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
          <kbd className="rounded border border-border-subtle bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
            ⌘K
          </kbd>
        </div>

        {/* Search Results Dropdown */}
        {isSearchOpen && searchQuery.trim() && (
          <div className="absolute top-full right-0 left-0 z-50 mt-1 overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-xl">
            {searchResults.length === 0 ? (
              <div className="px-4 py-3 text-sm text-text-muted">
                {t('header:noNodesFound', { query: searchQuery })}
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                {searchResults.map((node, index) => (
                  <button
                    key={node.id}
                    onClick={() => handleSelectNode(node)}
                    className={`flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                      index === selectedIndex
                        ? 'bg-accent/20 text-text-primary'
                        : 'text-text-secondary hover:bg-hover'
                    }`}
                  >
                    <span
                      className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                      style={{ backgroundColor: NODE_TYPE_COLORS[node.label] || '#6b7280' }}
                    />
                    <span className="flex-1 truncate text-sm font-medium">
                      {node.properties.name}
                    </span>
                    <span className="rounded bg-elevated px-2 py-0.5 text-xs text-text-muted">
                      {node.label}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right section */}
      <div className="flex items-center gap-2">
        {/* GitHub Star Button */}
        <a
          href="https://github.com/abhigyanpatwari/GitNexus"
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-2 rounded-lg bg-gradient-to-r from-purple-600 to-pink-600 px-3.5 py-2 text-sm font-medium text-white shadow-lg transition-all duration-200 hover:-translate-y-0.5 hover:from-purple-500 hover:to-pink-500 hover:shadow-xl"
        >
          <Github className="h-4 w-4" />
          <span className="hidden sm:inline">{t('header:starIfCool')}</span>
          <Star className="h-3.5 w-3.5 transition-all group-hover:fill-yellow-300 group-hover:text-yellow-300" />
          <span className="hidden sm:inline">✨</span>
        </a>

        {/* Stats — hidden in chat-only mode, where the empty-but-non-null graph
            would otherwise show a misleading "0 nodes / 0 edges" (#2178). */}
        {graph && graphMode !== 'chatOnly' && (
          <div className="mr-2 flex items-center gap-4 text-xs text-text-muted">
            <span>{t('common:counts.nodes', { count: nodeCount })}</span>
            <span>{t('common:counts.edges', { count: edgeCount })}</span>
          </div>
        )}

        {/* Embedding Status */}
        <EmbeddingStatus />

        <LanguageSwitcher />

        {/* Icon buttons */}
        <button
          onClick={() => setSettingsPanelOpen(true)}
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          title={t('header:aiSettings')}
        >
          <Settings className="h-4.5 w-4.5" />
        </button>
        <button
          title={t('header:help')}
          onClick={() => setHelpDialogBoxOpen(true)}
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
        >
          <HelpCircle className="h-4.5 w-4.5" />
        </button>

        {/* AI Button */}
        <button
          onClick={openChatPanel}
          className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-all ${
            isRightPanelOpen && rightPanelTab === 'chat'
              ? 'bg-accent text-white shadow-glow'
              : 'bg-gradient-to-r from-accent to-accent-dim text-white shadow-glow hover:-translate-y-0.5 hover:shadow-lg'
          } `}
        >
          <Sparkles className="h-4 w-4" />
          <span>{t('common:app.nexusAI')}</span>
        </button>
      </div>
    </header>
  );
};
