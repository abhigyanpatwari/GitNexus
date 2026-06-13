import { useEffect, useCallback, useMemo, useState, forwardRef, useImperativeHandle } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Focus,
  RotateCcw,
  Play,
  Pause,
  Lightbulb,
  LightbulbOff,
  Network,
  GitBranch,
  Target,
} from '@/lib/lucide-icons';
import { useSigma } from '../hooks/useSigma';
import { useAppState } from '../hooks/useAppState';
import {
  knowledgeGraphToGraphology,
  knowledgeGraphToTreeGraphology,
  knowledgeGraphToCirclesGraphology,
  filterGraphByDepth,
  SigmaNodeAttributes,
  SigmaEdgeAttributes,
} from '../lib/graph-adapter';
import type { GraphNode } from 'gitnexus-shared';
import { QueryFAB } from './QueryFAB';
import Graph from 'graphology';
import { useTranslation } from 'react-i18next';
import { LARGE_GRAPH_NODE_THRESHOLD } from '../config/ui-constants';
import { shouldConfirmGraphLoad } from '../lib/graph-load-decision';

export interface GraphCanvasHandle {
  focusNode: (nodeId: string) => void;
}

export const GraphCanvas = forwardRef<GraphCanvasHandle>((_, ref) => {
  const { t } = useTranslation('graph');
  const {
    graph,
    setSelectedNode,
    selectedNode: appSelectedNode,
    visibleLabels,
    visibleEdgeTypes,
    openCodePanel,
    depthFilter,
    highlightedNodeIds,
    setHighlightedNodeIds,
    aiCitationHighlightedNodeIds,
    aiToolHighlightedNodeIds,
    blastRadiusNodeIds,
    isAIHighlightsEnabled,
    toggleAIHighlights,
    clearAIToolHighlights,
    clearAICitationHighlights,
    clearBlastRadius,
    animatedNodes,
    graphViewMode,
    setGraphViewMode,
    graphMode,
    chatOnlyNodeCount,
    loadGraphAnyway,
  } = useAppState();
  const [hoveredNodeName, setHoveredNodeName] = useState<string | null>(null);

  const effectiveHighlightedNodeIds = useMemo(() => {
    if (!isAIHighlightsEnabled) return highlightedNodeIds;
    const next = new Set(highlightedNodeIds);
    for (const id of aiCitationHighlightedNodeIds) next.add(id);
    for (const id of aiToolHighlightedNodeIds) next.add(id);
    // Note: blast radius nodes are handled separately with red color
    return next;
  }, [
    highlightedNodeIds,
    aiCitationHighlightedNodeIds,
    aiToolHighlightedNodeIds,
    isAIHighlightsEnabled,
  ]);

  // Blast radius nodes (only when AI highlights enabled)
  const effectiveBlastRadiusNodeIds = useMemo(() => {
    if (!isAIHighlightsEnabled) return new Set<string>();
    return blastRadiusNodeIds;
  }, [blastRadiusNodeIds, isAIHighlightsEnabled]);

  // Animated nodes (only when AI highlights enabled)
  const effectiveAnimatedNodes = useMemo(() => {
    if (!isAIHighlightsEnabled) return new Map();
    return animatedNodes;
  }, [animatedNodes, isAIHighlightsEnabled]);

  const nodeById = useMemo(() => {
    if (!graph) return new Map<string, GraphNode>();
    return new Map(graph.nodes.map((n) => [n.id, n]));
  }, [graph]);

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      if (!graph) return;
      const node = nodeById.get(nodeId);
      if (node) {
        setSelectedNode(node);
        openCodePanel();
      }
    },
    [graph, nodeById, setSelectedNode, openCodePanel],
  );

  const handleNodeHover = useCallback(
    (nodeId: string | null) => {
      if (!nodeId || !graph) {
        setHoveredNodeName(null);
        return;
      }
      const node = nodeById.get(nodeId);
      setHoveredNodeName(node ? node.properties.name : null);
    },
    [graph, nodeById],
  );

  const handleStageClick = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  const handleToggleAIHighlights = useCallback(() => {
    if (isAIHighlightsEnabled) {
      clearAIToolHighlights();
      clearAICitationHighlights();
      clearBlastRadius();
      setSelectedNode(null);
      setSigmaSelectedNode(null);
    }
    toggleAIHighlights();
  }, [
    isAIHighlightsEnabled,
    clearAIToolHighlights,
    clearAICitationHighlights,
    clearBlastRadius,
    setSelectedNode,
    toggleAIHighlights,
  ]);

  const {
    containerRef,
    sigmaRef,
    setGraph: setSigmaGraph,
    zoomIn,
    zoomOut,
    resetZoom,
    focusNode,
    isLayoutRunning,
    startLayout,
    stopLayout,
    selectedNode: sigmaSelectedNode,
    setSelectedNode: setSigmaSelectedNode,
  } = useSigma({
    onNodeClick: handleNodeClick,
    onNodeHover: handleNodeHover,
    onStageClick: handleStageClick,
    highlightedNodeIds: effectiveHighlightedNodeIds,
    blastRadiusNodeIds: effectiveBlastRadiusNodeIds,
    animatedNodes: effectiveAnimatedNodes,
    visibleEdgeTypes,
    layoutMode: graphViewMode,
  });

  const handleViewModeChange = useCallback(
    (mode: 'force' | 'tree' | 'circles') => {
      if (mode === graphViewMode) return;
      setSelectedNode(null);
      setSigmaSelectedNode(null);
      setHoveredNodeName(null);
      setGraphViewMode(mode);
      // Reset zoom when switching views
      resetZoom();
    },
    [graphViewMode, resetZoom, setGraphViewMode, setSelectedNode, setSigmaSelectedNode],
  );

  // Expose focusNode to parent via ref
  useImperativeHandle(
    ref,
    () => ({
      focusNode: (nodeId: string) => {
        // Also update app state so the selection syncs properly
        if (graph) {
          const node = nodeById.get(nodeId);
          if (node) {
            setSelectedNode(node);
            openCodePanel();
          }
        }
        focusNode(nodeId);
      },
    }),
    [focusNode, graph, nodeById, setSelectedNode, openCodePanel],
  );

  // Update Sigma graph when KnowledgeGraph changes
  useEffect(() => {
    // Skip layout work in chat-only mode: `graph` is non-null but empty, the
    // overlay covers the canvas, and this guard also future-proofs against a
    // transient where a populated graph is set while mode is still chat-only.
    if (!graph || graphMode === 'chatOnly') return;

    let sigmaGraph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>;

    if (graphViewMode === 'tree') {
      sigmaGraph = knowledgeGraphToTreeGraphology(graph);
    } else if (graphViewMode === 'circles') {
      sigmaGraph = knowledgeGraphToCirclesGraphology(graph);
    } else {
      // Build community memberships map from MEMBER_OF relationships
      const communityMemberships = new Map<string, number>();
      graph.relationships.forEach((rel) => {
        if (rel.type === 'MEMBER_OF') {
          const communityNode = nodeById.get(rel.targetId);
          if (communityNode && communityNode.label === 'Community') {
            const numericPart = rel.targetId.replace('comm_', '');
            const communityIdx = /^\d+$/.test(numericPart) ? parseInt(numericPart, 10) : 0;
            communityMemberships.set(rel.sourceId, communityIdx);
          }
        }
      });
      sigmaGraph = knowledgeGraphToGraphology(graph, communityMemberships);
    }

    setSigmaGraph(sigmaGraph);
  }, [graph, graphMode, nodeById, setSigmaGraph, graphViewMode]);

  // Update node visibility when filters change
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;

    const sigmaGraph = sigma.getGraph() as Graph<SigmaNodeAttributes, SigmaEdgeAttributes>;
    if (sigmaGraph.order === 0) return; // Don't filter empty graph

    filterGraphByDepth(sigmaGraph, appSelectedNode?.id || null, depthFilter, visibleLabels);
    sigma.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sigmaRef identity never changes
  }, [graph, graphViewMode, visibleLabels, depthFilter, appSelectedNode]);

  // Sync app selected node with sigma
  useEffect(() => {
    if (appSelectedNode) {
      setSigmaSelectedNode(appSelectedNode.id);
    } else {
      setSigmaSelectedNode(null);
    }
  }, [appSelectedNode, setSigmaSelectedNode]);

  // Focus on selected node
  const handleFocusSelected = useCallback(() => {
    if (appSelectedNode) {
      focusNode(appSelectedNode.id);
    }
  }, [appSelectedNode, focusNode]);

  // Clear selection
  const handleClearSelection = useCallback(() => {
    setSelectedNode(null);
    setSigmaSelectedNode(null);
    resetZoom();
  }, [setSelectedNode, setSigmaSelectedNode, resetZoom]);

  // Chat-only mode (#2178): the graph download was skipped. `chatOnlyNodeCount`
  // comes from app state (captured at connect time), so it is authoritative and
  // available immediately — not derived from the async `availableRepos` list.
  const handleLoadGraphAnyway = useCallback(() => {
    // Warn before re-triggering a potentially browser-hanging download. Confirm
    // whenever the count is large OR unknown — never silently re-load a graph we
    // can't size, which would risk re-introducing the original #2178 hang. Skip
    // the prompt only when the count is known to be below the threshold (a small
    // repo force-skipped via ?skipGraph=1).
    const needsConfirm = shouldConfirmGraphLoad(chatOnlyNodeCount, LARGE_GRAPH_NODE_THRESHOLD);
    if (needsConfirm) {
      // Fail SAFE, not open: if there's no usable confirm dialog (some embedded
      // webviews) or it throws, treat it as declined rather than loading a
      // graph we couldn't warn about (#2178).
      const canPrompt = typeof window !== 'undefined' && typeof window.confirm === 'function';
      if (!canPrompt) return;
      let confirmed = false;
      try {
        confirmed = window.confirm(
          chatOnlyNodeCount != null
            ? t('canvas.chatOnly.loadAnywayWarning', { count: chatOnlyNodeCount.toLocaleString() })
            : t('canvas.chatOnly.loadAnywayWarningUnknown'),
        );
      } catch {
        return;
      }
      if (!confirmed) return;
    }
    void loadGraphAnyway();
  }, [chatOnlyNodeCount, loadGraphAnyway, t]);

  return (
    <div className="relative h-full w-full bg-void">
      {/* Background gradient */}
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-0"
          style={{
            background: `
              radial-gradient(circle at 50% 50%, rgba(124, 58, 237, 0.03) 0%, transparent 70%),
              linear-gradient(to bottom, #06060a, #0a0a10)
            `,
          }}
        />
      </div>

      {/* View Mode Tabs */}
      <div
        role="tablist"
        aria-label={t('canvas.viewModes.label')}
        className="absolute top-4 left-1/2 z-20 flex -translate-x-1/2 gap-1 rounded-lg border border-border-subtle bg-elevated/90 p-1 backdrop-blur-sm"
      >
        <button
          role="tab"
          aria-selected={graphViewMode === 'force'}
          onClick={() => handleViewModeChange('force')}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
            graphViewMode === 'force'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:bg-hover hover:text-text-primary'
          }`}
        >
          <Network className="h-3.5 w-3.5" />
          {t('canvas.viewModes.force')}
        </button>
        <button
          role="tab"
          aria-selected={graphViewMode === 'tree'}
          onClick={() => handleViewModeChange('tree')}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
            graphViewMode === 'tree'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:bg-hover hover:text-text-primary'
          }`}
        >
          <GitBranch className="h-3.5 w-3.5" />
          {t('canvas.viewModes.tree')}
        </button>
        <button
          role="tab"
          aria-selected={graphViewMode === 'circles'}
          onClick={() => handleViewModeChange('circles')}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
            graphViewMode === 'circles'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:bg-hover hover:text-text-primary'
          }`}
        >
          <Target className="h-3.5 w-3.5" />
          {t('canvas.viewModes.circles')}
        </button>
      </div>

      {/* Sigma container */}
      <div
        ref={containerRef}
        className="sigma-container h-full w-full cursor-grab active:cursor-grabbing"
      />

      {/* Chat-only empty state (#2178): graph download was skipped for a large
          project. Chat works normally; offer an explicit "load anyway" escape. */}
      {graphMode === 'chatOnly' && (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-6">
          <div className="max-w-md rounded-xl border border-border-subtle bg-elevated/95 p-6 text-center shadow-lg backdrop-blur-sm">
            <h3 className="text-lg font-semibold text-text-primary">
              {t('canvas.chatOnly.title')}
            </h3>
            <p className="mt-2 text-sm text-text-secondary">
              {chatOnlyNodeCount != null
                ? t('canvas.chatOnly.descriptionWithCount', {
                    count: chatOnlyNodeCount.toLocaleString(),
                  })
                : t('canvas.chatOnly.description')}
            </p>
            <p className="mt-2 text-xs text-text-muted">{t('canvas.chatOnly.citationNote')}</p>
            <button
              onClick={handleLoadGraphAnyway}
              className="mt-4 rounded-md border border-accent/30 bg-accent/20 px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/30"
            >
              {t('canvas.chatOnly.loadAnyway')}
            </button>
          </div>
        </div>
      )}

      {/* Hovered node tooltip - only show when NOT selected */}
      {hoveredNodeName && !sigmaSelectedNode && (
        <div className="pointer-events-none absolute top-4 left-1/2 z-20 -translate-x-1/2 animate-fade-in rounded-lg border border-border-subtle bg-elevated/95 px-3 py-1.5 backdrop-blur-sm">
          <span className="font-mono text-sm text-text-primary">{hoveredNodeName}</span>
        </div>
      )}

      {/* Selection info bar */}
      {sigmaSelectedNode && appSelectedNode && (
        <div className="absolute top-4 left-1/2 z-20 flex -translate-x-1/2 animate-slide-up items-center gap-2 rounded-xl border border-accent/30 bg-accent/20 px-4 py-2 backdrop-blur-sm">
          <div className="h-2 w-2 animate-pulse rounded-full bg-accent" />
          <span className="font-mono text-sm text-text-primary">
            {appSelectedNode.properties.name}
          </span>
          <span className="text-xs text-text-muted">({appSelectedNode.label})</span>
          <button
            onClick={handleClearSelection}
            className="ml-2 rounded px-2 py-0.5 text-xs text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
          >
            {t('canvas.clear')}
          </button>
        </div>
      )}

      {/* Graph Controls - Bottom Right */}
      <div className="absolute right-4 bottom-4 z-10 flex flex-col gap-1">
        <button
          onClick={zoomIn}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle bg-elevated text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          title={t('canvas.zoomIn')}
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          onClick={zoomOut}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle bg-elevated text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          title={t('canvas.zoomOut')}
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          onClick={resetZoom}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle bg-elevated text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          title={t('canvas.fit')}
        >
          <Maximize2 className="h-4 w-4" />
        </button>

        {/* Divider */}
        <div className="my-1 h-px bg-border-subtle" />

        {/* Focus on selected */}
        {appSelectedNode && (
          <button
            onClick={handleFocusSelected}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-accent/30 bg-accent/20 text-accent transition-colors hover:bg-accent/30"
            title={t('canvas.focusSelected')}
          >
            <Focus className="h-4 w-4" />
          </button>
        )}

        {/* Clear selection */}
        {sigmaSelectedNode && (
          <button
            onClick={handleClearSelection}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle bg-elevated text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
            title={t('canvas.clearSelection')}
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        )}

        {/* Divider */}
        <div className="my-1 h-px bg-border-subtle" />

        {/* Layout control */}
        <button
          onClick={isLayoutRunning ? stopLayout : startLayout}
          className={`flex h-9 w-9 items-center justify-center rounded-md border transition-all ${
            isLayoutRunning
              ? 'animate-pulse border-accent bg-accent text-white shadow-glow'
              : 'border-border-subtle bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary'
          } `}
          title={isLayoutRunning ? t('canvas.stopLayout') : t('canvas.runLayout')}
        >
          {isLayoutRunning ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
      </div>

      {/* Layout running indicator */}
      {isLayoutRunning && (
        <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 animate-fade-in items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/20 px-3 py-1.5 backdrop-blur-sm">
          <div className="h-2 w-2 animate-ping rounded-full bg-emerald-400" />
          <span className="text-xs font-medium text-emerald-400">
            {t('canvas.layoutOptimizing')}
          </span>
        </div>
      )}

      {/* Query FAB */}
      <QueryFAB />

      {/* AI Highlights toggle - Top Right */}
      <div className="absolute top-4 right-4 z-20">
        <button
          onClick={handleToggleAIHighlights}
          className={
            isAIHighlightsEnabled
              ? 'flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-400/40 bg-cyan-500/15 text-cyan-200 transition-colors hover:border-cyan-300/60 hover:bg-cyan-500/20'
              : 'flex h-10 w-10 items-center justify-center rounded-lg border border-border-subtle bg-elevated text-text-muted transition-colors hover:bg-hover hover:text-text-primary'
          }
          title={
            isAIHighlightsEnabled ? t('canvas.turnOffHighlights') : t('canvas.turnOnHighlights')
          }
          data-testid="ai-highlights-toggle"
        >
          {isAIHighlightsEnabled ? (
            <Lightbulb className="h-4 w-4" />
          ) : (
            <LightbulbOff className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
});

GraphCanvas.displayName = 'GraphCanvas';
