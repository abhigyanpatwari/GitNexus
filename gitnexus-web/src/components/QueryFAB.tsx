import { useState, useRef, useEffect, useCallback } from 'react';
import { Terminal, Play, X, ChevronDown, ChevronUp, Loader2, Sparkles, Table } from '@/lib/lucide-icons';
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
  const { setHighlightedNodeIds, setQueryResult, queryResult, clearQueryHighlights, graph, runQuery, isDatabaseReady } = useAppState();

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
        .flatMap(row => {
          const ids: string[] = [];

          if (Array.isArray(row)) {
            // Array format - check all elements for node ID patterns
            row.forEach(val => {
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
        className="
          group absolute bottom-4 left-4 z-20
          flex items-center gap-2 px-4 py-2.5
          bg-gradient-to-r from-cyan-500 to-teal-500
          rounded-xl text-white font-medium text-sm
          shadow-[0_0_20px_rgba(6,182,212,0.4)]
          hover:shadow-[0_0_30px_rgba(6,182,212,0.6)]
          hover:-translate-y-0.5
          transition-all duration-200
        "
      >
        <Terminal className="w-4 h-4" />
        <span>Query</span>
        {queryResult && queryResult.nodeIds.length > 0 && (
          <span className="
            px-1.5 py-0.5 ml-1
            bg-white/20 rounded-md
            text-xs font-semibold
          ">
            {queryResult.nodeIds.length}
          </span>
        )}
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      className="
        absolute bottom-4 left-4 z-20
        w-[480px] max-w-[calc(100%-2rem)]
        bg-deep/95 backdrop-blur-md
        border border-cyan-500/30
        rounded-xl
        shadow-[0_0_40px_rgba(6,182,212,0.2)]
        animate-fade-in
      "
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 flex items-center justify-center bg-gradient-to-br from-cyan-500 to-teal-500 rounded-lg">
            <Terminal className="w-4 h-4 text-white" />
          </div>
          <span className="font-medium text-sm">Cypher Query</span>
        </div>
        <button
          onClick={handleClose}
          className="p-1.5 text-text-muted hover:text-text-primary hover:bg-hover rounded-md transition-colors"
        >
          <X className="w-4 h-4" />
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
            className="
              w-full px-3 py-2.5
              bg-surface border border-border-subtle rounded-lg
              text-sm font-mono text-text-primary
              placeholder:text-text-muted
              focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/20
              outline-none resize-none
              transition-all
            "
          />
        </div>

        <div className="flex items-center justify-between mt-3">
          <div className="relative">
            <button
              onClick={() => setShowExamples(!showExamples)}
              className="
                flex items-center gap-1.5 px-3 py-1.5
                text-xs text-text-secondary
                hover:text-text-primary hover:bg-hover
                rounded-md transition-colors
              "
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Examples</span>
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showExamples ? 'rotate-180' : ''}`} />
            </button>

            {showExamples && (
              <div className="
                absolute bottom-full left-0 mb-2
                w-64 py-1
                bg-surface border border-border-subtle rounded-lg
                shadow-xl
                animate-fade-in
              ">
                {EXAMPLE_QUERIES.map((example) => (
                  <button
                    key={example.label}
                    onClick={() => handleSelectExample(example.query)}
                    className="
                      w-full px-3 py-2 text-left
                      text-sm text-text-secondary
                      hover:bg-hover hover:text-text-primary
                      transition-colors
                    "
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
                className="
                  px-3 py-1.5
                  text-xs text-text-secondary
                  hover:text-text-primary hover:bg-hover
                  rounded-md transition-colors
                "
              >
                Clear
              </button>
            )}
            <button
              onClick={handleRunQuery}
              disabled={!query.trim() || isRunning}
              className="
                flex items-center gap-1.5 px-4 py-1.5
                bg-gradient-to-r from-cyan-500 to-teal-500
                rounded-md text-white text-sm font-medium
                shadow-[0_0_15px_rgba(6,182,212,0.3)]
                hover:shadow-[0_0_20px_rgba(6,182,212,0.5)]
                disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none
                transition-all
              "
            >
              {isRunning ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              <span>Run</span>
              <kbd className="ml-1 px-1 py-0.5 bg-white/20 rounded text-[10px]">⌘↵</kbd>
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 bg-red-500/10 border-t border-red-500/20">
          <p className="text-xs text-red-400 font-mono">{error}</p>
        </div>
      )}

      {queryResult && !error && (
        <div className="border-t border-cyan-500/20">
          <div className="px-4 py-2.5 bg-cyan-500/5 flex items-center justify-between">
            <div className="flex items-center gap-3 text-xs">
              <span className="text-text-secondary">
                <span className="text-cyan-400 font-semibold">{queryResult.rows.length}</span> rows
              </span>
              {queryResult.nodeIds.length > 0 && (
                <span className="text-text-secondary">
                  <span className="text-cyan-400 font-semibold">{queryResult.nodeIds.length}</span> highlighted
                </span>
              )}
              <span className="text-text-muted">
                {queryResult.executionTime.toFixed(1)}ms
              </span>
            </div>
            <div className="flex items-center gap-2">
              {queryResult.nodeIds.length > 0 && (
                <button
                  onClick={clearQueryHighlights}
                  className="text-xs text-text-muted hover:text-text-primary transition-colors"
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => setShowResults(!showResults)}
                className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors"
              >
                <Table className="w-3 h-3" />
                {showResults ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
              </button>
            </div>
          </div>

          {showResults && queryResult.rows.length > 0 && (
            <div className="max-h-48 overflow-auto scrollbar-thin border-t border-border-subtle">
              <table className="w-full text-xs">
                <thead className="bg-surface sticky top-0">
                  <tr>
                    {Object.keys(queryResult.rows[0]).map((key) => (
                      <th key={key} className="px-3 py-2 text-left text-text-muted font-medium border-b border-border-subtle">
                        {key}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {queryResult.rows.slice(0, 50).map((row, i) => (
                    <tr key={i} className="hover:bg-hover/50 transition-colors">
                      {Object.values(row).map((val, j) => (
                        <td key={j} className="px-3 py-1.5 text-text-secondary border-b border-border-subtle/50 font-mono truncate max-w-[200px]">
                          {typeof val === 'object' ? JSON.stringify(val) : String(val ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {queryResult.rows.length > 50 && (
                <div className="px-3 py-2 text-xs text-text-muted bg-surface border-t border-border-subtle">
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

