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
  | 'Decorator';

export interface GraphNode {
  id: string;
  label: NodeLabel;
  properties: Record<string, unknown>;
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
  | 'ACCESSES';

export interface GraphRelationship {
  id: string;
  type: RelationshipType;
  source: string;
  target: string;
  properties?: Record<string, unknown>;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
} 
