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
  | 'Route'
  | 'Tool'
  | 'Delegate'
  | 'Annotation'
  | 'Constructor'
  | 'Template'
  | 'Section';


import { SupportedLanguages } from '../../config/supported-languages.js';

export type NodeProperties = {
  name: string,
  filePath?: string,
  // Cross-repo resolution — identifies which repo this node belongs to
  repoId?: string,
  // #50: marks a phantom File node that stands in for a symbol owned by an
  // indexed DEPENDENCY repo (created only when a CrossRepoRegistry is provided).
  isExternal?: boolean,
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
  requiredParameterCount?: number,
  parameterTypes?: string,  // JSON array of parameter type names
  returnType?: string,
  // Property visibility and modifiers
  visibility?: string,
  isStatic?: boolean,
  isReadonly?: boolean,
  declaredType?: string,
  // Route-specific properties (for HTTP endpoints)
  routeType?: string,
  httpMethod?: string,
  routePath?: string,
  controllerName?: string,
  // #67: spec-named aliases of the above — also exposed on Route nodes.
  controllerClass?: string,
  methodName?: string,
  handlerMethod?: string,
  lineNumber?: number,
  isInherited?: boolean,
  isControllerClass?: boolean,
  // @RequestMapping prefix (e.g. /api/v1) — from ExtractedRoute.prefix
  prefix?: string,
  // Response shape (top-level keys from NextResponse.json({...}) / res.json({...}))
  responseKeys?: string[],
  // Error response shape (top-level keys from .json() calls with status >= 400)
  errorKeys?: string[],
  // Middleware wrapper chain (outermost first): ['withRateLimit', 'withCSRF', 'withAuth']
  middleware?: string[],
  // Class fields (for DTO/Entity schema resolution)
  fields?: string,
  // Annotations (for Java/Kotlin)
  annotations?: string,
  // Section level (for markdown)
  level?: number,
  // ORM model / entity type name
  entityType?: string,
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
  | 'MEMBER_OF'
  | 'STEP_IN_PROCESS'
  // Cross-repo dependency tracking
  | 'CROSS_IMPORTS'
  // Additional relationship types
  | 'ACCESSES'
  | 'FETCHES'
  | 'QUERIES'
  | 'HANDLES_ROUTE'
  | 'HANDLES_TOOL'
  | 'ENTRY_POINT_OF'
  | 'WRAPS'
  // Angular @NgModule metadata edges (#32)
  | 'DECLARES'
  | 'IMPORTS_MODULE'
  | 'PROVIDES'
  | 'BOOTSTRAPS'
  // Structural composition: owner has a field/embedding of the target (e.g. Go anonymous field).
  | 'COMPOSITION'

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
  /** Resolution reason: 'import-resolved', 'same-file', 'fuzzy-global', or empty for non-CALLS */
  reason: string,
  /** Step number for STEP_IN_PROCESS relationships (1-indexed) */
  step?: number,
  /**
   * Edge provenance tag (WI-1 / #159 P3 Mode A).
   * Optional at the type level so every existing rel constructor stays
   * valid; the CSV/COPY serializer in `streamAllCSVsToDisk` defaults
   * missing values to `'heuristic'`. Persisted as the `source` column
   * on the CodeRelation rel table.
   *
   * The union members are the SAME writers that mint edges — there
   * is no widening to `string` anywhere on the write path.
   */
  source?: EdgeSource;
  /**
   * 0-based source line of the call/parent identifier (WI-1 / #159).
   * In-memory only — NOT serialized to CSV. Carried ONLY on per-site
   * CALLS edges (heuristic + LSP-minted) and on heritage edges that
   * were emitted from a worker with a captured position. Absent on
   * synthetic edges (route/tool) and on legacy emitters that did not
   * capture a call name node. Used by the Mode A engine to make
   * collapse keys + correction lookup site-precise.
   */
  line?: number;
}

/**
 * The four values the `source` column on a `GraphRelationship` can
 * take. The `GraphRelationship.source` field references this union
 * directly; the reconciler's writer re-uses the SAME members (no
 * widening to `string`).
 */
export type EdgeSource = 'heuristic' | 'lsp-confirmed' | 'lsp-corrected' | 'lsp-recall';

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
  removeRelationship: (relationshipId: string) => boolean,
  removeNodesByFile: (filePath: string) => number,
}
