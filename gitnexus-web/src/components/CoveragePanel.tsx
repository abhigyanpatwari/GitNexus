/**
 * Coverage Panel
 *
 * Displays test coverage overview with:
 * - Overall coverage progress bar
 * - Run selector (pick from available runs)
 * - Top uncovered symbols list (clickable → focus node)
 * - Diff entry (select two runs → compare)
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { Shield, RefreshCw, AlertTriangle, ChevronDown, ChevronRight, BarChart3 } from 'lucide-react';
import { useAppState } from '../hooks/useAppState';
import {
  fetchCoverageStatus,
  fetchCoverageRuns,
  fetchCoverageDiff,
  type CoverageStatus,
  type CoverageDiff,
} from '../services/backend-client';
import { coverageColor } from '../lib/coverage-colors';

export const CoveragePanel = () => {
  const { graph, setSelectedNode, openCodePanel } = useAppState();
  const [status, setStatus] = useState<CoverageStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Diff state
  const [diffRun1, setDiffRun1] = useState<string>('');
  const [diffRun2, setDiffRun2] = useState<string>('');
  const [diffResult, setDiffResult] = useState<CoverageDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  const loadCoverage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCoverageStatus();
      setStatus(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load coverage data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCoverage();
  }, [loadCoverage]);

  const handleDiff = useCallback(async () => {
    if (!diffRun1 || !diffRun2) return;
    setDiffLoading(true);
    try {
      const result = await fetchCoverageDiff(diffRun1, diffRun2);
      setDiffResult(result);
    } catch (err: any) {
      setError(err.message || 'Failed to load diff');
    } finally {
      setDiffLoading(false);
    }
  }, [diffRun1, diffRun2]);

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      if (!graph) return;
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (node) {
        setSelectedNode(node);
        openCodePanel();
      }
    },
    [graph, setSelectedNode, openCodePanel],
  );

  // Build a node-id → name lookup from graph
  const nodeNameMap = useMemo(() => {
    if (!graph) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const n of graph.nodes) {
      map.set(n.id, n.properties.name || n.id);
    }
    return map;
  }, [graph]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <RefreshCw className="h-5 w-5 animate-spin text-text-muted" />
        <span className="ml-2 text-sm text-text-muted">Loading coverage data...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
        <AlertTriangle className="h-8 w-8 text-amber-400" />
        <p className="text-sm text-text-muted">{error}</p>
        <button
          onClick={loadCoverage}
          className="rounded-md bg-accent/15 px-3 py-1.5 text-xs text-accent hover:bg-accent/25"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!status || status.status === 'no_data') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
        <Shield className="h-10 w-10 text-text-muted" />
        <p className="text-sm text-text-muted">
          {status?.message || 'No coverage data available'}
        </p>
        <p className="text-xs text-text-muted">
          Import coverage data with: <code className="rounded bg-elevated px-1 py-0.5">gitnexus coverage import &lt;file&gt;</code>
        </p>
      </div>
    );
  }

  const ratio = status.overallCoverage;
  const pct = (ratio * 100).toFixed(1);

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
      {/* Overall Coverage Bar */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Overall Coverage
          </h3>
          <span className="text-sm font-mono font-bold" style={{ color: coverageColor(ratio) }}>
            {pct}%
          </span>
        </div>
        {/* Progress bar */}
        <div className="h-3 w-full overflow-hidden rounded-full bg-elevated">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${Math.max(ratio * 100, 2)}%`,
              backgroundColor: coverageColor(ratio),
            }}
          />
        </div>
        <div className="mt-1.5 flex gap-4 text-xs text-text-muted">
          <span>
            {status.coveredSymbols} covered / {status.totalSymbols} total symbols
          </span>
          {status.latestRun && (
            <span>
              Latest: {new Date(status.latestRun.timestamp).toLocaleDateString()}
            </span>
          )}
        </div>
      </section>

      {/* Run Selector */}
      {status.availableRuns.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
            Coverage Runs
          </h3>
          <div className="max-h-32 overflow-y-auto rounded-lg border border-border-subtle">
            {status.availableRuns.map((run) => (
              <div
                key={run.id}
                className="flex items-center justify-between border-b border-border-subtle px-3 py-2 text-xs last:border-b-0"
              >
                <div className="flex flex-col">
                  <span className="text-text-primary">
                    {run.label || new Date(run.timestamp).toLocaleString()}
                  </span>
                  <span className="text-text-muted">
                    {run.coveredLines}/{run.totalLines} lines
                  </span>
                </div>
                <span
                  className="font-mono font-bold"
                  style={{ color: coverageColor(run.coverageRatio) }}
                >
                  {(run.coverageRatio * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Top Uncovered Symbols */}
      {status.topUncovered.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
            Top Uncovered Symbols
          </h3>
          <div className="max-h-64 overflow-y-auto rounded-lg border border-border-subtle">
            {status.topUncovered.map((sym) => (
              <button
                key={sym.nodeId}
                onClick={() => handleNodeClick(sym.nodeId)}
                className="flex w-full items-center justify-between border-b border-border-subtle px-3 py-2 text-left text-xs last:border-b-0 hover:bg-hover transition-colors"
              >
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="truncate text-text-primary">
                    {sym.symbolName || nodeNameMap.get(sym.nodeId) || sym.nodeId}
                  </span>
                  {sym.filePath && (
                    <span className="truncate text-text-muted">{sym.filePath}</span>
                  )}
                </div>
                <span className="ml-2 shrink-0 font-mono text-red-400">
                  {(sym.coverageRatio * 100).toFixed(0)}%
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Diff Section */}
      <section>
        <button
          onClick={() => setShowDiff(!showDiff)}
          className="flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-text-muted hover:text-text-primary"
        >
          {showDiff ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          Compare Runs (Diff)
        </button>

        {showDiff && (
          <div className="mt-2 space-y-2">
            <div className="flex gap-2">
              <select
                value={diffRun1}
                onChange={(e) => setDiffRun1(e.target.value)}
                className="flex-1 rounded-md border border-border-subtle bg-elevated px-2 py-1.5 text-xs text-text-primary"
              >
                <option value="">Select baseline...</option>
                {status.availableRuns.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label || new Date(r.timestamp).toLocaleDateString()} ({(r.coverageRatio * 100).toFixed(0)}%)
                  </option>
                ))}
              </select>
              <select
                value={diffRun2}
                onChange={(e) => setDiffRun2(e.target.value)}
                className="flex-1 rounded-md border border-border-subtle bg-elevated px-2 py-1.5 text-xs text-text-primary"
              >
                <option value="">Select comparison...</option>
                {status.availableRuns.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label || new Date(r.timestamp).toLocaleDateString()} ({(r.coverageRatio * 100).toFixed(0)}%)
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={handleDiff}
              disabled={!diffRun1 || !diffRun2 || diffLoading}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent/15 px-3 py-1.5 text-xs text-accent hover:bg-accent/25 disabled:opacity-50"
            >
              {diffLoading ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <BarChart3 className="h-3.5 w-3.5" />
              )}
              Compare
            </button>

            {diffResult && (
              <div className="rounded-lg border border-border-subtle p-3 text-xs">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-text-muted">Delta:</span>
                  <span
                    className={`font-mono font-bold ${
                      diffResult.delta > 0 ? 'text-emerald-400' : diffResult.delta < 0 ? 'text-red-400' : 'text-text-muted'
                    }`}
                  >
                    {diffResult.delta > 0 ? '+' : ''}
                    {(diffResult.delta * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="flex gap-4">
                  <span className="text-emerald-400">
                    +{diffResult.summary.newlyCovered} newly covered
                  </span>
                  <span className="text-red-400">
                    -{diffResult.summary.regressions} regressions
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
};