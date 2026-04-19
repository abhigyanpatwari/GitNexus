// gitnexus/src/core/ingestion/heritage-types.ts

/**
 * Types for the language-agnostic heritage extraction pipeline.
 *
 * Follows the same pattern as call-types.ts, variable-types.ts, and
 * method-types.ts: defines the domain interfaces consumed by
 * createHeritageExtractor() and the per-language configs.
 *
 * Heritage extraction handles extends/implements/trait-impl captures from
 * tree-sitter queries, plus call-based heritage for languages like Ruby
 * (include/extend/prepend expressed as method calls).
 */

import type { SupportedLanguages } from 'gitnexus-shared';
import type { SyntaxNode } from './utils/ast-helpers.js';
import type { CaptureMap } from './language-provider.js';

// ---------------------------------------------------------------------------
// Extracted result
// ---------------------------------------------------------------------------

/**
 * Per-match heritage extraction result.  The parse worker adds filePath to
 * produce the final {@link ExtractedHeritage} that enters the resolution
 * pipeline (heritage-processor.ts / heritage-map.ts).
 */
export interface HeritageInfo {
  className: string;
  parentName: string;
  /** 'extends' | 'implements' | 'trait-impl' | 'include' | 'extend' | 'prepend' */
  kind: string;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface HeritageExtractorContext {
  filePath: string;
  language: SupportedLanguages;
}

// ---------------------------------------------------------------------------
// Extractor interface (produced by createHeritageExtractor)
// ---------------------------------------------------------------------------

export interface HeritageExtractor {
  readonly language: SupportedLanguages;

  /**
   * Extract heritage records from tree-sitter @heritage.* captures.
   *
   * @param captureMap  The capture map from a single tree-sitter match
   * @param context     File path and language context
   * @returns Array of heritage records (may be empty if captures don't match)
   */
  extract(captureMap: CaptureMap, context: HeritageExtractorContext): HeritageInfo[];

  /**
   * Extract heritage from a call node (for languages where heritage is
   * expressed as method calls, e.g., Ruby include/extend/prepend).
   *
   * @param calledName  The method name (e.g. 'include', 'extend', 'prepend')
   * @param callNode    The tree-sitter call AST node
   * @param context     File path and language context
   * @returns Heritage records if the call is heritage-related, or null to
   *          fall through to the call router / normal call handling.
   */
  extractFromCall?(
    calledName: string,
    callNode: SyntaxNode,
    context: HeritageExtractorContext,
  ): HeritageInfo[] | null;
}

// ---------------------------------------------------------------------------
// Config interface (one per language / language group)
// ---------------------------------------------------------------------------

export interface HeritageExtractionConfig {
  language: SupportedLanguages;

  /**
   * Called for heritage.extends captures.  Return true to skip this extends
   * capture.  Used by Go to skip named struct fields that match the
   * field_declaration pattern but are not anonymous embeddings.
   *
   * Default: never skip (all extends captures are valid).
   */
  shouldSkipExtends?: (extendsNode: SyntaxNode) => boolean;

  /**
   * Call-based heritage extraction for languages where heritage is expressed
   * as method calls (e.g., Ruby include/extend/prepend).
   *
   * callNames: set of method names that trigger heritage extraction.
   * extract:   extract heritage items from the call node + method name.
   */
  callBasedHeritage?: {
    readonly callNames: ReadonlySet<string>;
    extract(calledName: string, callNode: SyntaxNode, filePath: string): HeritageInfo[];
  };
}
