/**
 * State Slot Processor (Phase 3.7)
 *
 * Converts ExtractedStateSlot data into graph nodes and edges.
 * - Creates StateSlot nodes (deduplicated by cacheKey)
 * - Creates PRODUCES edges from producer functions to StateSlot nodes
 * - Creates CONSUMES edges from consumer functions to StateSlot nodes
 * - Detects overlapping cache key prefixes and emits warnings
 */

import type { KnowledgeGraph } from '../graph/types.js';
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

  return { slotsCreated, producesEdges, consumesEdges, overlapWarnings };
}
