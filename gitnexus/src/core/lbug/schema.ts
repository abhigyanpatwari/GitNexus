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

// Import from shared package (single source of truth) — used in DDL templates below
import { NODE_TABLES, REL_TABLE_NAME, REL_TYPES, EMBEDDING_TABLE_NAME } from 'gitnexus-shared';
// Re-export so downstream consumers keep the same import path
export { NODE_TABLES, REL_TABLE_NAME, REL_TYPES, EMBEDDING_TABLE_NAME };
export type { NodeTableName, RelType } from 'gitnexus-shared';

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
  isExported BOOLEAN,
  content STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

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
  PRIMARY KEY (id)
)`;

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
  PRIMARY KEY (id)
)`;

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
  PRIMARY KEY (id)
)`;

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
  PRIMARY KEY (id)
)`;

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
  PRIMARY KEY (id)
)`;

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
  PRIMARY KEY (id)
)`;

// ============================================================================
// MULTI-LANGUAGE NODE TABLE SCHEMAS
// ============================================================================

// Generic code element with startLine/endLine for C, C++, Rust, Go, Java, C#
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
  PRIMARY KEY (id)
)`;

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
// API route endpoints (Next.js, Express, etc.)
export const ROUTE_SCHEMA = `
CREATE NODE TABLE Route (
  id STRING,
  name STRING,
  filePath STRING,
  responseKeys STRING[],
  errorKeys STRING[],
  middleware STRING[],
  PRIMARY KEY (id)
)`;

// MCP tool definitions
export const TOOL_SCHEMA = `
CREATE NODE TABLE Tool (
  id STRING,
  name STRING,
  filePath STRING,
  description STRING,
  PRIMARY KEY (id)
)`;

// Markdown heading sections
export const SECTION_SCHEMA = `
CREATE NODE TABLE Section (
  id STRING,
  name STRING,
  filePath STRING,
  startLine INT64,
  endLine INT64,
  level INT64,
  content STRING,
  description STRING,
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
  FROM File TO Section,
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
  FROM Function TO CodeElement,
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
  FROM Method TO CodeElement,
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
  FROM Section TO Section,
  FROM Section TO File,
  FROM File TO Route,
  FROM Function TO Route,
  FROM Method TO Route,
  FROM File TO Tool,
  FROM Function TO Tool,
  FROM Method TO Tool,
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
  FROM Route TO Process,
  FROM Tool TO Process,
  type STRING,
  confidence DOUBLE,
  reason STRING,
  step INT32
)`;

// ============================================================================
// EMBEDDING TABLE SCHEMA
// Separate table for vector storage to avoid copy-on-write overhead
// ============================================================================

/** Embedding vector dimensions. Default 384 (snowflake-arctic-embed-xs). */
const _rawDims = parseInt(process.env.GITNEXUS_EMBEDDING_DIMS ?? '384', 10);
if (Number.isNaN(_rawDims) || _rawDims <= 0) {
  throw new Error(
    `GITNEXUS_EMBEDDING_DIMS must be a positive integer, got "${process.env.GITNEXUS_EMBEDDING_DIMS}"`,
  );
}
export const EMBEDDING_DIMS = _rawDims;

export const EMBEDDING_SCHEMA = `
CREATE NODE TABLE ${EMBEDDING_TABLE_NAME} (
  nodeId STRING,
  embedding FLOAT[${EMBEDDING_DIMS}],
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
  // Markdown support
  SECTION_SCHEMA,
  // API routes
  ROUTE_SCHEMA,
  // MCP tools
  TOOL_SCHEMA,
];

export const REL_SCHEMA_QUERIES = [RELATION_SCHEMA];

export const SCHEMA_QUERIES = [...NODE_SCHEMA_QUERIES, ...REL_SCHEMA_QUERIES, EMBEDDING_SCHEMA];
