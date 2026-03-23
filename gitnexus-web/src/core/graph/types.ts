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
  | 'Section';


export type NodeProperties = {
  name: string,
  filePath: string,
  startLine?: number,
  endLine?: number,
  language?: string,
  isExported?: boolean,
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
  nodes: GraphNode[],
  relationships: GraphRelationship[],
  nodeCount: number,
  relationshipCount: number,
  addNode: (node: GraphNode) => void,
  addRelationship: (relationship: GraphRelationship) => void,
}