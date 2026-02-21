import { useEffect, useCallback, useMemo, useState, forwardRef, useImperativeHandle } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Focus, RotateCcw, Lightbulb, LightbulbOff } from 'lucide-react';
import { usePlayCanvas } from '../hooks/usePlayCanvas';
import { useAppState } from '../hooks/useAppState';
import { knowledgeGraphTo3D } from '../lib/graph-adapter-3d';
import { QueryFAB } from './QueryFAB';

export interface GraphCanvas3DHandle {
  focusNode: (nodeId: string) => void;
}

export const GraphCanvas3D = forwardRef<GraphCanvas3DHandle>((_, ref) => {
  const {
    graph,
    setSelectedNode,
    selectedNode: appSelectedNode,
    visibleLabels,
    highlightedNodeIds,
    setHighlightedNodeIds,
    aiCitationHighlightedNodeIds,
    aiToolHighlightedNodeIds,
    blastRadiusNodeIds,
    isAIHighlightsEnabled,
    toggleAIHighlights,
    openCodePanel,
  } = useAppState();

  const [hoveredNodeName, setHoveredNodeName] = useState<string | null>(null);

  const effectiveHighlightedNodeIds = useMemo(() => {
    if (!isAIHighlightsEnabled) return highlightedNodeIds;
    const next = new Set(highlightedNodeIds);
    for (const id of aiCitationHighlightedNodeIds) next.add(id);
    for (const id of aiToolHighlightedNodeIds) next.add(id);
    return next;
  }, [highlightedNodeIds, aiCitationHighlightedNodeIds, aiToolHighlightedNodeIds, isAIHighlightsEnabled]);

  const effectiveBlastRadiusNodeIds = useMemo(() => {
    if (!isAIHighlightsEnabled) return new Set<string>();
    return blastRadiusNodeIds;
  }, [blastRadiusNodeIds, isAIHighlightsEnabled]);

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

  const handleBackgroundClick = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  const {
    canvasRef,
    setGraphData,
    zoomIn,
    zoomOut,
    resetCamera,
    focusNode,
    isReady,
  } = usePlayCanvas({
    onNodeClick: handleNodeClick,
    onNodeHover: handleNodeHover,
    onBackgroundClick: handleBackgroundClick,
    highlightedNodeIds: effectiveHighlightedNodeIds,
    blastRadiusNodeIds: effectiveBlastRadiusNodeIds,
  });

  // Expose focusNode to parent
  useImperativeHandle(ref, () => ({
    focusNode: (nodeId: string) => {
      if (graph) {
        const node = graph.nodes.find(n => n.id === nodeId);
        if (node) {
          setSelectedNode(node);
          openCodePanel();
        }
      }
      focusNode(nodeId);
    }
  }), [focusNode, graph, setSelectedNode, openCodePanel]);

  // Build 3D data when graph changes
  useEffect(() => {
    if (!graph || !isReady) return;

    // Build communityMemberships map
    const communityMemberships = new Map<string, number>();
    graph.relationships.forEach(rel => {
      if (rel.type === 'MEMBER_OF') {
        const communityNode = graph.nodes.find(n => n.id === rel.targetId && n.label === 'Community');
        if (communityNode) {
          const communityIdx = parseInt(rel.targetId.replace('comm_', ''), 10) || 0;
          communityMemberships.set(rel.sourceId, communityIdx);
        }
      }
    });

    const data3d = knowledgeGraphTo3D(graph, communityMemberships);
    setGraphData(data3d);
  }, [graph, isReady, setGraphData]);

  const handleFocusSelected = useCallback(() => {
    if (appSelectedNode) {
      focusNode(appSelectedNode.id);
    }
  }, [appSelectedNode, focusNode]);

  const handleClearSelection = useCallback(() => {
    setSelectedNode(null);
    resetCamera();
  }, [setSelectedNode, resetCamera]);

  return (
    <div className="relative w-full h-full bg-void">
      {/* Background gradient */}
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute inset-0"
          style={{
            background: `
              radial-gradient(circle at 50% 50%, rgba(124, 58, 237, 0.03) 0%, transparent 70%),
              linear-gradient(to bottom, #06060a, #0a0a10)
            `
          }}
        />
      </div>

      {/* PlayCanvas canvas */}
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-grab active:cursor-grabbing"
        style={{ display: 'block' }}
      />

      {/* Hovered node tooltip */}
      {hoveredNodeName && !appSelectedNode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-elevated/95 border border-border-subtle rounded-lg backdrop-blur-sm z-20 pointer-events-none animate-fade-in">
          <span className="font-mono text-sm text-text-primary">{hoveredNodeName}</span>
        </div>
      )}

      {/* Selection info bar */}
      {appSelectedNode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2 bg-accent/20 border border-accent/30 rounded-xl backdrop-blur-sm z-20 animate-slide-up">
          <div className="w-2 h-2 bg-accent rounded-full animate-pulse" />
          <span className="font-mono text-sm text-text-primary">
            {appSelectedNode.properties.name}
          </span>
          <span className="text-xs text-text-muted">
            ({appSelectedNode.label})
          </span>
          <button
            onClick={handleClearSelection}
            className="ml-2 px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary hover:bg-white/10 rounded transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {/* 3D Badge */}
      <div className="absolute top-4 left-4 z-20">
        <div className="px-2 py-1 bg-accent/20 border border-accent/30 rounded-lg">
          <span className="text-xs font-mono text-accent">3D</span>
        </div>
      </div>

      {/* Controls - Bottom Right */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-1 z-10">
        <button
          onClick={zoomIn}
          className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
          title="Zoom In"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          onClick={zoomOut}
          className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
          title="Zoom Out"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <button
          onClick={resetCamera}
          className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
          title="Fit to Screen"
        >
          <Maximize2 className="w-4 h-4" />
        </button>

        <div className="h-px bg-border-subtle my-1" />

        {appSelectedNode && (
          <button
            onClick={handleFocusSelected}
            className="w-9 h-9 flex items-center justify-center bg-accent/20 border border-accent/30 rounded-md text-accent hover:bg-accent/30 transition-colors"
            title="Focus on Selected Node"
          >
            <Focus className="w-4 h-4" />
          </button>
        )}

        {appSelectedNode && (
          <button
            onClick={handleClearSelection}
            className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
            title="Clear Selection"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Query FAB */}
      <QueryFAB />

      {/* AI Highlights toggle */}
      <div className="absolute top-4 right-4 z-20">
        <button
          onClick={() => {
            if (isAIHighlightsEnabled) {
              setHighlightedNodeIds(new Set());
            }
            toggleAIHighlights();
          }}
          className={
            isAIHighlightsEnabled
              ? 'w-10 h-10 flex items-center justify-center bg-cyan-500/15 border border-cyan-400/40 rounded-lg text-cyan-200 hover:bg-cyan-500/20 hover:border-cyan-300/60 transition-colors'
              : 'w-10 h-10 flex items-center justify-center bg-elevated border border-border-subtle rounded-lg text-text-muted hover:bg-hover hover:text-text-primary transition-colors'
          }
          title={isAIHighlightsEnabled ? 'Turn off all highlights' : 'Turn on AI highlights'}
        >
          {isAIHighlightsEnabled ? <Lightbulb className="w-4 h-4" /> : <LightbulbOff className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
});

GraphCanvas3D.displayName = 'GraphCanvas3D';
