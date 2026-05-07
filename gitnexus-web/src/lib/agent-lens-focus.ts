import type { GraphNode } from 'gitnexus-shared';

export type AgentLensFocusSource = 'impact' | 'tool' | 'citation';

export type AgentLensToolCallSignature = {
  id: string;
  name: string;
};

export type ResolvedAgentLensFocus = {
  impactNodeIds: string[];
  toolNodeIds: string[];
  citationNodeIds: string[];
  focalNodeId: string | null;
  focalSource: AgentLensFocusSource | null;
  signature: string | null;
};

const getNodeSortKey = (nodeId: string, nodeById: Map<string, GraphNode>): string => {
  const node = nodeById.get(nodeId);
  const name = String(node?.properties.name ?? node?.properties.filePath ?? nodeId).toLowerCase();
  const label = String(node?.label ?? '');
  return `${label}\u0000${name}\u0000${nodeId.toLowerCase()}`;
};

const toSortedNodeIds = (nodeIds: Set<string>, nodeById: Map<string, GraphNode>): string[] =>
  Array.from(nodeIds)
    .filter((nodeId) => nodeById.has(nodeId))
    .sort((left, right) =>
      getNodeSortKey(left, nodeById).localeCompare(getNodeSortKey(right, nodeById)),
    );

export const resolveAgentLensFocus = ({
  isEnabled,
  impactNodeIds,
  toolNodeIds,
  citationNodeIds,
  currentToolCalls,
  nodeById,
}: {
  isEnabled: boolean;
  impactNodeIds: Set<string>;
  toolNodeIds: Set<string>;
  citationNodeIds: Set<string>;
  currentToolCalls: AgentLensToolCallSignature[];
  nodeById: Map<string, GraphNode>;
}): ResolvedAgentLensFocus => {
  const orderedImpactNodeIds = toSortedNodeIds(impactNodeIds, nodeById);
  const orderedToolNodeIds = toSortedNodeIds(toolNodeIds, nodeById);
  const orderedCitationNodeIds = toSortedNodeIds(citationNodeIds, nodeById);

  const focalNodeId =
    orderedImpactNodeIds[0] ?? orderedToolNodeIds[0] ?? orderedCitationNodeIds[0] ?? null;
  const focalSource = orderedImpactNodeIds[0]
    ? 'impact'
    : orderedToolNodeIds[0]
      ? 'tool'
      : orderedCitationNodeIds[0]
        ? 'citation'
        : null;

  const toolCallSignature = currentToolCalls
    .map((toolCall) => `${toolCall.id}:${toolCall.name}`)
    .sort()
    .join(',');

  return {
    impactNodeIds: orderedImpactNodeIds,
    toolNodeIds: orderedToolNodeIds,
    citationNodeIds: orderedCitationNodeIds,
    focalNodeId,
    focalSource,
    signature:
      isEnabled && focalNodeId
        ? [
            `calls=${toolCallSignature}`,
            `impact=${orderedImpactNodeIds.join(',')}`,
            `tool=${orderedToolNodeIds.join(',')}`,
            `citation=${orderedCitationNodeIds.join(',')}`,
          ].join('|')
        : null,
  };
};
