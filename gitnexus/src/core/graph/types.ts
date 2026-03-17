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
  | 'Template';


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
  // Code complexity metrics
  cyclomaticComplexity?: number,
  fanIn?: number,
  fanOut?: number,
  loc?: number,
  instability?: number,
  complexityRank?: 'low' | 'medium' | 'high' | 'critical',
  // Method signature (for MRO disambiguation)
  parameterCount?: number,
  returnType?: string,
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
  | 'MEMBER_OF'
  | 'STEP_IN_PROCESS'

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
