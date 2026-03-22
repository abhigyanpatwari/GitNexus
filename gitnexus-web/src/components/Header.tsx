import { Search, Settings, HelpCircle, Sparkles, Github, Star, ChevronDown } from 'lucide-react';
import { useAppState } from '../hooks/useAppState';
import type { RepoSummary } from '../services/server-connection';
import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { GraphNode } from '../core/graph/types';
import { EmbeddingStatus } from './EmbeddingStatus';

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
  availableRepos?: RepoSummary[];
  onSwitchRepo?: (repoName: string) => void;
}

export const Header = ({ onFocusNode, availableRepos = [], onSwitchRepo }: HeaderProps) => {
  const {
    projectName,
    graph,
    openChatPanel,
    isRightPanelOpen,
    rightPanelTab,
    setSettingsPanelOpen,
    setHelpDialogBoxOpen
  } = useAppState();
  const [isRepoDropdownOpen, setIsRepoDropdownOpen] = useState(false);
  const repoDropdownRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
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

  // Handle clicking outside to close dropdowns
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setIsSearchOpen(false);
      }
      if (repoDropdownRef.current && !repoDropdownRef.current.contains(e.target as Node)) {
        setIsRepoDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
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

        {/* Project badge / Repo selector dropdown */}
        {projectName && (
          <div className="relative" ref={repoDropdownRef}>
            <button
              onClick={() => availableRepos.length >= 2 && setIsRepoDropdownOpen(prev => !prev)}
              className={`flex items-center gap-2 px-3 py-1.5 bg-surface border border-border-subtle rounded-lg text-sm text-text-secondary transition-colors ${availableRepos.length >= 2 ? 'hover:bg-hover cursor-pointer' : ''}`}
            >
              <span className="w-1.5 h-1.5 bg-node-function rounded-full animate-pulse" />
              <span className="truncate max-w-[200px]">{projectName}</span>
              {availableRepos.length >= 2 && (
                <ChevronDown className={`w-3.5 h-3.5 text-text-muted transition-transform ${isRepoDropdownOpen ? 'rotate-180' : ''}`} />
              )}
            </button>

            {/* Repo dropdown */}
            {isRepoDropdownOpen && availableRepos.length >= 2 && (
              <div className="absolute top-full left-0 mt-1 w-72 bg-surface border border-border-subtle rounded-lg shadow-xl overflow-hidden z-50">
                {availableRepos.map((repo) => {
                  const isCurrent = repo.name === projectName;
                  return (
                    <button
                      key={repo.name}
                      onClick={() => {
                        if (!isCurrent && onSwitchRepo) {
                          onSwitchRepo(repo.name);
                        }
                        setIsRepoDropdownOpen(false);
                      }}
                      className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-colors ${isCurrent ? 'bg-accent/10 border-l-2 border-accent' : 'hover:bg-hover border-l-2 border-transparent'}`}
                    >
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isCurrent ? 'bg-node-function animate-pulse' : 'bg-text-muted'}`} />
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-medium truncate ${isCurrent ? 'text-accent' : 'text-text-primary'}`}>
                          {repo.name}
                        </div>
                        <div className="text-xs text-text-muted mt-0.5">
                          {repo.stats?.nodes ?? '?'} nodes &middot; {repo.stats?.files ?? '?'} files
                        </div>
                      </div>
                    </button>
                  );
                })}
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
          <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border-subtle rounded-lg shadow-xl overflow-hidden z-50">
            {searchResults.length === 0 ? (
              <div className="px-4 py-3 text-sm text-text-muted">
                No nodes found for "{searchQuery}"
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                {searchResults.map((node, index) => (
                  <button
                    key={node.id}
                    onClick={() => handleSelectNode(node)}
                    className={`w-full px-4 py-2.5 flex items-center gap-3 text-left transition-colors ${index === selectedIndex
                      ? 'bg-accent/20 text-text-primary'
                      : 'hover:bg-hover text-text-secondary'
                      }`}
                  >
                    {/* Node type indicator */}
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: NODE_TYPE_COLORS[node.label] || '#6b7280' }}
                    />
                    {/* Node name */}
                    <span className="flex-1 truncate text-sm font-medium">
                      {node.properties.name}
                    </span>
                    {/* Node type badge */}
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
          className="w-9 h-9 flex items-center justify-center rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
          title="AI Settings"
        >
          <Settings className="w-4.5 h-4.5" />
        </button>
        <button
          title="Help"
          onClick={() => setHelpDialogBoxOpen(true)}
          className="w-9 h-9 flex items-center justify-center rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors">
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

