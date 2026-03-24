export type NodeLabel =
  | 'Project'
  | 'Package'
  | 'Module'
  | 'Folder'
  | 'File'
  | 'Class'
  | 'Function'
  | 'Method'
  | 'Variable'
  | 'Interface'
  | 'Enum'
  | 'Decorator'
  | 'Import'
  | 'Type'
  | 'CodeElement'
  | 'Community'
  | 'Process'
  // Multi-language node types
  | 'Struct'
  | 'Macro'
  | 'Typedef'
  | 'Union'
  | 'Namespace'
  | 'Trait'
  | 'Impl'
  | 'TypeAlias'
  | 'Const'
  | 'Static'
  | 'Property'
  | 'Record'
  | 'Delegate'
  | 'Annotation'
  | 'Constructor'
  | 'Template'
  | 'Section'
  | 'Route'        // API route endpoint (e.g., /api/grants)
  | 'Tool';        // MCP tool definition


import { SupportedLanguages } from '../../config/supported-languages.js';

export type NodeProperties = {
  name: string,
  filePath: string,
  startLine?: number,
  endLine?: number,
  language?: SupportedLanguages,
  isExported?: boolean,
  // Optional AST-derived framework hint (e.g. @Controller, @GetMapping)
  astFrameworkMultiplier?: number,
  astFrameworkReason?: string,
  // Community-specific properties
  heuristicLabel?: string,
  cohesion?: number,
  symbolCount?: number,
  keywords?: string[],
  description?: string,
  enrichedBy?: 'heuristic' | 'llm',
  // Process-specific properties
  processType?: 'intra_community' | 'cross_community',
  stepCount?: number,
  communities?: string[],
  entryPointId?: string,
  terminalId?: string,
  // Entry point scoring (computed by process detection)
  entryPointScore?: number,
  entryPointReason?: string,
  // Method signature (for MRO disambiguation)
  parameterCount?: number,
  // Section-specific (markdown heading level, 1-6)
  level?: number,
  returnType?: string,
  // Response shape (top-level keys from NextResponse.json({...}) / res.json({...}))
  responseKeys?: string[],
  // Error response shape (top-level keys from .json() calls with status >= 400)
  errorKeys?: string[],
  // Middleware wrapper chain (outermost first): ['withRateLimit', 'withCSRF', 'withAuth']
  middleware?: string[],
}

export type RelationshipType =
  | 'CONTAINS'
  | 'CALLS'
  | 'INHERITS'
  | 'OVERRIDES'
  | 'IMPORTS'
  | 'USES'
  | 'DEFINES'
  | 'DECORATES'
  | 'IMPLEMENTS'
  | 'EXTENDS'
  | 'HAS_METHOD'
  | 'HAS_PROPERTY'
  | 'ACCESSES'
  | 'MEMBER_OF'
  | 'STEP_IN_PROCESS'
  | 'HANDLES_ROUTE'  // Function/File → Route (handler serves this endpoint)
  | 'FETCHES'        // Function/File → Route (consumer calls this endpoint)
  | 'HANDLES_TOOL'   // Function/File → Tool (handler implements this tool)
  | 'ENTRY_POINT_OF'  // Route/Tool → Process (this endpoint starts this execution flow)
  | 'WRAPS'           // Function → Function (middleware wrapper chain) — Reserved: future middleware graph traversal (not yet emitted)

export interface GraphNode {
  id:  string,
  label: NodeLabel,
  properties: NodeProperties,  
}

export interface GraphRelationship {
  id: string,
  sourceId: string,
  targetId: string,
  type: RelationshipType,
  /** Confidence score 0-1 (1.0 = certain, lower = uncertain resolution) */
  confidence: number,
  /** Semantics are edge-type-dependent: CALLS uses resolution tier, ACCESSES uses 'read'/'write', OVERRIDES uses MRO reason */
  reason: string,
  /** Step number for STEP_IN_PROCESS relationships (1-indexed) */
  step?: number,
}

export interface KnowledgeGraph {
  /** Returns a full array copy — prefer iterNodes() for iteration */
  nodes: GraphNode[],
  /** Returns a full array copy — prefer iterRelationships() for iteration */
  relationships: GraphRelationship[],
  /** Zero-copy iterator over nodes */
  iterNodes: () => IterableIterator<GraphNode>,
  /** Zero-copy iterator over relationships */
  iterRelationships: () => IterableIterator<GraphRelationship>,
  /** Zero-copy forEach — avoids iterator protocol overhead in hot loops */
  forEachNode: (fn: (node: GraphNode) => void) => void,
  forEachRelationship: (fn: (rel: GraphRelationship) => void) => void,
  /** Lookup a single node by id — O(1) */
  getNode: (id: string) => GraphNode | undefined,
  nodeCount: number,
  relationshipCount: number,
  addNode: (node: GraphNode) => void,
  addRelationship: (relationship: GraphRelationship) => void,
  removeNode: (nodeId: string) => boolean,
  removeNodesByFile: (filePath: string) => number,
}
