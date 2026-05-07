import {
  useEffect,
  useCallback,
  useMemo,
  useState,
  forwardRef,
  useImperativeHandle,
  useRef,
} from 'react';
import {
  Activity,
  AlertTriangle,
  Braces,
  Code,
  Copy,
  GitBranch,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Focus,
  RotateCcw,
  RefreshCw,
  Send,
  Target,
  Zap,
  Play,
  Pause,
  Lightbulb,
  LightbulbOff,
  Navigation,
  Orbit,
  Square,
  Box,
  HelpCircle,
} from '@/lib/lucide-icons';
import { useSigma } from '../hooks/useSigma';
import { useThreeGraph } from '../hooks/useThreeGraph';
import { useAppState } from '../hooks/useAppState';
import type { NodeAnimation } from '../hooks/useAppState';
import {
  knowledgeGraphToGraphology,
  filterGraphByDepth,
  SigmaNodeAttributes,
  SigmaEdgeAttributes,
} from '../lib/graph-adapter';
import { resolveAgentLensFocus, type AgentLensFocusSource } from '../lib/agent-lens-focus';
import { describeGraphDiff, diffKnowledgeGraphs, type GraphDiff } from '../lib/graph-diff';
import {
  ALL_EDGE_TYPES,
  DEFAULT_VISIBLE_EDGES,
  DEFAULT_VISIBLE_LABELS,
  EDGE_INFO,
  FILTERABLE_LABELS,
  GRAPH_COLOR_MODE_LEGENDS,
  GRAPH_SURFACE_COLORS,
  NODE_COLORS,
  type EdgeType,
  type GraphColorMode,
  type LegendItem,
} from '../lib/constants';
import { copyEdgeSelection, edgeSelectionEquals } from '../lib/edge-selection';
import type { GraphNode, GraphRelationship, NodeLabel } from 'gitnexus-shared';
import { QueryFAB } from './QueryFAB';
import Graph from 'graphology';

export interface GraphCanvasHandle {
  focusNode: (nodeId: string) => void;
}

type SigmaCameraSnapshot = {
  x: number;
  y: number;
  ratio: number;
};

type GraphCanvasPlaywrightState = {
  selectedNodeId: string | null;
  agentLensFocusNodeId: string | null;
  agentLensFocusSource: AgentLensFocusSource | null;
  agentLensSignature: string | null;
  graphViewMode: GraphViewMode;
  availableNodeIds: string[];
  isAIHighlightsEnabled: boolean;
  impactNodeIds: string[];
  toolNodeIds: string[];
  citationNodeIds: string[];
  agentActivityTotal: number;
  sigmaCamera: SigmaCameraSnapshot | null;
};

type GraphCanvasPlaywrightWindow = Window & {
  __gitnexusE2EGetGraphCanvasState?: () => GraphCanvasPlaywrightState;
  __gitnexusE2ESelectGraphNode?: (nodeId: string) => boolean;
};

type GraphViewMode = '2d' | '3d';
type GraphDetailMode = 'structural' | 'callFlow' | 'apiRuntime' | 'changeRisk' | 'agent';

type ColorModeDetails = {
  title: string;
  eyebrow: string;
  description: string;
  metric: string;
  lowLabel: string;
  highLabel: string;
  legend: LegendItem[];
};

type GraphDetailModeConfig = {
  title: string;
  label: string;
  description: string;
  colorMode: GraphColorMode;
  edgeTypes: EdgeType[];
};

const isPlaywrightRuntime = (): boolean =>
  (typeof navigator !== 'undefined' && navigator.webdriver) ||
  (typeof import.meta !== 'undefined' &&
    typeof import.meta.env !== 'undefined' &&
    import.meta.env.VITE_PLAYWRIGHT_TEST) ||
  (typeof process !== 'undefined' && process.env.PLAYWRIGHT_TEST);

const GRAPH_DETAIL_MODES: Record<GraphDetailMode, GraphDetailModeConfig> = {
  structural: {
    title: 'Structural',
    label: 'Structure',
    description: 'Folders, files, types, and ownership edges.',
    colorMode: 'structure',
    edgeTypes: ['CONTAINS', 'DEFINES', 'IMPORTS', 'USES', 'DECORATES', 'MEMBER_OF'],
  },
  callFlow: {
    title: 'Call-flow',
    label: 'Flow',
    description: 'Calls, entry points, process steps, and type dispatch.',
    colorMode: 'impact',
    edgeTypes: [
      'CALLS',
      'ENTRY_POINT_OF',
      'STEP_IN_PROCESS',
      'METHOD_OVERRIDES',
      'OVERRIDES',
      'METHOD_IMPLEMENTS',
    ],
  },
  apiRuntime: {
    title: 'API/runtime',
    label: 'API',
    description: 'Routes, handlers, fetchers, tools, and runtime observations.',
    colorMode: 'runtime',
    edgeTypes: [
      'HANDLES_ROUTE',
      'FETCHES',
      'HANDLES_TOOL',
      'QUERIES',
      'RUNTIME_MAPS_TO',
      'RUNTIME_OBSERVED_IN',
      'RUNTIME_HAS_SIGNAL',
    ],
  },
  changeRisk: {
    title: 'Change-risk',
    label: 'Risk',
    description: 'Impact, churn, access, and dependency hub signals.',
    colorMode: 'health',
    edgeTypes: [
      'CALLS',
      'INHERITS',
      'IMPORTS',
      'USES',
      'DECORATES',
      'ACCESSES',
      'HAS_METHOD',
      'HAS_PROPERTY',
      'EXTENDS',
      'IMPLEMENTS',
    ],
  },
  agent: {
    title: 'Agent',
    label: 'Agent',
    description: 'Tool calls, cited nodes, context clips, and assistant focus.',
    colorMode: 'agent',
    edgeTypes: ['HANDLES_TOOL', 'QUERIES', 'FETCHES', 'CALLS', 'DEFINES', 'RUNTIME_MAPS_TO'],
  },
};

const COLOR_MODE_DETAILS: Record<GraphColorMode, ColorModeDetails> = {
  type: {
    title: 'Type Map',
    eyebrow: 'Baseline lens',
    description:
      'Colors follow raw node type, so files, classes, functions, routes, and runtime nodes stay easy to separate.',
    metric: 'Node kind',
    lowLabel: 'metadata',
    highLabel: 'primary code',
    legend: GRAPH_COLOR_MODE_LEGENDS.type,
  },
  structure: {
    title: 'Structure Map',
    eyebrow: 'Navigation lens',
    description: 'Containers keep type colors while code symbols use functional-area colors.',
    metric: 'Type plus functional area',
    lowLabel: 'leaf code',
    highLabel: 'containers',
    legend: GRAPH_COLOR_MODE_LEGENDS.structure,
  },
  impact: {
    title: 'Impact Lens',
    eyebrow: 'Change-risk view',
    description:
      'Hotter and larger nodes are blast-radius targets or high-degree hubs. Use this before touching shared code.',
    metric: 'Dependants and highlighted impact',
    lowLabel: 'local',
    highLabel: 'wide impact',
    legend: GRAPH_COLOR_MODE_LEGENDS.impact,
  },
  runtime: {
    title: 'Runtime Lens',
    eyebrow: 'Production evidence',
    description:
      'Hotter and larger nodes have mapped errors, latency, spans, or log signals from the runtime overlay.',
    metric: 'Errors, latency, and observed signals',
    lowLabel: 'quiet',
    highLabel: 'failing or slow',
    legend: GRAPH_COLOR_MODE_LEGENDS.runtime,
  },
  agent: {
    title: 'Agent Lens',
    eyebrow: 'Assistant focus',
    description:
      'Tool results and citations override base type colors while background nodes keep their type color.',
    metric: 'Tool and citation activity',
    lowLabel: 'background',
    highLabel: 'active focus',
    legend: GRAPH_COLOR_MODE_LEGENDS.agent,
  },
  health: {
    title: 'Dependency Load',
    eyebrow: 'Coupling lens',
    description:
      'Hotter and larger nodes have many non-metadata relationships. These are hubs that can amplify change.',
    metric: 'Relationship degree',
    lowLabel: 'isolated',
    highLabel: 'hub',
    legend: GRAPH_COLOR_MODE_LEGENDS.health,
  },
  complexity: {
    title: 'Complexity Lens',
    eyebrow: 'Refactor candidates',
    description: 'Hotter and larger nodes have explicit complexity metrics or longer source spans.',
    metric: 'Complexity or source span',
    lowLabel: 'short',
    highLabel: 'complex',
    legend: GRAPH_COLOR_MODE_LEGENDS.complexity,
  },
  churn: {
    title: 'Churn Lens',
    eyebrow: 'Change-frequency view',
    description:
      'Hotter and larger nodes have churn or recent-change metrics when those signals are present.',
    metric: 'Recent changes',
    lowLabel: 'stable',
    highLabel: 'frequently changed',
    legend: GRAPH_COLOR_MODE_LEGENDS.churn,
  },
};

const preserveGraphPositions = (
  source: Graph<SigmaNodeAttributes, SigmaEdgeAttributes> | null,
  target: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  includeZ = false,
) => {
  if (!source) return;

  source.forEachNode((nodeId, attributes) => {
    if (!target.hasNode(nodeId)) return;
    target.setNodeAttribute(nodeId, 'x', attributes.x);
    target.setNodeAttribute(nodeId, 'y', attributes.y);
    if (includeZ && attributes.z !== undefined) {
      target.setNodeAttribute(nodeId, 'z', attributes.z);
    }
  });
};

export const GraphCanvas = forwardRef<GraphCanvasHandle>((_, ref) => {
  const {
    graph,
    setSelectedNode,
    selectedNode: appSelectedNode,
    visibleLabels,
    visibleEdgeTypes,
    setVisibleEdgeTypes,
    toggleEdgeVisibility,
    openCodePanel,
    openChatPanel,
    depthFilter,
    highlightedNodeIds,
    setVisibleLabels,
    toggleLabelVisibility,
    aiCitationHighlightedNodeIds,
    aiToolHighlightedNodeIds,
    blastRadiusNodeIds,
    isAIHighlightsEnabled,
    toggleAIHighlights,
    clearAIToolHighlights,
    clearAICitationHighlights,
    clearBlastRadius,
    animatedNodes,
    currentToolCalls,
  } = useAppState();
  const [hoveredNodeName, setHoveredNodeName] = useState<string | null>(null);
  const [graphViewMode, setGraphViewMode] = useState<GraphViewMode>('2d');
  const [graphDetailMode, setGraphDetailMode] = useState<GraphDetailMode | null>('structural');
  const [graphColorMode, setGraphColorMode] = useState<GraphColorMode>('structure');
  const [contextCopied, setContextCopied] = useState(false);
  const [graphChangeSummary, setGraphChangeSummary] = useState<GraphDiff | null>(null);
  const [graphChangeAnimations, setGraphChangeAnimations] = useState<Map<string, NodeAnimation>>(
    new Map(),
  );
  const graphViewModeRef = useRef<GraphViewMode>('2d');
  const renderGraph2DRef = useRef<Graph<SigmaNodeAttributes, SigmaEdgeAttributes> | null>(null);
  const renderGraph3DRef = useRef<Graph<SigmaNodeAttributes, SigmaEdgeAttributes> | null>(null);
  const previousKnowledgeGraphRef = useRef<typeof graph>(null);
  const graphChangeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentLensFocusSignatureRef = useRef<string | null>(null);
  const agentLensFocusedNodeIdRef = useRef<string | null>(null);
  const agentLensFocusSourceRef = useRef<AgentLensFocusSource | null>(null);

  useEffect(() => {
    graphViewModeRef.current = graphViewMode;
  }, [graphViewMode]);

  useEffect(
    () => () => {
      if (graphChangeTimeoutRef.current) {
        clearTimeout(graphChangeTimeoutRef.current);
      }
    },
    [],
  );

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

  const disabledAINodeIds = useMemo(() => new Set<string>(), []);
  const activeAICitationNodeIds = isAIHighlightsEnabled
    ? aiCitationHighlightedNodeIds
    : disabledAINodeIds;
  const activeAIToolNodeIds = isAIHighlightsEnabled ? aiToolHighlightedNodeIds : disabledAINodeIds;
  const rendererHighlightedNodeIds = useMemo(() => {
    if (!isAIHighlightsEnabled) return highlightedNodeIds;
    const next = new Set(highlightedNodeIds);
    for (const id of aiCitationHighlightedNodeIds) next.add(id);
    for (const id of aiToolHighlightedNodeIds) next.add(id);
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
  const agentActivityTotal =
    activeAICitationNodeIds.size + activeAIToolNodeIds.size + effectiveBlastRadiusNodeIds.size;

  const effectiveAnimatedNodes = useMemo(() => {
    const next = new Map<string, NodeAnimation>();
    if (isAIHighlightsEnabled) {
      animatedNodes.forEach((animation, nodeId) => next.set(nodeId, animation));
    }
    graphChangeAnimations.forEach((animation, nodeId) => next.set(nodeId, animation));
    return next;
  }, [animatedNodes, graphChangeAnimations, isAIHighlightsEnabled]);

  const nodeById = useMemo(() => {
    if (!graph) return new Map<string, GraphNode>();
    return new Map(graph.nodes.map((n) => [n.id, n]));
  }, [graph]);
  const agentLensFocusState = useMemo(
    () =>
      resolveAgentLensFocus({
        isEnabled: isAIHighlightsEnabled,
        impactNodeIds: effectiveBlastRadiusNodeIds,
        toolNodeIds: activeAIToolNodeIds,
        citationNodeIds: activeAICitationNodeIds,
        currentToolCalls: currentToolCalls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
        })),
        nodeById,
      }),
    [
      activeAICitationNodeIds,
      activeAIToolNodeIds,
      currentToolCalls,
      effectiveBlastRadiusNodeIds,
      isAIHighlightsEnabled,
      nodeById,
    ],
  );

  const activeVisibleEdgeTypes = visibleEdgeTypes;
  const nodeTypeCounts = useMemo(() => {
    const counts = new Map<NodeLabel, number>();
    if (!graph) return counts;
    graph.nodes.forEach((node) => {
      counts.set(node.label, (counts.get(node.label) ?? 0) + 1);
    });
    return counts;
  }, [graph]);
  const edgeTypeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!graph) return counts;
    graph.relationships.forEach((rel) => {
      counts.set(rel.type, (counts.get(rel.type) ?? 0) + 1);
    });
    return counts;
  }, [graph]);
  const nodeTypeOptions = useMemo(() => {
    const hasGraphCounts = nodeTypeCounts.size > 0;
    return FILTERABLE_LABELS.filter(
      (label) =>
        !hasGraphCounts ||
        nodeTypeCounts.has(label) ||
        visibleLabels.includes(label) ||
        DEFAULT_VISIBLE_LABELS.includes(label),
    );
  }, [nodeTypeCounts, visibleLabels]);
  const edgeTypeOptions = useMemo(() => {
    const hasGraphCounts = edgeTypeCounts.size > 0;
    return ALL_EDGE_TYPES.filter(
      (edgeType) =>
        !hasGraphCounts ||
        edgeTypeCounts.has(edgeType) ||
        activeVisibleEdgeTypes.includes(edgeType) ||
        DEFAULT_VISIBLE_EDGES.includes(edgeType),
    );
  }, [activeVisibleEdgeTypes, edgeTypeCounts]);
  const isDetailModeSelectionActive = useCallback(
    (mode: GraphDetailMode) =>
      graphColorMode === GRAPH_DETAIL_MODES[mode].colorMode &&
      edgeSelectionEquals(visibleEdgeTypes, GRAPH_DETAIL_MODES[mode].edgeTypes),
    [graphColorMode, visibleEdgeTypes],
  );

  const selectedNodeInsight = useMemo(() => {
    if (!graph || !appSelectedNode) return null;

    const selectedId = appSelectedNode.id;
    const relationships = graph.relationships.filter(
      (rel) => rel.sourceId === selectedId || rel.targetId === selectedId,
    );
    const inbound = relationships.filter((rel) => rel.targetId === selectedId);
    const outbound = relationships.filter((rel) => rel.sourceId === selectedId);
    const nodeName = (nodeId: string) => nodeById.get(nodeId)?.properties.name ?? nodeId;
    const processRelationships = relationships.filter((rel) => {
      const source = nodeById.get(rel.sourceId);
      const target = nodeById.get(rel.targetId);
      return (
        rel.type === 'STEP_IN_PROCESS' ||
        rel.type === 'ENTRY_POINT_OF' ||
        source?.label === 'Process' ||
        target?.label === 'Process'
      );
    });
    const communityRelationship = relationships.find((rel) => {
      const source = nodeById.get(rel.sourceId);
      const target = nodeById.get(rel.targetId);
      return (
        rel.type === 'MEMBER_OF' || source?.label === 'Community' || target?.label === 'Community'
      );
    });
    const communityNode =
      communityRelationship &&
      (nodeById.get(communityRelationship.sourceId)?.label === 'Community'
        ? nodeById.get(communityRelationship.sourceId)
        : nodeById.get(communityRelationship.targetId));
    const properties = appSelectedNode.properties;
    const lineSpan =
      typeof properties.startLine === 'number' && typeof properties.endLine === 'number'
        ? Math.max(0, properties.endLine - properties.startLine)
        : 0;
    const runtimeRelationships = relationships.filter((rel) => rel.type.startsWith('RUNTIME_'));
    const errorCount = Number(properties.errorCount ?? properties.errors ?? properties.count ?? 0);
    const churn = Number(
      properties.churn ??
        properties.churnCount ??
        properties.recentChanges ??
        properties.gitChurn ??
        0,
    );
    const explicitComplexity = Number(
      properties.complexity ?? properties.cyclomaticComplexity ?? properties.astComplexity ?? 0,
    );
    const dependencyCount = relationships.filter(
      (rel) => rel.type !== 'MEMBER_OF' && rel.type !== 'STEP_IN_PROCESS',
    ).length;
    const whyHot: string[] = [];

    if (effectiveBlastRadiusNodeIds.has(selectedId)) {
      whyHot.push('Impact: included in the current blast-radius result.');
    } else if (dependencyCount >= 12) {
      whyHot.push(
        `Impact: ${dependencyCount} non-metadata relationships make this a dependency hub.`,
      );
    }
    if (
      runtimeRelationships.length > 0 ||
      errorCount > 0 ||
      appSelectedNode.label.startsWith('Runtime')
    ) {
      whyHot.push(
        `Runtime: ${runtimeRelationships.length || errorCount || 1} mapped runtime signal${runtimeRelationships.length === 1 || errorCount === 1 ? '' : 's'}.`,
      );
    }
    if (explicitComplexity > 0 || lineSpan >= 120) {
      whyHot.push(
        `Complexity: ${explicitComplexity > 0 ? `score ${explicitComplexity}` : `${lineSpan} source lines`}.`,
      );
    }
    if (churn > 0) {
      whyHot.push(`Churn: ${churn} recent change${churn === 1 ? '' : 's'} recorded.`);
    }
    if (isAIHighlightsEnabled && effectiveHighlightedNodeIds.has(selectedId)) {
      whyHot.push('Agent: cited by the current assistant context or tool result.');
    }
    if (whyHot.length === 0) {
      whyHot.push(
        'Stable: no strong impact, runtime, complexity, churn, or agent signal is attached.',
      );
    }

    const relationshipPreview = relationships
      .slice()
      .sort((a, b) => {
        const aWeight = a.type === 'CALLS' || a.type.startsWith('RUNTIME_') ? 0 : 1;
        const bWeight = b.type === 'CALLS' || b.type.startsWith('RUNTIME_') ? 0 : 1;
        return aWeight - bWeight;
      })
      .slice(0, 8)
      .map((rel) => ({
        rel,
        direction: rel.sourceId === selectedId ? 'out' : 'in',
        otherName: rel.sourceId === selectedId ? nodeName(rel.targetId) : nodeName(rel.sourceId),
      }));

    const purpose =
      properties.purpose ??
      properties.description ??
      properties.summary ??
      properties.heuristicLabel ??
      (properties.filePath ? `Defined in ${properties.filePath}` : `${appSelectedNode.label} node`);

    return {
      purpose: String(purpose),
      filePath: properties.filePath ? String(properties.filePath) : '',
      inbound,
      outbound,
      relationships,
      relationshipPreview,
      processCount: new Set(
        processRelationships.map((rel) =>
          nodeById.get(rel.sourceId)?.label === 'Process' ? rel.sourceId : rel.targetId,
        ),
      ).size,
      communityName: communityNode
        ? String(communityNode.properties.heuristicLabel || communityNode.properties.name || '')
        : '',
      whyHot,
    };
  }, [
    appSelectedNode,
    effectiveBlastRadiusNodeIds,
    effectiveHighlightedNodeIds,
    graph,
    isAIHighlightsEnabled,
    nodeById,
  ]);

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

  const {
    containerRef: sigmaContainerRef,
    sigmaRef,
    setGraph: setSigmaGraph,
    zoomIn: sigmaZoomIn,
    zoomOut: sigmaZoomOut,
    resetZoom: sigmaResetZoom,
    focusNode: sigmaFocusNode,
    isLayoutRunning: isSigmaLayoutRunning,
    startLayout: startSigmaLayout,
    stopLayout: stopSigmaLayout,
    selectedNode: sigmaSelectedNode,
    setSelectedNode: setSigmaSelectedNode,
    refreshHighlights: refreshSigmaHighlights,
  } = useSigma({
    onNodeClick: handleNodeClick,
    onNodeHover: handleNodeHover,
    onStageClick: handleStageClick,
    highlightedNodeIds: rendererHighlightedNodeIds,
    blastRadiusNodeIds: effectiveBlastRadiusNodeIds,
    animatedNodes: effectiveAnimatedNodes,
    visibleEdgeTypes: activeVisibleEdgeTypes,
  });

  const {
    containerRef: threeContainerRef,
    setGraph: setThreeGraph,
    zoomIn: threeZoomIn,
    zoomOut: threeZoomOut,
    resetZoom: threeResetZoom,
    focusNode: threeFocusNode,
    isLayoutRunning: isThreeLayoutRunning,
    startLayout: startThreeLayout,
    stopLayout: stopThreeLayout,
    selectedNode: threeSelectedNode,
    setSelectedNode: setThreeSelectedNode,
    refreshHighlights: refreshThreeHighlights,
    cameraMode,
    setCameraMode,
  } = useThreeGraph({
    onNodeClick: handleNodeClick,
    onNodeHover: handleNodeHover,
    onStageClick: handleStageClick,
    highlightedNodeIds: rendererHighlightedNodeIds,
    blastRadiusNodeIds: effectiveBlastRadiusNodeIds,
    animatedNodes: effectiveAnimatedNodes,
    visibleEdgeTypes: activeVisibleEdgeTypes,
  });

  const is3DMode = graphViewMode === '3d';
  const activeColorModeDetails = COLOR_MODE_DETAILS[graphColorMode];
  const zoomIn = is3DMode ? threeZoomIn : sigmaZoomIn;
  const zoomOut = is3DMode ? threeZoomOut : sigmaZoomOut;
  const resetZoom = is3DMode ? threeResetZoom : sigmaResetZoom;
  const focusNode = is3DMode ? threeFocusNode : sigmaFocusNode;
  const isLayoutRunning = is3DMode ? isThreeLayoutRunning : isSigmaLayoutRunning;
  const startLayout = is3DMode ? startThreeLayout : startSigmaLayout;
  const stopLayout = is3DMode ? stopThreeLayout : stopSigmaLayout;
  const rendererSelectedNode = is3DMode ? threeSelectedNode : sigmaSelectedNode;
  const selectNodeInGraph = useCallback(
    (nodeId: string, shouldFocusCamera = false) => {
      if (!graph) return false;

      const node = nodeById.get(nodeId);
      if (!node) return false;

      if (shouldFocusCamera) {
        setSelectedNode(node);
        focusNode(nodeId);
        return true;
      }

      setSelectedNode(node);
      return true;
    },
    [focusNode, graph, nodeById, setSelectedNode],
  );

  const handleToggleAIHighlights = useCallback(() => {
    if (isAIHighlightsEnabled) {
      clearAIToolHighlights();
      clearAICitationHighlights();
      clearBlastRadius();
      setSelectedNode(null);
      setSigmaSelectedNode(null);
      setThreeSelectedNode(null);
    }
    toggleAIHighlights();
  }, [
    isAIHighlightsEnabled,
    clearAIToolHighlights,
    clearAICitationHighlights,
    clearBlastRadius,
    setSelectedNode,
    setSigmaSelectedNode,
    setThreeSelectedNode,
    toggleAIHighlights,
  ]);

  // Expose focusNode to parent via ref
  useImperativeHandle(
    ref,
    () => ({
      focusNode: (nodeId: string) => {
        if (selectNodeInGraph(nodeId, true)) {
          openCodePanel();
        }
      },
    }),
    [openCodePanel, selectNodeInGraph],
  );

  // Update Sigma graph when KnowledgeGraph changes
  useEffect(() => {
    if (!graph) return;

    // Build communityMemberships map from MEMBER_OF relationships
    // MEMBER_OF edges: nodeId -> communityId (stored as targetId)
    const communityMemberships = new Map<string, number>();
    graph.relationships.forEach((rel) => {
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

    const graphologyOptions = {
      colorMode: graphColorMode,
      impactNodeIds: effectiveBlastRadiusNodeIds,
      agentFocusNodeIds: effectiveHighlightedNodeIds,
      citationNodeIds: activeAICitationNodeIds,
      toolNodeIds: activeAIToolNodeIds,
    };
    const visualOnlyUpdate = previousKnowledgeGraphRef.current === graph;
    const graphDiff =
      previousKnowledgeGraphRef.current && !visualOnlyUpdate
        ? diffKnowledgeGraphs(previousKnowledgeGraphRef.current, graph)
        : null;
    const previous2DGraph = renderGraph2DRef.current;
    const previous3DGraph = renderGraph3DRef.current;
    const hasExistingRenderGraph = Boolean(previous2DGraph || previous3DGraph);
    const shouldPreserveViewport = visualOnlyUpdate || hasExistingRenderGraph;
    const sigmaGraph = knowledgeGraphToGraphology(graph, communityMemberships, graphologyOptions);
    const threeGraph = knowledgeGraphToGraphology(graph, communityMemberships, graphologyOptions);

    if (shouldPreserveViewport) {
      preserveGraphPositions(previous2DGraph, sigmaGraph);
      preserveGraphPositions(previous3DGraph, threeGraph, true);
    }

    if (graphDiff?.hasChanges) {
      setGraphChangeSummary(graphDiff);
      const now = Date.now();
      const nextAnimations = new Map<string, NodeAnimation>();
      graphDiff.addedNodeIds.slice(0, 60).forEach((nodeId) => {
        nextAnimations.set(nodeId, { type: 'pulse', startTime: now, duration: 3600 });
      });
      graphDiff.changedNodeIds.slice(0, 40).forEach((nodeId) => {
        nextAnimations.set(nodeId, { type: 'glow', startTime: now, duration: 3200 });
      });
      setGraphChangeAnimations(nextAnimations);
      if (graphChangeTimeoutRef.current) {
        clearTimeout(graphChangeTimeoutRef.current);
      }
      graphChangeTimeoutRef.current = setTimeout(() => {
        setGraphChangeSummary(null);
        setGraphChangeAnimations(new Map());
      }, 5200);
    } else if (!visualOnlyUpdate) {
      setGraphChangeSummary(null);
      setGraphChangeAnimations(new Map());
    }

    renderGraph2DRef.current = sigmaGraph;
    renderGraph3DRef.current = threeGraph;
    setSigmaGraph(sigmaGraph, {
      runLayout: !shouldPreserveViewport,
      resetCamera: !shouldPreserveViewport,
      clearSelection: false,
    });
    setThreeGraph(threeGraph, {
      runLayout: !shouldPreserveViewport,
      resetCamera: !shouldPreserveViewport,
      clearSelection: false,
      preservePositions: shouldPreserveViewport,
    });
    previousKnowledgeGraphRef.current = graph;
    if (graphViewModeRef.current === '2d') {
      stopThreeLayout();
    } else {
      stopSigmaLayout();
    }
  }, [
    graph,
    nodeById,
    setSigmaGraph,
    setThreeGraph,
    stopSigmaLayout,
    stopThreeLayout,
    graphColorMode,
    effectiveBlastRadiusNodeIds,
    effectiveHighlightedNodeIds,
    activeAICitationNodeIds,
    activeAIToolNodeIds,
  ]);

  // Update node visibility when filters change
  useEffect(() => {
    const sigmaGraph = renderGraph2DRef.current;
    const threeGraph = renderGraph3DRef.current;
    if (!sigmaGraph && !threeGraph) return;

    if (sigmaGraph && sigmaGraph.order > 0) {
      filterGraphByDepth(sigmaGraph, appSelectedNode?.id || null, depthFilter, visibleLabels);
    }
    if (threeGraph && threeGraph.order > 0) {
      filterGraphByDepth(threeGraph, appSelectedNode?.id || null, depthFilter, visibleLabels);
    }
    refreshSigmaHighlights();
    refreshThreeHighlights();
  }, [
    graph,
    graphColorMode,
    visibleLabels,
    depthFilter,
    appSelectedNode,
    effectiveBlastRadiusNodeIds,
    effectiveHighlightedNodeIds,
    aiCitationHighlightedNodeIds,
    aiToolHighlightedNodeIds,
    refreshSigmaHighlights,
    refreshThreeHighlights,
  ]);

  // Sync app selected node with both renderers
  useEffect(() => {
    const selectedNodeId = appSelectedNode?.id || null;
    setSigmaSelectedNode(selectedNodeId);
    setThreeSelectedNode(selectedNodeId);
  }, [appSelectedNode, graphColorMode, setSigmaSelectedNode, setThreeSelectedNode]);

  useEffect(() => {
    if (graphViewMode === '2d') {
      stopThreeLayout();
      setCameraMode('arcball');
    } else {
      stopSigmaLayout();
      startThreeLayout();
    }
  }, [graphViewMode, stopSigmaLayout, stopThreeLayout, startThreeLayout, setCameraMode]);

  useEffect(() => {
    if (
      !isAIHighlightsEnabled ||
      !agentLensFocusState.signature ||
      !agentLensFocusState.focalNodeId
    ) {
      agentLensFocusSignatureRef.current = null;
      agentLensFocusedNodeIdRef.current = null;
      agentLensFocusSourceRef.current = null;
      return;
    }

    if (agentLensFocusSignatureRef.current === agentLensFocusState.signature) {
      return;
    }

    if (!selectNodeInGraph(agentLensFocusState.focalNodeId, true)) {
      return;
    }

    agentLensFocusSignatureRef.current = agentLensFocusState.signature;
    agentLensFocusedNodeIdRef.current = agentLensFocusState.focalNodeId;
    agentLensFocusSourceRef.current = agentLensFocusState.focalSource;
  }, [
    agentLensFocusState.focalNodeId,
    agentLensFocusState.focalSource,
    agentLensFocusState.signature,
    isAIHighlightsEnabled,
    selectNodeInGraph,
  ]);

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
    setThreeSelectedNode(null);
    resetZoom();
  }, [setSelectedNode, setSigmaSelectedNode, setThreeSelectedNode, resetZoom]);

  useEffect(() => {
    if (!isPlaywrightRuntime() || typeof window === 'undefined') return;

    const playwrightWindow = window as GraphCanvasPlaywrightWindow;
    playwrightWindow.__gitnexusE2EGetGraphCanvasState = () => {
      const camera = sigmaRef.current?.getCamera();
      return {
        selectedNodeId: appSelectedNode?.id ?? null,
        agentLensFocusNodeId: agentLensFocusedNodeIdRef.current,
        agentLensFocusSource: agentLensFocusSourceRef.current,
        agentLensSignature: agentLensFocusSignatureRef.current,
        graphViewMode,
        availableNodeIds: graph?.nodes.slice(0, 16).map((node) => node.id) ?? [],
        isAIHighlightsEnabled,
        impactNodeIds: agentLensFocusState.impactNodeIds,
        toolNodeIds: agentLensFocusState.toolNodeIds,
        citationNodeIds: agentLensFocusState.citationNodeIds,
        agentActivityTotal,
        sigmaCamera:
          graphViewMode === '2d' && camera
            ? {
                x: Number(camera.x.toFixed(4)),
                y: Number(camera.y.toFixed(4)),
                ratio: Number(camera.ratio.toFixed(4)),
              }
            : null,
      };
    };
    playwrightWindow.__gitnexusE2ESelectGraphNode = (nodeId: string) =>
      selectNodeInGraph(nodeId, false);

    return () => {
      delete playwrightWindow.__gitnexusE2EGetGraphCanvasState;
      delete playwrightWindow.__gitnexusE2ESelectGraphNode;
    };
  }, [
    agentActivityTotal,
    agentLensFocusState.citationNodeIds,
    agentLensFocusState.impactNodeIds,
    agentLensFocusState.toolNodeIds,
    appSelectedNode?.id,
    graph,
    graphViewMode,
    isAIHighlightsEnabled,
    selectNodeInGraph,
    sigmaRef,
  ]);

  const buildContextClip = useCallback(
    (format: 'markdown' | 'jsonl' = 'markdown') => {
      if (!graph) return '';

      const seedIds = new Set<string>();
      if (appSelectedNode) seedIds.add(appSelectedNode.id);
      for (const id of effectiveHighlightedNodeIds) seedIds.add(id);
      for (const id of effectiveBlastRadiusNodeIds) seedIds.add(id);

      const adjacency = new Map<string, string[]>();
      graph.relationships.forEach((rel) => {
        if (!adjacency.has(rel.sourceId)) adjacency.set(rel.sourceId, []);
        if (!adjacency.has(rel.targetId)) adjacency.set(rel.targetId, []);
        adjacency.get(rel.sourceId)!.push(rel.targetId);
        adjacency.get(rel.targetId)!.push(rel.sourceId);
      });

      const clippedIds = new Set<string>();
      if (seedIds.size === 0) {
        graph.nodes
          .filter((node) => visibleLabels.includes(node.label))
          .slice(0, 80)
          .forEach((node) => clippedIds.add(node.id));
      } else {
        const queue = [...seedIds].map((nodeId) => ({ nodeId, depth: 0 }));
        while (queue.length > 0 && clippedIds.size < 120) {
          const current = queue.shift()!;
          if (clippedIds.has(current.nodeId) || current.depth > 2) continue;
          clippedIds.add(current.nodeId);
          if (current.depth >= 2) continue;
          for (const next of adjacency.get(current.nodeId) ?? []) {
            if (!clippedIds.has(next)) queue.push({ nodeId: next, depth: current.depth + 1 });
          }
        }
      }

      const clippedNodes = graph.nodes.filter((node) => clippedIds.has(node.id));
      const clippedRelationships = graph.relationships
        .filter((rel) => clippedIds.has(rel.sourceId) && clippedIds.has(rel.targetId))
        .slice(0, 220);
      const nodeName = (id: string) => nodeById.get(id)?.properties.name ?? id;

      if (format === 'jsonl') {
        return [
          ...clippedNodes.map((node) =>
            JSON.stringify({
              type: 'node',
              id: node.id,
              label: node.label,
              name: node.properties.name,
              filePath: node.properties.filePath,
              startLine: node.properties.startLine,
              endLine: node.properties.endLine,
            }),
          ),
          ...clippedRelationships.map((rel) =>
            JSON.stringify({
              type: 'relationship',
              sourceId: rel.sourceId,
              sourceName: nodeName(rel.sourceId),
              relationship: rel.type,
              targetId: rel.targetId,
              targetName: nodeName(rel.targetId),
            }),
          ),
        ].join('\n');
      }

      const nodeLines = clippedNodes.map((node) => {
        const location = node.properties.filePath
          ? `${node.properties.filePath}${node.properties.startLine ? `:${node.properties.startLine}` : ''}`
          : '';
        return `- ${node.properties.name} [${node.label}] ${location}`.trim();
      });
      const edgeLines = clippedRelationships.map(
        (rel) => `- ${nodeName(rel.sourceId)} --${rel.type}--> ${nodeName(rel.targetId)}`,
      );

      return [
        '# NexusForge Context Clip',
        '',
        `Nodes: ${clippedNodes.length}`,
        `Relationships: ${clippedRelationships.length}`,
        '',
        '## Nodes',
        ...nodeLines,
        '',
        '## Relationships',
        ...edgeLines,
      ].join('\n');
    },
    [
      appSelectedNode,
      effectiveBlastRadiusNodeIds,
      effectiveHighlightedNodeIds,
      graph,
      nodeById,
      visibleLabels,
    ],
  );

  const copyText = useCallback(async (text: string) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }, []);

  const copyContextClip = useCallback(
    async (format: 'markdown' | 'jsonl') => {
      const clip = buildContextClip(format);
      if (!clip) return;
      await copyText(clip);
      setContextCopied(true);
      window.setTimeout(() => setContextCopied(false), 1600);
    },
    [buildContextClip, copyText],
  );

  const handleCopyContextClip = useCallback(async () => {
    await copyContextClip('markdown');
  }, [copyContextClip]);

  const handleCopyJsonlContextClip = useCallback(async () => {
    await copyContextClip('jsonl');
  }, [copyContextClip]);

  const handleSendContextClip = useCallback(async () => {
    const clip = buildContextClip();
    if (!clip) return;
    await copyText(clip);
    setContextCopied(true);
    openChatPanel();
    window.setTimeout(() => setContextCopied(false), 1600);
  }, [buildContextClip, copyText, openChatPanel]);

  const handleDetailModeChange = useCallback(
    (mode: GraphDetailMode) => {
      const detailMode = GRAPH_DETAIL_MODES[mode];
      setGraphDetailMode(mode);
      setGraphColorMode(detailMode.colorMode);
      setVisibleEdgeTypes(copyEdgeSelection(detailMode.edgeTypes));
    },
    [setVisibleEdgeTypes],
  );

  const handleColorModeChange = useCallback((mode: GraphColorMode) => {
    setGraphDetailMode(null);
    setGraphColorMode(mode);
  }, []);

  const handleToggleEdgeVisibility = useCallback(
    (edgeType: EdgeType) => {
      setGraphDetailMode(null);
      toggleEdgeVisibility(edgeType);
    },
    [toggleEdgeVisibility],
  );

  const showAllNodeTypes = useCallback(() => {
    setVisibleLabels([...nodeTypeOptions]);
  }, [nodeTypeOptions, setVisibleLabels]);

  const hideAllNodeTypes = useCallback(() => {
    setVisibleLabels([]);
  }, [setVisibleLabels]);

  const resetNodeTypes = useCallback(() => {
    setVisibleLabels([...DEFAULT_VISIBLE_LABELS]);
  }, [setVisibleLabels]);

  const showAllEdgeTypes = useCallback(() => {
    setGraphDetailMode(null);
    setVisibleEdgeTypes([...edgeTypeOptions]);
  }, [edgeTypeOptions, setVisibleEdgeTypes]);

  const hideAllEdgeTypes = useCallback(() => {
    setGraphDetailMode(null);
    setVisibleEdgeTypes([]);
  }, [setVisibleEdgeTypes]);

  const resetEdgeTypes = useCallback(() => {
    setGraphDetailMode(null);
    setVisibleEdgeTypes(copyEdgeSelection(DEFAULT_VISIBLE_EDGES));
  }, [setVisibleEdgeTypes]);

  const clearAgentActivity = useCallback(() => {
    clearAIToolHighlights();
    clearAICitationHighlights();
    clearBlastRadius();
  }, [clearAIToolHighlights, clearAICitationHighlights, clearBlastRadius]);

  const colorModeControls: Array<{
    mode: GraphColorMode;
    Icon: typeof Activity;
    activeClass: string;
  }> = [
    {
      mode: 'type',
      Icon: Code,
      activeClass: 'border-sky-400/40 bg-sky-500/15 text-sky-200',
    },
    {
      mode: 'structure',
      Icon: GitBranch,
      activeClass: 'border-cyan-400/40 bg-cyan-500/15 text-cyan-200',
    },
    {
      mode: 'impact',
      Icon: Target,
      activeClass: 'border-rose-400/50 bg-rose-500/15 text-rose-200',
    },
    {
      mode: 'runtime',
      Icon: AlertTriangle,
      activeClass: 'border-red-400/50 bg-red-500/15 text-red-200',
    },
    {
      mode: 'agent',
      Icon: Zap,
      activeClass: 'border-cyan-400/50 bg-cyan-500/15 text-cyan-200',
    },
    {
      mode: 'health',
      Icon: Activity,
      activeClass: 'border-orange-400/50 bg-orange-500/15 text-orange-200',
    },
    {
      mode: 'complexity',
      Icon: Braces,
      activeClass: 'border-violet-400/50 bg-violet-500/15 text-violet-200',
    },
    {
      mode: 'churn',
      Icon: RefreshCw,
      activeClass: 'border-lime-400/50 bg-lime-500/15 text-lime-200',
    },
  ];

  return (
    <div className="relative h-full w-full bg-void">
      {/* Background gradient */}
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-0"
          style={{
            background: `
              radial-gradient(circle at 50% 50%, rgba(124, 58, 237, 0.03) 0%, transparent 70%),
              linear-gradient(to bottom, ${GRAPH_SURFACE_COLORS.background}, ${GRAPH_SURFACE_COLORS.backgroundSoft})
            `,
          }}
        />
      </div>

      {/* Graph renderers */}
      <div className="absolute inset-0 z-[1]">
        <div
          ref={sigmaContainerRef}
          data-testid="sigma-graph-container"
          className={`sigma-container absolute inset-0 cursor-grab transition-opacity duration-200 active:cursor-grabbing ${
            graphViewMode === '2d' ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
          aria-hidden={graphViewMode !== '2d'}
        />
        <div
          ref={threeContainerRef}
          className={`three-graph-container absolute inset-0 cursor-grab transition-opacity duration-200 active:cursor-grabbing ${
            graphViewMode === '3d' ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
          aria-hidden={graphViewMode !== '3d'}
        />
      </div>

      {/* Hovered node tooltip - only show when NOT selected */}
      {hoveredNodeName && !appSelectedNode && (
        <div className="pointer-events-none absolute top-4 left-1/2 z-20 -translate-x-1/2 animate-fade-in rounded-lg border border-border-subtle bg-elevated/95 px-3 py-1.5 backdrop-blur-sm">
          <span className="font-mono text-sm text-text-primary">{hoveredNodeName}</span>
        </div>
      )}

      {graphChangeSummary?.hasChanges && (
        <div className="pointer-events-none absolute top-16 left-1/2 z-20 -translate-x-1/2 animate-fade-in rounded-lg border border-cyan-400/25 bg-cyan-500/15 px-3 py-1.5 backdrop-blur-sm">
          <span className="text-xs font-medium text-cyan-100">Graph refreshed</span>
          <span className="ml-2 text-xs text-cyan-200/80">
            {describeGraphDiff(graphChangeSummary)}
          </span>
        </div>
      )}

      {/* Selection info bar */}
      {appSelectedNode && (
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
            Clear
          </button>
        </div>
      )}

      <div className="absolute top-4 left-4 z-20 flex w-[340px] max-w-[calc(100vw-6rem)] flex-col gap-2">
        <div className="rounded-lg border border-border-subtle bg-elevated/90 p-3 shadow-xl backdrop-blur-sm">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-cyan-400/25 bg-cyan-500/10 text-cyan-200">
              <HelpCircle className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="text-sm font-semibold text-text-primary">
                  {activeColorModeDetails.title}
                </h2>
                <span className="rounded border border-border-subtle px-1.5 py-0.5 text-[10px] text-text-muted uppercase">
                  {activeColorModeDetails.eyebrow}
                </span>
              </div>
              <p className="mt-1 text-xs leading-5 text-text-secondary">
                {activeColorModeDetails.description}
              </p>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-5 gap-1">
            {(
              Object.entries(GRAPH_DETAIL_MODES) as Array<[GraphDetailMode, GraphDetailModeConfig]>
            ).map(([mode, detail]) => {
              const isActivePreset = graphDetailMode === mode && isDetailModeSelectionActive(mode);

              return (
                <button
                  key={mode}
                  onClick={() => handleDetailModeChange(mode)}
                  className={`rounded-md border px-1.5 py-1 text-[10px] transition-colors ${
                    isActivePreset
                      ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-100'
                      : 'border-border-subtle bg-deep/70 text-text-muted hover:bg-hover hover:text-text-primary'
                  }`}
                  title={`Apply ${detail.title} edge preset: ${detail.description}`}
                  data-testid={`graph-detail-mode-${mode}`}
                >
                  {detail.label}
                </button>
              );
            })}
          </div>

          <div className="mt-3 border-t border-border-subtle pt-2">
            <div className="flex items-center justify-between gap-3 text-[11px] text-text-muted">
              <span>{activeColorModeDetails.lowLabel}</span>
              <span className="truncate text-text-secondary">{activeColorModeDetails.metric}</span>
              <span>{activeColorModeDetails.highLabel}</span>
            </div>
            <div className="mt-2 flex gap-1">
              {activeColorModeDetails.legend.map((item) => (
                <div
                  key={`${graphColorMode}-${item.label}`}
                  className="h-1.5 flex-1 rounded-full"
                  style={{ backgroundColor: item.color }}
                  title={item.label}
                />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {activeColorModeDetails.legend.map((item) => (
                <span
                  key={`${graphColorMode}-${item.label}-label`}
                  className="inline-flex items-center gap-1 text-[11px] text-text-muted"
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
                  {item.label}
                </span>
              ))}
            </div>
            {isAIHighlightsEnabled && agentActivityTotal > 0 && (
              <div className="mt-2 border-t border-border-subtle pt-2">
                <div className="flex items-center justify-between gap-2 text-[10px] text-text-muted uppercase">
                  <span>Agent activity</span>
                  <button
                    type="button"
                    onClick={clearAgentActivity}
                    className="rounded border border-border-subtle bg-deep/60 px-1.5 py-0.5 text-[10px] text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
                    title="Clear agent graph activity"
                  >
                    Clear
                  </button>
                </div>
                <div className="mt-1 grid grid-cols-3 gap-1">
                  <button
                    type="button"
                    onClick={clearAICitationHighlights}
                    className="rounded border border-violet-400/20 bg-violet-500/10 px-1.5 py-1 text-left transition-colors hover:bg-violet-500/15"
                    title="Clear citation highlights"
                  >
                    <div className="text-xs font-semibold text-violet-100">
                      {activeAICitationNodeIds.size}
                    </div>
                    <div className="text-[10px] text-violet-200/70 uppercase">Citations</div>
                  </button>
                  <button
                    type="button"
                    onClick={clearAIToolHighlights}
                    className="rounded border border-cyan-400/20 bg-cyan-500/10 px-1.5 py-1 text-left transition-colors hover:bg-cyan-500/15"
                    title="Clear tool-result highlights"
                  >
                    <div className="text-xs font-semibold text-cyan-100">
                      {activeAIToolNodeIds.size}
                    </div>
                    <div className="text-[10px] text-cyan-200/70 uppercase">Tools</div>
                  </button>
                  <button
                    type="button"
                    onClick={clearBlastRadius}
                    className="rounded border border-red-400/20 bg-red-500/10 px-1.5 py-1 text-left transition-colors hover:bg-red-500/15"
                    title="Clear impact highlights"
                  >
                    <div className="text-xs font-semibold text-red-100">
                      {effectiveBlastRadiusNodeIds.size}
                    </div>
                    <div className="text-[10px] text-red-200/70 uppercase">Impact</div>
                  </button>
                </div>
              </div>
            )}
            <div className="mt-2 border-t border-border-subtle pt-2">
              <div className="flex items-center justify-between gap-3 text-[10px] text-text-muted uppercase">
                <span>Visible nodes</span>
                <span>
                  {visibleLabels.length}/{nodeTypeOptions.length} types
                </span>
              </div>
              <div className="mt-1 flex gap-1">
                <button
                  type="button"
                  onClick={showAllNodeTypes}
                  className="rounded border border-border-subtle bg-deep/60 px-1.5 py-0.5 text-[10px] text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
                  title="Show every node type present in this graph"
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={hideAllNodeTypes}
                  className="rounded border border-border-subtle bg-deep/60 px-1.5 py-0.5 text-[10px] text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
                  title="Hide every node type"
                >
                  None
                </button>
                <button
                  type="button"
                  onClick={resetNodeTypes}
                  className="rounded border border-border-subtle bg-deep/60 px-1.5 py-0.5 text-[10px] text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
                  title="Restore default node visibility"
                >
                  Reset
                </button>
              </div>
              <div className="mt-1 flex max-h-28 flex-wrap gap-1 overflow-y-auto pr-1">
                {nodeTypeOptions.map((label) => {
                  const isVisible = visibleLabels.includes(label);
                  const count = nodeTypeCounts.get(label) ?? 0;

                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => toggleLabelVisibility(label)}
                      className={`inline-flex min-h-6 items-center gap-1 rounded border px-1.5 text-[10px] transition-colors ${
                        isVisible
                          ? 'border-cyan-400/25 bg-elevated text-text-primary'
                          : 'border-border-subtle bg-deep/50 text-text-muted hover:bg-hover hover:text-text-secondary'
                      }`}
                      title={`${isVisible ? 'Hide' : 'Show'} ${label} nodes${count ? ` (${count})` : ''}`}
                      aria-pressed={isVisible}
                      data-testid={`graph-node-toggle-${label}`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${isVisible ? '' : 'opacity-40'}`}
                        style={{ backgroundColor: NODE_COLORS[label] }}
                      />
                      <span>{label}</span>
                      {count > 0 && <span className="text-text-muted">{count}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="mt-3 border-t border-border-subtle pt-2">
              <div className="flex items-center justify-between gap-3 text-[10px] text-text-muted uppercase">
                <span>Visible edges</span>
                <span>
                  {activeVisibleEdgeTypes.length}/{edgeTypeOptions.length} types
                </span>
              </div>
              <div className="mt-1 flex gap-1">
                <button
                  type="button"
                  onClick={showAllEdgeTypes}
                  className="rounded border border-border-subtle bg-deep/60 px-1.5 py-0.5 text-[10px] text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
                  title="Show every edge type present in this graph"
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={hideAllEdgeTypes}
                  className="rounded border border-border-subtle bg-deep/60 px-1.5 py-0.5 text-[10px] text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
                  title="Hide every edge type"
                >
                  None
                </button>
                <button
                  type="button"
                  onClick={resetEdgeTypes}
                  className="rounded border border-border-subtle bg-deep/60 px-1.5 py-0.5 text-[10px] text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
                  title="Restore default edge visibility"
                >
                  Reset
                </button>
              </div>
              <div className="mt-1 flex max-h-28 flex-wrap gap-1 overflow-y-auto pr-1">
                {edgeTypeOptions.map((edgeType) => {
                  const info = EDGE_INFO[edgeType];
                  const isVisible = activeVisibleEdgeTypes.includes(edgeType);
                  const count = edgeTypeCounts.get(edgeType) ?? 0;

                  return (
                    <button
                      key={`${graphDetailMode ?? 'custom'}-${edgeType}`}
                      type="button"
                      onClick={() => handleToggleEdgeVisibility(edgeType)}
                      className={`inline-flex min-h-6 items-center gap-1 rounded border px-1.5 text-[10px] transition-colors ${
                        isVisible
                          ? 'border-cyan-400/25 bg-elevated text-text-primary'
                          : 'border-border-subtle bg-deep/50 text-text-muted hover:bg-hover hover:text-text-secondary'
                      }`}
                      title={`${isVisible ? 'Hide' : 'Show'} ${info.label}`}
                      aria-pressed={isVisible}
                      data-testid={`graph-edge-toggle-${edgeType}`}
                    >
                      <span
                        className={`h-1.5 w-3 rounded-full ${isVisible ? '' : 'opacity-40'}`}
                        style={{ backgroundColor: info.color }}
                      />
                      <span>{info.label}</span>
                      {count > 0 && <span className="text-text-muted">{count}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {appSelectedNode && selectedNodeInsight && (
          <div className="rounded-lg border border-border-subtle bg-elevated/90 p-3 shadow-xl backdrop-blur-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-text-primary">
                  {appSelectedNode.properties.name}
                </h3>
                <p className="mt-1 text-xs leading-5 text-text-secondary">
                  {selectedNodeInsight.purpose}
                </p>
              </div>
              <span className="shrink-0 rounded border border-border-subtle px-1.5 py-0.5 text-[10px] text-text-muted uppercase">
                {appSelectedNode.label}
              </span>
            </div>

            {selectedNodeInsight.filePath && (
              <p className="mt-2 truncate font-mono text-[10px] text-text-muted">
                {selectedNodeInsight.filePath}
              </p>
            )}

            <div className="mt-3 grid grid-cols-3 gap-2">
              <div className="rounded-md border border-border-subtle bg-deep/60 p-2">
                <div className="text-sm font-semibold text-text-primary">
                  {selectedNodeInsight.outbound.length}
                </div>
                <div className="text-[10px] text-text-muted uppercase">Outbound</div>
              </div>
              <div className="rounded-md border border-border-subtle bg-deep/60 p-2">
                <div className="text-sm font-semibold text-text-primary">
                  {selectedNodeInsight.inbound.length}
                </div>
                <div className="text-[10px] text-text-muted uppercase">Inbound</div>
              </div>
              <div className="rounded-md border border-border-subtle bg-deep/60 p-2">
                <div className="text-sm font-semibold text-text-primary">
                  {selectedNodeInsight.processCount}
                </div>
                <div className="text-[10px] text-text-muted uppercase">Flows</div>
              </div>
            </div>

            <p className="mt-2 text-[11px] leading-4 text-text-muted">
              This node calls{' '}
              {
                selectedNodeInsight.outbound.filter(
                  (rel: GraphRelationship) => rel.type === 'CALLS',
                ).length
              }{' '}
              methods, is called by{' '}
              {
                selectedNodeInsight.inbound.filter((rel: GraphRelationship) => rel.type === 'CALLS')
                  .length
              }{' '}
              flows
              {selectedNodeInsight.communityName
                ? `, and belongs to ${selectedNodeInsight.communityName} cluster.`
                : '.'}
            </p>

            <div className="mt-3">
              <div className="mb-1 text-[10px] text-text-muted uppercase">Why hot</div>
              <div className="space-y-1">
                {selectedNodeInsight.whyHot.slice(0, 4).map((reason) => (
                  <div
                    key={reason}
                    className="rounded border border-border-subtle bg-deep/60 px-2 py-1 text-[11px] leading-4 text-text-secondary"
                  >
                    {reason}
                  </div>
                ))}
              </div>
            </div>

            {selectedNodeInsight.relationshipPreview.length > 0 && (
              <div className="mt-3">
                <div className="mb-1 text-[10px] text-text-muted uppercase">Relationships</div>
                <div className="space-y-1">
                  {selectedNodeInsight.relationshipPreview.map(({ rel, direction, otherName }) => (
                    <div
                      key={rel.id}
                      className="flex items-center gap-2 rounded border border-border-subtle bg-deep/60 px-2 py-1 text-[11px]"
                      title={`${rel.sourceId} -> ${rel.targetId}${rel.reason ? ` | ${rel.reason}` : ''}`}
                    >
                      <span
                        className="h-1.5 w-3 rounded-full"
                        style={{
                          backgroundColor:
                            EDGE_INFO[rel.type as EdgeType]?.color ??
                            GRAPH_SURFACE_COLORS.fallbackEdge,
                        }}
                      />
                      <span className="shrink-0 text-text-muted">
                        {direction === 'out' ? 'to' : 'from'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-text-secondary">
                        {otherName}
                      </span>
                      <span className="shrink-0 text-text-muted">
                        {EDGE_INFO[rel.type as EdgeType]?.label ?? rel.type}
                        {rel.confidence !== undefined
                          ? ` ${Math.round(rel.confidence * 100)}%`
                          : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {isAIHighlightsEnabled && currentToolCalls.length > 0 && (
          <div className="flex flex-col gap-1 rounded-lg border border-cyan-400/20 bg-elevated/90 p-2 backdrop-blur-sm">
            {currentToolCalls.slice(-4).map((toolCall) => (
              <div key={toolCall.id} className="flex items-center gap-2 text-xs">
                <span
                  className={`h-2 w-2 rounded-full ${
                    toolCall.status === 'running'
                      ? 'animate-pulse bg-cyan-300'
                      : toolCall.status === 'error'
                        ? 'bg-red-400'
                        : 'bg-emerald-400'
                  }`}
                />
                <span className="truncate font-mono text-text-secondary">{toolCall.name}</span>
                <span className="ml-auto text-[10px] text-text-muted uppercase">
                  {toolCall.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Graph Controls - Bottom Right */}
      <div className="absolute right-4 bottom-4 z-10 flex flex-col gap-1">
        <button
          onClick={zoomIn}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle bg-elevated text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          title="Zoom In"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          onClick={zoomOut}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle bg-elevated text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          title="Zoom Out"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          onClick={resetZoom}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle bg-elevated text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          title="Fit to Screen"
        >
          <Maximize2 className="h-4 w-4" />
        </button>

        {/* Divider */}
        <div className="my-1 h-px bg-border-subtle" />

        {/* View mode */}
        <button
          onClick={() => setGraphViewMode('2d')}
          className={`flex h-9 w-9 items-center justify-center rounded-md border transition-colors ${
            graphViewMode === '2d'
              ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-200'
              : 'border-border-subtle bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary'
          }`}
          title="2D Graph"
          data-testid="graph-view-2d-toggle"
        >
          <Square className="h-4 w-4" />
        </button>
        <button
          onClick={() => setGraphViewMode('3d')}
          className={`flex h-9 w-9 items-center justify-center rounded-md border transition-colors ${
            graphViewMode === '3d'
              ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-200'
              : 'border-border-subtle bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary'
          }`}
          title="3D Graph"
          data-testid="graph-view-3d-toggle"
        >
          <Box className="h-4 w-4" />
        </button>

        {colorModeControls.map(({ mode, Icon, activeClass }) => {
          const detail = COLOR_MODE_DETAILS[mode];

          return (
            <button
              key={mode}
              onClick={() => handleColorModeChange(mode)}
              className={`flex h-9 w-9 items-center justify-center rounded-md border transition-colors ${
                graphColorMode === mode
                  ? activeClass
                  : 'border-border-subtle bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary'
              }`}
              title={`${detail.title}: ${detail.metric}`}
              aria-label={`${detail.title}. ${detail.description}`}
              aria-pressed={graphColorMode === mode}
              data-testid={`graph-color-${mode}`}
            >
              <Icon className="h-4 w-4" />
            </button>
          );
        })}

        {/* Divider */}
        <div className="my-1 h-px bg-border-subtle" />

        <button
          onClick={handleCopyContextClip}
          className={`flex h-9 w-9 items-center justify-center rounded-md border transition-colors ${
            contextCopied
              ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200'
              : 'border-border-subtle bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary'
          }`}
          title="Copy Context Clip"
          data-testid="graph-context-copy"
        >
          <Copy className="h-4 w-4" />
        </button>
        <button
          onClick={handleCopyJsonlContextClip}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle bg-elevated text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          title="Copy JSONL Context Clip"
          data-testid="graph-context-copy-jsonl"
        >
          <Code className="h-4 w-4" />
        </button>
        <button
          onClick={handleSendContextClip}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle bg-elevated text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          title="Send Context Clip"
          data-testid="graph-context-send"
        >
          <Send className="h-4 w-4" />
        </button>

        {/* Divider */}
        <div className="my-1 h-px bg-border-subtle" />

        {/* Focus on selected */}
        {appSelectedNode && (
          <button
            onClick={handleFocusSelected}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-accent/30 bg-accent/20 text-accent transition-colors hover:bg-accent/30"
            title="Focus on Selected Node"
          >
            <Focus className="h-4 w-4" />
          </button>
        )}

        {/* Clear selection */}
        {appSelectedNode && rendererSelectedNode && (
          <button
            onClick={handleClearSelection}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle bg-elevated text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
            title="Clear Selection"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        )}

        {is3DMode && (
          <>
            {/* Divider */}
            <div className="my-1 h-px bg-border-subtle" />

            {/* Camera mode */}
            <button
              onClick={() => setCameraMode('arcball')}
              className={`flex h-9 w-9 items-center justify-center rounded-md border transition-colors ${
                cameraMode === 'arcball'
                  ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-200'
                  : 'border-border-subtle bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary'
              }`}
              title="Arcball Camera"
            >
              <Orbit className="h-4 w-4" />
            </button>
            <button
              onClick={() => setCameraMode('firstPerson')}
              className={`flex h-9 w-9 items-center justify-center rounded-md border transition-colors ${
                cameraMode === 'firstPerson'
                  ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-200'
                  : 'border-border-subtle bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary'
              }`}
              title="First-Person Camera"
            >
              <Navigation className="h-4 w-4" />
            </button>
          </>
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
          title={isLayoutRunning ? 'Stop Layout' : 'Run Layout Again'}
        >
          {isLayoutRunning ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
      </div>

      {/* Layout running indicator */}
      {isLayoutRunning && (
        <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 animate-fade-in items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/20 px-3 py-1.5 backdrop-blur-sm">
          <div className="h-2 w-2 animate-ping rounded-full bg-emerald-400" />
          <span className="text-xs font-medium text-emerald-400">Layout optimizing...</span>
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
          title={isAIHighlightsEnabled ? 'Turn off all highlights' : 'Turn on AI highlights'}
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
