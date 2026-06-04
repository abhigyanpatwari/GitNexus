/**
 * Import-path preprocessing.
 *
 * The legacy import *resolution* pipeline that lived here (per-file ImportMap /
 * NamedImportMap / PackageMap / ModuleAliasMap population feeding the tiered
 * `ResolutionContext.resolve` lookup) was deleted in RING4-2 (#943). IMPORTS
 * edges are now emitted by the scope-resolution phase
 * (`scope-resolution/graph-bridge/imports-to-edges.ts`) from finalized
 * `ImportEdge`s, and implicit imports by each resolver's
 * `emitImplicitImportEdges` hook.
 *
 * What remains is the syntactic path cleanup shared by the worker extract path.
 */

import type { LanguageProvider } from './language-provider.js';
import type { SyntaxNode } from './utils/ast-helpers.js';

/**
 * Normalize a raw import path string from a syntax node into a clean module
 * specifier, applying the language provider's optional preprocessor.
 *
 * Strips surrounding quotes / angle brackets, rejects empties, overly long
 * strings, and control characters, then defers to the provider's
 * `importPathPreprocessor` when present.
 */
export function preprocessImportPath(
  sourceText: string,
  importNode: SyntaxNode,
  provider: LanguageProvider,
): string | null {
  const cleaned = sourceText.replace(/['"<>]/g, '');
  // Defense-in-depth: reject null bytes and control characters (matches Ruby call-routing pattern)
  if (!cleaned || cleaned.length > 2048 || /[\x00-\x1f]/.test(cleaned)) return null;
  if (provider.importPathPreprocessor) {
    return provider.importPathPreprocessor(cleaned, importNode);
  }
  return cleaned;
}
