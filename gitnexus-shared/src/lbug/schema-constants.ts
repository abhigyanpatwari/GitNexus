/**
 * LadybugDB schema constants — single source of truth.
 *
 * NODE_TABLES and REL_TYPES define what the knowledge graph can contain.
 * Both CLI and web must agree on these for data compatibility.
 *
 * Full DDL schemas remain in each package's own schema.ts because
 * the CLI uses native LadybugDB and the web uses WASM.
 */

export const NODE_TABLES = [
  'File',
  'Folder',
  'Function',
  'Class',
  'Interface',
  'Method',
  'CodeElement',
  'Community',
  'Process',
  'Section',
  'Struct',
  'Enum',
  'Macro',
  'Typedef',
  'Union',
  'Namespace',
  'Trait',
  'Impl',
  'TypeAlias',
  'Const',
  'Static',
  'Variable',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Constructor',
  'Template',
  'Module',
  'Route',
  'Tool',
] as const;

export type NodeTableName = (typeof NODE_TABLES)[number];

export const REL_TABLE_NAME = 'CodeRelation';

export const REL_TYPES = [
  'CONTAINS',
  'DEFINES',
  'IMPORTS',
  'CALLS',
  'EXTENDS',
  'IMPLEMENTS',
  'HAS_METHOD',
  'HAS_PROPERTY',
  'ACCESSES',
  'METHOD_OVERRIDES',
  'OVERRIDES', // Legacy compat alias — kept until all stored indexes are migrated
  'METHOD_IMPLEMENTS',
  'MEMBER_OF',
  'STEP_IN_PROCESS',
  'HANDLES_ROUTE',
  'FETCHES',
  'HANDLES_TOOL',
  'ENTRY_POINT_OF',
  'WRAPS',
  'QUERIES',
] as const;

export type RelType = (typeof REL_TYPES)[number];

export const EMBEDDING_TABLE_NAME = 'CodeEmbedding';
