/**
 * ToolCallCard Component
 *
 * Displays a tool call with expand/collapse functionality.
 * Shows the tool name, status, and when expanded, the query/args and result.
 */

import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Sparkles,
  Check,
  Loader2,
  AlertCircle,
} from '@/lib/lucide-icons';
import type { ToolCallInfo } from '../core/llm/types';

interface ToolCallCardProps {
  toolCall: ToolCallInfo;
  /** Start expanded (useful for in-progress calls) */
  defaultExpanded?: boolean;
}

/**
 * Format tool arguments for display
 */
const formatArgs = (args: Record<string, unknown>): string => {
  if (!args || Object.keys(args).length === 0) {
    return '';
  }

  // Special handling for Cypher queries
  if ('cypher' in args && typeof args.cypher === 'string') {
    let result = '';
    if ('query' in args && typeof args.query === 'string') {
      result += `Search: "${args.query}"\n\n`;
    }
    result += args.cypher;
    return result;
  }

  // Special handling for search/grep queries
  if ('query' in args && typeof args.query === 'string') {
    return args.query;
  }

  // For other tools, show as formatted JSON
  return JSON.stringify(args, null, 2);
};

/**
 * Get status icon and color
 */
const getStatusDisplay = (status: ToolCallInfo['status']) => {
  switch (status) {
    case 'running':
      return {
        icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
        color: 'text-amber-400',
        bgColor: 'bg-amber-500/10',
        borderColor: 'border-amber-500/30',
      };
    case 'completed':
      return {
        icon: <Check className="h-3.5 w-3.5" />,
        color: 'text-emerald-400',
        bgColor: 'bg-emerald-500/10',
        borderColor: 'border-emerald-500/30',
      };
    case 'error':
      return {
        icon: <AlertCircle className="h-3.5 w-3.5" />,
        color: 'text-rose-400',
        bgColor: 'bg-rose-500/10',
        borderColor: 'border-rose-500/30',
      };
    default:
      return {
        icon: <Sparkles className="h-3.5 w-3.5" />,
        color: 'text-text-muted',
        bgColor: 'bg-surface',
        borderColor: 'border-border-subtle',
      };
  }
};

/**
 * Get a friendly display name for the tool
 */
const getToolDisplayName = (name: string): string => {
  const names: Record<string, string> = {
    // Current 7-tool architecture
    search: '🔍 Search Code',
    cypher: '🔗 Cypher Query',
    grep: '🔎 Pattern Search',
    read: '📄 Read File',
    overview: '🗺️ Codebase Overview',
    explore: '🔬 Deep Dive',
    impact: '💥 Impact Analysis',
  };
  return names[name] || name;
};

export const ToolCallCard = ({ toolCall, defaultExpanded = false }: ToolCallCardProps) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const status = getStatusDisplay(toolCall.status);
  const formattedArgs = formatArgs(toolCall.args);

  return (
    <div
      className={`rounded-lg border ${status.borderColor} ${status.bgColor} overflow-hidden transition-all`}
    >
      {/* Header - always visible */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsExpanded(!isExpanded);
          }
        }}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors select-none hover:bg-white/5"
      >
        {/* Expand/collapse icon */}
        <span className="text-text-muted">
          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>

        {/* Tool name */}
        <span className="flex-1 text-sm font-medium text-text-primary">
          {getToolDisplayName(toolCall.name)}
        </span>

        {/* Status indicator */}
        <span className={`flex items-center gap-1 text-xs ${status.color}`}>
          {status.icon}
          <span className="capitalize">{toolCall.status}</span>
        </span>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-border-subtle/50">
          {/* Arguments/Query */}
          {formattedArgs && (
            <div className="border-b border-border-subtle/50 px-3 py-2">
              <div className="mb-1.5 text-[10px] tracking-wider text-text-muted uppercase">
                {toolCall.name === 'cypher' ? 'Query' : 'Input'}
              </div>
              <pre className="overflow-x-auto rounded bg-surface/50 p-2 font-mono text-xs whitespace-pre-wrap text-text-secondary">
                {formattedArgs}
              </pre>
            </div>
          )}

          {/* Result */}
          {toolCall.result && (
            <div className="px-3 py-2">
              <div className="mb-1.5 text-[10px] tracking-wider text-text-muted uppercase">
                Result
              </div>
              <div className="max-h-[400px] overflow-y-auto rounded bg-surface/50">
                <pre className="p-2 font-mono text-xs whitespace-pre-wrap text-text-secondary">
                  {toolCall.result.length > 3000
                    ? toolCall.result.slice(0, 3000) + '\n\n... (truncated)'
                    : toolCall.result}
                </pre>
              </div>
            </div>
          )}

          {/* Loading state for in-progress */}
          {toolCall.status === 'running' && !toolCall.result && (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-text-muted">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Executing...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolCallCard;
