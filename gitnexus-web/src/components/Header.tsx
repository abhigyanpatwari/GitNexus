import { Search, Settings, HelpCircle, ChevronDown, Activity, Sun, Moon } from 'lucide-react';
import { useAppState } from '../hooks/useAppState';
import { useTheme } from '../context/ThemeContext';
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
    setSettingsPanelOpen,
    setTracePanelOpen,
  } = useAppState();
  const { theme, toggleTheme } = useTheme();
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
    <header className="flex items-center justify-between px-5 py-3 bg-deep border-b border-border-subtle">
      {/* Left section */}
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          {/* Analog sphere icon */}
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="14" cy="14" r="12" stroke="#0f0f1a" strokeWidth="1.5" fill="none" />
            <ellipse cx="14" cy="14" rx="6" ry="12" stroke="#0f0f1a" strokeWidth="1" fill="none" />
            <line x1="2" y1="14" x2="26" y2="14" stroke="#0f0f1a" strokeWidth="1" />
            <line x1="5" y1="7.5" x2="23" y2="7.5" stroke="#0f0f1a" strokeWidth="0.75" strokeDasharray="1.5 1.5" />
            <line x1="5" y1="20.5" x2="23" y2="20.5" stroke="#0f0f1a" strokeWidth="0.75" strokeDasharray="1.5 1.5" />
          </svg>
          <span
            className="text-[15px] tracking-widest uppercase text-text-primary"
            style={{ fontFamily: "'Courier New', Courier, monospace", letterSpacing: '0.18em', fontWeight: 400 }}
          >
            Darksphere
          </span>
        </div>

        {/* Project badge / Repo selector dropdown */}
        {projectName && (
          <div className="relative" ref={repoDropdownRef}>
            <button
              onClick={() => availableRepos.length >= 2 && setIsRepoDropdownOpen(prev => !prev)}
              className={`flex items-center gap-2 px-3 py-1.5 bg-surface border border-border-subtle text-sm text-text-secondary transition-colors ${availableRepos.length >= 2 ? 'hover:bg-hover cursor-pointer' : ''}`}
            >
              <span className="w-1.5 h-1.5 bg-node-function rounded-full animate-pulse" />
              <span className="truncate max-w-[200px]">{projectName}</span>
              {availableRepos.length >= 2 && (
                <ChevronDown className={`w-3.5 h-3.5 text-text-muted transition-transform ${isRepoDropdownOpen ? 'rotate-180' : ''}`} />
              )}
            </button>

            {/* Repo dropdown */}
            {isRepoDropdownOpen && availableRepos.length >= 2 && (
              <div className="absolute top-full left-0 mt-1 w-72 bg-surface border border-border-subtle shadow-xl overflow-hidden z-50">
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
        <div className="flex items-center gap-2.5 px-3.5 py-2 bg-surface border border-border-subtle transition-all focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
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
          <kbd className="px-1.5 py-0.5 bg-elevated border border-border-subtle text-[10px] text-text-muted font-mono">
            ⌘K
          </kbd>
        </div>

        {/* Search Results Dropdown */}
        {isSearchOpen && searchQuery.trim() && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border-subtle shadow-xl overflow-hidden z-50">
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
                    <span className="text-xs text-text-muted px-2 py-0.5 bg-elevated">
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
        {/* Stats */}
        {graph && (
          <div className="flex items-center gap-4 mr-2 text-xs text-text-muted">
            <span>{nodeCount} nodes</span>
            <span>{edgeCount} edges</span>
          </div>
        )}

        {/* Embedding Status */}
        <EmbeddingStatus />

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="w-9 h-9 flex items-center justify-center text-text-secondary hover:bg-hover hover:text-text-primary transition-colors border border-border-subtle"
          title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
        >
          {theme === 'light' ? <Moon className="w-[16px] h-[16px]" /> : <Sun className="w-[16px] h-[16px]" />}
        </button>

        {/* Icon buttons */}
        <button
          onClick={() => setTracePanelOpen(true)}
          className="w-9 h-9 flex items-center justify-center text-text-secondary hover:bg-hover hover:text-cyan-400 transition-colors"
          title="Agent Trace"
        >
          <Activity className="w-[18px] h-[18px]" />
        </button>
        <button
          onClick={() => setSettingsPanelOpen(true)}
          className="w-9 h-9 flex items-center justify-center text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
          title="AI Settings"
        >
          <Settings className="w-[18px] h-[18px]" />
        </button>
        <button className="w-9 h-9 flex items-center justify-center text-text-secondary hover:bg-hover hover:text-text-primary transition-colors">
          <HelpCircle className="w-[18px] h-[18px]" />
        </button>
      </div>
    </header>
  );
};

