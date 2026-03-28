import { Search, Settings, HelpCircle, Sparkles, Github, Star, FolderOpen, ChevronDown, Trash2, RefreshCw, Loader2 } from '@/lib/lucide-icons';
import { useAppState } from '../hooks/useAppState';
import { deleteRepo, fetchRepos, startAnalyze, streamAnalyzeProgress, type BackendRepo, type JobProgress } from '../services/backend-client';
import { useState, useMemo, useRef, useEffect } from 'react';
import { GraphNode } from 'gitnexus-shared';
import { EmbeddingStatus } from './EmbeddingStatus';
import { RepoAnalyzer } from './RepoAnalyzer';

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

export const Header = ({ onFocusNode, availableRepos = [], onSwitchRepo, onAnalyzeComplete, onReposChanged }: HeaderProps) => {
  const {
    projectName,
    graph,
    openChatPanel,
    isRightPanelOpen,
    rightPanelTab,
    setSettingsPanelOpen,
    setHelpDialogBoxOpen
  } = useAppState();
  const [searchQuery, setSearchQuery] = useState('');
  const [isRepoDropdownOpen, setIsRepoDropdownOpen] = useState(false);
  const [showAnalyzer, setShowAnalyzer] = useState(false);
  const [reanalyzing, setReanalyzing] = useState<string | null>(null); // repo name being re-analyzed
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
      .filter(node => node.properties.name.toLowerCase().includes(query))
      .slice(0, 10); // Limit to 10 results
  }, [graph, searchQuery]);

  // Handle clicking outside search or repo dropdown to close them
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setIsSearchOpen(false);
      }
      if (repoDropdownRef.current && !repoDropdownRef.current.contains(e.target as Node)) {
        setIsRepoDropdownOpen(false);
        setShowAnalyzer(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Cleanup re-analyze SSE on unmount
  useEffect(() => {
    return () => { reanalyzeSseRef.current?.abort(); };
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
      setSelectedIndex(i => Math.min(i + 1, searchResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
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
    <header className="flex items-center justify-between px-5 py-3 bg-deep border-b border-dashed border-border-subtle">
      {/* Left section */}
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 flex items-center justify-center bg-gradient-to-br from-accent to-node-interface rounded-md shadow-glow text-white text-sm font-bold">
            ◇
          </div>
          <span className="font-semibold text-[15px] tracking-tight">GitNexus</span>
        </div>

        {/* Project badge + repo dropdown */}
        {projectName && (
          <div className="relative" ref={repoDropdownRef}>
            <button
              onClick={() => { setIsRepoDropdownOpen(prev => !prev); setShowAnalyzer(false); }}
              className={`
                flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm transition-all cursor-pointer
                ${isRepoDropdownOpen
                  ? 'bg-accent/10 border-accent/40 text-text-primary'
                  : 'bg-surface border-border-subtle text-text-secondary hover:bg-hover hover:border-border-default'
                }
              `}
            >
              <span className="w-1.5 h-1.5 bg-node-function rounded-full animate-pulse" />
              <span className="truncate max-w-[160px]">{projectName}</span>
              <ChevronDown className={`w-3 h-3 text-text-muted transition-transform duration-200 ${isRepoDropdownOpen ? 'rotate-180' : ''}`} />
            </button>

            {isRepoDropdownOpen && (
              <div className="absolute top-full left-0 mt-1.5 w-80 bg-surface border border-border-subtle rounded-xl shadow-xl overflow-hidden z-50 animate-slide-up">
                {showAnalyzer ? (
                  <div className="p-4">
                    <RepoAnalyzer
                      variant="sheet"
                      onComplete={(repoName) => {
                        setShowAnalyzer(false);
                        setIsRepoDropdownOpen(false);
                        onAnalyzeComplete?.(repoName);
                      }}
                      onCancel={() => setShowAnalyzer(false)}
                    />
                  </div>
                ) : (
                  <>
                    {/* Repo list */}
                    {availableRepos.length > 0 && (
                      <div>
                        <div className="px-3 pt-2.5 pb-1.5 text-[10px] font-medium text-text-muted uppercase tracking-wider">
                          Repositories
                        </div>
                        {availableRepos.map(repo => (
                          <div
                            key={repo.name}
                            className={`group flex items-center gap-2 px-4 py-2 transition-colors ${
                              repo.name === projectName
                                ? 'bg-accent/10 border-l-2 border-accent'
                                : 'hover:bg-hover'
                            }`}
                          >
                            <button
                              onClick={() => {
                                if (repo.name !== projectName) onSwitchRepo?.(repo.name);
                                setIsRepoDropdownOpen(false);
                              }}
                              className="flex-1 flex items-center gap-3 text-left cursor-pointer min-w-0"
                            >
                              <FolderOpen className="w-3.5 h-3.5 text-node-folder shrink-0" />
                              <span className="flex-1 truncate text-sm text-text-primary font-mono">{repo.name}</span>
                              {repo.name === projectName && (
                                <span className="text-[10px] text-accent font-mono shrink-0">active</span>
                              )}
                            </button>
                            {/* Re-analyze */}
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (reanalyzing) return; // already running
                                setReanalyzing(repo.name);
                                setReanalyzeProgress({ phase: 'queued', percent: 0, message: 'Starting...' });
                                try {
                                  const { jobId } = await startAnalyze({ path: repo.path, force: true });
                                  reanalyzeSseRef.current = streamAnalyzeProgress(
                                    jobId,
                                    (p) => setReanalyzeProgress(p),
                                    () => {
                                      setReanalyzing(null);
                                      setReanalyzeProgress(null);
                                      reanalyzeSseRef.current = null;
                                      onAnalyzeComplete?.(repo.name);
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
                              className={`p-1 rounded transition-all cursor-pointer ${
                                reanalyzing === repo.name
                                  ? 'text-accent'
                                  : 'text-text-muted/0 group-hover:text-text-muted hover:!text-accent'
                              }`}
                              title={reanalyzing === repo.name ? 'Re-analyzing...' : `Re-analyze ${repo.name}`}
                            >
                              <RefreshCw className={`w-3.5 h-3.5 ${reanalyzing === repo.name ? 'animate-spin' : ''}`} />
                            </button>
                            {/* Delete */}
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                // Abort any running re-analysis for this repo
                                if (reanalyzing === repo.name) {
                                  reanalyzeSseRef.current?.abort();
                                  setReanalyzing(null);
                                  setReanalyzeProgress(null);
                                  reanalyzeSseRef.current = null;
                                }
                                try {
                                  await deleteRepo(repo.name);
                                  const updated = await fetchRepos();
                                  onReposChanged?.(updated);
                                  // If we deleted the active repo, switch to first available
                                  if (repo.name === projectName && updated.length > 0) {
                                    onSwitchRepo?.(updated[0].name);
                                  } else if (updated.length === 0) {
                                    // No repos left — go back to onboarding
                                    window.location.reload();
                                  }
                                } catch (err) {
                                  console.error('Failed to delete repo:', err);
                                }
                              }}
                              className="p-1 text-text-muted/0 group-hover:text-text-muted hover:!text-red-400 rounded transition-all cursor-pointer"
                              title={`Delete ${repo.name}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Re-analyze progress bar */}
                    {reanalyzing && reanalyzeProgress && (
                      <div className="px-4 py-2.5 border-t border-border-subtle bg-accent/5">
                        <div className="flex items-center gap-2 mb-1.5">
                          <Loader2 className="w-3 h-3 text-accent animate-spin shrink-0" />
                          <span className="text-xs text-text-secondary truncate">
                            Re-analyzing {reanalyzing}: {reanalyzeProgress.message}
                          </span>
                        </div>
                        <div className="h-1 bg-elevated rounded-full overflow-hidden">
                          <div
                            className="h-full bg-accent rounded-full transition-all duration-300"
                            style={{ width: `${Math.max(2, reanalyzeProgress.percent)}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Analyze new */}
                    <div className={availableRepos.length > 0 || reanalyzing ? 'border-t border-border-subtle' : ''}>
                      <button
                        onClick={() => setShowAnalyzer(true)}
                        disabled={!!reanalyzing}
                        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Sparkles className="w-3.5 h-3.5 text-accent shrink-0" />
                        <span className="text-sm text-text-secondary">Analyze a new repository...</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Center - Search */}
      <div className="flex-1 max-w-md mx-6 relative" ref={searchRef}>
        <div className="flex items-center gap-2.5 px-3.5 py-2 bg-surface border border-border-subtle rounded-lg transition-all focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
          <Search className="w-4 h-4 text-text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search nodes..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setIsSearchOpen(true);
              setSelectedIndex(0);
            }}
            onFocus={() => setIsSearchOpen(true)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent border-none outline-none text-sm text-text-primary placeholder:text-text-muted"
          />
          <kbd className="px-1.5 py-0.5 bg-elevated border border-border-subtle rounded text-[10px] text-text-muted font-mono">
            ⌘K
          </kbd>
        </div>

        {/* Search Results Dropdown */}
        {isSearchOpen && searchQuery.trim() && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border-subtle rounded-xl shadow-xl overflow-hidden z-50">
            {searchResults.length === 0 ? (
              <div className="px-4 py-3 text-sm text-text-muted">
                No nodes found for &ldquo;{searchQuery}&rdquo;
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                {searchResults.map((node, index) => (
                  <button
                    key={node.id}
                    onClick={() => handleSelectNode(node)}
                    className={`w-full px-4 py-2.5 flex items-center gap-3 text-left transition-colors cursor-pointer ${index === selectedIndex
                      ? 'bg-accent/20 text-text-primary'
                      : 'hover:bg-hover text-text-secondary'
                      }`}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: NODE_TYPE_COLORS[node.label] || '#6b7280' }}
                    />
                    <span className="flex-1 truncate text-sm font-medium">
                      {node.properties.name}
                    </span>
                    <span className="text-xs text-text-muted px-2 py-0.5 bg-elevated rounded">
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
          className="flex items-center gap-2 px-3.5 py-2 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 rounded-lg text-white text-sm font-medium shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200 group"
        >
          <Github className="w-4 h-4" />
          <span className="hidden sm:inline">Star if cool</span>
          <Star className="w-3.5 h-3.5 group-hover:fill-yellow-300 group-hover:text-yellow-300 transition-all" />
          <span className="hidden sm:inline">✨</span>
        </a>

        {/* Stats */}
        {graph && (
          <div className="flex items-center gap-4 mr-2 text-xs text-text-muted">
            <span>{nodeCount} nodes</span>
            <span>{edgeCount} edges</span>
          </div>
        )}

        {/* Embedding Status */}
        <EmbeddingStatus />

        {/* Icon buttons */}
        <button
          onClick={() => setSettingsPanelOpen(true)}
          className="w-9 h-9 flex items-center justify-center rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors cursor-pointer"
          title="AI Settings"
        >
          <Settings className="w-4.5 h-4.5" />
        </button>
        <button
          title="Help"
          onClick={() => setHelpDialogBoxOpen(true)}
          className="w-9 h-9 flex items-center justify-center rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors cursor-pointer">
          <HelpCircle className="w-4.5 h-4.5" />
        </button>

        {/* AI Button */}
        <button
          onClick={openChatPanel}
          className={`
            flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition-all
            ${isRightPanelOpen && rightPanelTab === 'chat'
              ? 'bg-accent text-white shadow-glow'
              : 'bg-gradient-to-r from-accent to-accent-dim text-white shadow-glow hover:shadow-lg hover:-translate-y-0.5'
            }
          `}
        >
          <Sparkles className="w-4 h-4" />
          <span>Nexus AI</span>
        </button>
      </div>
    </header>
  );
};

