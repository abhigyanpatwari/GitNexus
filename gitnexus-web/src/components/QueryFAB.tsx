import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Terminal,
  Play,
  X,
  ChevronDown,
  ChevronUp,
  Loader2,
  Sparkles,
  Table,
} from '@/lib/lucide-icons';
import { useAppState } from '../hooks/useAppState';

const EXAMPLE_QUERIES = [
  {
    label: 'All Functions',
    query: `MATCH (n:Function) RETURN n.id AS id, n.name AS name, n.filePath AS path LIMIT 50`,
  },
  {
    label: 'All Classes',
    query: `MATCH (n:Class) RETURN n.id AS id, n.name AS name, n.filePath AS path LIMIT 50`,
  },
  {
    label: 'All Interfaces',
    query: `MATCH (n:Interface) RETURN n.id AS id, n.name AS name, n.filePath AS path LIMIT 50`,
  },
  {
    label: 'Function Calls',
    query: `MATCH (a:File)-[r:CodeRelation {type: 'CALLS'}]->(b:Function) RETURN a.id AS id, a.name AS caller, b.name AS callee LIMIT 50`,
  },
  {
    label: 'Import Dependencies',
    query: `MATCH (a:File)-[r:CodeRelation {type: 'IMPORTS'}]->(b:File) RETURN a.id AS id, a.name AS from, b.name AS imports LIMIT 50`,
  },
];

export const QueryFAB = () => {
  const {
    setHighlightedNodeIds,
    setQueryResult,
    queryResult,
    clearQueryHighlights,
    graph,
    runQuery,
    isDatabaseReady,
  } = useAppState();

  const [isExpanded, setIsExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExamples, setShowExamples] = useState(false);
  const [showResults, setShowResults] = useState(true);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isExpanded && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isExpanded]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setShowExamples(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isExpanded) {
        setIsExpanded(false);
        setShowExamples(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isExpanded]);

  const handleRunQuery = useCallback(async () => {
    if (!query.trim() || isRunning) return;

    if (!graph) {
      setError('No project loaded. Load a project first.');
      return;
    }

    const ready = await isDatabaseReady();
    if (!ready) {
      setError('Database not ready. Please wait for loading to complete.');
      return;
    }

    setIsRunning(true);
    setError(null);

    const startTime = performance.now();

    try {
      const rows = await runQuery(query);
      const executionTime = performance.now() - startTime;

      // Extract node IDs from results - handles various formats
      // 1. Array format: first element if it looks like a node ID
      // 2. Object format: any field ending with 'id' (case-insensitive)
      // 3. Values matching node ID pattern: Label:path:name
      const nodeIdPattern = /^(File|Function|Class|Method|Interface|Folder|CodeElement):/;

      const nodeIds = rows
        .flatMap((row) => {
          const ids: string[] = [];

          if (Array.isArray(row)) {
            // Array format - check all elements for node ID patterns
            row.forEach((val) => {
              if (typeof val === 'string' && (nodeIdPattern.test(val) || val.includes(':'))) {
                ids.push(val);
              }
            });
          } else if (typeof row === 'object' && row !== null) {
            // Object format - check fields ending with 'id' and values matching patterns
            Object.entries(row).forEach(([key, val]) => {
              const keyLower = key.toLowerCase();
              if (typeof val === 'string') {
                // Field name contains 'id'
                if (keyLower.includes('id') || keyLower === 'id') {
                  ids.push(val);
                }
                // Value matches node ID pattern
                else if (nodeIdPattern.test(val)) {
                  ids.push(val);
                }
              }
            });
          }

          return ids;
        })
        .filter(Boolean)
        .filter((id, index, arr) => arr.indexOf(id) === index);

      setQueryResult({ rows, nodeIds, executionTime });
      setHighlightedNodeIds(new Set(nodeIds));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Query execution failed');
      setQueryResult(null);
      setHighlightedNodeIds(new Set());
    } finally {
      setIsRunning(false);
    }
  }, [query, isRunning, graph, isDatabaseReady, runQuery, setHighlightedNodeIds, setQueryResult]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleRunQuery();
    }
  };

  const handleSelectExample = (exampleQuery: string) => {
    setQuery(exampleQuery);
    setShowExamples(false);
    textareaRef.current?.focus();
  };

  const handleClose = () => {
    setIsExpanded(false);
    setShowExamples(false);
    clearQueryHighlights();
    setError(null);
  };

  const handleClear = () => {
    setQuery('');
    clearQueryHighlights();
    setError(null);
    textareaRef.current?.focus();
  };

  if (!isExpanded) {
    return (
      <button
        onClick={() => setIsExpanded(true)}
        className="group absolute bottom-4 left-4 z-20 flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-teal-500 px-4 py-2.5 text-sm font-medium text-white shadow-[0_0_20px_rgba(6,182,212,0.4)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_0_30px_rgba(6,182,212,0.6)]"
      >
        <Terminal className="h-4 w-4" />
        <span>Query</span>
        {queryResult && queryResult.nodeIds.length > 0 && (
          <span className="ml-1 rounded-md bg-white/20 px-1.5 py-0.5 text-xs font-semibold">
            {queryResult.nodeIds.length}
          </span>
        )}
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      className="absolute bottom-4 left-4 z-20 w-[480px] max-w-[calc(100%-2rem)] animate-fade-in rounded-xl border border-cyan-500/30 bg-deep/95 shadow-[0_0_40px_rgba(6,182,212,0.2)] backdrop-blur-md"
    >
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-teal-500">
            <Terminal className="h-4 w-4 text-white" />
          </div>
          <span className="text-sm font-medium">Cypher Query</span>
        </div>
        <button
          onClick={handleClose}
          className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-hover hover:text-text-primary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="p-3">
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="MATCH (n:Function) RETURN n.name, n.filePath LIMIT 10"
            rows={3}
            className="w-full resize-none rounded-lg border border-border-subtle bg-surface px-3 py-2.5 font-mono text-sm text-text-primary transition-all outline-none placeholder:text-text-muted focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/20"
          />
        </div>

        <div className="mt-3 flex items-center justify-between">
          <div className="relative">
            <button
              onClick={() => setShowExamples(!showExamples)}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>Examples</span>
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${showExamples ? 'rotate-180' : ''}`}
              />
            </button>

            {showExamples && (
              <div className="absolute bottom-full left-0 mb-2 w-64 animate-fade-in rounded-lg border border-border-subtle bg-surface py-1 shadow-xl">
                {EXAMPLE_QUERIES.map((example) => (
                  <button
                    key={example.label}
                    onClick={() => handleSelectExample(example.query)}
                    className="w-full px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
                  >
                    {example.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {query && (
              <button
                onClick={handleClear}
                className="rounded-md px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
              >
                Clear
              </button>
            )}
            <button
              onClick={handleRunQuery}
              disabled={!query.trim() || isRunning}
              className="flex items-center gap-1.5 rounded-md bg-gradient-to-r from-cyan-500 to-teal-500 px-4 py-1.5 text-sm font-medium text-white shadow-[0_0_15px_rgba(6,182,212,0.3)] transition-all hover:shadow-[0_0_20px_rgba(6,182,212,0.5)] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
            >
              {isRunning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              <span>Run</span>
              <kbd className="ml-1 rounded bg-white/20 px-1 py-0.5 text-[10px]">⌘↵</kbd>
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="border-t border-red-500/20 bg-red-500/10 px-4 py-2">
          <p className="font-mono text-xs text-red-400">{error}</p>
        </div>
      )}

      {queryResult && !error && (
        <div className="border-t border-cyan-500/20">
          <div className="flex items-center justify-between bg-cyan-500/5 px-4 py-2.5">
            <div className="flex items-center gap-3 text-xs">
              <span className="text-text-secondary">
                <span className="font-semibold text-cyan-400">{queryResult.rows.length}</span> rows
              </span>
              {queryResult.nodeIds.length > 0 && (
                <span className="text-text-secondary">
                  <span className="font-semibold text-cyan-400">{queryResult.nodeIds.length}</span>{' '}
                  highlighted
                </span>
              )}
              <span className="text-text-muted">{queryResult.executionTime.toFixed(1)}ms</span>
            </div>
            <div className="flex items-center gap-2">
              {queryResult.nodeIds.length > 0 && (
                <button
                  onClick={clearQueryHighlights}
                  className="text-xs text-text-muted transition-colors hover:text-text-primary"
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => setShowResults(!showResults)}
                className="flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-text-primary"
              >
                <Table className="h-3 w-3" />
                {showResults ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronUp className="h-3 w-3" />
                )}
              </button>
            </div>
          </div>

          {showResults && queryResult.rows.length > 0 && (
            <div className="scrollbar-thin max-h-48 overflow-auto border-t border-border-subtle">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    {Object.keys(queryResult.rows[0]).map((key) => (
                      <th
                        key={key}
                        className="border-b border-border-subtle px-3 py-2 text-left font-medium text-text-muted"
                      >
                        {key}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {queryResult.rows.slice(0, 50).map((row, i) => (
                    <tr key={i} className="transition-colors hover:bg-hover/50">
                      {Object.values(row).map((val, j) => (
                        <td
                          key={j}
                          className="max-w-[200px] truncate border-b border-border-subtle/50 px-3 py-1.5 font-mono text-text-secondary"
                        >
                          {typeof val === 'object' ? JSON.stringify(val) : String(val ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {queryResult.rows.length > 50 && (
                <div className="border-t border-border-subtle bg-surface px-3 py-2 text-xs text-text-muted">
                  Showing 50 of {queryResult.rows.length} rows
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
