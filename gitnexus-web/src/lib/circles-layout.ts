import type { KnowledgeGraph } from '../core/graph/types';
import type { GraphNode, NodeLabel } from 'gitnexus-shared';
import { NODE_SIZES } from './constants';

export interface CirclesNodePosition {
  x: number;
  y: number;
  size: number;
  /** Logical ring index 0 (innermost) … RING_COUNT-1 (outermost) */
  ring: number;
  /** Angle in radians, stored so the physics can use it as an anchor */
  angle: number;
}

// ---------------------------------------------------------------------------
// Configurable constants
// ---------------------------------------------------------------------------

/** Target radius (px) for each ring.  Ring 0 is innermost. */
export const CIRCLES_RING_RADII = [90, 240, 420, 620] as const;

/**
 * Half-width of the allowed radial band around each ring centre.
 * Keep this small enough that adjacent rings never overlap.
 * Current ring gaps: 150 / 180 / 200 px → band = 45 leaves 60-110 px of clear air.
 */
export const CIRCLES_BAND_HALF = 45;

/** Number of rings (= number of layers). */
export const RING_COUNT = CIRCLES_RING_RADII.length; // 4

// ---------------------------------------------------------------------------
// Layer assignment — identical to tree-layout so the same node types
// end up in the same conceptual layer.
// ---------------------------------------------------------------------------

const TYPE_TO_RING: Record<string, number> = {
  // Ring 0 – innermost: structural containers
  Project: 0,
  Package: 0,
  Module: 0,
  Folder: 0,
  Namespace: 0,

  // Ring 1 – files
  File: 1,
  Section: 1,
  Import: 1,
  Route: 1,
  Tool: 1,

  // Ring 2 – type definitions
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

  // Ring 3 – outermost: functions / methods / variables
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

const DEFAULT_RING = 1;

/** Hierarchy edges used for angular-allocation grouping. */
export const CIRCLES_HIERARCHY_RELATIONS = new Set([
  'CONTAINS',
  'DEFINES',
  'HAS_METHOD',
  'HAS_PROPERTY',
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getNodeRing(node: GraphNode): number {
  return TYPE_TO_RING[node.label] ?? DEFAULT_RING;
}

function calculateNodeSize(ring: number, nodeType: NodeLabel): number {
  const baseSize = NODE_SIZES[nodeType] || 6;
  const ringMultiplier = Math.max(0.6, 1 - ring * 0.12);
  return baseSize * ringMultiplier;
}

function deterministicHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
    hash |= 0;
  }
  return (Math.abs(hash) % 10000) / 10000;
}

function buildHierarchyMaps(graph: KnowledgeGraph) {
  const childrenByParent = new Map<string, string[]>();
  const parentsByChild = new Map<string, string[]>();

  for (const rel of graph.relationships) {
    if (!CIRCLES_HIERARCHY_RELATIONS.has(rel.type)) continue;

    if (!childrenByParent.has(rel.sourceId)) childrenByParent.set(rel.sourceId, []);
    childrenByParent.get(rel.sourceId)!.push(rel.targetId);

    if (!parentsByChild.has(rel.targetId)) parentsByChild.set(rel.targetId, []);
    parentsByChild.get(rel.targetId)!.push(rel.sourceId);
  }

  return { childrenByParent, parentsByChild };
}

// ---------------------------------------------------------------------------
// Parent-centred angular allocation
//
// Each parent's children are placed in an arc CENTRED on the parent's own
// angle, with arc size proportional to child count.  This prevents the
// sequential-concatenation bias (where the largest group's arc centre drifts
// to 90° / 270° regardless of where the parent sits) that caused top-bottom
// crowding in the previous sequential allocation.
//
// Overlapping initial arcs are fine — the physics simulation's angular spread
// force resolves them during the simulation.
// ---------------------------------------------------------------------------

function initParentCentredAngles(
  graph: KnowledgeGraph,
  parentsByChild: Map<string, string[]>,
): Map<string, CirclesNodePosition> {
  const positions = new Map<string, CirclesNodePosition>();

  // Group nodes by ring
  const nodesByRing: GraphNode[][] = Array.from({ length: RING_COUNT }, () => []);
  const nodeRingMap = new Map<string, number>();

  for (const node of graph.nodes) {
    const ring = getNodeRing(node);
    if (ring >= 0 && ring < RING_COUNT) {
      nodesByRing[ring].push(node);
      nodeRingMap.set(node.id, ring);
    }
  }

  const TWO_PI = Math.PI * 2;

  // --- Ring 0: sorted alphabetically, evenly spaced around full circle ---
  const ring0Nodes = [...nodesByRing[0]].sort((a, b) =>
    a.properties.name.localeCompare(b.properties.name),
  );

  if (ring0Nodes.length > 0) {
    const count = ring0Nodes.length;
    for (let i = 0; i < count; i++) {
      const node = ring0Nodes[i];
      const angle = (i / count) * TWO_PI;
      const r = CIRCLES_RING_RADII[0];
      positions.set(node.id, {
        x: r * Math.cos(angle),
        y: r * Math.sin(angle),
        size: calculateNodeSize(0, node.label),
        ring: 0,
        angle,
      });
    }
  }

  // --- Rings 1-3: parent-centred arc placement ---
  for (let ring = 1; ring < RING_COUNT; ring++) {
    const ringNodes = nodesByRing[ring];
    if (ringNodes.length === 0) continue;

    const r = CIRCLES_RING_RADII[ring];

    // Find each node's primary parent: placed ancestor with highest ring index
    // (so a Method prefers its Class over a distant Package).
    const assignedParent = new Map<string, string>();
    for (const node of ringNodes) {
      const parents = parentsByChild.get(node.id) ?? [];
      let bestParent: string | null = null;
      let bestParentRing = -1;
      for (const p of parents) {
        if (!positions.has(p)) continue;
        const pRing = nodeRingMap.get(p) ?? -1;
        if (pRing > bestParentRing) {
          bestParentRing = pRing;
          bestParent = p;
        }
      }
      if (bestParent) assignedParent.set(node.id, bestParent);
    }

    // Bucket into parent groups and orphans
    const childrenOfParent = new Map<string, GraphNode[]>();
    const orphans: GraphNode[] = [];

    for (const node of ringNodes) {
      const p = assignedParent.get(node.id);
      if (!p) {
        orphans.push(node);
      } else {
        if (!childrenOfParent.has(p)) childrenOfParent.set(p, []);
        childrenOfParent.get(p)!.push(node);
      }
    }

    for (const children of childrenOfParent.values()) {
      children.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
    }
    orphans.sort((a, b) => a.properties.name.localeCompare(b.properties.name));

    const totalParented = ringNodes.length - orphans.length;
    const parentedFraction = totalParented > 0 ? totalParented / ringNodes.length : 0;

    // Place each parent's children in an arc centred on the parent's angle.
    // Arc size ∝ child count relative to all parented nodes.
    for (const [parentId, children] of childrenOfParent) {
      if (children.length === 0) continue;

      const parentAngle = positions.get(parentId)?.angle ?? 0;
      const slotArc = (children.length / totalParented) * parentedFraction * TWO_PI;
      const startAngle = parentAngle - slotArc / 2;

      for (let i = 0; i < children.length; i++) {
        const angle = startAngle + (i + 0.5) * (slotArc / children.length);
        positions.set(children[i].id, {
          x: r * Math.cos(angle),
          y: r * Math.sin(angle),
          size: calculateNodeSize(ring, children[i].label),
          ring,
          angle,
        });
      }
    }

    // Orphans: spread evenly in their proportional arc, centred at angle = π
    // (left side), away from the 0° / ±π boundary to avoid wrapping artefacts.
    if (orphans.length > 0) {
      const orphanFraction = orphans.length / ringNodes.length;
      const orphanArc = orphanFraction * TWO_PI;
      // Centre orphan arc at π so it doesn't overlap with the typical 0° cluster
      const orphanStart = Math.PI - orphanArc / 2;
      for (let i = 0; i < orphans.length; i++) {
        const angle = orphanStart + (i + 0.5) * (orphanArc / orphans.length);
        positions.set(orphans[i].id, {
          x: r * Math.cos(angle),
          y: r * Math.sin(angle),
          size: calculateNodeSize(ring, orphans[i].label),
          ring,
          angle,
        });
      }
    }
  }

  return positions;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Circles view layout: concentric rings with parent-centred angular allocation.
 *
 * Ring 0 (innermost) = Folders/Packages
 * Ring 1             = Files
 * Ring 2             = Classes/Interfaces
 * Ring 3 (outermost) = Functions/Methods/Variables
 *
 * Returns initial positions; the physics simulation in useSigma.ts refines
 * them using radial gravity + hard band clamping, angular spread, and 2D
 * repulsion — identical in structure to the tree-view physics.
 */
export function calculateCirclesLayout(graph: KnowledgeGraph): Map<string, CirclesNodePosition> {
  const { parentsByChild } = buildHierarchyMaps(graph);

  // 1. Parent-centred angular allocation — no top/bottom bias
  const positions = initParentCentredAngles(graph, parentsByChild);

  // 2. Subtle radial jitter only — angular jitter would fight the centred placement
  for (const [nodeId, pos] of positions) {
    const jitter = (deterministicHash(nodeId + 'r') - 0.5) * 10; // ±10 px
    const r = CIRCLES_RING_RADII[pos.ring] + jitter;
    pos.x = r * Math.cos(pos.angle);
    pos.y = r * Math.sin(pos.angle);
  }

  return positions;
}
