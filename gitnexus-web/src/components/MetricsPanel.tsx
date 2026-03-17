/**
 * Metrics Panel
 * 
 * Displays code complexity metrics and hotspots.
 * Shows functions/methods sorted by cyclomatic complexity.
 * Color-coded by complexity rank (low/medium/high/critical).
 */

import { useState, useMemo, useCallback } from 'react';
import { 
  Activity, 
  Search, 
  AlertTriangle, 
  AlertCircle, 
  CheckCircle, 
  TrendingUp,
  ArrowDownRight,
  ArrowUpRight,
  Filter,
  ChevronDown,
  ChevronRight,
  Flame,
  Zap
} from 'lucide-react';
import { useAppState } from '../hooks/useAppState';
import type { GraphNode } from '../core/graph/types';

type ComplexityRank = 'low' | 'medium' | 'high' | 'critical';

interface MetricsSummary {
  totalFunctions: number;
  avgComplexity: number;
  maxComplexity: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

interface MetricsNodeItem {
  node: GraphNode;
  complexity: number;
  rank: ComplexityRank;
  fanIn: number;
  fanOut: number;
  loc: number;
  instability: number;
}

const RANK_CONFIG: Record<ComplexityRank, { color: string; bg: string; icon: typeof AlertTriangle; label: string }> = {
  critical: { color: 'text-red-400', bg: 'bg-red-500/20', icon: AlertTriangle, label: 'Critical' },
  high: { color: 'text-orange-400', bg: 'bg-orange-500/20', icon: AlertCircle, label: 'High' },
  medium: { color: 'text-yellow-400', bg: 'bg-yellow-500/20', icon: TrendingUp, label: 'Medium' },
  low: { color: 'text-green-400', bg: 'bg-green-500/20', icon: CheckCircle, label: 'Low' },
};

export const MetricsPanel = ({ onFocusNode }: { onFocusNode?: (nodeId: string) => void }) => {
  const { graph, setSelectedNode, setHighlightedNodeIds } = useAppState();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRanks, setSelectedRanks] = useState<Set<ComplexityRank>>(
    new Set(['critical', 'high', 'medium', 'low'])
  );
  const [expandedSections, setExpandedSections] = useState<Set<ComplexityRank>>(
    new Set(['critical', 'high'])
  );
  const [sortBy, setSortBy] = useState<'complexity' | 'fanIn' | 'fanOut' | 'instability'>('complexity');

  // Extract metrics data from graph
  const { items, summary } = useMemo(() => {
    if (!graph) {
      return { 
        items: [] as MetricsNodeItem[], 
        summary: { totalFunctions: 0, avgComplexity: 0, maxComplexity: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 } 
      };
    }

    const metricsNodes: MetricsNodeItem[] = [];
    let totalComplexity = 0;
    let maxComplexity = 0;
    const rankCounts = { critical: 0, high: 0, medium: 0, low: 0 };

    for (const node of graph.nodes) {
      if (!['Function', 'Method'].includes(node.label)) continue;
      
      const complexity = node.properties.cyclomaticComplexity ?? 1;
      const rank = (node.properties.complexityRank as ComplexityRank) ?? 'low';
      const fanIn = node.properties.fanIn ?? 0;
      const fanOut = node.properties.fanOut ?? 0;
      const loc = node.properties.loc ?? 0;
      const instability = node.properties.instability ?? 0;

      metricsNodes.push({ node, complexity, rank, fanIn, fanOut, loc, instability });
      
      totalComplexity += complexity;
      if (complexity > maxComplexity) maxComplexity = complexity;
      rankCounts[rank]++;
    }

    const summary: MetricsSummary = {
      totalFunctions: metricsNodes.length,
      avgComplexity: metricsNodes.length > 0 ? Math.round((totalComplexity / metricsNodes.length) * 10) / 10 : 0,
      maxComplexity,
      criticalCount: rankCounts.critical,
      highCount: rankCounts.high,
      mediumCount: rankCounts.medium,
      lowCount: rankCounts.low,
    };

    return { items: metricsNodes, summary };
  }, [graph]);

  // Filter and sort items
  const filteredItems = useMemo(() => {
    let filtered = items.filter(item => selectedRanks.has(item.rank));

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(item => 
        item.node.properties.name.toLowerCase().includes(query) ||
        item.node.properties.filePath.toLowerCase().includes(query)
      );
    }

    // Sort
    filtered.sort((a, b) => {
      switch (sortBy) {
        case 'complexity': return b.complexity - a.complexity;
        case 'fanIn': return b.fanIn - a.fanIn;
        case 'fanOut': return b.fanOut - a.fanOut;
        case 'instability': return b.instability - a.instability;
        default: return b.complexity - a.complexity;
      }
    });

    return filtered;
  }, [items, selectedRanks, searchQuery, sortBy]);

  // Group by rank
  const groupedItems = useMemo(() => {
    const groups: Record<ComplexityRank, MetricsNodeItem[]> = {
      critical: [],
      high: [],
      medium: [],
      low: [],
    };

    for (const item of filteredItems) {
      groups[item.rank].push(item);
    }

    return groups;
  }, [filteredItems]);

  // Toggle rank filter
  const toggleRank = useCallback((rank: ComplexityRank) => {
    setSelectedRanks(prev => {
      const next = new Set(prev);
      if (next.has(rank)) {
        next.delete(rank);
      } else {
        next.add(rank);
      }
      return next;
    });
  }, []);

  // Toggle section expansion
  const toggleSection = useCallback((rank: ComplexityRank) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(rank)) {
        next.delete(rank);
      } else {
        next.add(rank);
      }
      return next;
    });
  }, []);

  // Handle node click
  const handleNodeClick = useCallback((item: MetricsNodeItem) => {
    setSelectedNode(item.node);
    setHighlightedNodeIds(new Set([item.node.id]));
    onFocusNode?.(item.node.id);
  }, [setSelectedNode, setHighlightedNodeIds, onFocusNode]);

  // Highlight all nodes of a rank
  const highlightRank = useCallback((rank: ComplexityRank) => {
    const nodeIds = groupedItems[rank].map(item => item.node.id);
    setHighlightedNodeIds(new Set(nodeIds));
  }, [groupedItems, setHighlightedNodeIds]);

  if (!graph) {
    return (
      <div className="p-4 text-gray-400 text-sm">
        Load a repository to view metrics.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-void text-gray-200">
      {/* Header */}
      <div className="p-3 border-b border-gray-800">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-4 h-4 text-purple-400" />
          <span className="font-medium text-sm">Code Metrics</span>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-4 gap-2 mb-3">
          <div className="bg-gray-800/50 rounded p-2 text-center">
            <div className="text-lg font-bold text-white">{summary.totalFunctions}</div>
            <div className="text-xs text-gray-400">Functions</div>
          </div>
          <div className="bg-gray-800/50 rounded p-2 text-center">
            <div className="text-lg font-bold text-blue-400">{summary.avgComplexity}</div>
            <div className="text-xs text-gray-400">Avg CC</div>
          </div>
          <div className="bg-red-500/20 rounded p-2 text-center">
            <div className="text-lg font-bold text-red-400">{summary.criticalCount}</div>
            <div className="text-xs text-gray-400">Critical</div>
          </div>
          <div className="bg-orange-500/20 rounded p-2 text-center">
            <div className="text-lg font-bold text-orange-400">{summary.highCount}</div>
            <div className="text-xs text-gray-400">High</div>
          </div>
        </div>

        {/* Search */}
        <div className="relative mb-3">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search functions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm focus:outline-none focus:border-purple-500"
          />
        </div>

        {/* Rank Filters */}
        <div className="flex gap-1 mb-2">
          {(['critical', 'high', 'medium', 'low'] as ComplexityRank[]).map(rank => {
            const config = RANK_CONFIG[rank];
            const count = groupedItems[rank].length;
            const isSelected = selectedRanks.has(rank);
            
            return (
              <button
                key={rank}
                onClick={() => toggleRank(rank)}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                  isSelected ? config.bg + ' ' + config.color : 'bg-gray-800 text-gray-500'
                }`}
              >
                <config.icon className="w-3 h-3" />
                <span>{count}</span>
              </button>
            );
          })}
        </div>

        {/* Sort Options */}
        <div className="flex items-center gap-2 text-xs">
          <Filter className="w-3 h-3 text-gray-500" />
          <span className="text-gray-500">Sort:</span>
          {[
            { key: 'complexity', label: 'CC' },
            { key: 'fanIn', label: 'Fan-In' },
            { key: 'fanOut', label: 'Fan-Out' },
            { key: 'instability', label: 'Instability' },
          ].map(opt => (
            <button
              key={opt.key}
              onClick={() => setSortBy(opt.key as typeof sortBy)}
              className={`px-2 py-0.5 rounded ${
                sortBy === opt.key ? 'bg-purple-500/30 text-purple-300' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {(['critical', 'high', 'medium', 'low'] as ComplexityRank[]).map(rank => {
          const rankItems = groupedItems[rank];
          if (rankItems.length === 0 || !selectedRanks.has(rank)) return null;

          const config = RANK_CONFIG[rank];
          const isExpanded = expandedSections.has(rank);

          return (
            <div key={rank} className="border-b border-gray-800">
              {/* Section Header */}
              <button
                onClick={() => toggleSection(rank)}
                className={`w-full flex items-center gap-2 px-3 py-2 ${config.bg} hover:brightness-110 transition-all`}
              >
                {isExpanded ? (
                  <ChevronDown className="w-4 h-4 text-gray-400" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                )}
                <config.icon className={`w-4 h-4 ${config.color}`} />
                <span className={`font-medium text-sm ${config.color}`}>{config.label}</span>
                <span className="text-xs text-gray-400">({rankItems.length})</span>
                <button
                  onClick={(e) => { e.stopPropagation(); highlightRank(rank); }}
                  className="ml-auto text-xs text-gray-400 hover:text-white px-2 py-0.5 rounded bg-gray-700/50"
                >
                  Highlight All
                </button>
              </button>

              {/* Items */}
              {isExpanded && (
                <div className="divide-y divide-gray-800/50">
                  {rankItems.slice(0, 50).map(item => (
                    <button
                      key={item.node.id}
                      onClick={() => handleNodeClick(item)}
                      className="w-full text-left px-3 py-2 hover:bg-gray-800/50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <Zap className={`w-3 h-3 ${config.color}`} />
                        <span className="font-mono text-sm text-gray-200 truncate flex-1">
                          {item.node.properties.name}
                        </span>
                        <span className={`text-xs font-bold ${config.color}`}>
                          CC: {item.complexity}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                        <span className="truncate flex-1">{item.node.properties.filePath}</span>
                        <span className="flex items-center gap-1">
                          <ArrowDownRight className="w-3 h-3" />
                          {item.fanIn}
                        </span>
                        <span className="flex items-center gap-1">
                          <ArrowUpRight className="w-3 h-3" />
                          {item.fanOut}
                        </span>
                        <span>{item.loc} LOC</span>
                      </div>
                    </button>
                  ))}
                  {rankItems.length > 50 && (
                    <div className="px-3 py-2 text-xs text-gray-500 text-center">
                      +{rankItems.length - 50} more...
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {filteredItems.length === 0 && (
          <div className="p-4 text-center text-gray-500 text-sm">
            No functions match the current filters.
          </div>
        )}
      </div>
    </div>
  );
};
