import type { NodeLabel, RelationshipType } from 'gitnexus-shared';

export type GraphColorMode =
  | 'type'
  | 'structure'
  | 'health'
  | 'impact'
  | 'runtime'
  | 'agent'
  | 'complexity'
  | 'churn';

export type GraphMetricColorMode = Exclude<GraphColorMode, 'type' | 'structure' | 'agent'>;

export type LegendItem = { color: string; label: string };

export const GRAPH_SURFACE_COLORS = {
  background: '#06060a',
  backgroundSoft: '#0a0a10',
  dimMix: '#12121c',
  dimEdge: '#151827',
  defaultNode: '#6b7280',
  defaultEdge: '#2a2a3a',
  fallbackNode: '#9ca3af',
  fallbackEdge: '#4a4a5a',
  tooltipBackground: '#12121c',
  tooltipText: '#f5f5f7',
} as const;

// Node colors by semantic type. Primary filter labels use distinct colors; related
// language-specific labels stay in nearby color families without reusing the same hex.
export const NODE_COLORS: Record<NodeLabel, string> = {
  Project: '#a855f7',
  Package: '#7c3aed',
  Module: '#4f46e5',
  Folder: '#2563eb',
  File: '#0ea5e9',
  Class: '#f59e0b',
  Function: '#10b981',
  Method: '#14b8a6',
  Variable: '#64748b',
  Interface: '#ec4899',
  Enum: '#f97316',
  Decorator: '#eab308',
  Import: '#475569',
  Type: '#8b5cf6',
  CodeElement: '#94a3b8',
  Community: '#818cf8',
  Process: '#f43f5e',
  Section: '#60a5fa',
  Struct: '#fbbf24',
  Trait: '#db2777',
  Impl: '#2dd4bf',
  TypeAlias: '#c084fc',
  Const: '#6b7280',
  Static: '#334155',
  Namespace: '#6366f1',
  Union: '#fb923c',
  Typedef: '#d8b4fe',
  Macro: '#ca8a04',
  Property: '#9ca3af',
  Record: '#fde68a',
  Delegate: '#0f766e',
  Annotation: '#facc15',
  Constructor: '#34d399',
  Template: '#ddd6fe',
  Route: '#e11d48',
  Tool: '#22d3ee',
  RuntimeService: '#22c55e',
  RuntimeSpan: '#38bdf8',
  RuntimeRoute: '#ea580c',
  RuntimeError: '#ef4444',
  RuntimeLogPattern: '#fde047',
};

export const getNodeTypeColor = (label: NodeLabel): string =>
  NODE_COLORS[label] ?? GRAPH_SURFACE_COLORS.fallbackNode;

// Node sizes by type - clear visual hierarchy with dramatic size differences
// Structural nodes are MUCH larger to make hierarchy obvious
export const NODE_SIZES: Record<NodeLabel, number> = {
  Project: 20, // Largest - root of everything
  Package: 16, // Major structural element
  Module: 13, // Important container
  Folder: 10, // Structural - clearly bigger than files
  File: 6, // Common element - smaller than folders
  Class: 8, // Important code structure
  Function: 4, // Common code element - small
  Method: 3, // Smaller than function
  Variable: 2, // Tiny - leaf node
  Interface: 7, // Important type definition
  Enum: 5, // Type definition
  Decorator: 2, // Tiny modifier
  Import: 1.5, // Very small - usually hidden anyway
  Type: 3, // Type alias - small
  CodeElement: 2, // Generic small
  Community: 6, // Hidden by default, visible when the user enables metadata nodes
  Process: 7, // Hidden by default, visible when the user enables process nodes
  Section: 8, // Structural section - similar to Folder
  Struct: 8, // Like Class
  Trait: 7, // Like Interface
  Impl: 3, // Like Method
  TypeAlias: 3, // Like Type
  Const: 2, // Like Variable
  Static: 2, // Like Variable
  Namespace: 13, // Like Module
  Union: 5, // Like Enum
  Typedef: 3, // Like Type
  Macro: 2, // Like Decorator
  Property: 2, // Like Variable
  Record: 8, // Like Class
  Delegate: 3, // Like Method
  Annotation: 2, // Like Decorator
  Constructor: 4, // Like Function
  Template: 3, // Like Type
  Route: 5, // Like Enum
  Tool: 5, // Like Enum
  RuntimeService: 7, // Runtime service
  RuntimeSpan: 4, // Trace span
  RuntimeRoute: 6, // Runtime endpoint
  RuntimeError: 5, // Error signal
  RuntimeLogPattern: 4, // Log signal
};

// Community color palette for structure mode. This palette is intentionally
// separate from NODE_COLORS so functional areas do not masquerade as node types.
export const COMMUNITY_COLORS = [
  '#ff6b6b',
  '#f06595',
  '#cc5de8',
  '#845ef7',
  '#5c7cfa',
  '#339af0',
  '#22b8cf',
  '#20c997',
  '#51cf66',
  '#94d82d',
  '#fcc419',
  '#ff922b',
];

export const getCommunityColor = (communityIndex: number): string => {
  return COMMUNITY_COLORS[communityIndex % COMMUNITY_COLORS.length];
};

export const GRAPH_HEATMAP_COLORS: Record<
  GraphMetricColorMode,
  { low: string; medium: string; elevated: string; high: string }
> = {
  health: {
    low: '#10b981',
    medium: '#eab308',
    elevated: '#f97316',
    high: '#ef4444',
  },
  impact: {
    low: '#38bdf8',
    medium: '#f59e0b',
    elevated: '#fb7185',
    high: '#f43f5e',
  },
  runtime: {
    low: '#22c55e',
    medium: '#facc15',
    elevated: '#f97316',
    high: '#dc2626',
  },
  complexity: {
    low: '#06b6d4',
    medium: '#2563eb',
    elevated: '#7c3aed',
    high: '#c026d3',
  },
  churn: {
    low: '#14b8a6',
    medium: '#84cc16',
    elevated: '#eab308',
    high: '#f97316',
  },
};

export const GRAPH_AGENT_COLORS = {
  base: GRAPH_SURFACE_COLORS.fallbackNode,
  focus: '#a78bfa',
  tool: '#22d3ee',
} as const;

export const GRAPH_HIGHLIGHT_COLORS = {
  query: '#06b6d4',
  querySoft: '#67e8f9',
  blast: '#ef4444',
  blastSoft: '#fca5a5',
  blastPulse: '#f87171',
  change: '#a855f7',
  changePulse: '#c084fc',
  changeSoft: '#d8b4fe',
} as const;

export const getMetricColor = (mode: GraphMetricColorMode, score: number): string => {
  const palette = GRAPH_HEATMAP_COLORS[mode];
  if (score >= 0.78) return palette.high;
  if (score >= 0.54) return palette.elevated;
  if (score >= 0.3) return palette.medium;
  return palette.low;
};

export const getAgentColor = (score: number, baseColor: string): string => {
  if (score >= 0.8) return GRAPH_AGENT_COLORS.tool;
  if (score >= 0.5) return GRAPH_AGENT_COLORS.focus;
  return baseColor;
};

export const TYPE_COLOR_LEGEND_LABELS: NodeLabel[] = [
  'Folder',
  'File',
  'Class',
  'Function',
  'Method',
  'Interface',
  'Enum',
  'Route',
  'Tool',
];

export const FILTER_COLOR_LEGEND_LABELS: NodeLabel[] = [
  'Folder',
  'File',
  'Class',
  'Interface',
  'Enum',
  'Type',
  'Function',
  'Method',
  'Variable',
  'Decorator',
];

export const GRAPH_COLOR_MODE_LEGENDS: Record<GraphColorMode, LegendItem[]> = {
  type: TYPE_COLOR_LEGEND_LABELS.map((label) => ({ color: NODE_COLORS[label], label })),
  structure: [
    { color: NODE_COLORS.Folder, label: 'Folder' },
    { color: NODE_COLORS.File, label: 'File' },
    { color: COMMUNITY_COLORS[0], label: 'Area 1' },
    { color: COMMUNITY_COLORS[4], label: 'Area 2' },
    { color: COMMUNITY_COLORS[7], label: 'Area 3' },
  ],
  impact: [
    { color: GRAPH_HEATMAP_COLORS.impact.low, label: 'Low' },
    { color: GRAPH_HEATMAP_COLORS.impact.medium, label: 'Medium' },
    { color: GRAPH_HEATMAP_COLORS.impact.high, label: 'High' },
  ],
  runtime: [
    { color: GRAPH_HEATMAP_COLORS.runtime.low, label: 'Quiet' },
    { color: GRAPH_HEATMAP_COLORS.runtime.medium, label: 'Noisy' },
    { color: GRAPH_HEATMAP_COLORS.runtime.high, label: 'Critical' },
  ],
  agent: [
    { color: GRAPH_AGENT_COLORS.base, label: 'Base' },
    { color: GRAPH_AGENT_COLORS.focus, label: 'Citation' },
    { color: GRAPH_AGENT_COLORS.tool, label: 'Tool result' },
  ],
  health: [
    { color: GRAPH_HEATMAP_COLORS.health.low, label: 'Low' },
    { color: GRAPH_HEATMAP_COLORS.health.medium, label: 'Medium' },
    { color: GRAPH_HEATMAP_COLORS.health.high, label: 'High' },
  ],
  complexity: [
    { color: GRAPH_HEATMAP_COLORS.complexity.low, label: 'Low' },
    { color: GRAPH_HEATMAP_COLORS.complexity.medium, label: 'Medium' },
    { color: GRAPH_HEATMAP_COLORS.complexity.high, label: 'High' },
  ],
  churn: [
    { color: GRAPH_HEATMAP_COLORS.churn.low, label: 'Low' },
    { color: GRAPH_HEATMAP_COLORS.churn.medium, label: 'Medium' },
    { color: GRAPH_HEATMAP_COLORS.churn.high, label: 'High' },
  ],
};

export const ALL_NODE_LABELS: NodeLabel[] = [
  'Project',
  'Package',
  'Module',
  'Folder',
  'File',
  'Class',
  'Function',
  'Method',
  'Variable',
  'Interface',
  'Enum',
  'Decorator',
  'Import',
  'Type',
  'CodeElement',
  'Community',
  'Process',
  'Section',
  'Struct',
  'Trait',
  'Impl',
  'TypeAlias',
  'Const',
  'Static',
  'Namespace',
  'Union',
  'Typedef',
  'Macro',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Constructor',
  'Template',
  'Route',
  'Tool',
  'RuntimeService',
  'RuntimeSpan',
  'RuntimeRoute',
  'RuntimeError',
  'RuntimeLogPattern',
];

// Labels to show by default (hide imports, metadata, and leaf details by default as they clutter)
export const DEFAULT_VISIBLE_LABELS: NodeLabel[] = [
  'Project',
  'Package',
  'Module',
  'Folder',
  'File',
  'Class',
  'Function',
  'Method',
  'Interface',
  'Enum',
  'Type',
  'Route',
  'Tool',
  'RuntimeService',
  'RuntimeRoute',
  'RuntimeError',
];

// All filterable labels (in display order)
export const FILTERABLE_LABELS: NodeLabel[] = ALL_NODE_LABELS;

// Edge/Relation types
export type EdgeType = RelationshipType | 'OVERRIDES';

export const ALL_EDGE_TYPES: EdgeType[] = [
  'CONTAINS',
  'CALLS',
  'INHERITS',
  'METHOD_OVERRIDES',
  'METHOD_IMPLEMENTS',
  'IMPORTS',
  'USES',
  'DEFINES',
  'DECORATES',
  'IMPLEMENTS',
  'EXTENDS',
  'HAS_METHOD',
  'HAS_PROPERTY',
  'ACCESSES',
  'OVERRIDES',
  'MEMBER_OF',
  'STEP_IN_PROCESS',
  'HANDLES_ROUTE',
  'FETCHES',
  'HANDLES_TOOL',
  'ENTRY_POINT_OF',
  'WRAPS',
  'QUERIES',
  'RUNTIME_MAPS_TO',
  'RUNTIME_OBSERVED_IN',
  'RUNTIME_HAS_SIGNAL',
];

// Default visible edges (CALLS hidden by default to reduce clutter)
export const DEFAULT_VISIBLE_EDGES: EdgeType[] = [
  'CONTAINS',
  'DEFINES',
  'IMPORTS',
  'INHERITS',
  'EXTENDS',
  'IMPLEMENTS',
  'CALLS',
  'USES',
  'DECORATES',
  'HAS_METHOD',
  'HAS_PROPERTY',
  'MEMBER_OF',
  'STEP_IN_PROCESS',
  'HANDLES_ROUTE',
  'ENTRY_POINT_OF',
  'RUNTIME_MAPS_TO',
  'RUNTIME_OBSERVED_IN',
];

// Edge display info for UI
export type EdgeStyle = { color: string; label: string; sizeMultiplier: number };

export const EDGE_STYLES: Record<EdgeType, EdgeStyle> = {
  CONTAINS: { color: '#86efac', label: 'Contains', sizeMultiplier: 0.4 },
  CALLS: { color: '#e879f9', label: 'Calls', sizeMultiplier: 0.8 },
  INHERITS: { color: '#fb923c', label: 'Inherits', sizeMultiplier: 1.0 },
  METHOD_OVERRIDES: { color: '#fed7aa', label: 'Method Overrides', sizeMultiplier: 0.85 },
  METHOD_IMPLEMENTS: { color: '#f0abfc', label: 'Method Implements', sizeMultiplier: 0.75 },
  IMPORTS: { color: '#93c5fd', label: 'Imports', sizeMultiplier: 0.6 },
  USES: { color: '#a7f3d0', label: 'Uses', sizeMultiplier: 0.55 },
  DEFINES: { color: '#67e8f9', label: 'Defines', sizeMultiplier: 0.5 },
  DECORATES: { color: '#fde68a', label: 'Decorates', sizeMultiplier: 0.6 },
  EXTENDS: { color: '#fdba74', label: 'Extends', sizeMultiplier: 1.0 },
  IMPLEMENTS: { color: '#f9a8d4', label: 'Implements', sizeMultiplier: 0.9 },
  HAS_METHOD: { color: '#5eead4', label: 'Has Method', sizeMultiplier: 0.55 },
  HAS_PROPERTY: { color: '#cbd5e1', label: 'Has Property', sizeMultiplier: 0.45 },
  ACCESSES: { color: '#fcd34d', label: 'Accesses', sizeMultiplier: 0.55 },
  OVERRIDES: { color: '#ffedd5', label: 'Overrides', sizeMultiplier: 0.85 },
  MEMBER_OF: { color: '#a5b4fc', label: 'Member Of', sizeMultiplier: 0.3 },
  STEP_IN_PROCESS: { color: '#fb7185', label: 'Process Step', sizeMultiplier: 0.65 },
  HANDLES_ROUTE: { color: '#be123c', label: 'Handles Route', sizeMultiplier: 0.8 },
  FETCHES: { color: '#7dd3fc', label: 'Fetches', sizeMultiplier: 0.7 },
  HANDLES_TOOL: { color: '#c4b5fd', label: 'Handles Tool', sizeMultiplier: 0.8 },
  ENTRY_POINT_OF: { color: '#99f6e4', label: 'Entry Point', sizeMultiplier: 0.75 },
  WRAPS: { color: '#e9d5ff', label: 'Wraps', sizeMultiplier: 0.6 },
  QUERIES: { color: '#bfdbfe', label: 'Queries', sizeMultiplier: 0.6 },
  RUNTIME_MAPS_TO: { color: '#bbf7d0', label: 'Runtime Maps To', sizeMultiplier: 1.0 },
  RUNTIME_OBSERVED_IN: { color: '#fef3c7', label: 'Runtime Observed In', sizeMultiplier: 0.9 },
  RUNTIME_HAS_SIGNAL: { color: '#fca5a5', label: 'Runtime Signal', sizeMultiplier: 0.9 },
};

export const FALLBACK_EDGE_STYLE: EdgeStyle = {
  color: GRAPH_SURFACE_COLORS.fallbackEdge,
  label: 'Relationship',
  sizeMultiplier: 0.5,
};

export const getEdgeStyle = (edgeType: string): EdgeStyle =>
  Object.prototype.hasOwnProperty.call(EDGE_STYLES, edgeType)
    ? EDGE_STYLES[edgeType as EdgeType]
    : FALLBACK_EDGE_STYLE;

export const EDGE_INFO = Object.fromEntries(
  ALL_EDGE_TYPES.map((edgeType) => {
    const { color, label } = EDGE_STYLES[edgeType];
    return [edgeType, { color, label }];
  }),
) as Record<EdgeType, { color: string; label: string }>;
