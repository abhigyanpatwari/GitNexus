/**
 * LadybugDB Schema Definitions
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
export const NODE_TABLES = [
  'File', 'Folder', 'Function', 'Class', 'Interface', 'Method', 'CodeElement', 'Community', 'Process',
  'Route',
  // Multi-language support
  'Struct', 'Enum', 'Macro', 'Typedef', 'Union', 'Namespace', 'Trait', 'Impl',
  'TypeAlias', 'Const', 'Static', 'Property', 'Record', 'Delegate', 'Annotation', 'Constructor', 'Template', 'Module'
] as const;
export type NodeTableName = typeof NODE_TABLES[number];

// ============================================================================
// RELATION TABLE
// ============================================================================
export const REL_TABLE_NAME = 'CodeRelation';

// Valid relation types
export const REL_TYPES = [
  'CONTAINS', 'DEFINES', 'IMPORTS', 'CALLS',
  'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'OVERRIDES',
  'MEMBER_OF', 'STEP_IN_PROCESS', 'CROSS_IMPORTS',
  // Angular metadata edges (#32):
  'DECLARES', 'IMPORTS_MODULE', 'PROVIDES', 'BOOTSTRAPS',
  // Structural composition (Go anonymous embedding, #26):
  'COMPOSITION',
] as const;
export type RelType = typeof REL_TYPES[number];

// ============================================================================
// EMBEDDING TABLE
// ============================================================================
export const EMBEDDING_TABLE_NAME = 'CodeEmbedding';

// Default embedding dimensions (snowflake-arctic-embed-xs)
export function getEmbeddingDims(): number {
  return parseInt(process.env.GITNEXUS_EMBEDDING_DIMS ?? '384', 10);
}

// ============================================================================
// NODE TABLE SCHEMAS
// ============================================================================

// Cross-repo support - repoId column for multi-repo resolution
// Migration (for existing databases): ALTER TABLE File ADD repoId STRING
export const FILE_SCHEMA = `
CREATE NODE TABLE File (
  id STRING,
  name STRING,
  filePath STRING,
  content STRING,
  repoId STRING,
  PRIMARY KEY (id)
)`;
// Migration statement for backward compatibility with existing databases
export const FILE_SCHEMA_MIGRATION = `
ALTER TABLE File ADD repoId STRING`;

export const FOLDER_SCHEMA = `
CREATE NODE TABLE Folder (
  id STRING,
  name STRING,
  filePath STRING,
  repoId STRING,
  PRIMARY KEY (id)
)`;
// Migration for cross-repo support
export const FOLDER_SCHEMA_MIGRATION = `
ALTER TABLE Folder ADD repoId STRING`;

export const FUNCTION_SCHEMA = `
CREATE NODE TABLE Function (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  parameterCount INT32,
  returnType STRING,
  repoId STRING,
  PRIMARY KEY (id)
)`;
// Migration for cross-repo support
export const FUNCTION_SCHEMA_MIGRATION = `
ALTER TABLE Function ADD repoId STRING`;
// #86: Migration for parameterCount/returnType so existing DBs pick up the
// new columns without a re-create. Mirrors METHOD_SCHEMA_MIGRATION_2's
// additive pattern; the runner's error-suppression in lbug-adapter
// catches the "already has property" thrown on re-runs against an existing DB.
export const FUNCTION_SCHEMA_MIGRATION_2 = `
ALTER TABLE Function ADD parameterCount INT32;
ALTER TABLE Function ADD returnType STRING`;

export const CLASS_SCHEMA = `
CREATE NODE TABLE Class (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  fields STRING,
  annotations STRING,
  repoId STRING,
  PRIMARY KEY (id)
)`;
// Migration for cross-repo support
export const CLASS_SCHEMA_MIGRATION = `
ALTER TABLE Class ADD repoId STRING`;

export const INTERFACE_SCHEMA = `
CREATE NODE TABLE Interface (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  repoId STRING,
  PRIMARY KEY (id)
)`;
// Migration for cross-repo support
export const INTERFACE_SCHEMA_MIGRATION = `
ALTER TABLE Interface ADD repoId STRING`;

export const METHOD_SCHEMA = `
CREATE NODE TABLE Method (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  parameterCount INT32,
  returnType STRING,
  parameters STRING,
  annotations STRING,
  parameterAnnotations STRING,
  repoId STRING,
  PRIMARY KEY (id)
)`;
// Migration for cross-repo support
export const METHOD_SCHEMA_MIGRATION = `
ALTER TABLE Method ADD repoId STRING`;
// Migration for parameter annotations
export const METHOD_SCHEMA_MIGRATION_2 = `
ALTER TABLE Method ADD parameterAnnotations STRING`;

export const CODE_ELEMENT_SCHEMA = `
CREATE NODE TABLE CodeElement (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  isExported BOOLEAN,
  content STRING,
  description STRING,
  repoId STRING,
  PRIMARY KEY (id)
)`;
// Migration for cross-repo support
export const CODE_ELEMENT_SCHEMA_MIGRATION = `
ALTER TABLE CodeElement ADD repoId STRING`;

// ============================================================================
// COMMUNITY NODE TABLE (for Leiden algorithm clusters)
// ============================================================================

export const COMMUNITY_SCHEMA = `
CREATE NODE TABLE Community (
  id STRING,
  label STRING,
  heuristicLabel STRING,
  keywords STRING[],
  description STRING,
  enrichedBy STRING,
  cohesion DOUBLE,
  symbolCount INT32,
  repoId STRING,
  PRIMARY KEY (id)
)`;
// Migration for cross-repo support
export const COMMUNITY_SCHEMA_MIGRATION = `
ALTER TABLE Community ADD repoId STRING`;

// ============================================================================
// PROCESS NODE TABLE (for execution flow detection)
// ============================================================================

export const PROCESS_SCHEMA = `
CREATE NODE TABLE Process (
  id STRING,
  label STRING,
  heuristicLabel STRING,
  processType STRING,
  stepCount INT32,
  communities STRING[],
  entryPointId STRING,
  terminalId STRING,
  repoId STRING,
  PRIMARY KEY (id)
)`;
// Migration for cross-repo support
export const PROCESS_SCHEMA_MIGRATION = `
ALTER TABLE Process ADD repoId STRING`;

// ============================================================================
// ROUTE NODE TABLE SCHEMA (Spring, Laravel, etc. HTTP endpoints)
// ============================================================================

export const ROUTE_SCHEMA = `
CREATE NODE TABLE Route (
  id STRING,
  name STRING,
  httpMethod STRING,
  routePath STRING,
  controllerName STRING,
  methodName STRING,
  filePath STRING,
  startLine INT64,
  lineNumber INT64,
  isInherited BOOLEAN,
  repoId STRING,
  responseKeys STRING[],
  errorKeys STRING[],
  middleware STRING[],
  controllerClass STRING,
  handlerMethod STRING,
  isControllerClass BOOLEAN,
  prefix STRING,
  PRIMARY KEY (id)
)`;
// Migration for cross-repo support + (#67) Route property aliases.
// 8 statements, split on `;` at the runner. Kùzu rejects `IF NOT EXISTS`
// in ALTER — the runner's "already has property" suppression keeps this
// idempotent on re-runs against an existing DB.
export const ROUTE_SCHEMA_MIGRATION = `
ALTER TABLE Route ADD repoId STRING;
ALTER TABLE Route ADD responseKeys STRING[];
ALTER TABLE Route ADD errorKeys STRING[];
ALTER TABLE Route ADD middleware STRING[];
ALTER TABLE Route ADD controllerClass STRING;
ALTER TABLE Route ADD handlerMethod STRING;
ALTER TABLE Route ADD isControllerClass BOOLEAN;
ALTER TABLE Route ADD prefix STRING`;

// ============================================================================
// MULTI-LANGUAGE NODE TABLE SCHEMAS
// ============================================================================

// Generic code element with startLine/endLine and repoId for cross-repo support
// description: optional metadata (e.g. Eloquent $fillable fields, relationship targets)
const CODE_ELEMENT_BASE = (name: string) => `
CREATE NODE TABLE \`${name}\` (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  content STRING,
  description STRING,
  repoId STRING,
  PRIMARY KEY (id)
)`;
// Migration helper for cross-repo support.
// Kùzu's ALTER TABLE does NOT support `IF NOT EXISTS` — it must be a plain
// `ALTER TABLE \`X\` ADD col TYPE` statement. The runner's error-suppression
// loop in lbug-adapter.doInitLbug catches the "already has property" error
// thrown on re-runs against an existing DB, keeping the migrations idempotent.
const CODE_ELEMENT_MIGRATION = (name: string) => `
ALTER TABLE \`${name}\` ADD repoId STRING`;

export const STRUCT_SCHEMA = CODE_ELEMENT_BASE('Struct');
export const ENUM_SCHEMA = CODE_ELEMENT_BASE('Enum');
export const MACRO_SCHEMA = CODE_ELEMENT_BASE('Macro');
export const TYPEDEF_SCHEMA = CODE_ELEMENT_BASE('Typedef');
export const UNION_SCHEMA = CODE_ELEMENT_BASE('Union');
export const NAMESPACE_SCHEMA = CODE_ELEMENT_BASE('Namespace');
export const TRAIT_SCHEMA = CODE_ELEMENT_BASE('Trait');
export const IMPL_SCHEMA = CODE_ELEMENT_BASE('Impl');
export const TYPE_ALIAS_SCHEMA = CODE_ELEMENT_BASE('TypeAlias');
export const CONST_SCHEMA = CODE_ELEMENT_BASE('Const');
export const STATIC_SCHEMA = CODE_ELEMENT_BASE('Static');
export const PROPERTY_SCHEMA = CODE_ELEMENT_BASE('Property');
export const RECORD_SCHEMA = CODE_ELEMENT_BASE('Record');
export const DELEGATE_SCHEMA = CODE_ELEMENT_BASE('Delegate');
export const ANNOTATION_SCHEMA = CODE_ELEMENT_BASE('Annotation');
export const CONSTRUCTOR_SCHEMA = CODE_ELEMENT_BASE('Constructor');
export const TEMPLATE_SCHEMA = CODE_ELEMENT_BASE('Template');
export const MODULE_SCHEMA = CODE_ELEMENT_BASE('Module');

// Migration exports for multi-language schemas
export const STRUCT_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('Struct');
export const ENUM_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('Enum');
export const MACRO_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('Macro');
export const TYPEDEF_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('Typedef');
export const UNION_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('Union');
export const NAMESPACE_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('Namespace');
export const TRAIT_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('Trait');
export const IMPL_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('Impl');
export const TYPE_ALIAS_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('TypeAlias');
export const CONST_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('Const');
export const STATIC_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('Static');
export const PROPERTY_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('Property');
export const RECORD_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('Record');
export const DELEGATE_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('Delegate');
export const ANNOTATION_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('Annotation');
export const CONSTRUCTOR_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('Constructor');
export const TEMPLATE_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('Template');
export const MODULE_SCHEMA_MIGRATION = CODE_ELEMENT_MIGRATION('Module');

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
  FROM File TO \`Struct\`,
  FROM File TO \`Enum\`,
  FROM File TO \`Macro\`,
  FROM File TO \`Typedef\`,
  FROM File TO \`Union\`,
  FROM File TO \`Namespace\`,
  FROM File TO \`Trait\`,
  FROM File TO \`Impl\`,
  FROM File TO \`TypeAlias\`,
  FROM File TO \`Const\`,
  FROM File TO \`Static\`,
  FROM File TO \`Property\`,
  FROM File TO \`Record\`,
  FROM File TO \`Delegate\`,
  FROM File TO \`Annotation\`,
  FROM File TO \`Constructor\`,
  FROM File TO \`Template\`,
  FROM File TO \`Module\`,
  FROM File TO Route,
  FROM Folder TO Folder,
  FROM Folder TO File,
  FROM Function TO Function,
  FROM Function TO Method,
  FROM Function TO Class,
  FROM Function TO Community,
  FROM Function TO \`Macro\`,
  FROM Function TO \`Struct\`,
  FROM Function TO \`Template\`,
  FROM Function TO \`Enum\`,
  FROM Function TO \`Namespace\`,
  FROM Function TO \`TypeAlias\`,
  FROM Function TO \`Module\`,
  FROM Function TO \`Impl\`,
  FROM Function TO Interface,
  FROM Function TO \`Constructor\`,
  FROM Function TO \`Const\`,
  FROM Function TO \`Typedef\`,
  FROM Function TO \`Union\`,
  FROM Function TO \`Property\`,
  FROM Function TO Route,
  FROM Class TO Method,
  FROM Class TO Function,
  FROM Class TO Class,
  FROM Class TO Interface,
  FROM Class TO Community,
  FROM Class TO \`Template\`,
  FROM Class TO \`TypeAlias\`,
  FROM Class TO \`Struct\`,
  FROM Class TO \`Enum\`,
  FROM Class TO \`Annotation\`,
  FROM Class TO \`Constructor\`,
  FROM Class TO \`Trait\`,
  FROM Class TO \`Macro\`,
  FROM Class TO \`Impl\`,
  FROM Class TO \`Union\`,
  FROM Class TO \`Namespace\`,
  FROM Class TO \`Typedef\`,
  FROM Class TO \`Property\`,
  FROM Method TO Function,
  FROM Method TO Method,
  FROM Method TO Class,
  FROM Method TO Community,
  FROM Method TO \`Template\`,
  FROM Method TO \`Struct\`,
  FROM Method TO \`TypeAlias\`,
  FROM Method TO \`Enum\`,
  FROM Method TO \`Macro\`,
  FROM Method TO \`Namespace\`,
  FROM Method TO \`Module\`,
  FROM Method TO \`Impl\`,
  FROM Method TO Interface,
  FROM Method TO \`Constructor\`,
  FROM Method TO \`Property\`,
  FROM \`Template\` TO \`Template\`,
  FROM \`Template\` TO Function,
  FROM \`Template\` TO Method,
  FROM \`Template\` TO Class,
  FROM \`Template\` TO \`Struct\`,
  FROM \`Template\` TO \`TypeAlias\`,
  FROM \`Template\` TO \`Enum\`,
  FROM \`Template\` TO \`Macro\`,
  FROM \`Template\` TO Interface,
  FROM \`Template\` TO \`Constructor\`,
  FROM \`Module\` TO \`Module\`,
  FROM CodeElement TO Community,
  FROM Interface TO Community,
  FROM Interface TO Function,
  FROM Interface TO Method,
  FROM Interface TO Class,
  FROM Interface TO Interface,
  FROM Interface TO \`TypeAlias\`,
  FROM Interface TO \`Struct\`,
  FROM Interface TO \`Constructor\`,
  FROM Interface TO \`Property\`,
  FROM \`Struct\` TO Community,
  FROM \`Struct\` TO \`Trait\`,
  FROM \`Struct\` TO \`Struct\`,
  FROM \`Struct\` TO Class,
  FROM \`Struct\` TO \`Enum\`,
  FROM \`Struct\` TO Function,
  FROM \`Struct\` TO Method,
  FROM \`Struct\` TO Interface,
  FROM \`Struct\` TO \`Constructor\`,
  FROM \`Struct\` TO \`Property\`,
  FROM \`Enum\` TO \`Enum\`,
  FROM \`Enum\` TO Community,
  FROM \`Enum\` TO Class,
  FROM \`Enum\` TO Interface,
  FROM \`Macro\` TO Community,
  FROM \`Macro\` TO Function,
  FROM \`Macro\` TO Method,
  FROM \`Module\` TO Function,
  FROM \`Module\` TO Method,
  FROM \`Typedef\` TO Community,
  FROM \`Union\` TO Community,
  FROM \`Namespace\` TO Community,
  FROM \`Namespace\` TO \`Struct\`,
  FROM \`Trait\` TO Method,
  FROM \`Trait\` TO \`Constructor\`,
  FROM \`Trait\` TO \`Property\`,
  FROM \`Trait\` TO Community,
  FROM \`Impl\` TO Method,
  FROM \`Impl\` TO \`Constructor\`,
  FROM \`Impl\` TO \`Property\`,
  FROM \`Impl\` TO Community,
  FROM \`Impl\` TO \`Trait\`,
  FROM \`Impl\` TO \`Struct\`,
  FROM \`Impl\` TO \`Impl\`,
  FROM \`TypeAlias\` TO Community,
  FROM \`TypeAlias\` TO \`Trait\`,
  FROM \`TypeAlias\` TO Class,
  FROM \`Const\` TO Community,
  FROM \`Static\` TO Community,
  FROM \`Property\` TO Community,
  FROM \`Record\` TO Method,
  FROM \`Record\` TO \`Constructor\`,
  FROM \`Record\` TO \`Property\`,
  FROM \`Record\` TO Community,
  FROM \`Delegate\` TO Community,
  FROM \`Annotation\` TO Community,
  FROM \`Constructor\` TO Community,
  FROM \`Constructor\` TO Interface,
  FROM \`Constructor\` TO Class,
  FROM \`Constructor\` TO Method,
  FROM \`Constructor\` TO Function,
  FROM \`Constructor\` TO \`Constructor\`,
  FROM \`Constructor\` TO \`Struct\`,
  FROM \`Constructor\` TO \`Macro\`,
  FROM \`Constructor\` TO \`Template\`,
  FROM \`Constructor\` TO \`TypeAlias\`,
  FROM \`Constructor\` TO \`Enum\`,
  FROM \`Constructor\` TO \`Annotation\`,
  FROM \`Constructor\` TO \`Impl\`,
  FROM \`Constructor\` TO \`Namespace\`,
  FROM \`Constructor\` TO \`Module\`,
  FROM \`Constructor\` TO \`Property\`,
  FROM \`Constructor\` TO \`Typedef\`,
  FROM \`Template\` TO Community,
  FROM \`Module\` TO Community,
  FROM Function TO Process,
  FROM Method TO Process,
  FROM Class TO Process,
  FROM Interface TO Process,
  FROM \`Struct\` TO Process,
  FROM \`Constructor\` TO Process,
  FROM \`Module\` TO Process,
  FROM \`Macro\` TO Process,
  FROM \`Impl\` TO Process,
  FROM \`Typedef\` TO Process,
  FROM \`TypeAlias\` TO Process,
  FROM \`Enum\` TO Process,
  FROM \`Union\` TO Process,
  FROM \`Namespace\` TO Process,
  FROM \`Trait\` TO Process,
  FROM \`Const\` TO Process,
  FROM \`Static\` TO Process,
  FROM \`Property\` TO Process,
  FROM \`Record\` TO Process,
  FROM \`Delegate\` TO Process,
  FROM \`Annotation\` TO Process,
  FROM \`Template\` TO Process,
  FROM CodeElement TO Process,
  FROM Route TO Method,
  FROM Route TO Function,
  FROM Route TO Community,
  FROM Route TO Process,
  type STRING,
  confidence DOUBLE,
  reason STRING,
  step INT32
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
  COMMUNITY_SCHEMA,
  PROCESS_SCHEMA,
  ROUTE_SCHEMA,
  // Multi-language support
  STRUCT_SCHEMA,
  ENUM_SCHEMA,
  MACRO_SCHEMA,
  TYPEDEF_SCHEMA,
  UNION_SCHEMA,
  NAMESPACE_SCHEMA,
  TRAIT_SCHEMA,
  IMPL_SCHEMA,
  TYPE_ALIAS_SCHEMA,
  CONST_SCHEMA,
  STATIC_SCHEMA,
  PROPERTY_SCHEMA,
  RECORD_SCHEMA,
  DELEGATE_SCHEMA,
  ANNOTATION_SCHEMA,
  CONSTRUCTOR_SCHEMA,
  TEMPLATE_SCHEMA,
  MODULE_SCHEMA,
];

export const REL_SCHEMA_QUERIES = [
  RELATION_SCHEMA,
];

export const SCHEMA_QUERIES = [
  ...NODE_SCHEMA_QUERIES,
  ...REL_SCHEMA_QUERIES,
  EMBEDDING_SCHEMA,
];

/**
 * Ordered list of all `*_MIGRATION[_N]` constants.
 *
 * The migration runner in `lbug-adapter.doInitLbug` iterates this array after
 * `SCHEMA_QUERIES` and executes each entry. Every `*_MIGRATION[_N]` constant
 * in this file MUST be listed here exactly once.
 *
 * How to add a new migration:
 * 1. Define a new `*_MIGRATION_N` constant (use `ALTER TABLE ... ADD col TYPE`).
 *    Kùzu's ALTER does not support `IF NOT EXISTS` — the runner suppresses
 *    the "already has property" error on re-runs.
 * 2. Append it to this array on a new line.
 *
 * Multi-statement migrations (currently `FUNCTION_SCHEMA_MIGRATION_2` and
 * `ROUTE_SCHEMA_MIGRATION`) are split on `;` at the runner — the constants
 * stay readable as a single block in the schema file.
 */
export const SCHEMA_MIGRATIONS = [
  FILE_SCHEMA_MIGRATION,
  FOLDER_SCHEMA_MIGRATION,
  FUNCTION_SCHEMA_MIGRATION,
  FUNCTION_SCHEMA_MIGRATION_2,         // multi-statement (2 stmts)
  CLASS_SCHEMA_MIGRATION,
  INTERFACE_SCHEMA_MIGRATION,
  METHOD_SCHEMA_MIGRATION,
  METHOD_SCHEMA_MIGRATION_2,
  CODE_ELEMENT_SCHEMA_MIGRATION,
  COMMUNITY_SCHEMA_MIGRATION,
  PROCESS_SCHEMA_MIGRATION,
  ROUTE_SCHEMA_MIGRATION,              // multi-statement (8 stmts)
  STRUCT_SCHEMA_MIGRATION,
  ENUM_SCHEMA_MIGRATION,
  MACRO_SCHEMA_MIGRATION,
  TYPEDEF_SCHEMA_MIGRATION,
  UNION_SCHEMA_MIGRATION,
  NAMESPACE_SCHEMA_MIGRATION,
  TRAIT_SCHEMA_MIGRATION,
  IMPL_SCHEMA_MIGRATION,
  TYPE_ALIAS_SCHEMA_MIGRATION,
  CONST_SCHEMA_MIGRATION,
  STATIC_SCHEMA_MIGRATION,
  PROPERTY_SCHEMA_MIGRATION,
  RECORD_SCHEMA_MIGRATION,
  DELEGATE_SCHEMA_MIGRATION,
  ANNOTATION_SCHEMA_MIGRATION,
  CONSTRUCTOR_SCHEMA_MIGRATION,
  TEMPLATE_SCHEMA_MIGRATION,
  MODULE_SCHEMA_MIGRATION,
];

/** Schema version derived from table count — increments when tables are added/removed. */
export const SCHEMA_VERSION = NODE_SCHEMA_QUERIES.length + REL_SCHEMA_QUERIES.length;
