import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import Graph from 'graphology';
import { ArcballControls } from 'three/examples/jsm/controls/ArcballControls.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  forceZ,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force-3d';
import { SigmaEdgeAttributes, SigmaNodeAttributes } from '../lib/graph-adapter';
import { GRAPH_SURFACE_COLORS, type EdgeType } from '../lib/constants';
import {
  brightenColor,
  mixColor,
  resolveGraphEdgeVisual,
  resolveGraphNodeVisual,
} from '../lib/graph-visual-state';
import type { NodeAnimation } from './useAppState';

export type ThreeGraphCameraMode = 'arcball' | 'firstPerson';

interface UseThreeGraphOptions {
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  onStageClick?: () => void;
  highlightedNodeIds?: Set<string>;
  blastRadiusNodeIds?: Set<string>;
  animatedNodes?: Map<string, NodeAnimation>;
  visibleEdgeTypes?: EdgeType[];
}

interface UseThreeGraphReturn {
  containerRef: React.RefObject<HTMLDivElement>;
  setGraph: (
    graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
    options?: ThreeSetGraphOptions,
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
  cameraMode: ThreeGraphCameraMode;
  setCameraMode: (mode: ThreeGraphCameraMode) => void;
}

interface ThreeSetGraphOptions {
  runLayout?: boolean;
  resetCamera?: boolean;
  clearSelection?: boolean;
  preservePositions?: boolean;
}

type ArcballWithTarget = ArcballControls & { target: THREE.Vector3 };

interface Graph3DNode extends SimulationNodeDatum {
  id: string;
  attributes: SigmaNodeAttributes;
}

interface Graph3DLink extends SimulationLinkDatum<Graph3DNode> {
  id: string;
  sourceId: string;
  targetId: string;
  attributes: SigmaEdgeAttributes;
  curveVector: THREE.Vector3;
  curveMultiplier: number;
}

type NodeVisual = {
  visible: boolean;
  color: string;
  scale: number;
  haloScale: number;
  shellScale: number;
  shellColor: string;
};

const BACKGROUND_COLOR = GRAPH_SURFACE_COLORS.background;
const EDGE_CURVE_SEGMENTS = 5;
const WHITE_COLOR = new THREE.Color('#ffffff');
const SCRATCH_SOURCE = new THREE.Vector3();
const SCRATCH_TARGET = new THREE.Vector3();
const SCRATCH_MID = new THREE.Vector3();
const SCRATCH_DIRECTION = new THREE.Vector3();
const SCRATCH_BEND = new THREE.Vector3();
const SCRATCH_CONTROL = new THREE.Vector3();
const SCRATCH_POINT_A = new THREE.Vector3();
const SCRATCH_POINT_B = new THREE.Vector3();

const createRadialTexture = (stops: Array<[number, string]>): THREE.CanvasTexture => {
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');

  if (context) {
    const radius = size / 2;
    const gradient = context.createRadialGradient(radius, radius, 0, radius, radius, radius);
    stops.forEach(([offset, color]) => gradient.addColorStop(offset, color));
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
};

const disposeMaterial = (material: THREE.Material | THREE.Material[]): void => {
  const materials = Array.isArray(material) ? material : [material];
  materials.forEach((item) => {
    Object.values(item).forEach((value) => {
      if (value && typeof value === 'object' && 'isTexture' in value) {
        (value as THREE.Texture).dispose();
      }
    });
    item.dispose();
  });
};

const hashToUnit = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
};

const getRelationCurveMultiplier = (relationType?: string): number => {
  if (relationType === 'CONTAINS' || relationType === 'DEFINES') return 0.085;
  if (relationType === 'CALLS') return 0.24;
  if (relationType === 'IMPORTS') return 0.18;
  if (relationType === 'EXTENDS' || relationType === 'IMPLEMENTS') return 0.2;
  return 0.15;
};

const setQuadraticPoint = (
  target: THREE.Vector3,
  source: THREE.Vector3,
  control: THREE.Vector3,
  end: THREE.Vector3,
  t: number,
): THREE.Vector3 => {
  const inverse = 1 - t;
  const sourceWeight = inverse * inverse;
  const controlWeight = 2 * inverse * t;
  const endWeight = t * t;

  target.set(
    source.x * sourceWeight + control.x * controlWeight + end.x * endWeight,
    source.y * sourceWeight + control.y * controlWeight + end.y * endWeight,
    source.z * sourceWeight + control.z * controlWeight + end.z * endWeight,
  );

  return target;
};

const getNodeGeometrySegments = (nodeCount: number): number => {
  if (nodeCount > 5000) return 10;
  if (nodeCount > 1500) return 12;
  return 16;
};

const getLayoutAlphaDecay = (nodeCount: number): number => {
  if (nodeCount > 10000) return 0.003;
  if (nodeCount > 5000) return 0.0038;
  if (nodeCount > 2000) return 0.005;
  if (nodeCount > 1000) return 0.0065;
  if (nodeCount > 500) return 0.009;
  return 0.012;
};

const getNodePosition = (node: Graph3DNode): THREE.Vector3 => {
  return new THREE.Vector3(node.x || 0, node.y || 0, node.z || 0);
};

const resolveLinkNode = (value: string | number | Graph3DNode): Graph3DNode | null => {
  return typeof value === 'object' && value !== null && 'id' in value ? value : null;
};

const getCameraTarget = (
  nodes: Graph3DNode[],
  fallback = new THREE.Vector3(),
): { center: THREE.Vector3; radius: number } => {
  if (nodes.length === 0) return { center: fallback, radius: 100 };

  const box = new THREE.Box3();
  for (const node of nodes) {
    const attrs = node.attributes;
    if (attrs.hidden) continue;
    box.expandByPoint(getNodePosition(node));
  }

  if (box.isEmpty()) {
    for (const node of nodes) box.expandByPoint(getNodePosition(node));
  }

  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);

  return {
    center: sphere.center.lengthSq() > 0 ? sphere.center : fallback,
    radius: Math.max(80, sphere.radius || 100),
  };
};

export const useThreeGraph = (options: UseThreeGraphOptions = {}): UseThreeGraphReturn => {
  const containerRef = useRef<HTMLDivElement>(null!);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const arcballRef = useRef<ArcballWithTarget | null>(null);
  const pointerLockRef = useRef<PointerLockControls | null>(null);
  const nodeMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const haloMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const shellMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const sparkPointsRef = useRef<THREE.Points | null>(null);
  const edgeLinesRef = useRef<THREE.LineSegments | null>(null);
  const graphRef = useRef<Graph<SigmaNodeAttributes, SigmaEdgeAttributes> | null>(null);
  const nodesRef = useRef<Graph3DNode[]>([]);
  const nodeIndexRef = useRef<Map<string, Graph3DNode>>(new Map());
  const linksRef = useRef<Graph3DLink[]>([]);
  const simulationRef = useRef<Simulation<Graph3DNode, Graph3DLink> | null>(null);
  const selectedNodeRef = useRef<string | null>(null);
  const hoveredNodeRef = useRef<string | null>(null);
  const highlightedRef = useRef<Set<string>>(new Set());
  const blastRadiusRef = useRef<Set<string>>(new Set());
  const animatedNodesRef = useRef<Map<string, NodeAnimation>>(new Map());
  const visibleEdgeTypesRef = useRef<EdgeType[] | null>(null);
  const cameraModeRef = useRef<ThreeGraphCameraMode>('arcball');
  const optionsRef = useRef(options);
  const keyStateRef = useRef<Set<string>>(new Set());
  const animationFrameRef = useRef<number | null>(null);
  const edgePositionsRef = useRef<Float32Array | null>(null);
  const edgeColorsRef = useRef<Float32Array | null>(null);
  const sparkPositionsRef = useRef<Float32Array | null>(null);
  const sparkColorsRef = useRef<Float32Array | null>(null);
  const lastTimeRef = useRef(performance.now());

  const [selectedNode, setSelectedNodeState] = useState<string | null>(null);
  const [isLayoutRunning, setIsLayoutRunning] = useState(false);
  const [cameraMode, setCameraModeState] = useState<ThreeGraphCameraMode>('arcball');

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const setSelectedNode = useCallback((nodeId: string | null) => {
    selectedNodeRef.current = nodeId;
    setSelectedNodeState(nodeId);
  }, []);

  const createNodeVisual = useCallback(
    (
      color: string,
      scale: number,
      emphasis = 0.35,
      shell = false,
      shellColor = color,
    ): NodeVisual => {
      const lift = 0.06 + Math.max(0, Math.min(1, emphasis)) * 0.18;
      const displayColor = mixColor(color, '#f8fbff', lift);

      return {
        visible: true,
        color: displayColor,
        scale,
        haloScale: scale * (1.72 + emphasis * 1.28),
        shellScale: shell ? scale * (2.12 + emphasis * 0.5) : 0,
        shellColor: mixColor(shellColor, '#ffffff', 0.18),
      };
    },
    [],
  );

  const getNodeVisual = useCallback(
    (nodeId: string, attributes: SigmaNodeAttributes, now: number): NodeVisual => {
      if (attributes.hidden) {
        return {
          visible: false,
          color: attributes.color,
          scale: 0,
          haloScale: 0,
          shellScale: 0,
          shellColor: attributes.color,
        };
      }

      const graph = graphRef.current;
      const currentSelected = selectedNodeRef.current;
      const currentHovered = hoveredNodeRef.current;
      const baseSize = Math.max(2.4, (attributes.size || 4) * 1.9);
      const visual = resolveGraphNodeVisual({
        nodeId,
        color: attributes.color,
        size: baseSize,
        selectedNodeId: currentSelected,
        hoveredNodeId: currentHovered,
        highlightedNodeIds: highlightedRef.current,
        blastRadiusNodeIds: blastRadiusRef.current,
        animatedNodes: animatedNodesRef.current,
        isNeighbor: currentSelected
          ? Boolean(
              graph?.hasEdge(nodeId, currentSelected) || graph?.hasEdge(currentSelected, nodeId),
            )
          : false,
        now,
      });

      return createNodeVisual(
        visual.color,
        visual.size,
        visual.emphasis,
        visual.shell,
        visual.shellColor,
      );
    },
    [createNodeVisual],
  );

  const updateSceneObjects = useCallback(() => {
    const nodeMesh = nodeMeshRef.current;
    const haloMesh = haloMeshRef.current;
    const shellMesh = shellMeshRef.current;
    const sparkPoints = sparkPointsRef.current;
    const edgeLines = edgeLinesRef.current;
    const graph = graphRef.current;
    if (!nodeMesh || !haloMesh || !shellMesh || !sparkPoints || !edgeLines || !graph) return;

    const now = Date.now();
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    const edgeHighlightColor = new THREE.Color();
    const nodes = nodesRef.current;
    const billboardQuaternion = cameraRef.current?.quaternion || new THREE.Quaternion();
    const sparkPositionAttr = sparkPoints.geometry.getAttribute(
      'position',
    ) as THREE.BufferAttribute;
    const sparkColorAttr = sparkPoints.geometry.getAttribute('color') as THREE.BufferAttribute;
    const sparkPositions = sparkPositionsRef.current;
    const sparkColors = sparkColorsRef.current;

    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      const visual = getNodeVisual(node.id, node.attributes, now);
      const x = node.x || 0;
      const y = node.y || 0;
      const z = node.z || 0;
      matrix.compose(
        new THREE.Vector3(x, y, z),
        billboardQuaternion,
        new THREE.Vector3(visual.scale, visual.scale, visual.scale),
      );
      nodeMesh.setMatrixAt(i, matrix);
      color.set(visual.color);
      nodeMesh.setColorAt(i, color);

      matrix.compose(
        new THREE.Vector3(node.x || 0, node.y || 0, node.z || 0),
        billboardQuaternion,
        new THREE.Vector3(visual.haloScale, visual.haloScale, visual.haloScale),
      );
      haloMesh.setMatrixAt(i, matrix);
      color.set(brightenColor(visual.color, 1.45));
      haloMesh.setColorAt(i, color);

      matrix.compose(
        new THREE.Vector3(x, y, z),
        billboardQuaternion,
        new THREE.Vector3(visual.shellScale, visual.shellScale, visual.shellScale),
      );
      shellMesh.setMatrixAt(i, matrix);
      color.set(visual.shellColor);
      shellMesh.setColorAt(i, color);

      if (sparkPositions && sparkColors) {
        const sparkBase = i * 3;
        sparkPositions[sparkBase] = x;
        sparkPositions[sparkBase + 1] = y;
        sparkPositions[sparkBase + 2] = z;
        color.set(visual.visible ? mixColor(visual.color, '#ffffff', 0.18) : '#000000');
        sparkColors[sparkBase] = color.r;
        sparkColors[sparkBase + 1] = color.g;
        sparkColors[sparkBase + 2] = color.b;
      }
    }
    nodeMesh.instanceMatrix.needsUpdate = true;
    if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
    haloMesh.instanceMatrix.needsUpdate = true;
    if (haloMesh.instanceColor) haloMesh.instanceColor.needsUpdate = true;
    shellMesh.instanceMatrix.needsUpdate = true;
    if (shellMesh.instanceColor) shellMesh.instanceColor.needsUpdate = true;
    if (sparkPositions && sparkColors) {
      sparkPositionAttr.needsUpdate = true;
      sparkColorAttr.needsUpdate = true;
    }

    const positionAttr = edgeLines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colorAttr = edgeLines.geometry.getAttribute('color') as THREE.BufferAttribute;
    const positions = edgePositionsRef.current;
    const colors = edgeColorsRef.current;
    if (!positions || !colors) return;

    const visibleTypes = visibleEdgeTypesRef.current;
    const highlighted = highlightedRef.current;
    const blastRadius = blastRadiusRef.current;
    const currentSelected = selectedNodeRef.current;

    for (let i = 0; i < linksRef.current.length; i += 1) {
      const link = linksRef.current[i];
      const source = resolveLinkNode(link.source);
      const target = resolveLinkNode(link.target);
      const sourceAttrs = source ? source.attributes : null;
      const targetAttrs = target ? target.attributes : null;
      const base = i * EDGE_CURVE_SEGMENTS * 6;
      const edgeSpan = EDGE_CURVE_SEGMENTS * 6;
      const hiddenByType =
        visibleTypes && link.attributes.relationType
          ? !visibleTypes.includes(link.attributes.relationType as EdgeType)
          : false;
      const isVisible =
        Boolean(source && target && sourceAttrs && targetAttrs) &&
        !sourceAttrs?.hidden &&
        !targetAttrs?.hidden &&
        !hiddenByType;

      if (!isVisible || !source || !target) {
        positions.fill(0, base, base + edgeSpan);
        colors.fill(0, base, base + edgeSpan);
        continue;
      }

      const edgeVisual = resolveGraphEdgeVisual({
        sourceId: link.sourceId,
        targetId: link.targetId,
        color: link.attributes.color || GRAPH_SURFACE_COLORS.fallbackEdge,
        size: link.attributes.size || 1,
        selectedNodeId: currentSelected,
        highlightedNodeIds: highlighted,
        blastRadiusNodeIds: blastRadius,
      });
      const edgeColor = edgeVisual.color;

      color.set(edgeColor);
      edgeHighlightColor.copy(color).lerp(WHITE_COLOR, 0.34);

      SCRATCH_SOURCE.set(source.x || 0, source.y || 0, source.z || 0);
      SCRATCH_TARGET.set(target.x || 0, target.y || 0, target.z || 0);
      SCRATCH_MID.copy(SCRATCH_SOURCE).add(SCRATCH_TARGET).multiplyScalar(0.5);
      SCRATCH_DIRECTION.copy(SCRATCH_TARGET).sub(SCRATCH_SOURCE);
      const distance = Math.max(1, SCRATCH_DIRECTION.length());
      SCRATCH_DIRECTION.divideScalar(distance);

      SCRATCH_BEND.copy(link.curveVector);
      SCRATCH_BEND.addScaledVector(SCRATCH_DIRECTION, -SCRATCH_BEND.dot(SCRATCH_DIRECTION));
      if (SCRATCH_BEND.lengthSq() < 0.0001) {
        SCRATCH_BEND.set(0, 1, 0).addScaledVector(SCRATCH_DIRECTION, -SCRATCH_DIRECTION.y);
      }
      SCRATCH_BEND.normalize();

      const arcHeight = Math.min(125, Math.max(10, distance * link.curveMultiplier));
      SCRATCH_CONTROL.copy(SCRATCH_MID).addScaledVector(SCRATCH_BEND, arcHeight);

      for (let segment = 0; segment < EDGE_CURVE_SEGMENTS; segment += 1) {
        const startT = segment / EDGE_CURVE_SEGMENTS;
        const endT = (segment + 1) / EDGE_CURVE_SEGMENTS;
        setQuadraticPoint(SCRATCH_POINT_A, SCRATCH_SOURCE, SCRATCH_CONTROL, SCRATCH_TARGET, startT);
        setQuadraticPoint(SCRATCH_POINT_B, SCRATCH_SOURCE, SCRATCH_CONTROL, SCRATCH_TARGET, endT);

        const segmentBase = base + segment * 6;
        positions[segmentBase] = SCRATCH_POINT_A.x;
        positions[segmentBase + 1] = SCRATCH_POINT_A.y;
        positions[segmentBase + 2] = SCRATCH_POINT_A.z;
        positions[segmentBase + 3] = SCRATCH_POINT_B.x;
        positions[segmentBase + 4] = SCRATCH_POINT_B.y;
        positions[segmentBase + 5] = SCRATCH_POINT_B.z;

        const distanceFromMiddle = Math.abs((segment + 0.5) / EDGE_CURVE_SEGMENTS - 0.5) * 2;
        const segmentColor = distanceFromMiddle < 0.42 ? edgeHighlightColor : color;
        colors[segmentBase] = segmentColor.r;
        colors[segmentBase + 1] = segmentColor.g;
        colors[segmentBase + 2] = segmentColor.b;
        colors[segmentBase + 3] = segmentColor.r;
        colors[segmentBase + 4] = segmentColor.g;
        colors[segmentBase + 5] = segmentColor.b;
      }
    }

    positionAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
  }, [getNodeVisual]);

  const frameNodes = useCallback((targetNodeId?: string) => {
    const camera = cameraRef.current;
    const arcball = arcballRef.current;
    if (!camera || !arcball) return;

    const targetNode = targetNodeId ? nodeIndexRef.current.get(targetNodeId) : null;
    const target = targetNode
      ? {
          center: getNodePosition(targetNode),
          radius: Math.max(80, (targetNode.attributes.size || 4) * 26),
        }
      : getCameraTarget(nodesRef.current);

    const distance = Math.max(target.radius * (nodesRef.current.length > 5000 ? 1.22 : 1.55), 140);
    const destination = new THREE.Vector3(
      target.center.x + distance * 0.62,
      target.center.y + distance * 0.32,
      target.center.z + distance * 0.72,
    );

    camera.position.copy(destination);
    camera.near = Math.max(0.1, target.radius / 120);
    camera.far = Math.max(5000, target.radius * 18);
    camera.lookAt(target.center);
    camera.updateProjectionMatrix();

    arcball.target.copy(target.center);
    arcball.saveState();
    arcball.update();
  }, []);

  const stopLayout = useCallback(() => {
    simulationRef.current?.stop();
    setIsLayoutRunning(false);
  }, []);

  const startLayout = useCallback(() => {
    if (nodesRef.current.length === 0) return;

    simulationRef.current?.stop();

    const nodeCount = nodesRef.current.length;
    const linkDistance = nodeCount > 5000 ? 55 : nodeCount > 1500 ? 70 : 95;
    const chargeStrength = nodeCount > 5000 ? -46 : nodeCount > 1500 ? -68 : -96;

    const linkForce = forceLink<Graph3DNode, Graph3DLink>(linksRef.current)
      .id((node) => node.id)
      .distance((link) => {
        const relationType = link.attributes.relationType;
        if (relationType === 'CONTAINS' || relationType === 'DEFINES') return linkDistance * 0.72;
        if (relationType === 'CALLS') return linkDistance * 1.45;
        return linkDistance;
      })
      .strength((link) => {
        const relationType = link.attributes.relationType;
        if (relationType === 'CONTAINS') return 0.42;
        if (relationType === 'DEFINES') return 0.32;
        if (relationType === 'CALLS') return 0.08;
        return 0.16;
      });

    const simulation = forceSimulation<Graph3DNode>(nodesRef.current, 3)
      .force('link', linkForce)
      .force('charge', forceManyBody<Graph3DNode>().strength(chargeStrength).theta(0.9))
      .force(
        'collide',
        forceCollide<Graph3DNode>((node) => Math.max(4, (node.attributes.size || 4) * 2.3))
          .strength(0.28)
          .iterations(1),
      )
      .force('center', forceCenter<Graph3DNode>(0, 0, 0))
      .force('x', forceX<Graph3DNode>(0).strength(0.012))
      .force('y', forceY<Graph3DNode>(0).strength(0.012))
      .force('z', forceZ<Graph3DNode>(0).strength(0.012))
      .alpha(1)
      .alphaMin(0.001)
      .alphaDecay(getLayoutAlphaDecay(nodeCount))
      .velocityDecay(0.32)
      .on('end', () => setIsLayoutRunning(false));

    simulationRef.current = simulation;
    setIsLayoutRunning(true);
  }, []);

  const disposeSceneObjects = useCallback(() => {
    const scene = sceneRef.current;

    if (nodeMeshRef.current) {
      scene?.remove(nodeMeshRef.current);
      nodeMeshRef.current.geometry.dispose();
      disposeMaterial(nodeMeshRef.current.material);
      nodeMeshRef.current = null;
    }

    if (haloMeshRef.current) {
      scene?.remove(haloMeshRef.current);
      haloMeshRef.current.geometry.dispose();
      disposeMaterial(haloMeshRef.current.material);
      haloMeshRef.current = null;
    }

    if (shellMeshRef.current) {
      scene?.remove(shellMeshRef.current);
      shellMeshRef.current.geometry.dispose();
      disposeMaterial(shellMeshRef.current.material);
      shellMeshRef.current = null;
    }

    if (sparkPointsRef.current) {
      scene?.remove(sparkPointsRef.current);
      sparkPointsRef.current.geometry.dispose();
      disposeMaterial(sparkPointsRef.current.material);
      sparkPointsRef.current = null;
      sparkPositionsRef.current = null;
      sparkColorsRef.current = null;
    }

    if (edgeLinesRef.current) {
      scene?.remove(edgeLinesRef.current);
      edgeLinesRef.current.geometry.dispose();
      disposeMaterial(edgeLinesRef.current.material);
      edgeLinesRef.current = null;
    }
  }, []);

  const setGraph = useCallback(
    (
      graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
      options: ThreeSetGraphOptions = {},
    ) => {
      const scene = sceneRef.current;
      if (!scene) return;

      const shouldRunLayout = options.runLayout ?? true;
      const shouldResetCamera = options.resetCamera ?? true;
      const shouldClearSelection = options.clearSelection ?? false;
      const shouldPreservePositions = options.preservePositions ?? false;
      const previousPositions = new Map<string, { x?: number; y?: number; z?: number }>();

      if (shouldPreservePositions) {
        nodesRef.current.forEach((node) => {
          previousPositions.set(node.id, { x: node.x, y: node.y, z: node.z });
        });
      }

      stopLayout();
      disposeSceneObjects();
      graphRef.current = graph;
      if (shouldClearSelection) {
        setSelectedNode(null);
      }

      const nodeCount = Math.max(1, graph.order);
      const zSpread = Math.sqrt(nodeCount) * 48;
      const nodes: Graph3DNode[] = [];
      const nodeIndex = new Map<string, Graph3DNode>();

      graph.forEachNode((nodeId, attributes) => {
        const communityOffset =
          attributes.community === undefined
            ? 0
            : ((attributes.community % 9) - 4) * zSpread * 0.055;
        const previousPosition = previousPositions.get(nodeId);
        const node: Graph3DNode = {
          id: nodeId,
          attributes,
          x: previousPosition?.x ?? attributes.x,
          y: previousPosition?.y ?? attributes.y,
          z:
            previousPosition?.z ??
            attributes.z ??
            (hashToUnit(nodeId) - 0.5) * zSpread + communityOffset,
          vx: 0,
          vy: 0,
          vz: 0,
        };
        nodes.push(node);
        nodeIndex.set(nodeId, node);
      });

      const links: Graph3DLink[] = [];
      graph.forEachEdge((edgeId, attributes, sourceId, targetId) => {
        if (!nodeIndex.has(sourceId) || !nodeIndex.has(targetId)) return;
        const curveVector = new THREE.Vector3(
          hashToUnit(edgeId) - 0.5,
          hashToUnit(`${edgeId}:bend-y`) - 0.5,
          hashToUnit(`${edgeId}:bend-z`) - 0.5,
        );
        if (curveVector.lengthSq() < 0.0001) curveVector.set(0.35, 0.65, 0.2);
        links.push({
          id: edgeId,
          source: sourceId,
          target: targetId,
          sourceId,
          targetId,
          attributes,
          curveVector,
          curveMultiplier: getRelationCurveMultiplier(attributes.relationType),
        });
      });

      nodesRef.current = nodes;
      nodeIndexRef.current = nodeIndex;
      linksRef.current = links;

      const nodeSegments = getNodeGeometrySegments(nodes.length);
      const nodeGeometry = new THREE.CircleGeometry(1, nodeSegments);
      const haloGeometry = new THREE.CircleGeometry(1, Math.max(20, nodeSegments * 2));
      const shellGeometry = new THREE.RingGeometry(0.78, 1, Math.max(28, nodeSegments * 3));
      const nodeTexture = createRadialTexture([
        [0, '#ffffff'],
        [0.5, '#ffffff'],
        [0.78, '#d7f7ff'],
        [1, '#151827'],
      ]);
      const haloTexture = createRadialTexture([
        [0, '#ffffff'],
        [0.3, '#9be7ff'],
        [0.72, '#172033'],
        [1, '#000000'],
      ]);
      const sparkTexture = createRadialTexture([
        [0, 'rgba(255,255,255,1)'],
        [0.5, 'rgba(255,255,255,0.96)'],
        [0.82, 'rgba(255,255,255,0.36)'],
        [1, 'rgba(255,255,255,0)'],
      ]);
      const haloMaterial = new THREE.MeshBasicMaterial({
        color: '#ffffff',
        alphaMap: haloTexture,
        vertexColors: true,
        transparent: true,
        opacity: 0.62,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const haloMesh = new THREE.InstancedMesh(haloGeometry, haloMaterial, nodes.length);
      haloMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      haloMesh.frustumCulled = false;
      haloMesh.renderOrder = 1;
      scene.add(haloMesh);
      haloMeshRef.current = haloMesh;

      const shellMaterial = new THREE.MeshBasicMaterial({
        color: '#ffffff',
        vertexColors: true,
        transparent: true,
        opacity: 0.68,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const shellMesh = new THREE.InstancedMesh(shellGeometry, shellMaterial, nodes.length);
      shellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      shellMesh.frustumCulled = false;
      shellMesh.renderOrder = 3;
      scene.add(shellMesh);
      shellMeshRef.current = shellMesh;

      const nodeMaterial = new THREE.MeshBasicMaterial({
        color: '#ffffff',
        alphaMap: nodeTexture,
        vertexColors: true,
        transparent: true,
        opacity: 0.98,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const nodeMesh = new THREE.InstancedMesh(nodeGeometry, nodeMaterial, nodes.length);
      nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      nodeMesh.frustumCulled = false;
      nodeMesh.renderOrder = 2;
      nodeMesh.userData.kind = 'graph-nodes';
      scene.add(nodeMesh);
      nodeMeshRef.current = nodeMesh;

      const sparkPositions = new Float32Array(Math.max(1, nodes.length * 3));
      const sparkColors = new Float32Array(Math.max(1, nodes.length * 3));
      const sparkGeometry = new THREE.BufferGeometry();
      sparkGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(sparkPositions, 3).setUsage(THREE.DynamicDrawUsage),
      );
      sparkGeometry.setAttribute(
        'color',
        new THREE.BufferAttribute(sparkColors, 3).setUsage(THREE.DynamicDrawUsage),
      );
      const sparkMaterial = new THREE.PointsMaterial({
        size: nodes.length > 5000 ? 5.4 : nodes.length > 1500 ? 6.6 : 8.2,
        sizeAttenuation: false,
        map: sparkTexture,
        vertexColors: true,
        transparent: true,
        opacity: 1,
        alphaTest: 0.02,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      const sparkPoints = new THREE.Points(sparkGeometry, sparkMaterial);
      sparkPoints.frustumCulled = false;
      sparkPoints.renderOrder = 4;
      scene.add(sparkPoints);
      sparkPointsRef.current = sparkPoints;
      sparkPositionsRef.current = sparkPositions;
      sparkColorsRef.current = sparkColors;

      const edgeVertexCount = links.length * EDGE_CURVE_SEGMENTS * 2;
      const edgePositions = new Float32Array(Math.max(1, edgeVertexCount * 3));
      const edgeColors = new Float32Array(Math.max(1, edgeVertexCount * 3));
      const edgeGeometry = new THREE.BufferGeometry();
      edgeGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(edgePositions, 3).setUsage(THREE.DynamicDrawUsage),
      );
      edgeGeometry.setAttribute(
        'color',
        new THREE.BufferAttribute(edgeColors, 3).setUsage(THREE.DynamicDrawUsage),
      );
      edgeGeometry.setDrawRange(0, edgeVertexCount);
      edgeGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1000000);

      const edgeMaterial = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.66,
        blending: THREE.AdditiveBlending,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      });
      const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
      edgeLines.frustumCulled = false;
      scene.add(edgeLines);
      edgeLinesRef.current = edgeLines;
      edgePositionsRef.current = edgePositions;
      edgeColorsRef.current = edgeColors;

      updateSceneObjects();
      if (shouldResetCamera) {
        frameNodes();
      }
      if (shouldRunLayout) {
        startLayout();
      }
    },
    [disposeSceneObjects, frameNodes, setSelectedNode, startLayout, stopLayout, updateSceneObjects],
  );

  const setCameraMode = useCallback((mode: ThreeGraphCameraMode) => {
    const arcball = arcballRef.current;
    const pointerLock = pointerLockRef.current;

    cameraModeRef.current = mode;
    setCameraModeState(mode);

    if (mode === 'firstPerson') {
      if (arcball) arcball.enabled = false;
      pointerLock?.lock();
    } else {
      pointerLock?.unlock();
      if (arcball) {
        arcball.enabled = true;
        arcball.update();
      }
    }
  }, []);

  const focusNode = useCallback(
    (nodeId: string) => {
      if (!nodeIndexRef.current.has(nodeId)) return;
      setSelectedNode(nodeId);
      frameNodes(nodeId);
    },
    [frameNodes, setSelectedNode],
  );

  const zoomToward = useCallback((amount: number) => {
    const camera = cameraRef.current;
    const arcball = arcballRef.current;
    if (!camera || !arcball) return;

    const target = arcball.target;
    const direction = target.clone().sub(camera.position);
    camera.position.add(direction.multiplyScalar(amount));
    camera.lookAt(target);
    arcball.update();
  }, []);

  const zoomIn = useCallback(() => zoomToward(0.18), [zoomToward]);
  const zoomOut = useCallback(() => zoomToward(-0.22), [zoomToward]);

  const resetZoom = useCallback(() => {
    frameNodes();
    setSelectedNode(null);
  }, [frameNodes, setSelectedNode]);

  const refreshHighlights = useCallback(() => {
    updateSceneObjects();
  }, [updateSceneObjects]);

  useEffect(() => {
    highlightedRef.current = options.highlightedNodeIds || new Set();
    blastRadiusRef.current = options.blastRadiusNodeIds || new Set();
    animatedNodesRef.current = options.animatedNodes || new Map();
    visibleEdgeTypesRef.current = options.visibleEdgeTypes || null;
    updateSceneObjects();
  }, [
    options.highlightedNodeIds,
    options.blastRadiusNodeIds,
    options.animatedNodes,
    options.visibleEdgeTypes,
    updateSceneObjects,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BACKGROUND_COLOR);
    scene.fog = new THREE.FogExp2(BACKGROUND_COLOR, 0.00028);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 12000);
    camera.position.set(650, 420, 900);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(BACKGROUND_COLOR, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.domElement.dataset.testid = 'three-graph-canvas';
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.width = '100%';
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    scene.add(new THREE.HemisphereLight('#e0f2fe', '#111827', 1.35));
    const keyLight = new THREE.DirectionalLight('#ffffff', 1.8);
    keyLight.position.set(600, 700, 400);
    scene.add(keyLight);

    const arcball = new ArcballControls(camera, renderer.domElement, scene) as ArcballWithTarget;
    arcball.setGizmosVisible(false);
    arcball.enableAnimations = true;
    arcball.dampingFactor = 18;
    arcball.rotateSpeed = 1.15;
    arcball.cursorZoom = true;
    arcball.target.set(0, 0, 0);
    arcball.saveState();
    arcballRef.current = arcball;

    const pointerLock = new PointerLockControls(camera, renderer.domElement);
    pointerLock.pointerSpeed = 0.75;
    pointerLock.addEventListener('unlock', () => {
      if (cameraModeRef.current === 'firstPerson') {
        cameraModeRef.current = 'arcball';
        setCameraModeState('arcball');
        arcball.enabled = true;
      }
    });
    pointerLockRef.current = pointerLock;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const resize = () => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      arcball.update();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    const pickNode = (event: PointerEvent): string | null => {
      const mesh = nodeMeshRef.current;
      if (!mesh || pointerLock.isLocked) return null;

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const intersections = raycaster.intersectObject(mesh, false);
      for (const intersection of intersections) {
        if (intersection.instanceId === undefined) continue;
        const node = nodesRef.current[intersection.instanceId];
        if (node && !node.attributes.hidden) return node.id;
      }

      return null;
    };

    const handlePointerMove = (event: PointerEvent) => {
      const nodeId = pickNode(event);
      if (hoveredNodeRef.current !== nodeId) {
        hoveredNodeRef.current = nodeId;
        optionsRef.current.onNodeHover?.(nodeId);
        updateSceneObjects();
      }
      container.style.cursor = nodeId
        ? 'pointer'
        : cameraModeRef.current === 'arcball'
          ? 'grab'
          : 'crosshair';
    };

    const handlePointerDown = () => {
      if (cameraModeRef.current === 'arcball') {
        container.style.cursor = 'grabbing';
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      const nodeId = pickNode(event);
      if (nodeId) {
        setSelectedNode(nodeId);
        optionsRef.current.onNodeClick?.(nodeId);
      } else if (!pointerLock.isLocked) {
        setSelectedNode(null);
        hoveredNodeRef.current = null;
        optionsRef.current.onStageClick?.();
      }
      container.style.cursor = nodeId
        ? 'pointer'
        : cameraModeRef.current === 'arcball'
          ? 'grab'
          : 'crosshair';
    };

    const handlePointerLeave = () => {
      if (hoveredNodeRef.current !== null) {
        hoveredNodeRef.current = null;
        optionsRef.current.onNodeHover?.(null);
        updateSceneObjects();
      }
      container.style.cursor = cameraModeRef.current === 'arcball' ? 'grab' : 'crosshair';
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      keyStateRef.current.add(event.code);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      keyStateRef.current.delete(event.code);
    };

    renderer.domElement.addEventListener('pointermove', handlePointerMove);
    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);
    renderer.domElement.addEventListener('pointerleave', handlePointerLeave);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    const animate = (time: number) => {
      animationFrameRef.current = requestAnimationFrame(animate);
      const deltaSeconds = Math.min(0.05, (time - lastTimeRef.current) / 1000);
      lastTimeRef.current = time;

      if (cameraModeRef.current === 'firstPerson' && pointerLock.isLocked) {
        const keys = keyStateRef.current;
        const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 760 : 430;
        const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
        const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
        const lift =
          (keys.has('Space') ? 1 : 0) -
          (keys.has('ControlLeft') || keys.has('ControlRight') ? 1 : 0);

        if (forward !== 0) pointerLock.moveForward(forward * speed * deltaSeconds);
        if (strafe !== 0) pointerLock.moveRight(strafe * speed * deltaSeconds);
        if (lift !== 0) camera.position.y += lift * speed * deltaSeconds;
      } else {
        arcball.update();
      }

      updateSceneObjects();
      renderer.render(scene, camera);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointermove', handlePointerMove);
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      renderer.domElement.removeEventListener('pointerleave', handlePointerLeave);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);

      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }

      simulationRef.current?.stop();
      simulationRef.current = null;
      disposeSceneObjects();
      arcball.dispose();
      pointerLock.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      arcballRef.current = null;
      pointerLockRef.current = null;
    };
  }, [disposeSceneObjects, setSelectedNode, updateSceneObjects]);

  return {
    containerRef,
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
    cameraMode,
    setCameraMode,
  };
};
