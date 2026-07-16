/**
 * Community Detection Processor
 *
 * Uses the Leiden algorithm (via graphology-communities-leiden) to detect
 * communities/clusters in the code graph based on CALLS relationships.
 *
 * Communities represent groups of code that work together frequently,
 * helping agents navigate the codebase by functional area rather than file structure.
 */

// NOTE: The Leiden algorithm source is vendored from graphology's repo
// (src/communities-leiden) because it was never published to npm.
// We use createRequire to load the CommonJS vendored files in ESM context.
import Graph from 'graphology';
import type { AbstractGraph, Attributes } from 'graphology-types';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { GraphNode, NodeLabel } from 'gitnexus-shared';
import { KnowledgeGraph } from '../graph/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Navigate to package root (works from both src/ and dist/)
const leidenPath = resolve(__dirname, '..', '..', '..', 'vendor', 'leiden', 'index.cjs');
const _require = createRequire(import.meta.url);
/** Graphology Graph instance type (AbstractGraph from graphology-types avoids CJS/ESM interop namespace issue) */
type GraphInstance = AbstractGraph<Attributes, Attributes, Attributes>;

const leiden: LeidenModule = _require(leidenPath);

/** Vendored Leiden algorithm module shape */
interface LeidenModule {
  detailed: (graph: GraphInstance, options: Record<string, unknown>) => LeidenDetailedResult;
}

/** Result returned by leiden.detailed() */
interface LeidenDetailedResult {
  communities: Record<string, number>;
  count: number;
  modularity: number;
}

type CommunityEngine = 'graphology' | 'icebug';
export type CommunityDetectionEngine = CommunityEngine | 'auto';

export interface CommunityDetectionOptions {
  /**
   * Graphology remains the default. `icebug`/`auto` are guarded prototype
   * paths for #2337 and fall back to Graphology if the optional native module
   * is not available or does not expose the expected API.
   */
  engine?: CommunityDetectionEngine;
  icebug?: {
    threads?: number;
    seed?: number;
    iterations?: number;
    gamma?: number;
    randomize?: boolean;
  };
}

export interface CommunityProjectionNode {
  id: string;
  name: unknown;
  filePath: unknown;
  type: NodeLabel;
}

export interface CommunityProjection {
  nodes: CommunityProjectionNode[];
  edges: Array<readonly [number, number]>;
  symbolCount: number;
  isLarge: boolean;
}

export interface CommunityCsr {
  indptr: BigUint64Array;
  indices: BigUint64Array;
}

interface CommunityEngineResult extends LeidenDetailedResult {
  engine: CommunityEngine;
  engineRequested: CommunityDetectionEngine;
  fallbackReason?: string;
}

interface IcebugWorkerSuccess {
  ok: true;
  partition: number[];
  modularity: number;
}

interface IcebugWorkerFailure {
  ok: false;
  error: string;
}

/**
 * Deterministic PRNG (mulberry32) seed for the vendored Leiden algorithm.
 * Vendored Leiden defaults `rng: Math.random`, which makes community
 * assignment non-deterministic across runs. Passing a seeded RNG gives us
 * reproducible community/modularity output, which is required for the
 * incremental-indexing equivalence test (incremental ≡ full rebuild).
 */
const LEIDEN_SEED = 0xc0de;
function createSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMMUNITY_ENGINE_ENV = 'GITNEXUS_COMMUNITY_ENGINE';
const DEFAULT_COMMUNITY_ENGINE: CommunityEngine = 'graphology';
const LEIDEN_TIMEOUT_MS = 60_000;
const ICEBUG_TIMEOUT_MS = 60_000;
const MIN_CONFIDENCE_LARGE = 0.5;

export const resolveCommunityDetectionEngine = (
  raw = process.env[COMMUNITY_ENGINE_ENV],
): CommunityDetectionEngine => {
  if (raw === undefined || raw.trim() === '') return DEFAULT_COMMUNITY_ENGINE;

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'graphology' || normalized === 'icebug' || normalized === 'auto') {
    return normalized;
  }

  return DEFAULT_COMMUNITY_ENGINE;
};

// ============================================================================
// TYPES
// ============================================================================

export interface CommunityNode {
  id: string;
  label: string;
  heuristicLabel: string;
  cohesion: number;
  symbolCount: number;
}

export interface CommunityMembership {
  nodeId: string;
  communityId: string;
}

export interface CommunityDetectionResult {
  communities: CommunityNode[];
  memberships: CommunityMembership[];
  stats: {
    totalCommunities: number;
    modularity: number;
    nodesProcessed: number;
    engine?: CommunityEngine;
    engineRequested?: CommunityDetectionEngine;
    fallbackReason?: string;
  };
}

// ============================================================================
// COMMUNITY COLORS (for visualization)
// ============================================================================

export const COMMUNITY_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#d946ef', // fuchsia
  '#ec4899', // pink
  '#f43f5e', // rose
  '#14b8a6', // teal
  '#84cc16', // lime
];

export const getCommunityColor = (communityIndex: number): string => {
  return COMMUNITY_COLORS[communityIndex % COMMUNITY_COLORS.length];
};

// ============================================================================
// MAIN PROCESSOR
// ============================================================================

/**
 * Detect communities in the knowledge graph using Leiden algorithm
 *
 * This runs AFTER all relationships (CALLS, IMPORTS, etc.) have been built.
 * It uses primarily CALLS edges to cluster code that works together.
 */
export const processCommunities = async (
  knowledgeGraph: KnowledgeGraph,
  onProgress?: (message: string, progress: number) => void,
  options: CommunityDetectionOptions = {},
): Promise<CommunityDetectionResult> => {
  onProgress?.('Building graph for community detection...', 0);

  const engineRequested = options.engine ?? resolveCommunityDetectionEngine();
  const projection = buildCommunityProjection(knowledgeGraph);
  const graph = buildGraphologyGraph(projection);

  if (graph.order === 0) {
    return {
      communities: [],
      memberships: [],
      stats: {
        totalCommunities: 0,
        modularity: 0,
        nodesProcessed: 0,
        engine: DEFAULT_COMMUNITY_ENGINE,
        engineRequested,
      },
    };
  }

  const nodeCount = graph.order;
  const edgeCount = graph.size;

  onProgress?.(
    `Running Leiden on ${nodeCount} nodes, ${edgeCount} edges${projection.isLarge ? ` (filtered from ${projection.symbolCount} symbols)` : ''}...`,
    30,
  );

  const details = await runCommunityEngine(graph, projection, engineRequested, options, onProgress);

  onProgress?.(`Found ${details.count} communities...`, 60);

  // Step 3: Create community nodes with heuristic labels
  const communityNodes = createCommunityNodes(
    details.communities as Record<string, number>,
    details.count,
    graph,
    knowledgeGraph,
  );

  onProgress?.('Creating membership edges...', 80);

  // Step 4: Create membership mappings
  const memberships: CommunityMembership[] = [];
  Object.entries(details.communities).forEach(([nodeId, communityNum]) => {
    memberships.push({
      nodeId,
      communityId: `comm_${communityNum}`,
    });
  });

  onProgress?.('Community detection complete!', 100);

  return {
    communities: communityNodes,
    memberships,
    stats: {
      totalCommunities: details.count,
      modularity: details.modularity,
      nodesProcessed: graph.order,
      engine: details.engine,
      engineRequested: details.engineRequested,
      fallbackReason: details.fallbackReason,
    },
  };
};

// ============================================================================
// HELPER: Build community projection from knowledge graph
// ============================================================================

/**
 * Build a community projection containing only symbol nodes and clustering edges.
 * For large graphs (>10K symbols), filter out low-confidence fuzzy-global edges
 * and degree-1 nodes that add noise and massively increase Leiden runtime.
 */
export const buildCommunityProjection = (knowledgeGraph: KnowledgeGraph): CommunityProjection => {
  let symbolCount = 0;
  knowledgeGraph.forEachNode((node) => {
    if (isCommunitySymbol(node)) {
      symbolCount++;
    }
  });
  const isLarge = symbolCount > 10_000;

  const connectedNodes = new Set<string>();
  const nodeDegree = new Map<string, number>();

  knowledgeGraph.forEachRelationship((rel) => {
    if (!isClusteringRelationship(rel.type) || rel.sourceId === rel.targetId) return;
    if (isLarge && rel.confidence < MIN_CONFIDENCE_LARGE) return;

    connectedNodes.add(rel.sourceId);
    connectedNodes.add(rel.targetId);
    nodeDegree.set(rel.sourceId, (nodeDegree.get(rel.sourceId) || 0) + 1);
    nodeDegree.set(rel.targetId, (nodeDegree.get(rel.targetId) || 0) + 1);
  });

  const nodes: CommunityProjectionNode[] = [];
  const nodeIndexById = new Map<string, number>();
  const eligibleNodes: GraphNode[] = [];

  knowledgeGraph.forEachNode((node) => {
    if (!isCommunitySymbol(node) || !connectedNodes.has(node.id)) return;
    // For large graphs, skip degree-1 nodes — they just become singletons or
    // get absorbed into their single neighbor's community, but cost iteration time.
    if (isLarge && (nodeDegree.get(node.id) || 0) < 2) return;

    eligibleNodes.push(node);
  });

  eligibleNodes.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  for (const node of eligibleNodes) {
    nodeIndexById.set(node.id, nodes.length);
    nodes.push({
      id: node.id,
      name: node.properties.name,
      filePath: node.properties.filePath,
      type: node.label,
    });
  }

  const seenEdges = new Set<string>();
  const edges: Array<readonly [number, number]> = [];

  knowledgeGraph.forEachRelationship((rel) => {
    if (!isClusteringRelationship(rel.type) || rel.sourceId === rel.targetId) return;
    if (isLarge && rel.confidence < MIN_CONFIDENCE_LARGE) return;

    const sourceIndex = nodeIndexById.get(rel.sourceId);
    const targetIndex = nodeIndexById.get(rel.targetId);
    if (sourceIndex === undefined || targetIndex === undefined || sourceIndex === targetIndex)
      return;

    const [a, b] =
      sourceIndex < targetIndex ? [sourceIndex, targetIndex] : [targetIndex, sourceIndex];
    const edgeKey = `${a}:${b}`;
    if (seenEdges.has(edgeKey)) return;

    seenEdges.add(edgeKey);
    edges.push([a, b]);
  });
  edges.sort(([leftA, leftB], [rightA, rightB]) => leftA - rightA || leftB - rightB);

  return { nodes, edges, symbolCount, isLarge };
};

export const buildCommunityCsr = (projection: CommunityProjection): CommunityCsr => {
  const adjacency = Array.from({ length: projection.nodes.length }, () => new Set<number>());

  for (const [sourceIndex, targetIndex] of projection.edges) {
    adjacency[sourceIndex].add(targetIndex);
    adjacency[targetIndex].add(sourceIndex);
  }

  const edgeTraversalCount = adjacency.reduce((count, neighbors) => count + neighbors.size, 0);
  const indptr = new BigUint64Array(projection.nodes.length + 1);
  const indices = new BigUint64Array(edgeTraversalCount);

  let cursor = 0;
  for (let nodeIndex = 0; nodeIndex < adjacency.length; nodeIndex++) {
    indptr[nodeIndex] = BigInt(cursor);
    const neighbors = [...adjacency[nodeIndex]].sort((a, b) => a - b);
    for (const neighbor of neighbors) {
      indices[cursor++] = BigInt(neighbor);
    }
  }
  indptr[projection.nodes.length] = BigInt(cursor);

  return { indptr, indices };
};

export const buildGraphologyGraph = (projection: CommunityProjection): GraphInstance => {
  const GraphCtor = Graph as unknown as new (options: {
    type: string;
    allowSelfLoops: boolean;
  }) => GraphInstance;
  const graph = new GraphCtor({ type: 'undirected', allowSelfLoops: false });

  for (const node of projection.nodes) {
    graph.addNode(node.id, {
      name: node.name,
      filePath: node.filePath,
      type: node.type,
    });
  }

  for (const [sourceIndex, targetIndex] of projection.edges) {
    graph.addEdge(projection.nodes[sourceIndex].id, projection.nodes[targetIndex].id);
  }

  return graph;
};

const isCommunitySymbol = (node: GraphNode): boolean =>
  node.label === 'Function' ||
  node.label === 'Class' ||
  node.label === 'Method' ||
  node.label === 'Interface';

const isClusteringRelationship = (type: string): boolean =>
  type === 'CALLS' || type === 'EXTENDS' || type === 'IMPLEMENTS';

const runCommunityEngine = async (
  graph: GraphInstance,
  projection: CommunityProjection,
  engineRequested: CommunityDetectionEngine,
  options: CommunityDetectionOptions,
  onProgress?: (message: string, progress: number) => void,
): Promise<CommunityEngineResult> => {
  if (engineRequested === 'graphology') {
    return runGraphologyLeiden(graph, projection.isLarge, engineRequested);
  }

  try {
    return await runIcebugLeiden(projection, engineRequested, options);
  } catch (error) {
    const fallbackReason = error instanceof Error ? error.message : String(error);
    onProgress?.(
      `Icebug community engine unavailable, falling back to Graphology: ${fallbackReason}`,
      35,
    );
    const fallback = await runGraphologyLeiden(graph, projection.isLarge, engineRequested);
    return { ...fallback, fallbackReason };
  }
};

const runGraphologyLeiden = async (
  graph: GraphInstance,
  isLarge: boolean,
  engineRequested: CommunityDetectionEngine,
): Promise<CommunityEngineResult> => {
  try {
    const details = await Promise.race([
      Promise.resolve(
        leiden.detailed(graph, {
          resolution: isLarge ? 2.0 : 1.0,
          maxIterations: isLarge ? 3 : 0,
          rng: createSeededRng(LEIDEN_SEED),
        }),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Leiden timeout')), LEIDEN_TIMEOUT_MS),
      ),
    ]);
    return { ...details, engine: 'graphology', engineRequested };
  } catch (e: any) {
    if (e.message !== 'Leiden timeout') {
      throw e;
    }

    // Fallback: assign all nodes to community 0
    const communities: Record<string, number> = {};
    graph.forEachNode((node: string) => {
      communities[node] = 0;
    });
    return {
      communities,
      count: 1,
      modularity: 0,
      engine: 'graphology',
      engineRequested,
      fallbackReason: 'Graphology Leiden timeout',
    };
  }
};

const runIcebugLeiden = async (
  projection: CommunityProjection,
  engineRequested: CommunityDetectionEngine,
  options: CommunityDetectionOptions,
): Promise<CommunityEngineResult> => {
  const csr = buildCommunityCsr(projection);
  const nativeResult = await runIcebugWorker(projection.nodes.length, csr, options);
  const partition = nativeResult.partition;
  if (!Number.isFinite(nativeResult.modularity)) {
    throw new Error('optional icebug modularity was not finite');
  }
  if (
    partition.length !== projection.nodes.length ||
    partition.some((community) => !Number.isSafeInteger(community))
  ) {
    throw new Error(
      `optional icebug partition was malformed for ${projection.nodes.length} projected nodes`,
    );
  }

  const communities = normalizePartition(projection, partition);
  return {
    communities,
    count: new Set(Object.values(communities)).size,
    modularity: nativeResult.modularity,
    engine: 'icebug',
    engineRequested,
  };
};

const runIcebugWorker = (
  nodeCount: number,
  csr: CommunityCsr,
  options: CommunityDetectionOptions,
): Promise<IcebugWorkerSuccess> => {
  const threads = options.icebug?.threads ?? 1;
  if (!Number.isSafeInteger(threads) || threads !== 1) {
    throw new Error('optional icebug engine currently requires deterministic threads=1');
  }
  if (options.icebug?.randomize === true) {
    throw new Error('optional icebug engine currently requires randomize=false');
  }

  const worker = new Worker(ICEBUG_WORKER_SOURCE, {
    eval: true,
    workerData: {
      nodeCount,
      indices: csr.indices,
      indptr: csr.indptr,
      threads,
      seed: options.icebug?.seed ?? LEIDEN_SEED,
      iterations: options.icebug?.iterations ?? 4,
      gamma: options.icebug?.gamma ?? 1.0,
      randomize: options.icebug?.randomize ?? false,
    },
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      void worker.terminate();
      reject(new Error(`optional icebug community engine timed out after ${ICEBUG_TIMEOUT_MS}ms`));
    }, ICEBUG_TIMEOUT_MS);

    worker.once('message', (message: IcebugWorkerSuccess | IcebugWorkerFailure) => {
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      if (message.ok === true) {
        resolve(message);
      } else {
        reject(new Error(message.error));
      }
    });

    worker.once('error', (error) => {
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      reject(error);
    });

    worker.once('exit', (code) => {
      if (settled) return;
      clearTimeout(timeout);
      if (code === 0) {
        reject(new Error('optional icebug worker exited before returning a partition'));
        return;
      }
      reject(new Error(`optional icebug worker exited with code ${code}`));
    });
  });
};

const ICEBUG_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');

const isNumericArrayLike = (value) =>
  typeof value === 'object' &&
  value !== null &&
  'length' in value &&
  typeof value.length === 'number';

const readPartition = (runner) => {
  const candidates = [
    typeof runner.getPartition === 'function' ? runner.getPartition() : runner.partition,
    typeof runner.getCommunities === 'function' ? runner.getCommunities() : undefined,
    typeof runner.getMembership === 'function' ? runner.getMembership() : undefined,
    typeof runner.getMemberships === 'function' ? runner.getMemberships() : undefined,
  ];

  for (const candidate of candidates) {
    if (isNumericArrayLike(candidate)) {
      return Array.from(candidate, Number);
    }
  }

  throw new Error('optional icebug ParallelLeidenView did not expose a partition array');
};

const readModularity = (runner) => {
  if (typeof runner.getModularity === 'function') return runner.getModularity();
  if (typeof runner.modularity === 'function') return runner.modularity();
  if (typeof runner.modularity === 'number') return runner.modularity;
  return 0;
};

(async () => {
  const imported = await import('icebug');
  const icebug = imported.default ?? imported;
  const fromCSR = icebug.Graph?.fromCSR;
  const ParallelLeidenView = icebug.community?.ParallelLeidenView;
  if (!fromCSR || !ParallelLeidenView) {
    throw new Error('optional icebug module does not expose Graph.fromCSR/ParallelLeidenView');
  }

  if (typeof icebug.setNumberOfThreads !== 'function' || typeof icebug.setSeed !== 'function') {
    throw new Error('optional icebug module does not expose deterministic thread/seed controls');
  }
  icebug.setNumberOfThreads(workerData.threads);
  icebug.setSeed(workerData.seed, false);

  const nativeGraph = fromCSR(workerData.nodeCount, false, workerData.indices, workerData.indptr);
  let runner;
  try {
    runner = new ParallelLeidenView(nativeGraph, {
      iterations: workerData.iterations,
      gamma: workerData.gamma,
      randomize: workerData.randomize,
    });
  } catch {
    runner = new ParallelLeidenView(
      nativeGraph,
      workerData.iterations,
      workerData.gamma,
      workerData.randomize,
    );
  }

  if (typeof runner.run !== 'function') {
    throw new Error('optional icebug ParallelLeidenView does not expose run()');
  }

  runner.run();
  parentPort.postMessage({
    ok: true,
    partition: readPartition(runner),
    modularity: readModularity(runner),
  });
})().catch((error) => {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
});
`;

const normalizePartition = (
  projection: CommunityProjection,
  partition: ArrayLike<number>,
): Record<string, number> => {
  const remap = new Map<string, number>();
  const communities: Record<string, number> = {};

  for (let index = 0; index < projection.nodes.length; index++) {
    const rawCommunity = String(partition[index]);
    let communityId = remap.get(rawCommunity);
    if (communityId === undefined) {
      communityId = remap.size;
      remap.set(rawCommunity, communityId);
    }
    communities[projection.nodes[index].id] = communityId;
  }

  return communities;
};

// ============================================================================
// HELPER: Create community nodes with heuristic labels
// ============================================================================

/**
 * Create Community nodes with auto-generated labels based on member file paths
 */
const createCommunityNodes = (
  communities: Record<string, number>,
  communityCount: number,
  graph: GraphInstance,
  knowledgeGraph: KnowledgeGraph,
): CommunityNode[] => {
  // Group node IDs by community
  const communityMembers = new Map<number, string[]>();

  Object.entries(communities).forEach(([nodeId, commNum]) => {
    if (!communityMembers.has(commNum)) {
      communityMembers.set(commNum, []);
    }
    communityMembers.get(commNum)!.push(nodeId);
  });

  // Build node lookup for file paths
  const nodePathMap = new Map<string, string>();
  for (const node of knowledgeGraph.iterNodes()) {
    if (node.properties.filePath) {
      nodePathMap.set(node.id, node.properties.filePath);
    }
  }

  // Create community nodes - SKIP SINGLETONS (isolated nodes)
  const communityNodes: CommunityNode[] = [];

  communityMembers.forEach((memberIds, commNum) => {
    // Skip singleton communities - they're just isolated nodes
    if (memberIds.length < 2) return;

    const heuristicLabel = generateHeuristicLabel(memberIds, nodePathMap, graph, commNum);

    communityNodes.push({
      id: `comm_${commNum}`,
      label: heuristicLabel,
      heuristicLabel,
      cohesion: calculateCohesion(memberIds, graph),
      symbolCount: memberIds.length,
    });
  });

  // Sort by size descending
  communityNodes.sort((a, b) => b.symbolCount - a.symbolCount);

  return communityNodes;
};

// ============================================================================
// HELPER: Generate heuristic label from folder patterns
// ============================================================================

/**
 * Generate a human-readable label from the most common folder name in the community
 */
const generateHeuristicLabel = (
  memberIds: string[],
  nodePathMap: Map<string, string>,
  graph: GraphInstance,
  commNum: number,
): string => {
  // Collect folder names from file paths
  const folderCounts = new Map<string, number>();

  memberIds.forEach((nodeId) => {
    const filePath = nodePathMap.get(nodeId) || '';
    const parts = filePath.split('/').filter(Boolean);

    // Get the most specific folder (parent directory)
    if (parts.length >= 2) {
      const folder = parts[parts.length - 2];
      // Skip generic folder names
      if (
        !['src', 'lib', 'core', 'utils', 'common', 'shared', 'helpers'].includes(
          folder.toLowerCase(),
        )
      ) {
        folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
      }
    }
  });

  // Find most common folder
  let maxCount = 0;
  let bestFolder = '';

  folderCounts.forEach((count, folder) => {
    if (count > maxCount) {
      maxCount = count;
      bestFolder = folder;
    }
  });

  if (bestFolder) {
    // Capitalize first letter
    return bestFolder.charAt(0).toUpperCase() + bestFolder.slice(1);
  }

  // Fallback: use function names to detect patterns
  const names: string[] = [];
  memberIds.forEach((nodeId) => {
    const name = graph.getNodeAttribute(nodeId, 'name');
    if (name) names.push(name);
  });

  // Look for common prefixes
  if (names.length > 2) {
    const commonPrefix = findCommonPrefix(names);
    if (commonPrefix.length > 2) {
      return commonPrefix.charAt(0).toUpperCase() + commonPrefix.slice(1);
    }
  }

  // Last resort: generic name with community ID for uniqueness
  return `Cluster_${commNum}`;
};

/**
 * Find common prefix among strings
 */
const findCommonPrefix = (strings: string[]): string => {
  if (strings.length === 0) return '';

  const sorted = strings.slice().sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  let i = 0;
  while (i < first.length && first[i] === last[i]) {
    i++;
  }

  return first.substring(0, i);
};

// ============================================================================
// HELPER: Calculate community cohesion
// ============================================================================

/**
 * Estimate cohesion score (0-1) based on internal edge density.
 * Uses sampling for large communities to avoid O(N^2) cost.
 */
const calculateCohesion = (memberIds: string[], graph: GraphInstance): number => {
  if (memberIds.length <= 1) return 1.0;

  const memberSet = new Set(memberIds);

  // Sample up to 50 members for large communities
  const SAMPLE_SIZE = 50;
  const sample = memberIds.length <= SAMPLE_SIZE ? memberIds : memberIds.slice(0, SAMPLE_SIZE);

  let internalEdges = 0;
  let totalEdges = 0;

  for (const nodeId of sample) {
    if (!graph.hasNode(nodeId)) continue;
    graph.forEachNeighbor(nodeId, (neighbor: string) => {
      totalEdges++;
      if (memberSet.has(neighbor)) {
        internalEdges++;
      }
    });
  }

  // Cohesion = fraction of edges that stay internal
  if (totalEdges === 0) return 1.0;
  return Math.min(1.0, internalEdges / totalEdges);
};
