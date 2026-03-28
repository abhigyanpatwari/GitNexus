/**
 * Parameter Processor
 *
 * Creates Parameter nodes from extracted parameter data and builds
 * PASSES_TO edges by mapping call-site argument positions to callee parameters.
 *
 * This is Phase B of the security analysis path (architecture assessment).
 */

import { generateId } from '../../lib/utils.js';
import type { ExtractedParameter } from './workers/parse-worker.js';

export interface ParameterNode {
  id: string;
  name: string;
  filePath: string;
  paramIndex: number;
  declaredType?: string;
  isRest: boolean;
  /** ID of the owning function/method */
  ownerId: string;
}

export interface PassesToEdge {
  id: string;
  /** The CALLS edge source (caller function) */
  callerId: string;
  /** The Parameter node being passed to */
  targetParamId: string;
  /** Argument position at the call site */
  sourceParamIndex: number;
  /** Confidence (matches CALLS edge confidence) */
  confidence: number;
}

/**
 * Create Parameter graph nodes from extracted parameter data.
 */
export function createParameterNodes(params: ExtractedParameter[]): ParameterNode[] {
  const nodes: ParameterNode[] = [];
  const seenIds = new Set<string>();

  for (const p of params) {
    const id = generateId('Parameter', `${p.functionId}:${p.paramName}:${p.paramIndex}`);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    nodes.push({
      id,
      name: p.paramName,
      filePath: p.filePath,
      paramIndex: p.paramIndex,
      declaredType: p.declaredType,
      isRest: p.isRest,
      ownerId: p.functionId,
    });
  }

  return nodes;
}

/**
 * Build PASSES_TO edges by matching call-site argument positions
 * to callee parameter positions.
 *
 * For each CALLS edge (caller -> callee), if the callee has Parameter nodes,
 * create PASSES_TO edges from the caller to each callee parameter that
 * receives an argument.
 */
export function buildPassesToEdges(
  callEdges: Array<{ sourceId: string; targetId: string; argCount: number }>,
  calleeParamMap: Map<string, ExtractedParameter[]>,
): PassesToEdge[] {
  const edges: PassesToEdge[] = [];

  for (const call of callEdges) {
    const params = calleeParamMap.get(call.targetId);
    if (!params || params.length === 0) continue;

    const argCount = call.argCount || 0;
    for (const param of params) {
      // Only create edge if the call site provides this argument
      // Rest params receive all remaining args, so always match if argCount > 0
      if (param.paramIndex >= argCount && !param.isRest) continue;

      const paramNodeId = generateId('Parameter', `${param.functionId}:${param.paramName}:${param.paramIndex}`);

      edges.push({
        id: generateId('PASSES_TO', `${call.sourceId}->${paramNodeId}`),
        callerId: call.sourceId,
        targetParamId: paramNodeId,
        sourceParamIndex: param.paramIndex,
        confidence: 0.9,
      });
    }
  }

  return edges;
}
