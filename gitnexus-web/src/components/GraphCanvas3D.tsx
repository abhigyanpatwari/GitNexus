import { useMemo, useCallback, useState, useEffect } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import SpriteText from 'three-spritetext';
import { useTheme } from '../context/ThemeContext';
import { useAppState } from '../hooks/useAppState';
import { NODE_COLORS, NODE_SIZES, EDGE_INFO } from '../lib/constants';
import type { NodeLabel } from '../core/graph/types';
import type { EdgeType } from '../lib/constants';

interface Props {
  highlightedNodeIds: Set<string>;
  blastRadiusNodeIds: Set<string>;
}

// --- colour helpers (mirrors useSigma.ts) ---

const hexToRgb = (hex: string) => {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return r
    ? { r: parseInt(r[1], 16), g: parseInt(r[2], 16), b: parseInt(r[3], 16) }
    : { r: 100, g: 100, b: 100 };
};

const rgbToHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');

/** Mix colour toward the background — same formula as 2D dim */
const dimColor = (hex: string, amount: number, isDark: boolean) => {
  const { r, g, b } = hexToRgb(hex);
  const bg = isDark ? { r: 15, g: 15, b: 15 } : { r: 198, g: 198, b: 198 };
  return rgbToHex(bg.r + (r - bg.r) * amount, bg.g + (g - bg.g) * amount, bg.b + (b - bg.b) * amount);
};

/** Brighten a colour — same formula as 2D brighten */
const brightenColor = (hex: string, factor: number) => {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(
    r + (255 - r) * (factor - 1) / factor,
    g + (255 - g) * (factor - 1) / factor,
    b + (255 - b) * (factor - 1) / factor,
  );
};

/** Resolve link endpoint — ForceGraph3D replaces source/target with node objects after simulation */
const linkEndId = (end: any): string => (typeof end === 'object' && end !== null ? end.id : end);

export const GraphCanvas3D = ({ highlightedNodeIds, blastRadiusNodeIds }: Props) => {
  const { graph, selectedNode: appSelectedNode, setSelectedNode, openCodePanel } = useAppState();
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  // Local selection state drives all visual updates
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Sync from app state (e.g. user selected a node in 2D then switched to 3D)
  useEffect(() => {
    setSelectedNodeId(appSelectedNode?.id ?? null);
  }, [appSelectedNode]);

  // Set of direct neighbours for the selected node
  const neighborIds = useMemo(() => {
    if (!selectedNodeId || !graph) return new Set<string>();
    const s = new Set<string>();
    for (const rel of graph.relationships) {
      if (rel.sourceId === selectedNodeId) s.add(rel.targetId);
      if (rel.targetId === selectedNodeId) s.add(rel.sourceId);
    }
    return s;
  }, [selectedNodeId, graph]);

  // Build node + link lists; embed selection flags so ForceGraph3D recreates
  // Three.js node objects (and thus labels) when selection changes.
  const graphData = useMemo(() => {
    if (!graph) return { nodes: [], links: [] };
    return {
      nodes: graph.nodes
        .filter(n => n.label !== 'Community' && n.label !== 'Process')
        .map(n => ({
          id: n.id,
          name: n.properties.name,
          baseColor: NODE_COLORS[n.label as NodeLabel] || '#9ca3af',
          val: (NODE_SIZES[n.label as NodeLabel] || 4) / 2,
          // Selection flags baked in so object reference changes on selection change
          _selected: n.id === selectedNodeId,
          _neighbour: neighborIds.has(n.id),
        })),
      links: graph.relationships
        .filter(r => r.type !== 'MEMBER_OF')
        .map(r => ({
          source: r.sourceId,
          target: r.targetId,
          baseColor: EDGE_INFO[r.type as EdgeType]?.color || '#4a4a5a',
        })),
    };
  }, [graph, selectedNodeId, neighborIds]);

  // --- node colour: mirrors 2D nodeReducer ---
  const getNodeColor = useCallback((node: any) => {
    // AI highlight layers take priority
    if (blastRadiusNodeIds.has(node.id)) return '#ef4444';
    if (highlightedNodeIds.has(node.id)) return '#dc2626';

    if (selectedNodeId) {
      if (node.id === selectedNodeId) return node.baseColor;           // selected: full colour
      if (neighborIds.has(node.id))   return node.baseColor;           // neighbour: full colour
      return dimColor(node.baseColor, 0.25, isDark);                   // rest: dimmed
    }
    return node.baseColor;
  }, [highlightedNodeIds, blastRadiusNodeIds, selectedNodeId, neighborIds, isDark]);

  // --- node size: mirrors 2D size multipliers ---
  const getNodeVal = useCallback((node: any) => {
    if (selectedNodeId) {
      if (node.id === selectedNodeId) return node.val * 1.8;
      if (neighborIds.has(node.id))   return node.val * 1.3;
      return node.val * 0.6;
    }
    return node.val;
  }, [selectedNodeId, neighborIds]);

  // --- link colour: mirrors 2D edgeReducer ---
  const getLinkColor = useCallback((link: any) => {
    if (selectedNodeId) {
      const src = linkEndId(link.source);
      const tgt = linkEndId(link.target);
      const isConnected = src === selectedNodeId || tgt === selectedNodeId;
      return isConnected
        ? brightenColor(link.baseColor, 1.5)
        : dimColor(link.baseColor, 0.1, isDark);
    }
    return link.baseColor;
  }, [selectedNodeId, isDark]);

  // --- link width: thick for connected edges, thin for rest ---
  const getLinkWidth = useCallback((link: any) => {
    if (selectedNodeId) {
      const src = linkEndId(link.source);
      const tgt = linkEndId(link.target);
      return (src === selectedNodeId || tgt === selectedNodeId) ? 2 : 0.15;
    }
    return 0.5;
  }, [selectedNodeId]);

  // --- node labels: shown on selected + neighbours, mirrors 2D hover tooltip ---
  // Reads _selected/_neighbour from the node object (baked into graphData) so
  // ForceGraph3D recreates this object whenever selection changes.
  const getNodeThreeObject = useCallback((node: any) => {
    if (!node._selected && !node._neighbour) return null;

    const sprite = new SpriteText(node.name);
    sprite.textHeight = node._selected ? 3.5 : 2.5;
    sprite.color = isDark ? '#e4e4ed' : '#0f0f1a';
    sprite.backgroundColor = isDark ? 'rgba(26,26,26,0.90)' : 'rgba(255,255,255,0.90)';
    sprite.padding = 1.5;
    sprite.borderRadius = 2;
    if (node._selected) {
      sprite.borderColor = node.baseColor || '#dc2626';
      sprite.borderWidth = 0.4;
    }
    // Position above the sphere — offset proportional to node val
    sprite.position.y = Math.sqrt(node.val) * 4 + 8;
    return sprite;
  }, [isDark]);

  // --- click handlers ---
  const handleNodeClick = useCallback((node: any) => {
    if (!graph) return;
    const graphNode = graph.nodes.find(n => n.id === node.id);
    if (graphNode) {
      setSelectedNodeId(node.id);
      setSelectedNode(graphNode);
      openCodePanel();
    }
  }, [graph, setSelectedNode, openCodePanel]);

  const handleBackgroundClick = useCallback(() => {
    setSelectedNodeId(null);
    setSelectedNode(null);
  }, [setSelectedNode]);

  return (
    <div className="w-full h-full">
      <ForceGraph3D
        graphData={graphData}
        nodeLabel="name"
        nodeColor={getNodeColor}
        nodeVal={getNodeVal}
        linkColor={getLinkColor}
        linkWidth={getLinkWidth}
        linkOpacity={0.6}
        backgroundColor={isDark ? '#0f0f0f' : '#fafafa'}
        onNodeClick={handleNodeClick}
        onBackgroundClick={handleBackgroundClick}
        nodeThreeObject={getNodeThreeObject}
        nodeThreeObjectExtend={true}
        nodeResolution={8}
        warmupTicks={100}
        cooldownTicks={0}
      />
    </div>
  );
};
