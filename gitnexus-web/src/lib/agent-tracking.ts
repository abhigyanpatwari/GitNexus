export type AgentNodeMarker = 'HIGHLIGHT_NODES' | 'IMPACT';

const MARKER_NODE_LIMIT = 250;

const uniqueNodeIds = (nodeIds: Iterable<string | null | undefined>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const nodeId of nodeIds) {
    if (!nodeId) continue;
    const trimmed = String(nodeId).trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= MARKER_NODE_LIMIT) break;
  }

  return result;
};

export const formatNodeMarker = (
  marker: AgentNodeMarker,
  nodeIds: Iterable<string | null | undefined>,
): string => {
  const ids = uniqueNodeIds(nodeIds);
  if (ids.length === 0) return '';
  return `[${marker}:${ids.map((id) => encodeURIComponent(id)).join(',')}]`;
};

export const parseNodeMarker = (text: string, marker: AgentNodeMarker): string[] => {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\[${escapedMarker}:([^\\]]+)\\]`, 'g');
  const ids: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    for (const rawId of match[1].split(',')) {
      const trimmed = rawId.trim();
      if (!trimmed) continue;
      try {
        ids.push(decodeURIComponent(trimmed));
      } catch {
        ids.push(trimmed);
      }
    }
  }

  return uniqueNodeIds(ids);
};

export const stripNodeMarkers = (text: string): string =>
  text.replace(/\n?\[(?:HIGHLIGHT_NODES|IMPACT):[^\]]+\]/g, '').trimEnd();
