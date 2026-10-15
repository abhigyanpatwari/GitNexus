import type { ParsedFile } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import { generateId } from '../../../../lib/utils.js';
import { resolveDefGraphId } from './ids.js';
import type { GraphNodeLookup } from './node-lookup.js';

/**
 * Project resolved method ownership into the graph. Providers opt in through
 * their post-resolution hook when owners cannot be known during file parsing.
 * Both endpoints must be translated: semantic definition ids are not graph ids.
 */
export function emitMethodOwnerEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): void {
  const ownerIds = new Set<string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (def.type === 'Method' && def.ownerId !== undefined) ownerIds.add(def.ownerId);
    }
  }

  const ownerGraphIds = new Map<string, string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!ownerIds.has(def.nodeId)) continue;
      const graphId = resolveDefGraphId(def.filePath, def, nodeLookup);
      if (graphId !== undefined && graph.getNode(graphId) !== undefined) {
        ownerGraphIds.set(def.nodeId, graphId);
      }
    }
  }

  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (def.type !== 'Method' || def.ownerId === undefined) continue;
      const sourceId = ownerGraphIds.get(def.ownerId);
      if (sourceId === undefined) continue;
      const targetId = resolveDefGraphId(def.filePath, def, nodeLookup);
      if (targetId === undefined || graph.getNode(targetId) === undefined) continue;
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${sourceId}->${targetId}`),
        sourceId,
        targetId,
        type: 'HAS_METHOD',
        confidence: 1,
        reason: '',
      });
    }
  }
}
