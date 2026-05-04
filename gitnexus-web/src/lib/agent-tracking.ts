import type { GraphNode } from 'gitnexus-shared';

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

const normalizeLookupValue = (value: unknown): string =>
  String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .trim()
    .toLowerCase();

const getFileName = (filePath: unknown): string => {
  const normalized = normalizeLookupValue(filePath);
  return normalized.split('/').filter(Boolean).pop() ?? '';
};

const addResolvedId = (result: string[], seen: Set<string>, nodeId: string | undefined): boolean => {
  if (!nodeId || seen.has(nodeId)) return false;
  seen.add(nodeId);
  result.push(nodeId);
  return result.length >= MARKER_NODE_LIMIT;
};

export const resolveTrackedNodeIds = (
  rawIds: Iterable<string | null | undefined>,
  nodes: readonly GraphNode[] = [],
): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  const graphNodeIdSet = new Set(nodes.map((node) => node.id));
  const normalizedIdMap = new Map(nodes.map((node) => [normalizeLookupValue(node.id), node.id]));

  for (const rawId of rawIds) {
    const raw = String(rawId ?? '').trim();
    if (!raw) continue;
    const normalizedRaw = normalizeLookupValue(raw);

    if (graphNodeIdSet.has(raw) && addResolvedId(result, seen, raw)) break;

    const normalizedId = normalizedIdMap.get(normalizedRaw);
    if (normalizedId && addResolvedId(result, seen, normalizedId)) break;

    const fileLineMatch = normalizedRaw.match(/^(.*):(\d+)$/);
    const filePart = fileLineMatch?.[1];
    const linePart = fileLineMatch ? Number(fileLineMatch[2]) : NaN;

    const matches = nodes.filter((node) => {
      const nodeName = normalizeLookupValue(node.properties.name);
      const nodeLabelAndName = normalizeLookupValue(`${node.label}:${node.properties.name ?? ''}`);
      const nodeFilePath = normalizeLookupValue(node.properties.filePath);
      const nodeFileName = getFileName(node.properties.filePath);
      const startLine = Number(node.properties.startLine ?? 0);
      const endLine = Number(node.properties.endLine ?? startLine);

      if (normalizeLookupValue(node.id).endsWith(normalizedRaw)) return true;
      if (normalizeLookupValue(node.id).endsWith(`:${normalizedRaw}`)) return true;
      if (nodeLabelAndName === normalizedRaw) return true;
      if (nodeFilePath && nodeFilePath === normalizedRaw) return true;
      if (nodeFileName && nodeFileName === normalizedRaw) return true;
      if (nodeName && nodeName === normalizedRaw) return true;

      if (filePart && Number.isFinite(linePart) && nodeFilePath) {
        const fileMatches = nodeFilePath === filePart || nodeFilePath.endsWith(`/${filePart}`);
        const lineMatches = startLine <= linePart && (endLine === 0 || linePart <= endLine);
        return fileMatches && lineMatches;
      }

      return false;
    });

    for (const node of matches) {
      if (addResolvedId(result, seen, node.id)) break;
    }
    if (result.length >= MARKER_NODE_LIMIT) break;
  }

  return result;
};
