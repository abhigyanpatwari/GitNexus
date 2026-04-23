/**
 * File→File IMPORTS edge emission from a finalized `ImportEdge` map.
 *
 * Deduplicates by `(sourceFile, targetFile)` so multi-symbol imports
 * from the same module collapse to a single edge — matching the
 * legacy schema.
 *
 * Next-consumer contract: language-agnostic. Any provider with a
 * scope-resolution ImportEdge stream emits File→File edges via this
 * single function. The `reason` defaults to
 * `'scope-resolution: import'`; provider may override if downstream
 * filters on reason.
 */

import type { ImportEdge, ScopeId } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { generateId } from '../../../../lib/utils.js';

export function emitImportEdges(
  graph: KnowledgeGraph,
  imports: ReadonlyMap<ScopeId, readonly ImportEdge[]>,
  scopeTree: ScopeResolutionIndexes['scopeTree'],
  reason = 'scope-resolution: import',
): number {
  const seen = new Set<string>();
  let emitted = 0;

  for (const [scopeId, edges] of imports) {
    const scope = scopeTree.getScope(scopeId);
    if (scope === undefined) continue;
    const sourceFile = scope.filePath;

    for (const edge of edges) {
      if (edge.targetFile === null) continue;
      if (edge.targetFile === sourceFile) continue;

      const dedupKey = `${sourceFile}->${edge.targetFile}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const sourceId = generateId('File', sourceFile);
      const targetId = generateId('File', edge.targetFile);
      graph.addRelationship({
        id: generateId('IMPORTS', dedupKey),
        sourceId,
        targetId,
        type: 'IMPORTS',
        confidence: 1.0,
        reason,
      });
      emitted++;
    }
  }

  return emitted;
}
