import { useState, useCallback } from 'react';
import { Activity, X, ChevronDown, ChevronRight, Clock, AlertCircle, CheckCircle, AlertTriangle } from 'lucide-react';
import { useAppState } from '../hooks/useAppState';
import {
  fetchTraceOverlay,
  loadLangfuseConfig,
  saveLangfuseConfig,
  type LangfuseConfig,
  type TraceSpan,
} from '../services/trace-overlay';

interface TraceOverlayPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onLoad?: (hitNodeIds: string[], failedNodeIds: string[]) => void;
}

const LEVEL_TEXT: Record<string, string> = {
  DEFAULT: 'text-emerald-400',
  WARNING: 'text-amber-400',
  ERROR: 'text-red-400',
};

const LEVEL_BG: Record<string, string> = {
  DEFAULT: 'bg-emerald-500/10 border-emerald-500/20',
  WARNING: 'bg-amber-500/10 border-amber-500/20',
  ERROR: 'bg-red-500/10 border-red-500/20',
};

const LevelIcon = ({ level }: { level: string }) => {
  if (level === 'ERROR') return <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />;
  if (level === 'WARNING') return <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />;
  return <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />;
};

const formatMs = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

export const TraceOverlayPanel = ({ isOpen, onClose, onLoad }: TraceOverlayPanelProps) => {
  const {
    serverBaseUrl,
    projectName,
    setAIToolHighlightedNodeIds,
    setBlastRadiusNodeIds,
    setTraceSpans,
    traceSpans,
    clearAIToolHighlights,
    clearBlastRadius,
  } = useAppState();

  const [traceId, setTraceId] = useState('');
  const [config, setConfig] = useState<LangfuseConfig>(() => loadLangfuseConfig());
  const [serverUrl, setServerUrl] = useState(() => serverBaseUrl?.replace(/\/api$/, '') || 'http://127.0.0.1:4747');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [scores, setScores] = useState<Record<string, number>>({});

  const handleLoad = useCallback(async () => {
    if (!traceId.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      saveLangfuseConfig(config);
      const repoName = projectName?.split(/[/\\]/).filter(Boolean).pop() || undefined;
      const result = await fetchTraceOverlay(serverUrl, traceId.trim(), config, repoName);
      setAIToolHighlightedNodeIds(new Set(result.hit_node_ids));
      setBlastRadiusNodeIds(new Set(result.failed_node_ids));
      setTraceSpans(result.spans);
      setScores(result.scores || {});
      onLoad?.(result.hit_node_ids, result.failed_node_ids);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trace');
    } finally {
      setIsLoading(false);
    }
  }, [traceId, config, serverUrl, projectName, setAIToolHighlightedNodeIds, setBlastRadiusNodeIds, setTraceSpans, onLoad]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClear = useCallback(() => {
    clearAIToolHighlights();
    clearBlastRadius();
    setTraceSpans([]);
    setScores({});
    setError(null);
  }, [clearAIToolHighlights, clearBlastRadius, setTraceSpans]);

  if (!isOpen) return null;

  const scoreEntries = Object.entries(scores);
  const hasResults = traceSpans.length > 0 || scoreEntries.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-surface border border-border-subtle rounded-2xl shadow-2xl w-full max-w-xl mx-4 overflow-hidden max-h-[88vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle bg-elevated/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 flex items-center justify-center bg-cyan-500/20 rounded-xl">
              <Activity className="w-5 h-5 text-cyan-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text-primary">Agent Trace</h2>
              <p className="text-xs text-text-muted">Visualize a Langfuse trace on the graph</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-text-muted hover:text-text-primary hover:bg-hover rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">

          {/* Trace ID */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-text-secondary">Trace ID</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={traceId}
                onChange={e => setTraceId(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLoad()}
                placeholder="e.g. 018f1a2b-3c4d-7e8f-9a0b-c1d2e3f4a5b6"
                className="flex-1 px-4 py-2.5 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none font-mono text-sm"
              />
              <button
                onClick={handleLoad}
                disabled={isLoading || !traceId.trim()}
                className="px-4 py-2.5 bg-accent text-white text-sm font-medium rounded-xl hover:bg-accent-dim transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? 'Loading...' : 'Load'}
              </button>
            </div>
          </div>

          {/* Langfuse config (collapsible) */}
          <div className="space-y-2">
            <button
              onClick={() => setShowConfig(v => !v)}
              className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              {showConfig ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              Langfuse Connection
            </button>
            {showConfig && (
              <div className="space-y-3 p-4 bg-elevated/50 border border-border-subtle rounded-xl">
                <div className="space-y-1">
                  <label className="text-xs text-text-muted">GitNexus Server URL</label>
                  <input type="url" value={serverUrl}
                    onChange={e => setServerUrl(e.target.value)}
                    placeholder="http://127.0.0.1:4747"
                    className="w-full px-3 py-2 bg-elevated border border-border-subtle rounded-lg text-text-primary text-sm outline-none focus:border-accent font-mono" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-text-muted">Langfuse Host</label>
                  <input type="url" value={config.host} placeholder="https://us.cloud.langfuse.com"
                    onChange={e => setConfig(p => ({ ...p, host: e.target.value }))}
                    className="w-full px-3 py-2 bg-elevated border border-border-subtle rounded-lg text-text-primary text-sm outline-none focus:border-accent font-mono" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-text-muted">Public Key</label>
                  <input type="password" value={config.publicKey} placeholder="pk-lf-..."
                    onChange={e => setConfig(p => ({ ...p, publicKey: e.target.value }))}
                    className="w-full px-3 py-2 bg-elevated border border-border-subtle rounded-lg text-text-primary text-sm outline-none focus:border-accent font-mono" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-text-muted">Secret Key</label>
                  <input type="password" value={config.secretKey} placeholder="sk-lf-..."
                    onChange={e => setConfig(p => ({ ...p, secretKey: e.target.value }))}
                    className="w-full px-3 py-2 bg-elevated border border-border-subtle rounded-lg text-text-primary text-sm outline-none focus:border-accent font-mono" />
                </div>
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-xl">
              <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {/* Quality scores */}
          {scoreEntries.length > 0 && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-text-secondary">Quality Scores</label>
              <div className="flex flex-wrap gap-2">
                {scoreEntries.map(([name, value]) => (
                  <span
                    key={name}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium border ${
                      value >= 0.8
                        ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                        : value >= 0.5
                        ? 'bg-amber-500/15 border-amber-500/30 text-amber-400'
                        : 'bg-red-500/15 border-red-500/30 text-red-400'
                    }`}
                  >
                    {name}: {typeof value === 'number' ? value.toFixed(2) : value}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Span timeline */}
          {traceSpans.length > 0 && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-text-secondary">
                Span Timeline ({traceSpans.length} spans)
              </label>
              <div className="space-y-1.5">
                {traceSpans.map((span: TraceSpan, idx: number) => (
                  <div
                    key={idx}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg border ${LEVEL_BG[span.level] ?? LEVEL_BG.DEFAULT}`}
                  >
                    <LevelIcon level={span.level} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-mono truncate ${LEVEL_TEXT[span.level] ?? 'text-text-primary'}`}>
                          {span.name}
                        </span>
                        {span.mapped_nodes.length > 0 && (
                          <span className="text-xs text-cyan-400 bg-cyan-400/10 px-1.5 py-0.5 rounded flex-shrink-0">
                            {span.mapped_nodes.length} node{span.mapped_nodes.length !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                      {span.status_message && (
                        <p className="text-xs text-text-muted truncate mt-0.5">{span.status_message}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-xs text-text-muted flex-shrink-0">
                      <Clock className="w-3 h-3" />
                      {formatMs(span.latency_ms)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border-subtle bg-elevated/30">
          <div className="flex items-center gap-3 text-xs text-text-muted">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-cyan-400 inline-block" />
              Executed
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />
              Failed
            </span>
          </div>
          <div className="flex items-center gap-3">
            {hasResults && (
              <button onClick={handleClear} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors">
                Clear
              </button>
            )}
            <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors">
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
