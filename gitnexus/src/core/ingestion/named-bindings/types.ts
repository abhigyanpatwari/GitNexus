/**
 * Named binding types — shared across all per-language binding extractors.
 *
 * Extracted from import-resolution.ts to co-locate types with their consumers.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';

/** A single named import binding: local name in the importing file and exported name from the source.
 *  When `isModuleAlias` is true, the binding represents a Python `import X as Y` module alias
 *  and is routed to moduleAliasMap instead of namedImportMap during import processing. */
export interface NamedBinding {
  local: string;
  exported: string;
  isModuleAlias?: boolean;
}

/** Per-language named binding extractor -- optional (returns undefined if language has no named imports). */
export type NamedBindingExtractorFn = (importNode: SyntaxNode) => NamedBinding[] | undefined;
