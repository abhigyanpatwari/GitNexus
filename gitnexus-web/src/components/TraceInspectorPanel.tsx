import { useState } from 'react';
import { X, ChevronDown, ChevronRight, Cpu, Clock, Zap, AlertCircle, CheckCircle, AlertTriangle, Code2 } from 'lucide-react';
import type { TraceSpan } from '../services/trace-overlay';

interface TraceInspectorPanelProps {
  span: TraceSpan;
  onClose: () => void;
  onFocusNode?: (nodeId: string) => void;
}

const LEVEL_COLORS: Record<string, string> = {
  DEFAULT: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  WARNING: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  ERROR: 'text-red-400 bg-red-500/10 border-red-500/30',
};

const TYPE_COLORS: Record<string, string> = {
  GENERATION: 'text-purple-400 bg-purple-500/10 border-purple-500/30',
  SPAN: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
  EVENT: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
};

const LevelIcon = ({ level }: { level: string }) => {
  if (level === 'ERROR') return <AlertCircle className="w-3.5 h-3.5" />;
  if (level === 'WARNING') return <AlertTriangle className="w-3.5 h-3.5" />;
  return <CheckCircle className="w-3.5 h-3.5" />;
};

const formatMs = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

const JsonBlock = ({ value, label }: { value: unknown; label: string }) => {
  const [open, setOpen] = useState(true);
  if (value === undefined || value === null) return null;

  let display: string;
  try {
    display = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    display = String(value);
  }

  // Truncate very long strings for display
  const isLong = display.length > 4000;
  const shown = isLong ? display.slice(0, 4000) + '\n... (truncated)' : display;

  return (
    <div className="border border-border-subtle rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2 bg-elevated/50 hover:bg-elevated transition-colors text-left"
      >
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">{label}</span>
        <div className="flex items-center gap-2">
          {isLong && <span className="text-xs text-text-muted">4000/{display.length} chars</span>}
          {open ? <ChevronDown className="w-3.5 h-3.5 text-text-muted" /> : <ChevronRight className="w-3.5 h-3.5 text-text-muted" />}
        </div>
      </button>
      {open && (
        <pre className="px-3 py-2.5 text-xs font-mono text-text-secondary overflow-x-auto bg-surface leading-relaxed whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
          {shown}
        </pre>
      )}
    </div>
  );
};

export const TraceInspectorPanel = ({ span, onClose, onFocusNode }: TraceInspectorPanelProps) => {
  const levelColor = LEVEL_COLORS[span.level] ?? LEVEL_COLORS.DEFAULT;
  const typeColor = TYPE_COLORS[span.type ?? 'SPAN'] ?? TYPE_COLORS.SPAN;

  return (
    <div className="h-full flex flex-col bg-surface border-l border-border-subtle" style={{ width: 380 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-elevated/40 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Zap className="w-4 h-4 text-cyan-400 flex-shrink-0" />
          <span className="text-sm font-semibold text-text-primary font-mono truncate">{span.name}</span>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 text-text-muted hover:text-text-primary hover:bg-hover rounded-lg transition-colors flex-shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* Overview badges */}
        <div className="flex flex-wrap gap-1.5">
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${levelColor}`}>
            <LevelIcon level={span.level} />
            {span.level}
          </span>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${typeColor}`}>
            {span.type ?? 'SPAN'}
          </span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border text-text-secondary bg-elevated/50 border-border-subtle">
            <Clock className="w-3 h-3" />
            {formatMs(span.latency_ms)}
          </span>
          {span.mapped_nodes.length > 0 && (
            <span className="px-2 py-0.5 rounded-full text-xs font-medium border text-cyan-400 bg-cyan-500/10 border-cyan-500/30">
              {span.mapped_nodes.length} node{span.mapped_nodes.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Status message */}
        {span.status_message && (
          <div className="flex items-start gap-2 p-3 bg-elevated/50 border border-border-subtle rounded-lg">
            <AlertCircle className="w-3.5 h-3.5 text-text-muted mt-0.5 flex-shrink-0" />
            <p className="text-xs text-text-secondary leading-relaxed">{span.status_message}</p>
          </div>
        )}

        {/* Model + token usage (for GENERATION) */}
        {(span.model || span.usage) && (
          <div className="p-3 bg-purple-500/5 border border-purple-500/20 rounded-lg space-y-2">
            {span.model && (
              <div className="flex items-center gap-2">
                <Cpu className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
                <span className="text-xs font-mono text-purple-300">{span.model}</span>
              </div>
            )}
            {span.usage && (
              <div className="flex items-center gap-3 text-xs text-text-muted">
                <span>↑ <span className="text-text-secondary font-medium">{span.usage.input}</span> in</span>
                <span>↓ <span className="text-text-secondary font-medium">{span.usage.output}</span> out</span>
                <span className="text-text-secondary font-medium">{span.usage.total}</span> total
              </div>
            )}
          </div>
        )}

        {/* Mapped code nodes */}
        {span.mapped_nodes.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide">Code Nodes</p>
            <div className="space-y-1">
              {span.mapped_nodes.map(nodeId => {
                const short = nodeId.split(':').pop() ?? nodeId;
                return (
                  <button
                    key={nodeId}
                    onClick={() => onFocusNode?.(nodeId)}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-cyan-500/5 border border-cyan-500/20 hover:bg-cyan-500/10 transition-colors text-left group"
                  >
                    <Code2 className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
                    <span className="text-xs font-mono text-cyan-300 truncate">{short}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Input */}
        <JsonBlock value={span.input} label="Input" />

        {/* Output */}
        <JsonBlock value={span.output} label="Output" />

        {/* Metadata */}
        <JsonBlock value={span.metadata} label="Metadata" />

        {/* Timing */}
        {span.start_time && (
          <div className="text-xs text-text-muted pt-1 border-t border-border-subtle">
            Started: {new Date(span.start_time).toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })}
          </div>
        )}
      </div>
    </div>
  );
};
