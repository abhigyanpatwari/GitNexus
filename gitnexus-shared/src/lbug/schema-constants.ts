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
  // Taint/PDG substrate (issue #2080) — inert until M1 (#2081) emits blocks.
  'BasicBlock',
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
  'INJECTS',
  // Taint/PDG substrate (issue #2080) — reserved edge types, emitted by no
  // phase yet (CFG → M1, REACHING_DEF → M2, TAINTED/SANITIZES/TAINT_PATH →
  // M3/M4). REACHING_DEF's variable name rides the relation's `reason` column.
  'CFG',
  'REACHING_DEF',
  'TAINTED',
  'SANITIZES',
  'TAINT_PATH',
  // Control dependence (PDG, issue #2085 M5) — CDG carries its 'T'|'F' branch
  // label in the relation's `reason` column; POST_DOMINATE is debug-only
  // (behind GITNEXUS_PDG_EMIT_POST_DOMINATE). Both are BasicBlock→BasicBlock,
  // reusing the existing FROM BasicBlock TO BasicBlock pair in RELATION_SCHEMA.
  'CDG',
  'POST_DOMINATE',
] as const;

export type RelType = (typeof REL_TYPES)[number];

export const EMBEDDING_TABLE_NAME = 'CodeEmbedding';
