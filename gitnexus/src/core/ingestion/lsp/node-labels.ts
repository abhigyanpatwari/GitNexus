/**
 * Canonical node-label allowlist shared across core and MCP layers.
 *
 * This module exists to break the circular ESM import that would arise
 * if `location-mapper.ts` (core/ingestion/lsp) imported from
 * `local-backend.ts` (mcp/local) — a layering inversion that triggers
 * a Temporal Dead Zone crash at module initialisation.
 *
 * Rule: ONLY this file defines `VALID_NODE_LABELS`. All other modules
 * (local-backend.ts, location-mapper.ts, …) import from here.
 */

/** Valid LadybugDB node labels for safe Cypher query construction */
export const VALID_NODE_LABELS: ReadonlySet<string> = new Set([
  'File', 'Folder', 'Function', 'Class', 'Interface', 'Method', 'CodeElement',
  'Community', 'Process', 'Struct', 'Enum', 'Macro', 'Typedef', 'Union',
  'Namespace', 'Trait', 'Impl', 'TypeAlias', 'Const', 'Static', 'Property',
  'Record', 'Delegate', 'Annotation', 'Constructor', 'Template', 'Module',
]);
