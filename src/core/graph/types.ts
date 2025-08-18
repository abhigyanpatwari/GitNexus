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
  | 'CodeElement';

export interface GraphNode {
  id: string;
  label: NodeLabel;
  properties: NodeProperties;
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
  | 'ACCESSES'
  | 'EXTENDS'
  | 'BELONGS_TO';

export interface GraphRelationship {
  id: string;
  type: RelationshipType;
  source: string;
  target: string;
  properties: RelationshipProperties;
}

// Type-safe property interfaces
export interface NodeProperties {
  // Common properties
  name?: string;
  path?: string;
  filePath?: string;
  extension?: string;
  language?: string;
  size?: number;
  
  // Project-specific
  description?: string;
  version?: string;
  
  // File-specific
  definitionCount?: number;
  lineCount?: number;
  
  // Definition-specific
  type?: string;
  startLine?: number;
  endLine?: number;
  qualifiedName?: string;
  parameters?: string[];
  returnType?: string;
  
  // Relationship-specific
  relationshipType?: string;
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface RelationshipProperties {
  // Common properties
  strength?: number;
  confidence?: number;
  
  // Import-specific
  importType?: 'default' | 'named' | 'namespace' | 'dynamic';
  alias?: string;
  
  // Call-specific
  callType?: 'function' | 'method' | 'constructor';
  arguments?: string[];
  
  // Dependency-specific
  dependencyType?: 'direct' | 'transitive' | 'dev';
  version?: string;
  
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}
