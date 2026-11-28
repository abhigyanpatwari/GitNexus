import type { SupportedLanguages } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';

/** Zero-based, inclusive source lines, as on graph definition nodes. */
interface Site {
  startLine: number;
  endLine: number;
}

export interface ResourceLifetime {
  name: string;
  acquisition: Site;
  cleanup: Site;
  cleanupKind: 'explicit close' | 'context-manager exit';
}

/** Anchor the binding and its cleanup to source, keeping both out of the call graph. */
export function emitResourceLifetime(
  graph: KnowledgeGraph,
  filePath: string,
  language: SupportedLanguages,
  ownerId: string,
  fact: ResourceLifetime,
): void {
  const resourceId = `CodeElement:${filePath}:<resource@${fact.acquisition.startLine}:${fact.name}>`;
  const cleanupId = `${resourceId}:cleanup`;
  graph.addNode({
    id: resourceId,
    label: 'CodeElement',
    properties: { filePath, language, name: fact.name, ...fact.acquisition },
  });
  graph.addNode({
    id: cleanupId,
    label: 'CodeElement',
    properties: { filePath, language, name: fact.cleanupKind, ...fact.cleanup },
  });
  // A managed context can expose a borrowed value; its exit belongs to the manager.
  const relation = fact.cleanupKind === 'explicit close' ? 'OWNS_RESOURCE' : 'MANAGES_CONTEXT';
  graph.addRelationship({
    id: `${relation}:${ownerId}->${resourceId}`,
    sourceId: ownerId,
    targetId: resourceId,
    type: relation,
    confidence: 1,
    reason: fact.cleanupKind,
  });
  graph.addRelationship({
    id: `CLEANUP_AT:${resourceId}->${cleanupId}`,
    sourceId: resourceId,
    targetId: cleanupId,
    type: 'CLEANUP_AT',
    confidence: 1,
    reason: fact.cleanupKind,
  });
}
