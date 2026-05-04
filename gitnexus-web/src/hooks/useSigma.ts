import { useRef, useEffect, useCallback, useState } from 'react';
import Sigma from 'sigma';
import Graph from 'graphology';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import noverlap from 'graphology-layout-noverlap';
import EdgeCurveProgram from '@sigma/edge-curve';
import { SigmaNodeAttributes, SigmaEdgeAttributes } from '../lib/graph-adapter';
import type { NodeAnimation } from './useAppState';
import { GRAPH_SURFACE_COLORS, type EdgeType } from '../lib/constants';
import { resolveGraphEdgeVisual, resolveGraphNodeVisual } from '../lib/graph-visual-state';

interface UseSigmaOptions {
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  onStageClick?: () => void;
  highlightedNodeIds?: Set<string>;
  blastRadiusNodeIds?: Set<string>;
  animatedNodes?: Map<string, NodeAnimation>;
  visibleEdgeTypes?: EdgeType[];
}

interface UseSigmaReturn {
  containerRef: React.RefObject<HTMLDivElement>;
  sigmaRef: React.RefObject<Sigma | null>;
  setGraph: (
    graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
    options?: SigmaSetGraphOptions,
  ) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  focusNode: (nodeId: string) => void;
  isLayoutRunning: boolean;
  startLayout: () => void;
  stopLayout: () => void;
  selectedNode: string | null;
  setSelectedNode: (nodeId: string | null) => void;
  refreshHighlights: () => void;
}

interface SigmaSetGraphOptions {
  runLayout?: boolean;
  resetCamera?: boolean;
  clearSelection?: boolean;
}

type LayoutBudget = {
  minDurationMs: number;
  maxDurationMs: number;
  sampleIntervalMs: number;
  movementThreshold: number;
  maxMovementThreshold: number;
  stableSamples: number;
};

type LayoutSnapshot = Map<string, { x: number; y: number }>;

const snapshotLayout = (graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>): LayoutSnapshot => {
  const positions: LayoutSnapshot = new Map();

  graph.forEachNode((nodeId, attributes) => {
    positions.set(nodeId, { x: attributes.x, y: attributes.y });
  });

  return positions;
};

const measureLayoutMovement = (
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  previousPositions: LayoutSnapshot,
) => {
  const nextPositions: LayoutSnapshot = new Map();
  let totalMovement = 0;
  let maxMovement = 0;
  let measuredNodes = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  graph.forEachNode((nodeId, attributes) => {
    const x = attributes.x;
    const y = attributes.y;
    const previous = previousPositions.get(nodeId);

    if (previous) {
      const movement = Math.hypot(x - previous.x, y - previous.y);
      totalMovement += movement;
      maxMovement = Math.max(maxMovement, movement);
      measuredNodes += 1;
    }

    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    nextPositions.set(nodeId, { x, y });
  });

  const graphDiagonal = Math.max(1, Math.hypot(maxX - minX, maxY - minY));
  const averageMovement = measuredNodes > 0 ? totalMovement / measuredNodes : 0;

  return {
    positions: nextPositions,
    averageMovement: averageMovement / graphDiagonal,
    maxMovement: maxMovement / graphDiagonal,
  };
};

export const getNoverlapSettings = (nodeCount: number) => ({
  maxIterations: nodeCount > 10000 ? 32 : nodeCount > 5000 ? 42 : nodeCount > 2000 ? 55 : 80,
  ratio: nodeCount > 5000 ? 1.04 : 1.1,
  margin: nodeCount > 5000 ? 6 : 10,
  expansion: 1.05,
});

// ForceAtlas2 settings - optimized for fast convergence from the seeded hierarchy/community layout.
export const getFA2Settings = (nodeCount: number) => {
  const isSmall = nodeCount < 500;
  const isMedium = nodeCount >= 500 && nodeCount < 2000;
  const isLarge = nodeCount >= 2000 && nodeCount < 10000;
  const isHuge = nodeCount >= 10000;

  return {
    // Lower gravity allows folders to stay spread out
    gravity: isSmall ? 0.8 : isMedium ? 0.5 : isLarge ? 0.3 : 0.15,

    // Higher scaling ratio = more spread out overall
    scalingRatio: isSmall ? 15 : isMedium ? 30 : isLarge ? 60 : 100,

    // LOW slowDown = FASTER movement (converges quicker)
    slowDown: isSmall ? 0.65 : isMedium ? 1 : isLarge ? 1.55 : 2.2,

    // Barnes-Hut for performance - use it even on smaller graphs
    barnesHutOptimize: nodeCount > 150,
    barnesHutTheta: isHuge ? 0.95 : isLarge ? 0.85 : 0.7,

    // Large anti-collision inside FA2 is costly; the final noverlap pass
    // handles cleanup after the graph has reached a useful shape.
    strongGravityMode: false,
    outboundAttractionDistribution: true,
    linLogMode: false,
    adjustSizes: nodeCount < 5000,
    edgeWeightInfluence: 1,
  };
};

// Let FA2 run until movement settles enough for navigation, with a safety cap
// to avoid an accidental infinite worker on pathological graphs.
export const getLayoutBudget = (nodeCount: number): LayoutBudget => {
  if (nodeCount > 10000) {
    return {
      minDurationMs: 60000,
      maxDurationMs: 300000,
      sampleIntervalMs: 1750,
      movementThreshold: 0.0006,
      maxMovementThreshold: 0.007,
      stableSamples: 4,
    };
  }
  if (nodeCount > 5000) {
    return {
      minDurationMs: 45000,
      maxDurationMs: 210000,
      sampleIntervalMs: 1500,
      movementThreshold: 0.00065,
      maxMovementThreshold: 0.0075,
      stableSamples: 4,
    };
  }
  if (nodeCount > 2000) {
    return {
      minDurationMs: 30000,
      maxDurationMs: 150000,
      sampleIntervalMs: 1250,
      movementThreshold: 0.00075,
      maxMovementThreshold: 0.008,
      stableSamples: 3,
    };
  }
  if (nodeCount > 1000) {
    return {
      minDurationMs: 22000,
      maxDurationMs: 105000,
      sampleIntervalMs: 1000,
      movementThreshold: 0.0009,
      maxMovementThreshold: 0.009,
      stableSamples: 3,
    };
  }
  if (nodeCount > 500) {
    return {
      minDurationMs: 14000,
      maxDurationMs: 75000,
      sampleIntervalMs: 900,
      movementThreshold: 0.00105,
      maxMovementThreshold: 0.01,
      stableSamples: 3,
    };
  }
  return {
    minDurationMs: 10000,
    maxDurationMs: 45000,
    sampleIntervalMs: 800,
    movementThreshold: 0.0012,
    maxMovementThreshold: 0.011,
    stableSamples: 2,
  };
};

export const useSigma = (options: UseSigmaOptions = {}): UseSigmaReturn => {
  const containerRef = useRef<HTMLDivElement>(null!);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph<SigmaNodeAttributes, SigmaEdgeAttributes> | null>(null);
  const layoutRef = useRef<FA2Layout | null>(null);
  const selectedNodeRef = useRef<string | null>(null);
  const highlightedRef = useRef<Set<string>>(new Set());
  const blastRadiusRef = useRef<Set<string>>(new Set());
  const animatedNodesRef = useRef<Map<string, NodeAnimation>>(new Map());
  const visibleEdgeTypesRef = useRef<EdgeType[] | null>(null);
  const optionsRef = useRef(options);
  const layoutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutMonitorRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const layoutRunIdRef = useRef(0);
  const animationFrameRef = useRef<number | null>(null);
  const [isLayoutRunning, setIsLayoutRunning] = useState(false);
  const [selectedNode, setSelectedNodeState] = useState<string | null>(null);

  useEffect(() => {
    optionsRef.current = options;
  });

  const clearLayoutTimers = useCallback(() => {
    if (layoutTimeoutRef.current) {
      clearTimeout(layoutTimeoutRef.current);
      layoutTimeoutRef.current = null;
    }
    if (layoutMonitorRef.current) {
      clearInterval(layoutMonitorRef.current);
      layoutMonitorRef.current = null;
    }
  }, []);

  const finishLayoutRun = useCallback(
    (runId: number, graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>, runNoverlap = true) => {
      if (layoutRunIdRef.current !== runId) return;

      clearLayoutTimers();

      if (layoutRef.current) {
        layoutRef.current.kill();
        layoutRef.current = null;
      }

      if (runNoverlap && graph.order > 1) {
        noverlap.assign(graph, getNoverlapSettings(graph.order));
        sigmaRef.current?.refresh();
      }

      setIsLayoutRunning(false);
    },
    [clearLayoutTimers],
  );

  useEffect(() => {
    highlightedRef.current = options.highlightedNodeIds || new Set();
    blastRadiusRef.current = options.blastRadiusNodeIds || new Set();
    animatedNodesRef.current = options.animatedNodes || new Map();
    visibleEdgeTypesRef.current = options.visibleEdgeTypes || null;
    sigmaRef.current?.refresh();
  }, [
    options.highlightedNodeIds,
    options.blastRadiusNodeIds,
    options.animatedNodes,
    options.visibleEdgeTypes,
  ]);

  // Animation loop for node effects
  useEffect(() => {
    if (!options.animatedNodes || options.animatedNodes.size === 0) {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      return;
    }

    const animate = () => {
      sigmaRef.current?.refresh();
      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [options.animatedNodes]);

  const setSelectedNode = useCallback((nodeId: string | null) => {
    selectedNodeRef.current = nodeId;
    setSelectedNodeState(nodeId);

    const sigma = sigmaRef.current;
    if (!sigma) return;

    // Tiny camera nudge to force edge refresh (workaround for Sigma edge caching)
    const camera = sigma.getCamera();
    const currentRatio = camera.ratio;
    // Imperceptible zoom change that triggers re-render
    camera.animate({ ratio: currentRatio * 1.0001 }, { duration: 50 });

    sigma.refresh();
  }, []);

  // Initialize Sigma ONCE
  useEffect(() => {
    if (!containerRef.current) return;

    const graph = new Graph<SigmaNodeAttributes, SigmaEdgeAttributes>();
    graphRef.current = graph;

    const sigma = new Sigma(graph, containerRef.current, {
      allowInvalidContainer: true,
      renderLabels: true,
      labelFont: 'JetBrains Mono, monospace',
      labelSize: 11,
      labelWeight: '500',
      labelColor: { color: '#e4e4ed' },
      labelRenderedSizeThreshold: 8,
      labelDensity: 0.1,
      labelGridCellSize: 70,

      defaultNodeColor: GRAPH_SURFACE_COLORS.defaultNode,
      defaultEdgeColor: GRAPH_SURFACE_COLORS.defaultEdge,

      defaultEdgeType: 'curved',
      edgeProgramClasses: {
        curved: EdgeCurveProgram,
      },

      // Custom hover renderer - dark background instead of white
      defaultDrawNodeHover: (context, data, settings) => {
        const label = data.label;
        if (!label) return;

        const size = settings.labelSize || 11;
        const font = settings.labelFont || 'JetBrains Mono, monospace';
        const weight = settings.labelWeight || '500';

        context.font = `${weight} ${size}px ${font}`;
        const textWidth = context.measureText(label).width;

        const nodeSize = data.size || 8;
        const x = data.x;
        const y = data.y - nodeSize - 10;
        const paddingX = 8;
        const paddingY = 5;
        const height = size + paddingY * 2;
        const width = textWidth + paddingX * 2;
        const radius = 4;

        // Dark background pill
        context.fillStyle = GRAPH_SURFACE_COLORS.tooltipBackground;
        context.beginPath();
        context.roundRect(x - width / 2, y - height / 2, width, height, radius);
        context.fill();

        // Border matching node color
        context.strokeStyle = data.color || GRAPH_SURFACE_COLORS.fallbackNode;
        context.lineWidth = 2;
        context.stroke();

        // Label text - light color
        context.fillStyle = GRAPH_SURFACE_COLORS.tooltipText;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(label, x, y);

        // Also draw a subtle glow ring around the node
        context.beginPath();
        context.arc(data.x, data.y, nodeSize + 4, 0, Math.PI * 2);
        context.strokeStyle = data.color || GRAPH_SURFACE_COLORS.fallbackNode;
        context.lineWidth = 2;
        context.globalAlpha = 0.5;
        context.stroke();
        context.globalAlpha = 1;
      },

      minCameraRatio: 0.002,
      maxCameraRatio: 50,
      hideEdgesOnMove: true,
      zIndex: true,

      nodeReducer: (node, data) => {
        const res = { ...data };

        if (data.hidden) {
          res.hidden = true;
          return res;
        }

        const currentSelected = selectedNodeRef.current;
        const graph = graphRef.current;
        const visual = resolveGraphNodeVisual({
          nodeId: node,
          color: data.color || GRAPH_SURFACE_COLORS.fallbackNode,
          size: data.size || 8,
          selectedNodeId: currentSelected,
          highlightedNodeIds: highlightedRef.current,
          blastRadiusNodeIds: blastRadiusRef.current,
          animatedNodes: animatedNodesRef.current,
          isNeighbor: currentSelected
            ? Boolean(
                graph?.hasEdge(node, currentSelected) || graph?.hasEdge(currentSelected, node),
              )
            : false,
        });

        res.color = visual.color;
        res.size = visual.size;
        res.zIndex = visual.zIndex;
        res.highlighted = visual.highlighted;

        return res;
      },

      edgeReducer: (edge, data) => {
        const res = { ...data };

        // Check edge type visibility first
        const visibleTypes = visibleEdgeTypesRef.current;
        if (visibleTypes && data.relationType) {
          if (!visibleTypes.includes(data.relationType as EdgeType)) {
            res.hidden = true;
            return res;
          }
        }

        const currentSelected = selectedNodeRef.current;
        const highlighted = highlightedRef.current;
        const blastRadius = blastRadiusRef.current;

        const graph = graphRef.current;
        if (graph) {
          const [source, target] = graph.extremities(edge);
          const visual = resolveGraphEdgeVisual({
            sourceId: source,
            targetId: target,
            color: data.color || GRAPH_SURFACE_COLORS.fallbackEdge,
            size: data.size || 1,
            selectedNodeId: currentSelected,
            highlightedNodeIds: highlighted,
            blastRadiusNodeIds: blastRadius,
          });

          res.color = visual.color;
          res.size = visual.size;
          res.zIndex = visual.zIndex;
        }

        return res;
      },
    });

    sigmaRef.current = sigma;

    sigma.on('clickNode', ({ node }) => {
      setSelectedNode(node);
      optionsRef.current.onNodeClick?.(node);
    });

    sigma.on('clickStage', () => {
      setSelectedNode(null);
      optionsRef.current.onStageClick?.();
    });

    sigma.on('enterNode', ({ node }) => {
      optionsRef.current.onNodeHover?.(node);
      if (containerRef.current) {
        containerRef.current.style.cursor = 'pointer';
      }
    });

    sigma.on('leaveNode', () => {
      optionsRef.current.onNodeHover?.(null);
      if (containerRef.current) {
        containerRef.current.style.cursor = 'grab';
      }
    });

    return () => {
      layoutRunIdRef.current += 1;
      if (layoutTimeoutRef.current) {
        clearTimeout(layoutTimeoutRef.current);
      }
      if (layoutMonitorRef.current) {
        clearInterval(layoutMonitorRef.current);
      }
      layoutRef.current?.kill();
      sigma.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, []);

  // Run ForceAtlas2 layout
  const runLayout = useCallback(
    (graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>) => {
      const nodeCount = graph.order;
      if (nodeCount === 0) return;

      // Kill existing
      layoutRunIdRef.current += 1;
      clearLayoutTimers();
      if (layoutRef.current) {
        layoutRef.current.kill();
        layoutRef.current = null;
      }

      const runId = layoutRunIdRef.current;
      const budget = getLayoutBudget(nodeCount);
      let previousPositions = snapshotLayout(graph);
      let stableSamples = 0;
      let movedSamples = 0;
      const startedAt = Date.now();

      // Get settings
      const inferredSettings = forceAtlas2.inferSettings(graph);
      const customSettings = getFA2Settings(nodeCount);
      const settings = { ...inferredSettings, ...customSettings };

      const layout = new FA2Layout(graph, { settings });

      layoutRef.current = layout;
      layout.start();
      setIsLayoutRunning(true);

      layoutMonitorRef.current = setInterval(() => {
        if (layoutRunIdRef.current !== runId || !layoutRef.current?.isRunning()) return;

        const movement = measureLayoutMovement(graph, previousPositions);
        previousPositions = movement.positions;

        if (movement.averageMovement > 0) {
          movedSamples += 1;
        }

        const elapsedMs = Date.now() - startedAt;
        const isSettled =
          elapsedMs >= budget.minDurationMs &&
          movedSamples >= 2 &&
          movement.averageMovement > 0 &&
          movement.averageMovement <= budget.movementThreshold &&
          movement.maxMovement <= budget.maxMovementThreshold;

        stableSamples = isSettled ? stableSamples + 1 : 0;

        if (stableSamples >= budget.stableSamples) {
          finishLayoutRun(runId, graph);
        }
      }, budget.sampleIntervalMs);

      layoutTimeoutRef.current = setTimeout(() => {
        finishLayoutRun(runId, graph);
      }, budget.maxDurationMs);
    },
    [clearLayoutTimers, finishLayoutRun],
  );

  const setGraph = useCallback(
    (
      newGraph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
      options: SigmaSetGraphOptions = {},
    ) => {
      const sigma = sigmaRef.current;
      if (!sigma) return;

      const shouldRunLayout = options.runLayout ?? true;
      const shouldResetCamera = options.resetCamera ?? true;
      const shouldClearSelection = options.clearSelection ?? true;

      layoutRunIdRef.current += 1;
      clearLayoutTimers();
      if (layoutRef.current) {
        layoutRef.current.kill();
        layoutRef.current = null;
      }
      setIsLayoutRunning(false);

      graphRef.current = newGraph;
      sigma.setGraph(newGraph);
      if (shouldClearSelection) {
        setSelectedNode(null);
      }

      if (shouldRunLayout) {
        runLayout(newGraph);
      } else {
        sigma.refresh();
      }
      if (shouldResetCamera) {
        sigma.getCamera().animatedReset({ duration: 500 });
      }
    },
    [clearLayoutTimers, runLayout, setSelectedNode],
  );

  const focusNode = useCallback((nodeId: string) => {
    const sigma = sigmaRef.current;
    const graph = graphRef.current;
    if (!sigma || !graph || !graph.hasNode(nodeId)) return;

    // Skip if already focused on this node (prevents double-click issues)
    const alreadySelected = selectedNodeRef.current === nodeId;

    // Set selection state directly (without the camera nudge from setSelectedNode)
    selectedNodeRef.current = nodeId;
    setSelectedNodeState(nodeId);

    // Only animate camera if selecting a new node
    if (!alreadySelected) {
      const nodeAttrs = graph.getNodeAttributes(nodeId);
      sigma.getCamera().animate({ x: nodeAttrs.x, y: nodeAttrs.y, ratio: 0.15 }, { duration: 400 });
    }

    sigma.refresh();
  }, []);

  const zoomIn = useCallback(() => {
    sigmaRef.current?.getCamera().animatedZoom({ duration: 200 });
  }, []);

  const zoomOut = useCallback(() => {
    sigmaRef.current?.getCamera().animatedUnzoom({ duration: 200 });
  }, []);

  const resetZoom = useCallback(() => {
    sigmaRef.current?.getCamera().animatedReset({ duration: 300 });
    setSelectedNode(null);
  }, [setSelectedNode]);

  const startLayout = useCallback(() => {
    const graph = graphRef.current;
    if (!graph || graph.order === 0) return;
    runLayout(graph);
  }, [runLayout]);

  const stopLayout = useCallback(() => {
    const graph = graphRef.current;
    if (graph) {
      finishLayoutRun(layoutRunIdRef.current, graph);
    } else {
      clearLayoutTimers();
      if (layoutRef.current) {
        layoutRef.current.kill();
        layoutRef.current = null;
      }
      setIsLayoutRunning(false);
    }
  }, [clearLayoutTimers, finishLayoutRun]);

  const refreshHighlights = useCallback(() => {
    sigmaRef.current?.refresh();
  }, []);

  return {
    containerRef,
    sigmaRef,
    setGraph,
    zoomIn,
    zoomOut,
    resetZoom,
    focusNode,
    isLayoutRunning,
    startLayout,
    stopLayout,
    selectedNode,
    setSelectedNode,
    refreshHighlights,
  };
};
