import { useEffect, useCallback, useMemo, useState, forwardRef, useImperativeHandle } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Focus, RotateCcw, Play, Pause, Lightbulb, LightbulbOff } from '@/lib/lucide-icons';
import { useSigma } from '../hooks/useSigma';
import { useAppState } from '../hooks/useAppState';
import { knowledgeGraphToGraphology, filterGraphByDepth, SigmaNodeAttributes, SigmaEdgeAttributes } from '../lib/graph-adapter';
import type { GraphNode } from '../core/graph/types';
import { fetchCommunityMembers, fetchNodeNeighbors } from '../services/server-connection';
import { QueryFAB } from './QueryFAB';
import Graph from 'graphology';

export interface GraphCanvasHandle {
  focusNode: (nodeId: string) => void;
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
    clearAIToolHighlights,
    clearAICitationHighlights,
    clearBlastRadius,
    animatedNodes,
    expandedCommunities,
    setExpandedCommunities,
    addNodesToGraph,
    collapseCommunity,
    serverBaseUrl,
    currentRepoName,
    setProgress,
    incrementalUpdate,
    clearIncrementalUpdate,
  } = useAppState();
  const [hoveredNodeName, setHoveredNodeName] = useState<string | null>(null);

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

  const nodeById = useMemo(() => {
    if (!graph) return new Map<string, GraphNode>();
    return new Map(graph.nodes.map(n => [n.id, n]));
  }, [graph]);

  const handleNodeClick = useCallback(async (nodeId: string) => {
    if (!graph) return;
    const node = nodeById.get(nodeId);
    if (!node) return;

    // Handle Community node click: expand/collapse
    if (node.label === 'Community') {
      const isExpanded = expandedCommunities.has(nodeId);

      if (!isExpanded) {
        // Expand: fetch and add member nodes
        if (!serverBaseUrl) return;
        setProgress?.({ phase: 'extracting', percent: 50, message: 'Expanding community...',  detail: `Loading members of ${node.properties.name || nodeId}` });
        try {
          const members = await fetchCommunityMembers(serverBaseUrl, nodeId, currentRepoName);
          addNodesToGraph(members.nodes, members.relationships);
          const updated = new Set(expandedCommunities);
          updated.add(nodeId);
          setExpandedCommunities(updated);
        } catch (err) {
          console.error('Failed to expand community:', err);
        } finally {
          setProgress?.(null);
        }
      } else {
        // Collapse: remove member nodes
        collapseCommunity(nodeId);
      }
      return;
    }

    // Non-community nodes: load neighbors if in server mode
    if (serverBaseUrl) {
      setProgress?.({ phase: 'extracting', percent: 50, message: 'Loading neighbors...', detail: `Loading connections for ${node.properties.name || nodeId}` });
      try {
        const neighbors = await fetchNodeNeighbors(serverBaseUrl, nodeId, currentRepoName);
        if (neighbors.nodes.length > 0 || neighbors.relationships.length > 0) {
          addNodesToGraph(neighbors.nodes, neighbors.relationships);
          console.log(`[GraphCanvas] Loaded ${neighbors.nodes.length} neighbors and ${neighbors.relationships.length} edges for ${nodeId}`);
        }
      } catch (err) {
        console.error('Failed to load node neighbors:', err);
      } finally {
        setProgress?.(null);
      }
    }

    // Select node and open code panel
    setSelectedNode(node);
    openCodePanel();
  }, [graph, nodeById, expandedCommunities, serverBaseUrl, currentRepoName, setProgress, addNodesToGraph, setExpandedCommunities, collapseCommunity, setSelectedNode, openCodePanel]);

  const handleNodeHover = useCallback((nodeId: string | null) => {
    if (!nodeId || !graph) {
      setHoveredNodeName(null);
      return;
    }
    const node = nodeById.get(nodeId);
    setHoveredNodeName(node ? node.properties.name : null);
  }, [graph, nodeById]);

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
  }, [isAIHighlightsEnabled, clearAIToolHighlights, clearAICitationHighlights, clearBlastRadius, setSelectedNode, toggleAIHighlights]);

  const {
    containerRef,
    sigmaRef,
    setGraph: setSigmaGraph,
    addNodes: addNodesToSigma,
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
  });

  // Expose focusNode to parent via ref
  useImperativeHandle(ref, () => ({
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
    }
  }), [focusNode, graph, nodeById, setSelectedNode, openCodePanel]);

  // Update Sigma graph when KnowledgeGraph changes
  useEffect(() => {
    if (!graph) return;

    // Build communityMemberships map from MEMBER_OF relationships
    // MEMBER_OF edges: nodeId -> communityId (stored as targetId)
    const communityMemberships = new Map<string, number>();
    graph.relationships.forEach(rel => {
      if (rel.type === 'MEMBER_OF') {
        // Find the community node to get its index
        const communityNode = nodeById.get(rel.targetId);
        if (communityNode && communityNode.label === 'Community') {
          // Extract community index from id (e.g., "comm_5" -> 5)
          const numericPart = rel.targetId.replace('comm_', '');
          const communityIdx = /^\d+$/.test(numericPart) ? parseInt(numericPart, 10) : 0;
          communityMemberships.set(rel.sourceId, communityIdx);
        }
      }
    });

    const sigmaGraph = knowledgeGraphToGraphology(graph, communityMemberships);
    setSigmaGraph(sigmaGraph);
  }, [graph, nodeById, setSigmaGraph]);

  // Handle incremental updates (add nodes without full rebuild)
  useEffect(() => {
    if (!incrementalUpdate || !graph) return;

    const { nodes: newNodes, relationships: newRels } = incrementalUpdate;
    if (newNodes.length === 0 && newRels.length === 0) {
      clearIncrementalUpdate();
      return;
    }

    // Build communityMemberships for new nodes
    const communityMemberships = new Map<string, number>();
    newRels.forEach(rel => {
      if (rel.type === 'MEMBER_OF') {
        const communityNode = nodeById.get(rel.targetId);
        if (communityNode && communityNode.label === 'Community') {
          const numericPart = rel.targetId.replace('comm_', '');
          const communityIdx = /^\d+$/.test(numericPart) ? parseInt(numericPart, 10) : 0;
          communityMemberships.set(rel.sourceId, communityIdx);
        }
      }
    });

    // Convert new nodes and relationships to Sigma format
    const sigmaNodes: Array<{ id: string; attributes: SigmaNodeAttributes }> = [];
    const sigmaEdges: Array<{ source: string; target: string; attributes: SigmaEdgeAttributes }> = [];

    // Import knowledgeGraphToGraphology logic inline for new nodes
    newNodes.forEach(node => {
      const communityIndex = communityMemberships.get(node.id);
      sigmaNodes.push({
        id: node.id,
        attributes: {
          label: node.properties.name,
          size: 10, // Will be calculated properly by Sigma
          color: '#888', // Will be calculated properly by Sigma
          nodeType: node.label,
          filePath: node.properties.filePath || '',
          startLine: node.properties.startLine,
          endLine: node.properties.endLine,
          x: 0,
          y: 0,
          community: communityIndex,
        }
      });
    });

    newRels.forEach(rel => {
      sigmaEdges.push({
        source: rel.sourceId,
        target: rel.targetId,
        attributes: {
          relationType: rel.type,
          size: 1,
          color: '#444',
        }
      });
    });

    // Use incremental add instead of full rebuild
    addNodesToSigma(sigmaNodes, sigmaEdges);
    clearIncrementalUpdate();
  }, [incrementalUpdate, graph, nodeById, addNodesToSigma, clearIncrementalUpdate]);

  // Update node visibility when filters change
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;

    const sigmaGraph = sigma.getGraph() as Graph<SigmaNodeAttributes, SigmaEdgeAttributes>;
    if (sigmaGraph.order === 0) return; // Don't filter empty graph

    filterGraphByDepth(sigmaGraph, appSelectedNode?.id || null, depthFilter, visibleLabels);
    sigma.refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sigmaRef identity never changes
  }, [visibleLabels, depthFilter, appSelectedNode]);

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

      {/* Sigma container */}
      <div
        ref={containerRef}
        className="sigma-container w-full h-full cursor-grab active:cursor-grabbing"
      />

      {/* Hovered node tooltip - only show when NOT selected */}
      {hoveredNodeName && !sigmaSelectedNode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-elevated/95 border border-border-subtle rounded-lg backdrop-blur-sm z-20 pointer-events-none animate-fade-in">
          <span className="font-mono text-sm text-text-primary">{hoveredNodeName}</span>
        </div>
      )}

      {/* Selection info bar */}
      {sigmaSelectedNode && appSelectedNode && (
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

      {/* Graph Controls - Bottom Right */}
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
          onClick={resetZoom}
          className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
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
            className="w-9 h-9 flex items-center justify-center bg-accent/20 border border-accent/30 rounded-md text-accent hover:bg-accent/30 transition-colors"
            title="Focus on Selected Node"
          >
            <Focus className="w-4 h-4" />
          </button>
        )}

        {/* Clear selection */}
        {sigmaSelectedNode && (
          <button
            onClick={handleClearSelection}
            className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
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
            w-9 h-9 flex items-center justify-center border rounded-md transition-all
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
      </div>

      {/* Layout running indicator */}
      {isLayoutRunning && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 bg-emerald-500/20 border border-emerald-500/30 rounded-full backdrop-blur-sm z-10 animate-fade-in">
          <div className="w-2 h-2 bg-emerald-400 rounded-full animate-ping" />
          <span className="text-xs text-emerald-400 font-medium">Layout optimizing...</span>
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

GraphCanvas.displayName = 'GraphCanvas';
