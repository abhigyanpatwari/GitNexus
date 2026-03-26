/**
 * State Slot Processor (Phase 3.7)
 *
 * Converts ExtractedStateSlot data into graph nodes and edges.
 * - Creates StateSlot nodes (deduplicated by cacheKey)
 * - Creates PRODUCES edges from producer functions to StateSlot nodes
 * - Creates CONSUMES edges from consumer functions to StateSlot nodes
 * - Detects overlapping cache key prefixes and emits warnings
 * - Chains Route responseKeys to PRODUCES edges (Task 17)
 * - Resolves wrapper hooks for indirect PRODUCES edges (Task 18)
 */

import type { KnowledgeGraph, GraphRelationship } from '../graph/types.js';
import type { ExtractedStateSlot } from './state-slot-detectors/index.js';
import { generateId } from '../../lib/utils.js';
import { cacheKeysOverlap } from './shape-inference.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface StateSlotProcessorResult {
  slotsCreated: number;
  producesEdges: number;
  consumesEdges: number;
  overlapWarnings: string[];
  routeChainsApplied: number;
  wrapperHooksResolved: number;
}

// ---------------------------------------------------------------------------
// Confidence mapping
// ---------------------------------------------------------------------------

const CONFIDENCE_MAP: Record<string, number> = {
  'type-checked': 1.0,
  'ast-literal': 0.8,
  'heuristic': 0.6,
};

function toConfidence(tier: string): number {
  return CONFIDENCE_MAP[tier] ?? 0.5;
}

// ---------------------------------------------------------------------------
// Function node lookup
// ---------------------------------------------------------------------------

/**
 * Try to find a Function/Variable/Const node for the given function name
 * in the given file. Tries the canonical `generateId` pattern first, then
 * falls back to iterating graph nodes.
 */
function findFunctionNodeId(
  graph: KnowledgeGraph,
  filePath: string,
  functionName: string,
): string | null {
  // Fast path: canonical ID patterns used by the pipeline
  for (const label of ['Function', 'Variable', 'Const'] as const) {
    const candidateId = generateId(label, `${filePath}:${functionName}`);
    if (graph.getNode(candidateId)) return candidateId;
  }

  // Slow path: linear scan
  for (const node of graph.iterNodes()) {
    if (
      (node.label === 'Function' || node.label === 'Variable' || node.label === 'Const' || node.label === 'Method') &&
      node.properties.name === functionName &&
      node.properties.filePath === filePath
    ) {
      return node.id;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

/**
 * Process extracted state slots into the knowledge graph.
 *
 * @param slots   - Flat list of ExtractedStateSlot from all detectors
 * @param graph   - Mutable knowledge graph to write into
 * @returns       - Summary counts and any overlap warnings
 */
export function processStateSlots(
  slots: ExtractedStateSlot[],
  graph: KnowledgeGraph,
): StateSlotProcessorResult {
  // --- Step 1: Deduplicate slots by cacheKey ---
  // Multiple detector results for the same key are merged.
  const byKey = new Map<string, ExtractedStateSlot>();
  for (const slot of slots) {
    const existing = byKey.get(slot.cacheKey);
    if (!existing) {
      byKey.set(slot.cacheKey, { ...slot });
    } else {
      // Merge producers and consumers from duplicate entries
      existing.producers = [...existing.producers, ...slot.producers];
      existing.consumers = [...existing.consumers, ...slot.consumers];
    }
  }

  const deduped = Array.from(byKey.values());

  // --- Step 2: Detect cache key prefix overlaps ---
  const overlapWarnings: string[] = [];
  const keys = deduped.map(s => s.cacheKey);
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (cacheKeysOverlap(keys[i], keys[j])) {
        overlapWarnings.push(`Cache key overlap: "${keys[i]}" vs "${keys[j]}"`);
      }
    }
  }

  // --- Step 3: Create nodes and edges ---
  let slotsCreated = 0;
  let producesEdges = 0;
  let consumesEdges = 0;

  for (const slot of deduped) {
    const slotNodeId = generateId('StateSlot', slot.cacheKey);

    // Create the StateSlot node (idempotent — addNode checks by ID)
    const slotNodeExists = !!graph.getNode(slotNodeId);
    graph.addNode({
      id: slotNodeId,
      label: 'StateSlot',
      properties: {
        name: slot.name,
        filePath: slot.filePath,
        startLine: slot.lineNumber,
        slotKind: slot.slotKind,
        cacheKey: slot.cacheKey,
      },
    });
    if (!slotNodeExists) slotsCreated++;

    // --- PRODUCES edges ---
    for (const producer of slot.producers) {
      const srcId = findFunctionNodeId(graph, producer.filePath, producer.functionName);
      if (!srcId) continue; // no matching function node in graph

      const keysStr = producer.keys.join(',');
      const reason = `shape-${producer.confidence}|keys:${keysStr}${producer.sourceType ? `|type:${producer.sourceType}` : ''}`;
      const edgeId = generateId('PRODUCES', `${srcId}->${slotNodeId}`);

      graph.addRelationship({
        id: edgeId,
        sourceId: srcId,
        targetId: slotNodeId,
        type: 'PRODUCES',
        confidence: toConfidence(producer.confidence),
        reason,
      });
      producesEdges++;
    }

    // --- CONSUMES edges ---
    for (const consumer of slot.consumers) {
      const srcId = findFunctionNodeId(graph, consumer.filePath, consumer.functionName);
      if (!srcId) continue;

      const keysStr = consumer.accessedKeys.join(',');
      const reason = `shape-${consumer.confidence}|keys:${keysStr}`;
      const edgeId = generateId('CONSUMES', `${srcId}->${slotNodeId}`);

      graph.addRelationship({
        id: edgeId,
        sourceId: srcId,
        targetId: slotNodeId,
        type: 'CONSUMES',
        confidence: toConfidence(consumer.confidence),
        reason,
      });
      consumesEdges++;
    }
  }

  // --- Step 4: Chain Route responseKeys to PRODUCES edges ---
  const routeChainsApplied = chainRoutesToSlots(graph);

  // --- Step 5: Resolve wrapper hooks for indirect PRODUCES edges ---
  const wrapperHooksResolved = resolveWrapperHooks(graph);

  return { slotsCreated, producesEdges, consumesEdges, overlapWarnings, routeChainsApplied, wrapperHooksResolved };
}

// ---------------------------------------------------------------------------
// Task 17: Route-to-Cache Chaining
// ---------------------------------------------------------------------------

/**
 * For each PRODUCES edge with empty keys, check if the producer function has a
 * FETCHES edge to a Route node. If so, copy the Route's responseKeys onto the
 * PRODUCES edge and upgrade confidence from heuristic to ast-literal.
 *
 * Mutates edge objects in-place (they are references held in the graph's internal Map).
 */
function chainRoutesToSlots(graph: KnowledgeGraph): number {
  // Build a lookup: functionNodeId → Route responseKeys (from FETCHES edges)
  const fetchTargetKeys = new Map<string, string[]>();
  for (const rel of graph.iterRelationships()) {
    if (rel.type !== 'FETCHES') continue;
    const routeNode = graph.getNode(rel.targetId);
    if (!routeNode || routeNode.label !== 'Route') continue;
    const rkeys = routeNode.properties.responseKeys;
    if (rkeys && rkeys.length > 0) {
      fetchTargetKeys.set(rel.sourceId, rkeys);
    }
  }

  if (fetchTargetKeys.size === 0) return 0;

  let applied = 0;

  for (const rel of graph.iterRelationships()) {
    if (rel.type !== 'PRODUCES') continue;

    // Parse existing reason to check if keys are empty
    const keysMatch = rel.reason.match(/\|keys:([^|]*)/);
    const existingKeys = keysMatch ? keysMatch[1] : '';
    if (existingKeys.length > 0) continue; // already has keys, skip

    // Check if this producer has a FETCHES edge to a Route with responseKeys
    const routeKeys = fetchTargetKeys.get(rel.sourceId);
    if (!routeKeys) continue;

    // Mutate the edge in-place: update reason and confidence
    const newKeysStr = routeKeys.join(',');
    rel.reason = rel.reason
      .replace(/shape-heuristic/, 'shape-ast-literal')
      .replace(/\|keys:[^|]*/, `|keys:${newKeysStr}`);
    rel.confidence = toConfidence('ast-literal');
    applied++;
  }

  return applied;
}

// ---------------------------------------------------------------------------
// Task 18: Wrapper Hook Resolution
// ---------------------------------------------------------------------------

/**
 * For each PRODUCES edge, find callers of the producer function (via CALLS edges)
 * that are hooks (name starts with 'use'). Create indirect PRODUCES edges from
 * those wrapper hooks to the same StateSlot. Follows up to 2 levels of wrapping.
 */
function resolveWrapperHooks(graph: KnowledgeGraph): number {
  // Build a reverse CALLS index: targetId → sourceIds (who calls this function)
  const callersOf = new Map<string, string[]>();
  for (const rel of graph.iterRelationships()) {
    if (rel.type !== 'CALLS') continue;
    const existing = callersOf.get(rel.targetId);
    if (existing) {
      existing.push(rel.sourceId);
    } else {
      callersOf.set(rel.targetId, [rel.sourceId]);
    }
  }

  // Collect existing PRODUCES edges (snapshot to avoid iterating while adding)
  const producesEdges: GraphRelationship[] = [];
  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'PRODUCES') {
      producesEdges.push(rel);
    }
  }

  let resolved = 0;

  for (const edge of producesEdges) {
    const slotId = edge.targetId;
    // BFS up to 2 levels of wrapper hooks
    const visited = new Set<string>([edge.sourceId]);
    let frontier = [edge.sourceId];

    for (let depth = 1; depth <= 2; depth++) {
      const nextFrontier: string[] = [];
      for (const fnId of frontier) {
        const callers = callersOf.get(fnId);
        if (!callers) continue;

        for (const callerId of callers) {
          if (visited.has(callerId)) continue;
          visited.add(callerId);

          // Only follow hooks (functions starting with 'use')
          const callerNode = graph.getNode(callerId);
          if (!callerNode) continue;
          const name = callerNode.properties.name;
          if (!name || !name.startsWith('use')) continue;

          // Create an indirect PRODUCES edge from the wrapper to the same slot
          const indirectEdgeId = generateId('PRODUCES', `${callerId}->${slotId}:wrapper-d${depth}`);
          const reason = `shape-heuristic|keys:${extractKeysFromReason(edge.reason)}|via:${callerNode.properties.name}`;

          graph.addRelationship({
            id: indirectEdgeId,
            sourceId: callerId,
            targetId: slotId,
            type: 'PRODUCES',
            confidence: toConfidence('heuristic'),
            reason,
          });
          resolved++;
          nextFrontier.push(callerId);
        }
      }
      frontier = nextFrontier;
    }
  }

  return resolved;
}

/**
 * Extract keys string from a PRODUCES edge reason.
 * Reason format: shape-{confidence}|keys:{comma-separated}|...
 */
function extractKeysFromReason(reason: string): string {
  const match = reason.match(/\|keys:([^|]*)/);
  return match ? match[1] : '';
}
