import { useRef, useEffect, useCallback, useState } from 'react';
import {
  Application,
  Entity,
  Color,
  Vec3,
  Quat,
  Mesh,
  MeshInstance,
  StandardMaterial,
  SphereGeometry,
  CylinderGeometry,
  BLEND_NORMAL,
  CameraComponent,
} from 'playcanvas';
import type { Graph3DData } from '../lib/graph-adapter-3d';

/** Hex "#rrggbb" → pc.Color */
const hexToPC = (hex: string): Color => {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return new Color(r, g, b, 1);
};

export interface UsePlayCanvasOptions {
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  onBackgroundClick?: () => void;
  highlightedNodeIds?: Set<string>;
  blastRadiusNodeIds?: Set<string>;
}

export interface UsePlayCanvasReturn {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  setGraphData: (data: Graph3DData) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetCamera: () => void;
  focusNode: (nodeId: string) => void;
  isReady: boolean;
}

// Force layout in 3D — simple spring/repulsion simulation
interface ForceNode {
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  mass: number;
  entity: Entity;
}

const FORCE_ITERATIONS = 120;
const REPULSION = 800;
const SPRING_K = 0.002;
const SPRING_LENGTH = 8;
const DAMPING = 0.85;
const GRAVITY = 0.01;

function runForceLayout(
  forceNodes: Map<string, ForceNode>,
  edges: { sourceId: string; targetId: string }[],
  iterations: number,
) {
  for (let iter = 0; iter < iterations; iter++) {
    const nodes = Array.from(forceNodes.values());

    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
        const force = REPULSION / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        const fz = (dz / dist) * force;
        a.vx += fx / a.mass;
        a.vy += fy / a.mass;
        a.vz += fz / a.mass;
        b.vx -= fx / b.mass;
        b.vy -= fy / b.mass;
        b.vz -= fz / b.mass;
      }
    }

    // Spring attraction along edges
    for (const edge of edges) {
      const a = forceNodes.get(edge.sourceId);
      const b = forceNodes.get(edge.targetId);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
      const disp = dist - SPRING_LENGTH;
      const force = SPRING_K * disp;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      const fz = (dz / dist) * force;
      a.vx += fx;
      a.vy += fy;
      a.vz += fz;
      b.vx -= fx;
      b.vy -= fy;
      b.vz -= fz;
    }

    // Gravity towards center
    for (const n of nodes) {
      n.vx -= n.x * GRAVITY;
      n.vy -= n.y * GRAVITY;
      n.vz -= n.z * GRAVITY;
    }

    // Integrate
    for (const n of nodes) {
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      n.vz *= DAMPING;
      n.x += n.vx;
      n.y += n.vy;
      n.z += n.vz;
    }
  }
}

/** Position a cylinder entity between two 3D points */
function positionCylinder(
  entity: Entity,
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 0.01) return;

  entity.setPosition((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  entity.setLocalScale(1, dist, 1);

  // Rotate from default Y-axis to the a→b direction
  const dir = new Vec3(dx, dy, dz).normalize();
  const up = new Vec3(0, 1, 0);
  const quat = new Quat();
  const cross = new Vec3().cross(up, dir);
  const dot = up.dot(dir);
  if (Math.abs(dot + 1) < 0.0001) {
    quat.set(1, 0, 0, 0);
  } else if (Math.abs(dot - 1) < 0.0001) {
    quat.set(0, 0, 0, 1);
  } else {
    quat.set(cross.x, cross.y, cross.z, 1 + dot).normalize();
  }
  entity.setRotation(quat);
}

export const usePlayCanvas = (options: UsePlayCanvasOptions = {}): UsePlayCanvasReturn => {
  const canvasRef = useRef<HTMLCanvasElement>(null!);
  const appRef = useRef<Application | null>(null);
  const cameraEntityRef = useRef<Entity | null>(null);
  const nodeEntitiesRef = useRef<Map<string, Entity>>(new Map());
  const edgeEntitiesRef = useRef<Entity[]>([]);
  const graphDataRef = useRef<Graph3DData | null>(null);
  const forceNodesRef = useRef<Map<string, ForceNode>>(new Map());
  const highlightedRef = useRef<Set<string>>(new Set());
  const blastRadiusRef = useRef<Set<string>>(new Set());
  const [isReady, setIsReady] = useState(false);

  // Camera orbit state
  const orbitRef = useRef({ yaw: 30, pitch: -20, distance: 80 });
  const targetRef = useRef(new Vec3(0, 0, 0));
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });

  // Update refs from props
  useEffect(() => {
    highlightedRef.current = options.highlightedNodeIds || new Set();
    blastRadiusRef.current = options.blastRadiusNodeIds || new Set();
  }, [options.highlightedNodeIds, options.blastRadiusNodeIds]);

  function updateCameraFromOrbit() {
    const camera = cameraEntityRef.current;
    if (!camera) return;
    const orb = orbitRef.current;
    const yawRad = orb.yaw * Math.PI / 180;
    const pitchRad = orb.pitch * Math.PI / 180;
    const t = targetRef.current;
    const cx = t.x + orb.distance * Math.cos(pitchRad) * Math.sin(yawRad);
    const cy = t.y + orb.distance * Math.sin(pitchRad);
    const cz = t.z + orb.distance * Math.cos(pitchRad) * Math.cos(yawRad);
    camera.setPosition(cx, cy, cz);
    camera.lookAt(t);
  }

  // ---- INIT PlayCanvas ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const app = new Application(canvas, {
      graphicsDeviceOptions: {
        alpha: true,
        antialias: true,
        depth: true,
        preserveDrawingBuffer: false,
      },
    });

    app.start();
    appRef.current = app;

    // Camera
    const camera = new Entity('camera');
    camera.addComponent('camera', {
      clearColor: new Color(0.024, 0.024, 0.039, 1), // #06060a
      fov: 55,
      nearClip: 0.1,
      farClip: 5000,
    });
    app.root.addChild(camera);
    cameraEntityRef.current = camera;

    // Ambient light
    const ambient = new Entity('ambientLight');
    ambient.addComponent('light', {
      type: 'directional',
      color: new Color(0.3, 0.3, 0.4),
      intensity: 0.6,
    });
    ambient.setEulerAngles(45, 30, 0);
    app.root.addChild(ambient);

    // Key light
    const keyLight = new Entity('keyLight');
    keyLight.addComponent('light', {
      type: 'directional',
      color: new Color(0.6, 0.6, 0.8),
      intensity: 0.8,
    });
    keyLight.setEulerAngles(-30, -60, 0);
    app.root.addChild(keyLight);

    // Fill light (from below)
    const fillLight = new Entity('fillLight');
    fillLight.addComponent('light', {
      type: 'directional',
      color: new Color(0.3, 0.2, 0.5),
      intensity: 0.3,
    });
    fillLight.setEulerAngles(60, 120, 0);
    app.root.addChild(fillLight);

    // Resize handler — read from parent since PlayCanvas sets inline styles on the canvas
    const parent = canvas.parentElement;
    const resize = () => {
      const el = parent || canvas;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) {
        app.resizeCanvas(w, h);
      }
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(parent || canvas);

    // Initial camera position
    updateCameraFromOrbit();

    // Mouse controls
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0 || e.button === 2) {
        isDragging.current = true;
        lastMouse.current = { x: e.clientX, y: e.clientY };
      }
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;
      lastMouse.current = { x: e.clientX, y: e.clientY };

      if (e.buttons & 1) {
        // Left drag → orbit
        orbitRef.current.yaw += dx * 0.3;
        orbitRef.current.pitch = Math.max(-89, Math.min(89, orbitRef.current.pitch - dy * 0.3));
      } else if (e.buttons & 2) {
        // Right drag → pan
        const panSpeed = orbitRef.current.distance * 0.002;
        const camRight = new Vec3();
        const camUp = new Vec3();
        camera.getWorldTransform().getX(camRight);
        camera.getWorldTransform().getY(camUp);
        targetRef.current.sub(camRight.mulScalar(dx * panSpeed));
        targetRef.current.add(camUp.mulScalar(dy * panSpeed));
      }
      updateCameraFromOrbit();
    };
    const onMouseUp = () => {
      isDragging.current = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      orbitRef.current.distance *= e.deltaY > 0 ? 1.1 : 0.9;
      orbitRef.current.distance = Math.max(5, Math.min(2000, orbitRef.current.distance));
      updateCameraFromOrbit();
    };
    const onContextMenu = (e: Event) => e.preventDefault();

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);

    // Click → pick node
    canvas.addEventListener('click', (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      let closestId: string | null = null;
      let closestDist = 20; // pixel threshold

      nodeEntitiesRef.current.forEach((entity, nodeId) => {
        const worldPos = entity.getPosition();
        const screenPos = new Vec3();
        (camera.camera as CameraComponent).worldToScreen(worldPos, screenPos);
        const sdx = screenPos.x - mx;
        const sdy = screenPos.y - my;
        const dist = Math.sqrt(sdx * sdx + sdy * sdy);
        if (dist < closestDist) {
          closestDist = dist;
          closestId = nodeId;
        }
      });

      if (closestId) {
        options.onNodeClick?.(closestId);
      } else {
        options.onBackgroundClick?.();
      }
    });

    setIsReady(true);

    return () => {
      resizeObserver.disconnect();
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('mouseleave', onMouseUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      app.destroy();
      appRef.current = null;
      cameraEntityRef.current = null;
    };
  }, []);

  // ---- SET GRAPH DATA ----
  const setGraphData = useCallback((data: Graph3DData) => {
    const app = appRef.current;
    if (!app) return;

    graphDataRef.current = data;

    // Clear old entities
    nodeEntitiesRef.current.forEach(e => e.destroy());
    nodeEntitiesRef.current.clear();
    edgeEntitiesRef.current.forEach(e => e.destroy());
    edgeEntitiesRef.current = [];
    forceNodesRef.current.clear();

    // Shared sphere mesh
    const sphereMesh = Mesh.fromGeometry(
      app.graphicsDevice,
      new SphereGeometry({ radius: 1, latitudeBands: 12, longitudeBands: 12 })
    );

    // Material cache by color
    const materialCache = new Map<string, StandardMaterial>();
    const getMaterial = (hex: string, emissive = false): StandardMaterial => {
      const key = hex + (emissive ? '_e' : '');
      if (materialCache.has(key)) return materialCache.get(key)!;
      const mat = new StandardMaterial();
      const col = hexToPC(hex);
      mat.diffuse = col;
      if (emissive) {
        mat.emissive = new Color(col.r * 0.5, col.g * 0.5, col.b * 0.5);
      }
      mat.update();
      materialCache.set(key, mat);
      return mat;
    };

    const structuralTypes = new Set(['Project', 'Package', 'Module', 'Folder']);

    // Create node entities
    data.nodes.forEach(node => {
      const entity = new Entity(node.id);
      entity.addComponent('render', {
        type: 'asset',
        meshInstances: [new MeshInstance(sphereMesh, getMaterial(node.color, true))],
      });
      const s = Math.max(0.15, node.size);
      entity.setLocalScale(s, s, s);
      entity.setPosition(node.x, node.y, node.z);
      app.root.addChild(entity);
      nodeEntitiesRef.current.set(node.id, entity);

      forceNodesRef.current.set(node.id, {
        id: node.id,
        x: node.x, y: node.y, z: node.z,
        vx: 0, vy: 0, vz: 0,
        mass: structuralTypes.has(node.nodeType) ? 3 : 1,
        entity,
      });
    });

    // Create edge entities (thin cylinders)
    const cylinderMesh = Mesh.fromGeometry(
      app.graphicsDevice,
      new CylinderGeometry({ radius: 0.03, height: 1, capSegments: 4 })
    );

    // Limit edges for performance
    const maxEdges = 10000;
    const edgesToRender = data.edges.length > maxEdges
      ? data.edges.slice(0, maxEdges)
      : data.edges;

    edgesToRender.forEach(edge => {
      const srcNode = data.nodeMap.get(edge.sourceId);
      const dstNode = data.nodeMap.get(edge.targetId);
      if (!srcNode || !dstNode) return;

      const entity = new Entity(`edge_${edge.id}`);
      const edgeMat = getMaterial(edge.color);
      edgeMat.opacity = 0.3;
      edgeMat.blendType = BLEND_NORMAL;
      edgeMat.update();
      entity.addComponent('render', {
        type: 'asset',
        meshInstances: [new MeshInstance(cylinderMesh, edgeMat)],
      });
      app.root.addChild(entity);
      edgeEntitiesRef.current.push(entity);
    });

    // Run force layout
    runForceLayout(forceNodesRef.current, data.edges, FORCE_ITERATIONS);

    // Apply positions after layout
    forceNodesRef.current.forEach(fn => {
      fn.entity.setPosition(fn.x, fn.y, fn.z);
    });

    // Update edge positions
    edgesToRender.forEach((edge, i) => {
      const srcFn = forceNodesRef.current.get(edge.sourceId);
      const dstFn = forceNodesRef.current.get(edge.targetId);
      if (!srcFn || !dstFn) return;
      const edgeEntity = edgeEntitiesRef.current[i];
      if (!edgeEntity) return;
      positionCylinder(edgeEntity, srcFn, dstFn);
    });

    // Fit camera to graph bounds
    if (data.nodes.length > 0) {
      let maxDist = 0;
      forceNodesRef.current.forEach(fn => {
        const d = Math.sqrt(fn.x * fn.x + fn.y * fn.y + fn.z * fn.z);
        if (d > maxDist) maxDist = d;
      });
      orbitRef.current.distance = Math.max(20, maxDist * 2.5);
      targetRef.current.set(0, 0, 0);
      updateCameraFromOrbit();
    }
  }, []);

  const zoomIn = useCallback(() => {
    orbitRef.current.distance *= 0.8;
    orbitRef.current.distance = Math.max(5, orbitRef.current.distance);
    updateCameraFromOrbit();
  }, []);

  const zoomOut = useCallback(() => {
    orbitRef.current.distance *= 1.25;
    orbitRef.current.distance = Math.min(2000, orbitRef.current.distance);
    updateCameraFromOrbit();
  }, []);

  const resetCamera = useCallback(() => {
    orbitRef.current = { yaw: 30, pitch: -20, distance: 80 };
    targetRef.current.set(0, 0, 0);

    if (forceNodesRef.current.size > 0) {
      let maxDist = 0;
      forceNodesRef.current.forEach(fn => {
        const d = Math.sqrt(fn.x * fn.x + fn.y * fn.y + fn.z * fn.z);
        if (d > maxDist) maxDist = d;
      });
      orbitRef.current.distance = Math.max(20, maxDist * 2.5);
    }
    updateCameraFromOrbit();
  }, []);

  const focusNode = useCallback((nodeId: string) => {
    const fn = forceNodesRef.current.get(nodeId);
    if (!fn) return;
    targetRef.current.set(fn.x, fn.y, fn.z);
    orbitRef.current.distance = 15;
    updateCameraFromOrbit();
  }, []);

  return {
    canvasRef,
    setGraphData,
    zoomIn,
    zoomOut,
    resetCamera,
    focusNode,
    isReady,
  };
};
