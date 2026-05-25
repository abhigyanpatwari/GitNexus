import type { KnowledgeGraph } from '../core/graph/types';
import type { GraphNode, NodeLabel } from 'gitnexus-shared';
import { NODE_SIZES } from './constants';

export interface TreeNodePosition {
  x: number;
  y: number;
  size: number;
  depth: number;
}

/**
 * Maps node types to display layers in the tree view.
 * Layer 0 = top (containers), Layer 3 = bottom (functions/methods).
 */
const TYPE_TO_LAYER: Record<string, number> = {
  // Layer 0: Structural containers
  Project: 0,
  Package: 0,
  Module: 0,
  Folder: 0,
  Namespace: 0,

  // Layer 1: Files
  File: 1,
  Section: 1,
  Import: 1,
  Route: 1,
  Tool: 1,

  // Layer 2: Type definitions
  Class: 2,
  Interface: 2,
  Enum: 2,
  Type: 2,
  Struct: 2,
  Trait: 2,
  Union: 2,
  Record: 2,
  Typedef: 2,
  Template: 2,
  TypeAlias: 2,

  // Layer 3: Functions / Methods
  Function: 3,
  Method: 3,
  Impl: 3,
  Delegate: 3,
  Constructor: 3,
  Variable: 3,
  Const: 3,
  Static: 3,
  Property: 3,
  Decorator: 3,
  Annotation: 3,
  Macro: 3,
  CodeElement: 3,
};

/** Fallback layer for unmapped types. */
const DEFAULT_LAYER = 1;

/** Virtual canvas size for layout calculation. */
const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 800;
const LAYER_COUNT = 4;
const LAYER_HEIGHT = CANVAS_HEIGHT / LAYER_COUNT; // 200
const PADDING_X = 60;
const PADDING_Y = 15;
const MIN_NODE_GAP = 45;
const MAX_LAYER_ROW_SPREAD = 132;
// HAS_METHOD and HAS_PROPERTY are Kotlin/Java-style hierarchy edges
// (Class→Method, Class→Property). Treat them like DEFINES for layout purposes
// so Methods/Properties cluster beneath their parent Class horizontally.
const HIERARCHY_RELATIONS = new Set(['CONTAINS', 'DEFINES', 'HAS_METHOD', 'HAS_PROPERTY']);
const MAX_X = (CANVAS_WIDTH - PADDING_X * 2) / 2;

const RELATION_SPRING_WEIGHTS: Record<string, number> = {
  CONTAINS: 0.12,
  DEFINES: 0.16,
  HAS_METHOD: 0.16, // Same as DEFINES — keeps methods near their class
  HAS_PROPERTY: 0.14, // Slightly weaker — properties can spread more
  IMPORTS: 0.2,
  CALLS: 0.24,
  EXTENDS: 0.18,
  IMPLEMENTS: 0.18,
};

function calculateNodeSize(layer: number, nodeType: NodeLabel): number {
  const baseSize = NODE_SIZES[nodeType] || 6;
  const layerMultiplier = Math.max(0.6, 1 - layer * 0.12);
  return baseSize * layerMultiplier;
}

function deterministicHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
    hash |= 0;
  }
  return (Math.abs(hash) % 10000) / 10000;
}

function getNodeLayer(node: GraphNode): number {
  return TYPE_TO_LAYER[node.label] ?? DEFAULT_LAYER;
}

function buildHierarchyMaps(graph: KnowledgeGraph) {
  const childrenByParent = new Map<string, string[]>();
  const parentsByChild = new Map<string, string[]>();

  for (const rel of graph.relationships) {
    if (!HIERARCHY_RELATIONS.has(rel.type)) continue;

    if (!childrenByParent.has(rel.sourceId)) {
      childrenByParent.set(rel.sourceId, []);
    }
    childrenByParent.get(rel.sourceId)!.push(rel.targetId);

    if (!parentsByChild.has(rel.targetId)) {
      parentsByChild.set(rel.targetId, []);
    }
    parentsByChild.get(rel.targetId)!.push(rel.sourceId);
  }

  return { childrenByParent, parentsByChild };
}

function buildLayerNodeIds(graph: KnowledgeGraph): string[][] {
  const nodeIdsByLayer: string[][] = Array.from({ length: LAYER_COUNT }, () => []);

  for (const node of graph.nodes) {
    const layer = getNodeLayer(node);
    if (layer >= 0 && layer < LAYER_COUNT) {
      nodeIdsByLayer[layer].push(node.id);
    }
  }

  return nodeIdsByLayer;
}

function getRestEdgeLength(
  relationType: string,
  source: TreeNodePosition,
  target: TreeNodePosition,
) {
  const depthGap = Math.abs(source.depth - target.depth);
  const baseLength = HIERARCHY_RELATIONS.has(relationType) ? 60 : 85;
  return baseLength + depthGap * 40;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getLayerRowOffsets(nodeCount: number): number[] {
  if (nodeCount <= 4) return [0];

  const rowCount = nodeCount <= 16 ? 2 : 3;
  const totalSpread = rowCount === 2 ? 72 : MAX_LAYER_ROW_SPREAD;
  const rowGap = totalSpread / (rowCount - 1);

  return Array.from({ length: rowCount }, (_, rowIndex) => -totalSpread / 2 + rowIndex * rowGap);
}

function placeNodesInSlice(
  positions: Map<string, TreeNodePosition>,
  nodes: GraphNode[],
  startX: number,
  slotWidth: number,
  layerY: number,
  layer: number,
) {
  const rowOffsets = getLayerRowOffsets(nodes.length);
  const rowCount = rowOffsets.length;
  const baseNodesPerRow = Math.floor(nodes.length / rowCount);
  const remainder = nodes.length % rowCount;

  let cursor = 0;

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const nodesInRow = baseNodesPerRow + (rowIndex < remainder ? 1 : 0);
    if (nodesInRow === 0) continue;

    const rowSpacing = slotWidth / nodesInRow;
    for (let i = 0; i < nodesInRow; i++) {
      const node = nodes[cursor++];
      positions.set(node.id, {
        x: startX + (i + 0.5) * rowSpacing,
        y: layerY + rowOffsets[rowIndex],
        size: calculateNodeSize(layer, node.label),
        depth: layer,
      });
    }
  }
}

function enforceLayerSpacing(
  layerNodeIds: string[],
  positions: Map<string, TreeNodePosition>,
  anchorXByNode: Map<string, number>,
) {
  if (layerNodeIds.length < 2) return;

  const sortedIds = [...layerNodeIds].sort((a, b) => positions.get(a)!.x - positions.get(b)!.x);

  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < sortedIds.length; i++) {
      const prev = positions.get(sortedIds[i - 1])!;
      const curr = positions.get(sortedIds[i])!;
      const minGap = Math.max(MIN_NODE_GAP * 0.65, (prev.size + curr.size) * 1.7);
      const gap = curr.x - prev.x;

      if (gap < minGap) {
        const push = (minGap - gap) / 2;
        prev.x -= push;
        curr.x += push;
      }
    }

    for (let i = sortedIds.length - 2; i >= 0; i--) {
      const curr = positions.get(sortedIds[i])!;
      const next = positions.get(sortedIds[i + 1])!;
      const minGap = Math.max(MIN_NODE_GAP * 0.65, (curr.size + next.size) * 1.7);
      const gap = next.x - curr.x;

      if (gap < minGap) {
        const push = (minGap - gap) / 2;
        curr.x -= push;
        next.x += push;
      }
    }
  }

  const anchorCenter =
    sortedIds.reduce((sum, nodeId) => sum + (anchorXByNode.get(nodeId) ?? 0), 0) / sortedIds.length;
  const currentCenter =
    sortedIds.reduce((sum, nodeId) => sum + positions.get(nodeId)!.x, 0) / sortedIds.length;
  const recenterDelta = currentCenter - anchorCenter;

  for (const nodeId of sortedIds) {
    const pos = positions.get(nodeId)!;
    pos.x = clamp(pos.x - recenterDelta, -MAX_X, MAX_X);
  }
}

/**
 * Initialize positions using proportional X allocation.
 *
 * Each parent in layer N is allocated a horizontal slice proportional to how
 * many direct hierarchy children it has in layer N+1.  Children are then placed
 * evenly within their parent's slice.  Orphan nodes (no placed hierarchy parent)
 * fill a proportional slice at the far right.
 *
 * Why this is better than uniform distribution:
 *   1. Dense parents (many children) get more canvas space  →  no artificial
 *      crowding in the centre even before the physics simulation runs.
 *   2. Each child starts within its parent's X slice  →  parent-child edges are
 *      short by construction, so the spring system converges quickly.
 *   3. Orphan nodes land at the right end; their spring connections pull them
 *      toward better positions at runtime without fighting a spread force.
 */
function initProportionalPositions(
  graph: KnowledgeGraph,
  parentsByChild: Map<string, string[]>,
): Map<string, TreeNodePosition> {
  const positions = new Map<string, TreeNodePosition>();

  // Group nodes by layer and build a fast layer-lookup map.
  const nodesByLayer: GraphNode[][] = Array.from({ length: LAYER_COUNT }, () => []);
  const nodeLayerMap = new Map<string, number>();
  for (const node of graph.nodes) {
    const layer = getNodeLayer(node);
    if (layer >= 0 && layer < LAYER_COUNT) {
      nodesByLayer[layer].push(node);
      nodeLayerMap.set(node.id, layer);
    }
  }

  const availableWidth = CANVAS_WIDTH - PADDING_X * 2;
  const halfWidth = availableWidth / 2;
  const availableHeight = LAYER_HEIGHT - PADDING_Y * 2;

  // Y centre for a given logical layer (layer 0 = top).
  const getLayerY = (layer: number): number => {
    const visualLayer = LAYER_COUNT - 1 - layer;
    return visualLayer * LAYER_HEIGHT + PADDING_Y + availableHeight / 2;
  };

  // --- Layer 0: sorted alphabetically, evenly spaced ---
  const layer0Nodes = [...nodesByLayer[0]].sort((a, b) =>
    a.properties.name.localeCompare(b.properties.name),
  );
  if (layer0Nodes.length > 0) {
    const spacing = availableWidth / layer0Nodes.length;
    for (let i = 0; i < layer0Nodes.length; i++) {
      const node = layer0Nodes[i];
      positions.set(node.id, {
        x: -halfWidth + (i + 0.5) * spacing,
        y: getLayerY(0),
        size: calculateNodeSize(0, node.label),
        depth: 0,
      });
    }
  }

  // --- Layers 1-3: proportional allocation from their parents ---
  for (let layer = 1; layer < LAYER_COUNT; layer++) {
    const layerNodes = nodesByLayer[layer];
    if (layerNodes.length === 0) continue;

    const layerY = getLayerY(layer);

    // For each node, find its "primary parent": the already-placed hierarchy
    // parent with the highest layer index (= closest ancestor in the tree).
    // Walking all parents and picking the deepest-placed one means a Method
    // prefers its Class over a distant Package, for example.
    const assignedParent = new Map<string, string>();
    for (const node of layerNodes) {
      const parents = parentsByChild.get(node.id) ?? [];
      let bestParent: string | null = null;
      let bestParentLayer = -1;
      for (const p of parents) {
        if (!positions.has(p)) continue; // not yet placed
        const pLayer = nodeLayerMap.get(p) ?? -1;
        if (pLayer > bestParentLayer) {
          bestParentLayer = pLayer;
          bestParent = p;
        }
      }
      if (bestParent) assignedParent.set(node.id, bestParent);
    }

    // Bucket nodes into parent groups or orphans.
    const childrenOfParent = new Map<string, GraphNode[]>();
    const orphans: GraphNode[] = [];
    for (const node of layerNodes) {
      const p = assignedParent.get(node.id);
      if (!p) {
        orphans.push(node);
      } else {
        if (!childrenOfParent.has(p)) childrenOfParent.set(p, []);
        childrenOfParent.get(p)!.push(node);
      }
    }

    // Sort within each parent's group and orphans alphabetically.
    for (const children of childrenOfParent.values()) {
      children.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
    }
    orphans.sort((a, b) => a.properties.name.localeCompare(b.properties.name));

    // Sort active parents left-to-right by their placed X position.
    const activeParents = [...childrenOfParent.keys()].sort(
      (a, b) => (positions.get(a)?.x ?? 0) - (positions.get(b)?.x ?? 0),
    );

    const totalParented = layerNodes.length - orphans.length;

    // Divide the full canvas width:
    //   • parented children  →  (totalParented / total) fraction of width
    //   • orphans            →  remaining fraction at the right
    const parentedWidth =
      totalParented > 0 ? availableWidth * (totalParented / layerNodes.length) : 0;
    const orphanWidth = availableWidth - parentedWidth;

    let curX = -halfWidth;

    // Place each parent's children in a sub-slice proportional to child count.
    for (const parentId of activeParents) {
      const children = childrenOfParent.get(parentId) ?? [];
      if (children.length === 0) continue;

      const slotWidth = (children.length / totalParented) * parentedWidth;
      placeNodesInSlice(positions, children, curX, slotWidth, layerY, layer);
      curX += slotWidth;
    }

    // Orphans fill the rightmost slice.
    if (orphans.length > 0 && orphanWidth > 0) {
      placeNodesInSlice(positions, orphans, curX, orphanWidth, layerY, layer);
    }
  }

  // Shift Y so the layout is centred at y = 0.
  const centerY = CANVAS_HEIGHT / 2;
  for (const pos of positions.values()) {
    pos.y -= centerY;
  }

  return positions;
}

/**
 * Tree view layout: type-layered grid with organic jitter and
 * structure-aware horizontal branch shaping.
 */
export function calculateTreeLayout(graph: KnowledgeGraph): Map<string, TreeNodePosition> {
  // Build hierarchy maps before initial placement so initProportionalPositions
  // can assign each node to its closest placed ancestor's X slice.
  const nodeIdsByLayer = buildLayerNodeIds(graph);
  const { childrenByParent, parentsByChild } = buildHierarchyMaps(graph);

  // 1. Start with proportional X allocation: each parent gets a canvas slice
  // proportional to its child count, so dense subtrees never crowd the centre.
  const positions = initProportionalPositions(graph, parentsByChild);

  // 2. Add subtle Y jitter only — X jitter would scramble the hierarchy ordering
  // that initProportionalPositions established (especially bad when node spacing < jitter).
  for (const [nodeId, pos] of positions) {
    pos.y += (deterministicHash(nodeId + 'y') - 0.5) * 20;
  }

  // 3. Use structural edges to create a tree-like horizontal ordering while
  // preserving the type-based vertical layers.
  const STRUCTURE_ITERATIONS = 6;
  for (let iter = 0; iter < STRUCTURE_ITERATIONS; iter++) {
    const childTargets = new Map<string, { sum: number; count: number }>();

    for (const [parentId, children] of childrenByParent) {
      const parentPos = positions.get(parentId);
      if (!parentPos || children.length === 0) continue;

      const childPositions = children
        .map((childId) => ({ childId, pos: positions.get(childId) }))
        .filter(
          (entry): entry is { childId: string; pos: TreeNodePosition } => entry.pos !== undefined,
        )
        .sort((a, b) => a.pos.x - b.pos.x);

      if (childPositions.length === 0) continue;

      const currentCenter =
        childPositions.reduce((sum, entry) => sum + entry.pos.x, 0) / childPositions.length;
      const shift = parentPos.x - currentCenter;

      for (const entry of childPositions) {
        const existing = childTargets.get(entry.childId) || { sum: 0, count: 0 };
        existing.sum += entry.pos.x + shift;
        existing.count += 1;
        childTargets.set(entry.childId, existing);
      }
    }

    for (const [nodeId, target] of childTargets) {
      const pos = positions.get(nodeId);
      if (!pos) continue;
      const avgTargetX = target.sum / target.count;
      pos.x = pos.x * 0.45 + avgTargetX * 0.55;
    }

    const parentTargets = new Map<string, { sum: number; count: number }>();
    for (const [parentId, children] of childrenByParent) {
      const parentPos = positions.get(parentId);
      if (!parentPos || children.length === 0) continue;

      const childXs = children
        .map((childId) => positions.get(childId)?.x)
        .filter((value): value is number => value !== undefined);

      if (childXs.length === 0) continue;

      const avgChildX = childXs.reduce((sum, value) => sum + value, 0) / childXs.length;
      const existing = parentTargets.get(parentId) || { sum: 0, count: 0 };
      existing.sum += avgChildX;
      existing.count += 1;
      parentTargets.set(parentId, existing);
    }

    for (const [nodeId, target] of parentTargets) {
      const pos = positions.get(nodeId);
      if (!pos) continue;
      const avgTargetX = target.sum / target.count;
      pos.x = pos.x * 0.65 + avgTargetX * 0.35;
    }
  }

  // 4. Pull childless nodes slightly toward their hierarchy parents when the
  // graph has enough structure information to form branches.
  for (const [nodeId, parents] of parentsByChild) {
    if (childrenByParent.has(nodeId)) continue;
    const pos = positions.get(nodeId);
    if (!pos || parents.length === 0) continue;

    const parentXs = parents
      .map((parentId) => positions.get(parentId)?.x)
      .filter((value): value is number => value !== undefined);

    if (parentXs.length === 0) continue;

    const avgParentX = parentXs.reduce((sum, value) => sum + value, 0) / parentXs.length;
    pos.x = pos.x * 0.7 + avgParentX * 0.3;
  }

  // 5. Keep a per-node horizontal anchor so long edges can pull nodes closer
  // without destroying each layer's original spread.
  const anchorXByNode = new Map<string, number>();
  for (const [nodeId, pos] of positions) {
    anchorXByNode.set(nodeId, pos.x);
  }

  // 6. Relax the graph like a constrained spring system. Only X is allowed
  // to move, so node types stay on their original Y layers.
  // For large graphs the spring phase is O(N×E×iterations) and would freeze
  // the main thread — scale it down proportionally so the initial proportional
  // layout (already good at large N) is kept without expensive refinement.
  const nodeCount = graph.nodes.length;
  const SPRING_ITERATIONS = nodeCount > 10000 ? 0 : nodeCount > 3000 ? 4 : 14;
  for (let iter = 0; iter < SPRING_ITERATIONS; iter++) {
    const deltaXByNode = new Map<string, number>();

    for (const [nodeId, pos] of positions) {
      const anchorX = anchorXByNode.get(nodeId) ?? pos.x;
      const normalizedDistance = Math.min(1, Math.abs(pos.x) / MAX_X);
      const anchorStrength = 0.05 + normalizedDistance * normalizedDistance * 0.1;
      deltaXByNode.set(nodeId, (anchorX - pos.x) * anchorStrength);
    }

    for (const rel of graph.relationships) {
      const sourcePos = positions.get(rel.sourceId);
      const targetPos = positions.get(rel.targetId);
      if (!sourcePos || !targetPos) continue;

      const dx = targetPos.x - sourcePos.x;
      const dy = targetPos.y - sourcePos.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      const restLength = getRestEdgeLength(rel.type, sourcePos, targetPos);
      const stretch = distance - restLength;

      if (stretch <= 0) continue;

      const springWeight = RELATION_SPRING_WEIGHTS[rel.type] ?? 0.14;
      const pull = stretch * springWeight * 0.08;
      const forceX = (dx / distance) * pull;

      deltaXByNode.set(rel.sourceId, (deltaXByNode.get(rel.sourceId) ?? 0) + forceX);
      deltaXByNode.set(rel.targetId, (deltaXByNode.get(rel.targetId) ?? 0) - forceX);
    }

    for (const [nodeId, pos] of positions) {
      const deltaX = deltaXByNode.get(nodeId) ?? 0;
      const normalizedDistance = Math.min(1, Math.abs(pos.x) / MAX_X);
      const edgeResistance = 1 + normalizedDistance * normalizedDistance * 4.5;
      const maxStep = 18 - normalizedDistance * 6;
      const step = clamp(deltaX / edgeResistance, -maxStep, maxStep);
      pos.x = clamp(pos.x + step, -MAX_X, MAX_X);
    }

    for (const layerNodeIds of nodeIdsByLayer) {
      enforceLayerSpacing(layerNodeIds, positions, anchorXByNode);
    }
  }

  // 7. Recenter and softly clamp X so the layout keeps its breadth without
  // drifting too far off-canvas.
  const xValues = Array.from(positions.values()).map((pos) => pos.x);
  if (xValues.length > 0) {
    const minX = Math.min(...xValues);
    const maxX = Math.max(...xValues);
    const centerX = (minX + maxX) / 2;
    const halfSpan = Math.max(1, (maxX - minX) / 2);
    const scale = halfSpan > MAX_X ? MAX_X / halfSpan : 1;

    for (const pos of positions.values()) {
      pos.x = (pos.x - centerX) * scale;
    }
  }

  return positions;
}
