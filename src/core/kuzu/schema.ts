/**
 * KuzuDB Schema Definitions
 * 
 * Hybrid Schema:
 * - Separate node tables for each code element type (File, Function, Class, etc.)
 * - Single CodeRelation table with 'type' property for all relationships
 * 
 * This allows LLMs to write natural Cypher queries like:
 *   MATCH (f:Function)-[r:CodeRelation {type: 'CALLS'}]->(g:Function) RETURN f, g
 */

// ============================================================================
// NODE TABLE NAMES
// ============================================================================
export const NODE_TABLES = ['File', 'Folder', 'Function', 'Class', 'Interface', 'Method', 'CodeElement'] as const;
export type NodeTableName = typeof NODE_TABLES[number];

// ============================================================================
// RELATION TABLE
// ============================================================================
export const REL_TABLE_NAME = 'CodeRelation';

// Valid relation types
export const REL_TYPES = ['CONTAINS', 'DEFINES', 'IMPORTS', 'CALLS', 'EXTENDS', 'IMPLEMENTS'] as const;
export type RelType = typeof REL_TYPES[number];

// ============================================================================
// EMBEDDING TABLE
// ============================================================================
export const EMBEDDING_TABLE_NAME = 'CodeEmbedding';

// ============================================================================
// NODE TABLE SCHEMAS
// ============================================================================

export const FILE_SCHEMA = `
CREATE NODE TABLE File (
  id STRING,
  name STRING,
  filePath STRING,
  content STRING,
  PRIMARY KEY (id)
)`;

export const FOLDER_SCHEMA = `
CREATE NODE TABLE Folder (
  id STRING,
  name STRING,
  filePath STRING,
  PRIMARY KEY (id)
)`;

export const FUNCTION_SCHEMA = `
CREATE NODE TABLE Function (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  content STRING,
  PRIMARY KEY (id)
)`;

export const CLASS_SCHEMA = `
CREATE NODE TABLE Class (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  content STRING,
  PRIMARY KEY (id)
)`;

export const INTERFACE_SCHEMA = `
CREATE NODE TABLE Interface (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  content STRING,
  PRIMARY KEY (id)
)`;

export const METHOD_SCHEMA = `
CREATE NODE TABLE Method (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  content STRING,
  PRIMARY KEY (id)
)`;

export const CODE_ELEMENT_SCHEMA = `
CREATE NODE TABLE CodeElement (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  content STRING,
  PRIMARY KEY (id)
)`;

// ============================================================================
// RELATION TABLE SCHEMA
// Single table with 'type' property - connects all node tables
// ============================================================================

export const RELATION_SCHEMA = `
CREATE REL TABLE ${REL_TABLE_NAME} (
  FROM File TO File,
  FROM File TO Folder,
  FROM File TO Function,
  FROM File TO Class,
  FROM File TO Interface,
  FROM File TO Method,
  FROM File TO CodeElement,
  FROM Folder TO Folder,
  FROM Folder TO File,
  FROM Function TO Function,
  FROM Function TO Method,
  FROM Class TO Method,
  FROM Class TO Function,
  FROM Class TO Class,
  FROM Class TO Interface,
  type STRING
)`;

// ============================================================================
// EMBEDDING TABLE SCHEMA
// Separate table for vector storage to avoid copy-on-write overhead
// ============================================================================

export const EMBEDDING_SCHEMA = `
CREATE NODE TABLE ${EMBEDDING_TABLE_NAME} (
  nodeId STRING,
  embedding FLOAT[384],
  PRIMARY KEY (nodeId)
)`;

/**
 * Create vector index for semantic search
 * Uses HNSW (Hierarchical Navigable Small World) algorithm with cosine similarity
 */
export const CREATE_VECTOR_INDEX_QUERY = `
CALL CREATE_VECTOR_INDEX('${EMBEDDING_TABLE_NAME}', 'code_embedding_idx', 'embedding', metric := 'cosine')
`;

// ============================================================================
// DATABASE INDEXES FOR QUERY PERFORMANCE
// ============================================================================
// These indexes significantly improve query performance for common operations
// like searching by name or filePath. Without indexes, KuzuDB performs full
// table scans for WHERE clauses on these columns.

export const INDEX_QUERIES = [
  // File table indexes
  'CREATE INDEX IF NOT EXISTS idx_file_name ON File (name)',
  'CREATE INDEX IF NOT EXISTS idx_file_filepath ON File (filePath)',

  // Function table indexes
  'CREATE INDEX IF NOT EXISTS idx_function_name ON Function (name)',
  'CREATE INDEX IF NOT EXISTS idx_function_filepath ON Function (filePath)',

  // Class table indexes
  'CREATE INDEX IF NOT EXISTS idx_class_name ON Class (name)',
  'CREATE INDEX IF NOT EXISTS idx_class_filepath ON Class (filePath)',

  // Interface table indexes
  'CREATE INDEX IF NOT EXISTS idx_interface_name ON Interface (name)',
  'CREATE INDEX IF NOT EXISTS idx_interface_filepath ON Interface (filePath)',

  // Method table indexes
  'CREATE INDEX IF NOT EXISTS idx_method_name ON Method (name)',
  'CREATE INDEX IF NOT EXISTS idx_method_filepath ON Method (filePath)',

  // CodeElement table indexes
  'CREATE INDEX IF NOT EXISTS idx_codeelement_name ON CodeElement (name)',
  'CREATE INDEX IF NOT EXISTS idx_codeelement_filepath ON CodeElement (filePath)',

  // Folder table index (no filePath needed, name is enough)
  'CREATE INDEX IF NOT EXISTS idx_folder_name ON Folder (name)',
];

// ============================================================================
// ALL SCHEMA QUERIES IN ORDER
// Node tables must be created before relationship tables that reference them
// ============================================================================

export const NODE_SCHEMA_QUERIES = [
  FILE_SCHEMA,
  FOLDER_SCHEMA,
  FUNCTION_SCHEMA,
  CLASS_SCHEMA,
  INTERFACE_SCHEMA,
  METHOD_SCHEMA,
  CODE_ELEMENT_SCHEMA,
];

export const REL_SCHEMA_QUERIES = [
  RELATION_SCHEMA,
];

export const SCHEMA_QUERIES = [
  ...NODE_SCHEMA_QUERIES,
  ...REL_SCHEMA_QUERIES,
  EMBEDDING_SCHEMA,
];

// Full initialization includes indexes for optimal query performance
export const ALL_SCHEMA_QUERIES = [
  ...SCHEMA_QUERIES,
  ...INDEX_QUERIES,
];
