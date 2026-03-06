import { useEffect, useCallback, useMemo, useState, forwardRef, useImperativeHandle } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Focus, RotateCcw, Play, Pause, Lightbulb, LightbulbOff, Box } from 'lucide-react';
import { useSigma } from '../hooks/useSigma';
import { useTheme } from '../context/ThemeContext';
import { useAppState } from '../hooks/useAppState';
import { knowledgeGraphToGraphology, filterGraphByDepth, SigmaNodeAttributes, SigmaEdgeAttributes } from '../lib/graph-adapter';
import { QueryFAB } from './QueryFAB';
import { GraphCanvas3D } from './GraphCanvas3D';
import Graph from 'graphology';

export interface GraphCanvasHandle {
  focusNode: (nodeId: string) => void;
  focusNodes: (nodeIds: string[]) => void;
}

export const GraphCanvas = forwardRef<GraphCanvasHandle>((_, ref) => {
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
    animatedNodes,
  } = useAppState();
  const [hoveredNodeName, setHoveredNodeName] = useState<string | null>(null);
  const [is3DMode, setIs3DMode] = useState(false);
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  const effectiveHighlightedNodeIds = useMemo(() => {
    if (!isAIHighlightsEnabled) return highlightedNodeIds;
    const next = new Set(highlightedNodeIds);
    for (const id of aiCitationHighlightedNodeIds) next.add(id);
    for (const id of aiToolHighlightedNodeIds) next.add(id);
    // Note: blast radius nodes are handled separately with red color
    return next;
  }, [highlightedNodeIds, aiCitationHighlightedNodeIds, aiToolHighlightedNodeIds, isAIHighlightsEnabled]);

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

  const handleNodeClick = useCallback((nodeId: string) => {
    if (!graph) return;
    const node = graph.nodes.find(n => n.id === nodeId);
    if (node) {
      setSelectedNode(node);
      openCodePanel();
    }
  }, [graph, setSelectedNode, openCodePanel]);

  const handleNodeHover = useCallback((nodeId: string | null) => {
    if (!nodeId || !graph) {
      setHoveredNodeName(null);
      return;
    }
    const node = graph.nodes.find(n => n.id === nodeId);
    if (node) {
      setHoveredNodeName(node.properties.name);
    }
  }, [graph]);

  const handleStageClick = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

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
    theme,
  });

  // Expose focusNode / focusNodes to parent via ref
  useImperativeHandle(ref, () => ({
    focusNode: (nodeId: string) => {
      // Also update app state so the selection syncs properly
      if (graph) {
        const node = graph.nodes.find(n => n.id === nodeId);
        if (node) {
          setSelectedNode(node);
          openCodePanel();
        }
      }
      focusNode(nodeId);
    },
    focusNodes: (nodeIds: string[]) => {
      const sigma = sigmaRef.current;
      if (!sigma || nodeIds.length === 0) return;
      const g = sigma.getGraph();
      const positions = nodeIds
        .filter(id => g.hasNode(id))
        .map(id => ({ x: g.getNodeAttribute(id, 'x') as number, y: g.getNodeAttribute(id, 'y') as number }));
      if (positions.length === 0) return;
      const xs = positions.map(p => p.x);
      const ys = positions.map(p => p.y);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const spread = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 0.001);
      const ratio = Math.min(Math.max(spread / 1.5, 0.05), 1.2);
      sigma.getCamera().animate({ x: cx, y: cy, ratio }, { duration: 600 });
    },
  }), [focusNode, sigmaRef, graph, setSelectedNode, openCodePanel]);

  // Update Sigma graph when KnowledgeGraph changes
  useEffect(() => {
    if (!graph) return;

    // Build communityMemberships map from MEMBER_OF relationships
    // MEMBER_OF edges: nodeId -> communityId (stored as targetId)
    const communityMemberships = new Map<string, number>();
    graph.relationships.forEach(rel => {
      if (rel.type === 'MEMBER_OF') {
        // Find the community node to get its index
        const communityNode = graph.nodes.find(n => n.id === rel.targetId && n.label === 'Community');
        if (communityNode) {
          // Extract community index from id (e.g., "comm_5" -> 5)
          const communityIdx = parseInt(rel.targetId.replace('comm_', ''), 10) || 0;
          communityMemberships.set(rel.sourceId, communityIdx);
        }
      }
    });

    const sigmaGraph = knowledgeGraphToGraphology(graph, communityMemberships);
    setSigmaGraph(sigmaGraph);
  }, [graph, setSigmaGraph]);

  // Update node visibility when filters change
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;

    const sigmaGraph = sigma.getGraph() as Graph<SigmaNodeAttributes, SigmaEdgeAttributes>;
    if (sigmaGraph.order === 0) return; // Don't filter empty graph

    filterGraphByDepth(sigmaGraph, appSelectedNode?.id || null, depthFilter, visibleLabels);
    sigma.refresh();
  }, [visibleLabels, depthFilter, appSelectedNode, sigmaRef]);

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

  return (
    <div className="relative w-full h-full bg-void">
      {/* Sigma 2D — kept mounted for instant switch back.
          Use visibility+position instead of display:none so Sigma can still measure
          its container width (display:none collapses to 0 and spams RAF errors). */}
      <div
        ref={containerRef}
        className="sigma-container cursor-grab active:cursor-grabbing"
        style={{
          position: 'absolute',
          inset: 0,
          visibility: is3DMode ? 'hidden' : 'visible',
          pointerEvents: is3DMode ? 'none' : 'auto',
          backgroundColor: isDark ? '#0f0f0f' : '#fafafa',
          backgroundImage: isDark
            ? 'radial-gradient(circle, rgba(255,255,255,0.08) 1px, transparent 1px)'
            : 'radial-gradient(circle, rgba(0,0,0,0.10) 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
      />

      {/* 3D view */}
      {is3DMode && (
        <div style={{ position: 'absolute', inset: 0 }}>
          <GraphCanvas3D
            highlightedNodeIds={effectiveHighlightedNodeIds}
            blastRadiusNodeIds={effectiveBlastRadiusNodeIds}
          />
        </div>
      )}

      {/* Hovered node tooltip - only show when NOT selected */}
      {hoveredNodeName && !sigmaSelectedNode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-elevated/95 border border-border-subtle backdrop-blur-sm z-20 pointer-events-none animate-fade-in">
          <span className="font-mono text-sm text-text-primary">{hoveredNodeName}</span>
        </div>
      )}

      {/* Selection info bar */}
      {sigmaSelectedNode && appSelectedNode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2 bg-accent/20 border border-accent/30 backdrop-blur-sm z-20 animate-slide-up">
          <div className="w-2 h-2 bg-accent rounded-full animate-pulse" />
          <span className="font-mono text-sm text-text-primary">
            {appSelectedNode.properties.name}
          </span>
          <span className="text-xs text-text-muted">
            ({appSelectedNode.label})
          </span>
          <button
            onClick={handleClearSelection}
            className="ml-2 px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary hover:bg-black/5 transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {/* Graph Controls - Bottom Right */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-1 z-10">
        {/* 3D toggle — always visible */}
        <button
          onClick={() => setIs3DMode(m => !m)}
          className={`w-9 h-9 flex items-center justify-center border transition-colors ${
            is3DMode
              ? 'bg-accent border-accent text-white'
              : 'bg-elevated border-border-subtle text-text-secondary hover:bg-hover hover:text-text-primary'
          }`}
          title={is3DMode ? 'Switch to 2D' : 'Switch to 3D'}
        >
          <Box className="w-4 h-4" />
        </button>

        {/* Divider */}
        <div className="h-px bg-border-subtle my-1" />

        {/* 2D-only controls */}
        {!is3DMode && (
          <>
            <button
              onClick={zoomIn}
              className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
              title="Zoom In"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              onClick={zoomOut}
              className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
              title="Zoom Out"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <button
              onClick={resetZoom}
              className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
              title="Fit to Screen"
            >
              <Maximize2 className="w-4 h-4" />
            </button>

            {/* Divider */}
            <div className="h-px bg-border-subtle my-1" />

            {/* Focus on selected */}
            {appSelectedNode && (
              <button
                onClick={handleFocusSelected}
                className="w-9 h-9 flex items-center justify-center bg-accent/20 border border-accent/30 text-accent hover:bg-accent/30 transition-colors"
                title="Focus on Selected Node"
              >
                <Focus className="w-4 h-4" />
              </button>
            )}

            {/* Clear selection */}
            {sigmaSelectedNode && (
              <button
                onClick={handleClearSelection}
                className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
                title="Clear Selection"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            )}

            {/* Divider */}
            <div className="h-px bg-border-subtle my-1" />

            {/* Layout control */}
            <button
              onClick={isLayoutRunning ? stopLayout : startLayout}
              className={`
                w-9 h-9 flex items-center justify-center border transition-all
                ${isLayoutRunning
                  ? 'bg-accent border-accent text-white shadow-glow animate-pulse'
                  : 'bg-elevated border-border-subtle text-text-secondary hover:bg-hover hover:text-text-primary'
                }
              `}
              title={isLayoutRunning ? 'Stop Layout' : 'Run Layout Again'}
            >
              {isLayoutRunning ? (
                <Pause className="w-4 h-4" />
              ) : (
                <Play className="w-4 h-4" />
              )}
            </button>
          </>
        )}
      </div>

      {/* Layout running indicator */}
      {isLayoutRunning && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 bg-emerald-500/20 border border-emerald-500/30 backdrop-blur-sm z-10 animate-fade-in">
          <div className="w-2 h-2 bg-emerald-400 rounded-full animate-ping" />
          <span className="text-xs text-emerald-400 font-medium">Layout optimizing...</span>
        </div>
      )}

      {/* Query FAB */}
      <QueryFAB />

      {/* AI Highlights toggle - Top Right */}
      <div className="absolute top-4 right-4 z-20">
        <button
          onClick={() => {
            // If turning off, also clear process highlights
            if (isAIHighlightsEnabled) {
              setHighlightedNodeIds(new Set());
            }
            toggleAIHighlights();
          }}
          className={
            isAIHighlightsEnabled
              ? 'w-10 h-10 flex items-center justify-center bg-cyan-500/15 border border-cyan-400/40 text-cyan-700 hover:bg-cyan-500/20 hover:border-cyan-300/60 transition-colors'
              : 'w-10 h-10 flex items-center justify-center bg-elevated border border-border-subtle text-text-muted hover:bg-hover hover:text-text-primary transition-colors'
          }
          title={isAIHighlightsEnabled ? 'Turn off all highlights' : 'Turn on AI highlights'}
        >
          {isAIHighlightsEnabled ? <Lightbulb className="w-4 h-4" /> : <LightbulbOff className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
});

GraphCanvas.displayName = 'GraphCanvas';
