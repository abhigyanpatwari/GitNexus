import { useRef, useEffect, useCallback, useState } from 'react';
import Sigma from 'sigma';
import Graph from 'graphology';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import noverlap from 'graphology-layout-noverlap';
import EdgeCurveProgram from '@sigma/edge-curve';
import { SigmaNodeAttributes, SigmaEdgeAttributes } from '../lib/graph-adapter';
import type { NodeAnimation } from './useAppState';
import type { EdgeType } from '../lib/constants';
// Helper: Parse hex color to RGB
const hexToRgb = (hex: string): { r: number; g: number; b: number } => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 100, g: 100, b: 100 };
};

// Helper: RGB to hex
const rgbToHex = (r: number, g: number, b: number): string => {
  return '#' + [r, g, b].map(x => {
    const hex = Math.max(0, Math.min(255, Math.round(x))).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
};

// LRU color caches — avoid re-computing hex→rgb→hex on every reducer call
const dimCache = new Map<string, string>();
const brightenCache = new Map<string, string>();
const COLOR_CACHE_MAX = 500;

// Dim a color by mixing with dark background (keeps color hint)
const dimColor = (hex: string, amount: number): string => {
  const key = `${hex}:${amount}`;
  const cached = dimCache.get(key);
  if (cached) return cached;

  const rgb = hexToRgb(hex);
  const darkBg = { r: 18, g: 18, b: 28 };
  const result = rgbToHex(
    darkBg.r + (rgb.r - darkBg.r) * amount,
    darkBg.g + (rgb.g - darkBg.g) * amount,
    darkBg.b + (rgb.b - darkBg.b) * amount
  );
  if (dimCache.size >= COLOR_CACHE_MAX) dimCache.clear();
  dimCache.set(key, result);
  return result;
};

// Brighten a color (increase luminosity)
const brightenColor = (hex: string, factor: number): string => {
  const key = `${hex}:${factor}`;
  const cached = brightenCache.get(key);
  if (cached) return cached;

  const rgb = hexToRgb(hex);
  const result = rgbToHex(
    rgb.r + (255 - rgb.r) * (factor - 1) / factor,
    rgb.g + (255 - rgb.g) * (factor - 1) / factor,
    rgb.b + (255 - rgb.b) * (factor - 1) / factor
  );
  if (brightenCache.size >= COLOR_CACHE_MAX) brightenCache.clear();
  brightenCache.set(key, result);
  return result;
};

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
  setGraph: (graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>) => void;
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

// Noverlap for final cleanup - minimal since it starts with good positions
const NOVERLAP_SETTINGS = {
  maxIterations: 20,  // Reduced - less cleanup needed
  ratio: 1.1,
  margin: 10,
  expansion: 1.05,
};

// ForceAtlas2 settings - FAST convergence since nodes start near their parents
const getFA2Settings = (nodeCount: number) => {
  const isSmall = nodeCount < 500;
  const isMedium = nodeCount >= 500 && nodeCount < 2000;
  const isLarge = nodeCount >= 2000 && nodeCount < 10000;

  return {
    // Very low gravity for large graphs keeps clusters far apart
    gravity: isSmall ? 0.8 : isMedium ? 0.5 : isLarge ? 0.15 : 0.03,

    // High scaling ratio preserves the wide spread during layout
    scalingRatio: isSmall ? 15 : isMedium ? 30 : isLarge ? 100 : 300,

    // LOW slowDown = FASTER movement (converges quicker)
    slowDown: isSmall ? 1 : isMedium ? 2 : isLarge ? 3 : 5,

    // Barnes-Hut for performance - use it even on smaller graphs
    barnesHutOptimize: nodeCount > 200,
    barnesHutTheta: isLarge ? 0.8 : 0.6,  // Higher = faster but less accurate

    // These help with clustering while keeping spread
    strongGravityMode: false,
    outboundAttractionDistribution: true,
    linLogMode: false,
    adjustSizes: true,
    edgeWeightInfluence: 1,
  };
};

// Layout duration — shorter for responsive UI, longer for quality
// The graph starts with good hierarchical positions, so FA2 converges fast
const getLayoutDuration = (nodeCount: number): number => {
  if (nodeCount > 10000) return 20000;  // 20s for huge graphs
  if (nodeCount > 5000) return 15000;   // 15s
  if (nodeCount > 2000) return 12000;   // 12s
  if (nodeCount > 1000) return 10000;   // 10s
  if (nodeCount > 500) return 8000;     // 8s
  return 5000;                          // 5s for small graphs
};

export const useSigma = (options: UseSigmaOptions = {}): UseSigmaReturn => {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph<SigmaNodeAttributes, SigmaEdgeAttributes> | null>(null);
  const layoutRef = useRef<FA2Layout | null>(null);
  const selectedNodeRef = useRef<string | null>(null);
  const highlightedRef = useRef<Set<string>>(new Set());
  const blastRadiusRef = useRef<Set<string>>(new Set());
  const animatedNodesRef = useRef<Map<string, NodeAnimation>>(new Map());
  const visibleEdgeTypesRef = useRef<EdgeType[] | null>(null);
  const layoutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const nodeCountRef = useRef<number>(0); // Track graph size for perf decisions
  const [isLayoutRunning, setIsLayoutRunning] = useState(false);
  const [selectedNode, setSelectedNodeState] = useState<string | null>(null);

  useEffect(() => {
    highlightedRef.current = options.highlightedNodeIds || new Set();
    blastRadiusRef.current = options.blastRadiusNodeIds || new Set();
    animatedNodesRef.current = options.animatedNodes || new Map();
    visibleEdgeTypesRef.current = options.visibleEdgeTypes || null;
    sigmaRef.current?.refresh();
  }, [options.highlightedNodeIds, options.blastRadiusNodeIds, options.animatedNodes, options.visibleEdgeTypes]);

  // Animation loop for node effects — throttled to ~30fps to halve reducer calls
  useEffect(() => {
    if (!options.animatedNodes || options.animatedNodes.size === 0) {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      return;
    }

    let lastFrame = 0;
    const FRAME_INTERVAL = 33; // ~30fps instead of 60fps

    const animate = (timestamp: number) => {
      if (timestamp - lastFrame >= FRAME_INTERVAL) {
        sigmaRef.current?.refresh();
        lastFrame = timestamp;
      }
      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

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

    // Only do camera nudge for small graphs (avoids full refresh on large ones)
    if (nodeCountRef.current < 2000) {
      const camera = sigma.getCamera();
      const currentRatio = camera.ratio;
      // Imperceptible zoom change that triggers re-render
      camera.animate(
        { ratio: currentRatio * 1.0001 },
        { duration: 50 }
      );
    }

    sigma.refresh();
  }, []);

  // Initialize Sigma ONCE
  useEffect(() => {
    if (!containerRef.current) return;

    const graph = new Graph<SigmaNodeAttributes, SigmaEdgeAttributes>();
    graphRef.current = graph;

    const sigma = new Sigma(graph, containerRef.current, {
      renderLabels: true,
      labelFont: 'JetBrains Mono, monospace',
      labelSize: 11,
      labelWeight: '500',
      labelColor: { color: '#e4e4ed' },
      // Higher threshold = fewer labels rendered = faster for large graphs
      labelRenderedSizeThreshold: 8,
      labelDensity: 0.07,
      labelGridCellSize: 100,

      defaultNodeColor: '#6b7280',
      defaultEdgeColor: '#2a2a3a',

      defaultEdgeType: 'curved',
      edgeProgramClasses: {
        curved: EdgeCurveProgram,
      },

      // Perf: skip edge click/hover detection entirely — saves CPU on large graphs
      enableEdgeEvents: false,
      
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
        context.fillStyle = '#12121c';
        context.beginPath();
        context.roundRect(x - width / 2, y - height / 2, width, height, radius);
        context.fill();
        
        // Border matching node color
        context.strokeStyle = data.color || '#6366f1';
        context.lineWidth = 2;
        context.stroke();
        
        // Label text - light color
        context.fillStyle = '#f5f5f7';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(label, x, y);
        
        // Also draw a subtle glow ring around the node
        context.beginPath();
        context.arc(data.x, data.y, nodeSize + 4, 0, Math.PI * 2);
        context.strokeStyle = data.color || '#6366f1';
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
        if (data.hidden) return data;

        const currentSelected = selectedNodeRef.current;
        const highlighted = highlightedRef.current;
        const blastRadius = blastRadiusRef.current;
        const animatedNodes = animatedNodesRef.current;
        const hasHighlights = highlighted.size > 0;
        const hasBlastRadius = blastRadius.size > 0;

        // Fast path: nothing active — return original data (no allocation)
        if (!currentSelected && !hasHighlights && !hasBlastRadius && animatedNodes.size === 0) {
          return data;
        }

        // For large graphs (2000+), skip per-node dimming of non-active nodes.
        // Only modify nodes that ARE selected/highlighted/animated — leave the rest untouched.
        // This turns O(N) object allocations into O(k) where k = active nodes (typically < 50).
        const isLargeGraph = nodeCountRef.current > 2000;

        const isQueryHighlighted = highlighted.has(node);
        const isBlastRadiusNode = blastRadius.has(node);

        // Apply animation effects FIRST
        const animation = animatedNodes.get(node);
        if (animation) {
          const res = { ...data };
          const now = Date.now();
          const elapsed = now - animation.startTime;
          const progress = Math.min(elapsed / animation.duration, 1);
          const phase = (Math.sin(progress * Math.PI * 4) + 1) / 2;

          if (animation.type === 'pulse') {
            res.size = (data.size || 8) * (1.5 + phase * 0.8);
            res.color = phase > 0.5 ? '#06b6d4' : brightenColor('#06b6d4', 1.3);
          } else if (animation.type === 'ripple') {
            res.size = (data.size || 8) * (1.3 + phase * 1.2);
            res.color = phase > 0.5 ? '#ef4444' : '#f87171';
          } else if (animation.type === 'glow') {
            res.size = (data.size || 8) * (1.4 + phase * 0.6);
            res.color = phase > 0.5 ? '#a855f7' : '#c084fc';
          }
          res.zIndex = 5;
          res.highlighted = true;
          return res;
        }

        // Blast radius
        if (hasBlastRadius && !currentSelected) {
          if (isBlastRadiusNode) {
            return { ...data, color: '#ef4444', size: (data.size || 8) * 1.8, zIndex: 3, highlighted: true };
          }
          if (isQueryHighlighted) {
            return { ...data, color: '#06b6d4', size: (data.size || 8) * 1.4, zIndex: 2, highlighted: true };
          }
          // Large graph: skip dimming non-active nodes (huge perf win)
          if (isLargeGraph) return data;
          return { ...data, color: dimColor(data.color, 0.15), size: (data.size || 8) * 0.4, zIndex: 0 };
        }

        // Query highlights
        if (hasHighlights && !currentSelected) {
          if (isQueryHighlighted) {
            return { ...data, color: '#06b6d4', size: (data.size || 8) * 1.6, zIndex: 2, highlighted: true };
          }
          if (isLargeGraph) return data;
          return { ...data, color: dimColor(data.color, 0.2), size: (data.size || 8) * 0.5, zIndex: 0 };
        }

        // Selection
        if (currentSelected) {
          const graph = graphRef.current;
          if (graph) {
            const isSelected = node === currentSelected;
            if (isSelected) {
              return { ...data, size: (data.size || 8) * 1.8, zIndex: 2, highlighted: true };
            }
            const isNeighbor = graph.hasEdge(node, currentSelected) || graph.hasEdge(currentSelected, node);
            if (isNeighbor) {
              return { ...data, size: (data.size || 8) * 1.3, zIndex: 1 };
            }
            // Large graph: skip dimming thousands of non-neighbor nodes
            if (isLargeGraph) return data;
            return { ...data, color: dimColor(data.color, 0.25), size: (data.size || 8) * 0.6, zIndex: 0 };
          }
        }

        return data;
      },
      
      edgeReducer: (edge, data) => {
        // Check edge type visibility first
        const visibleTypes = visibleEdgeTypesRef.current;
        if (visibleTypes && data.relationType) {
          if (!visibleTypes.includes(data.relationType as EdgeType)) {
            return { ...data, hidden: true };
          }
        }

        const currentSelected = selectedNodeRef.current;
        const highlighted = highlightedRef.current;
        const blastRadius = blastRadiusRef.current;
        const hasHighlights = highlighted.size > 0 || blastRadius.size > 0;
        const isLargeGraph = nodeCountRef.current > 2000;

        // Fast path: nothing active — return original data (no allocation)
        if (!hasHighlights && !currentSelected) return data;

        if (hasHighlights && !currentSelected) {
          const graph = graphRef.current;
          if (graph) {
            const [source, target] = graph.extremities(edge);
            const isSourceActive = highlighted.has(source) || blastRadius.has(source);
            const isTargetActive = highlighted.has(target) || blastRadius.has(target);

            if (isSourceActive && isTargetActive) {
              return {
                ...data,
                color: (blastRadius.has(source) && blastRadius.has(target)) ? '#ef4444' : '#06b6d4',
                size: Math.max(2, (data.size || 1) * 3),
                zIndex: 2,
              };
            }
            if (isSourceActive || isTargetActive) {
              return { ...data, color: dimColor('#06b6d4', 0.4), size: 1, zIndex: 1 };
            }
            // Large graph: skip dimming non-active edges
            if (isLargeGraph) return data;
            return { ...data, color: dimColor(data.color, 0.08), size: 0.2, zIndex: 0 };
          }
          return data;
        }

        if (currentSelected) {
          const graph = graphRef.current;
          if (graph) {
            const [source, target] = graph.extremities(edge);
            const isConnected = source === currentSelected || target === currentSelected;

            if (isConnected) {
              return {
                ...data,
                color: brightenColor(data.color, 1.5),
                size: Math.max(3, (data.size || 1) * 4),
                zIndex: 2,
              };
            }
            // Large graph: skip dimming non-connected edges
            if (isLargeGraph) return data;
            return { ...data, color: dimColor(data.color, 0.1), size: 0.3, zIndex: 0 };
          }
        }

        return data;
      },
    });

    sigmaRef.current = sigma;

    sigma.on('clickNode', ({ node }) => {
      setSelectedNode(node);
      options.onNodeClick?.(node);
    });

    sigma.on('clickStage', () => {
      setSelectedNode(null);
      options.onStageClick?.();
    });

    sigma.on('enterNode', ({ node }) => {
      options.onNodeHover?.(node);
      if (containerRef.current) {
        containerRef.current.style.cursor = 'pointer';
      }
    });

    sigma.on('leaveNode', () => {
      options.onNodeHover?.(null);
      if (containerRef.current) {
        containerRef.current.style.cursor = 'grab';
      }
    });

    return () => {
      if (layoutTimeoutRef.current) {
        clearTimeout(layoutTimeoutRef.current);
      }
      layoutRef.current?.kill();
      sigma.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, []);

  // Run ForceAtlas2 layout
  const runLayout = useCallback((graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>) => {
    const nodeCount = graph.order;
    if (nodeCount === 0) return;

    // Kill existing
    if (layoutRef.current) {
      layoutRef.current.kill();
      layoutRef.current = null;
    }
    if (layoutTimeoutRef.current) {
      clearTimeout(layoutTimeoutRef.current);
      layoutTimeoutRef.current = null;
    }

    // Get settings
    const inferredSettings = forceAtlas2.inferSettings(graph);
    const customSettings = getFA2Settings(nodeCount);
    const settings = { ...inferredSettings, ...customSettings };
    
    const layout = new FA2Layout(graph, { settings });
    
    layoutRef.current = layout;
    layout.start();
    setIsLayoutRunning(true);

    const duration = getLayoutDuration(nodeCount);
    
    layoutTimeoutRef.current = setTimeout(() => {
      if (layoutRef.current) {
        layoutRef.current.stop();
        layoutRef.current = null;

        // Light noverlap cleanup
        noverlap.assign(graph, NOVERLAP_SETTINGS);
        sigmaRef.current?.refresh();

        // Cache positions after layout completes
        try {
          const positions: Record<string, { x: number; y: number }> = {};
          graph.forEachNode((nodeId, attrs) => {
            positions[nodeId] = { x: attrs.x, y: attrs.y };
          });
          sessionStorage.setItem('gitnexus-layout-cache', JSON.stringify({
            nodeCount: graph.order,
            positions,
          }));
        } catch {
          // Ignore cache errors (e.g. storage full)
        }

        setIsLayoutRunning(false);
      }
    }, duration);
  }, []);

  const setGraph = useCallback((newGraph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>) => {
    const sigma = sigmaRef.current;
    if (!sigma) return;

    if (layoutRef.current) {
      layoutRef.current.kill();
      layoutRef.current = null;
    }
    if (layoutTimeoutRef.current) {
      clearTimeout(layoutTimeoutRef.current);
      layoutTimeoutRef.current = null;
    }

    graphRef.current = newGraph;
    nodeCountRef.current = newGraph.order;
    sigma.setGraph(newGraph);
    setSelectedNode(null);

    // For large graphs, adjust Sigma settings for performance
    if (newGraph.order > 2000) {
      sigma.setSetting('labelRenderedSizeThreshold', 14);
      sigma.setSetting('labelDensity', 0.04);
      sigma.setSetting('labelGridCellSize', 150);
    }

    // Use straight lines for very large graphs — curved edges are expensive
    if (newGraph.order > 5000) {
      sigma.setSetting('defaultEdgeType', 'line');
    }

    // Disable hover renderer and edge events for large graphs — saves CPU
    if (newGraph.order > 5000) {
      sigma.setSetting('defaultDrawNodeHover', () => {});
      sigma.setSetting('enableEdgeEvents', false);
    }

    // Try to restore cached layout positions
    try {
      const cached = sessionStorage.getItem('gitnexus-layout-cache');
      if (cached) {
        const { nodeCount: cachedCount, positions } = JSON.parse(cached);
        if (cachedCount === newGraph.order) {
          newGraph.forEachNode((nodeId) => {
            const pos = positions[nodeId];
            if (pos) {
              newGraph.setNodeAttribute(nodeId, 'x', pos.x);
              newGraph.setNodeAttribute(nodeId, 'y', pos.y);
            }
          });
          sigma.refresh();
          // Skip layout entirely — use cached positions
          sigma.getCamera().animatedReset({ duration: 500 });
          return; // early return, skip runLayout
        }
      }
    } catch {
      // Ignore cache errors
    }

    // Skip FA2 layout for very large graphs — hierarchical positioning is sufficient
    if (newGraph.order > 10000) {
      // Just do a quick noverlap pass to prevent overlaps
      noverlap.assign(newGraph, { ...NOVERLAP_SETTINGS, maxIterations: 5 });
      sigma.refresh();
      sigma.getCamera().animatedReset({ duration: 500 });
      // Don't call runLayout
      return;
    }

    runLayout(newGraph);
    sigma.getCamera().animatedReset({ duration: 500 });
  }, [runLayout, setSelectedNode]);

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
      sigma.getCamera().animate(
        { x: nodeAttrs.x, y: nodeAttrs.y, ratio: 0.15 },
        { duration: 400 }
      );
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
    if (layoutTimeoutRef.current) {
      clearTimeout(layoutTimeoutRef.current);
      layoutTimeoutRef.current = null;
    }
    if (layoutRef.current) {
      layoutRef.current.stop();
      layoutRef.current = null;
      
      const graph = graphRef.current;
      if (graph) {
        noverlap.assign(graph, NOVERLAP_SETTINGS);
        sigmaRef.current?.refresh();
      }
      
      setIsLayoutRunning(false);
    }
  }, []);

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
