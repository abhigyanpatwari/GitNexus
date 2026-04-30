import type { GraphNode, RelationshipType } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';

export const SEMANTIC_ANCHOR_VERSION = 1;
export const SEMANTIC_ANCHOR_MODEL = 'heuristic-v1';

export interface AnchorRelationCounts {
  incoming: number;
  outgoing: number;
  byType: Partial<Record<RelationshipType, number>>;
}

export interface SemanticAnchor {
  summary: string;
  purpose: string;
  tags: string[];
  anchorModel: string;
  anchorHash: string;
  anchorVersion: number;
  anchorGeneratedAt: string;
}

export interface SemanticAnchorResult {
  anchoredNodes: number;
}

const ANCHORABLE_LABELS = new Set<string>([
  'File',
  'Class',
  'Function',
  'Method',
  'Interface',
  'Struct',
  'Enum',
  'Trait',
  'Impl',
  'TypeAlias',
  'Const',
  'Static',
  'Variable',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Constructor',
  'Template',
  'Module',
  'CodeElement',
  'Route',
  'Tool',
  'Section',
]);

const normalizeTag = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

const addTag = (tags: Set<string>, value: string | undefined): void => {
  if (!value) return;
  const tag = normalizeTag(value);
  if (tag) tags.add(tag);
};

const basename = (filePath: string | undefined): string => {
  if (!filePath) return 'unknown file';
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
};

const formatDependencyPhrase = (counts: AnchorRelationCounts): string => {
  const calls = counts.byType.CALLS ?? 0;
  const imports = counts.byType.IMPORTS ?? 0;
  const definitions = counts.byType.DEFINES ?? 0;
  const parts: string[] = [];
  if (counts.incoming > 0) parts.push(`${counts.incoming} incoming`);
  if (counts.outgoing > 0) parts.push(`${counts.outgoing} outgoing`);
  if (calls > 0) parts.push(`${calls} call edge${calls === 1 ? '' : 's'}`);
  if (imports > 0) parts.push(`${imports} import edge${imports === 1 ? '' : 's'}`);
  if (definitions > 0) parts.push(`${definitions} definition edge${definitions === 1 ? '' : 's'}`);
  return parts.length > 0 ? parts.join(', ') : 'no dependency edges yet';
};

const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const buildRelationCounts = (graph: KnowledgeGraph): Map<string, AnchorRelationCounts> => {
  const counts = new Map<string, AnchorRelationCounts>();

  const ensure = (nodeId: string): AnchorRelationCounts => {
    let entry = counts.get(nodeId);
    if (!entry) {
      entry = { incoming: 0, outgoing: 0, byType: {} };
      counts.set(nodeId, entry);
    }
    return entry;
  };

  for (const node of graph.iterNodes()) ensure(node.id);

  for (const rel of graph.iterRelationships()) {
    const source = ensure(rel.sourceId);
    const target = ensure(rel.targetId);
    source.outgoing += 1;
    target.incoming += 1;
    source.byType[rel.type] = (source.byType[rel.type] ?? 0) + 1;
    target.byType[rel.type] = (target.byType[rel.type] ?? 0) + 1;
  }

  return counts;
};

export const createSemanticAnchor = (
  node: GraphNode,
  counts: AnchorRelationCounts,
  generatedAt = new Date().toISOString(),
): SemanticAnchor | null => {
  if (!ANCHORABLE_LABELS.has(node.label)) return null;

  const name = node.properties.name || node.id;
  const file = basename(node.properties.filePath);
  const dependencyPhrase = formatDependencyPhrase(counts);
  const tags = new Set<string>();
  addTag(tags, node.label);
  addTag(tags, node.properties.language as string | undefined);
  if (node.properties.isExported) addTag(tags, 'exported');
  if (counts.incoming >= 5) addTag(tags, 'shared');
  if (counts.outgoing >= 5) addTag(tags, 'orchestrates');
  if ((counts.byType.HANDLES_ROUTE ?? 0) > 0 || node.label === 'Route') addTag(tags, 'api-route');
  if ((counts.byType.HANDLES_TOOL ?? 0) > 0 || node.label === 'Tool') addTag(tags, 'mcp-tool');

  let summary: string;
  let purpose: string;

  switch (node.label) {
    case 'File':
      summary = `File ${name} groups code in ${node.properties.filePath || file}; ${dependencyPhrase}.`;
      purpose = `Use this file anchor to understand definitions and imports around ${file}.`;
      break;
    case 'Class':
    case 'Interface':
    case 'Struct':
    case 'Trait':
    case 'Record':
      summary = `${node.label} ${name} defines a type in ${file}; ${dependencyPhrase}.`;
      purpose = `Use this type anchor when changing object shape, inheritance, or implementations.`;
      break;
    case 'Function':
    case 'Method':
    case 'Constructor':
      summary = `${node.label} ${name} implements behavior in ${file}; ${dependencyPhrase}.`;
      purpose = `Use this behavior anchor to trace callers, callees, and process participation before editing.`;
      break;
    case 'Route':
      summary = `Route ${name} is handled in ${file}; ${dependencyPhrase}.`;
      purpose = `Use this API anchor to check request handlers, response shapes, and consumers.`;
      break;
    case 'Tool':
      summary = `Tool ${name} is defined in ${file}; ${dependencyPhrase}.`;
      purpose = `Use this tool anchor to inspect MCP/RPC behavior and callers.`;
      break;
    default:
      summary = `${node.label} ${name} appears in ${file}; ${dependencyPhrase}.`;
      purpose = `Use this anchor as semantic context before changing ${name}.`;
      break;
  }

  const hashInput = JSON.stringify({
    id: node.id,
    label: node.label,
    name,
    filePath: node.properties.filePath,
    startLine: node.properties.startLine,
    endLine: node.properties.endLine,
    counts,
    version: SEMANTIC_ANCHOR_VERSION,
  });

  return {
    summary,
    purpose,
    tags: [...tags].sort(),
    anchorModel: SEMANTIC_ANCHOR_MODEL,
    anchorHash: stableHash(hashInput),
    anchorVersion: SEMANTIC_ANCHOR_VERSION,
    anchorGeneratedAt: generatedAt,
  };
};

export const applySemanticAnchors = (
  graph: KnowledgeGraph,
  generatedAt = new Date().toISOString(),
): SemanticAnchorResult => {
  const counts = buildRelationCounts(graph);
  let anchoredNodes = 0;

  for (const node of graph.iterNodes()) {
    const anchor = createSemanticAnchor(node, counts.get(node.id) ?? {
      incoming: 0,
      outgoing: 0,
      byType: {},
    }, generatedAt);
    if (!anchor) continue;

    node.properties.summary = anchor.summary;
    node.properties.purpose = anchor.purpose;
    node.properties.tags = anchor.tags;
    node.properties.anchorModel = anchor.anchorModel;
    node.properties.anchorHash = anchor.anchorHash;
    node.properties.anchorVersion = anchor.anchorVersion;
    node.properties.anchorGeneratedAt = anchor.anchorGeneratedAt;
    if (!node.properties.description) {
      node.properties.description = anchor.summary;
    }
    anchoredNodes += 1;
  }

  return { anchoredNodes };
};
