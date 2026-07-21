/**
 * Move entry point detection.
 *
 * Creates ENTRY_POINT_OF edges for Move functions that serve as external
 * entry points into the contract:
 *   - entry functions (transaction entry points)
 *   - #[view] functions (read-only API queries)
 *
 * Must run AFTER moveIngest, which creates the Function nodes and sets the
 * isEntry/isView flags from compiler facts.
 */

import type { KnowledgeGraph } from '../graph/types.js';
import type { MoveIngestOutput } from './move-ingest.js';
import { moveModuleNodeId, moveModuleQualifiedName, moveRelId } from './symbol-id.js';
import { MOVE_EDGE_REASON } from './constants.js';

export function createMoveEntryPointEdges(
  graph: KnowledgeGraph,
  moveIngest: MoveIngestOutput,
): void {
  for (const [funcQualified, funcNodeId] of moveIngest.functionNodeMap) {
    const funcNode = graph.getNode(funcNodeId);
    if (!funcNode) continue;

    const isEntry = funcNode.properties.isEntry === true;
    const isView = funcNode.properties.isView === true;

    if (!isEntry && !isView) continue;

    const moduleQualified = moveModuleQualifiedName(funcQualified);
    const moduleFilePath = moveIngest.moduleFileMap.get(moduleQualified);
    if (!moduleFilePath) continue;

    const moduleNodeId = moveModuleNodeId(moduleQualified, moduleFilePath);
    if (!graph.getNode(moduleNodeId)) continue;

    const reason = isEntry ? MOVE_EDGE_REASON.entryFunction : MOVE_EDGE_REASON.viewFunction;

    graph.addRelationship({
      id: moveRelId(funcNodeId, 'ENTRY_POINT_OF', moduleNodeId, reason),
      sourceId: funcNodeId,
      targetId: moduleNodeId,
      type: 'ENTRY_POINT_OF',
      confidence: 1.0,
      reason,
    });
  }
}
