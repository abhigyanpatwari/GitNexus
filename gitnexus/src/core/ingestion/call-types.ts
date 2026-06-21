// gitnexus/src/core/ingestion/call-types.ts

/**
 * Types for the language-agnostic call extraction pipeline.
 *
 * Mirrors method-types.ts / field-types.ts: defines the domain interfaces
 * consumed by createCallExtractor() and the per-language configs.
 */

import type { SupportedLanguages } from 'gitnexus-shared';
import type { SyntaxNode } from './utils/ast-helpers.js';
import type { MixedChainStep } from './utils/call-analysis.js';

// ---------------------------------------------------------------------------
// Extracted result
// ---------------------------------------------------------------------------

/**
 * Per-node call extraction result.  The parse worker enriches this with
 * file-level context (filePath, sourceId, TypeEnv lookups, arg types) to
 * produce the final `ExtractedCall` that enters the resolution pipeline.
 */
export interface ExtractedCallSite {
  calledName: string;
  callForm?: 'free' | 'member' | 'constructor';
  receiverName?: string;
  argCount?: number;
  /** Unified mixed chain for complex receivers (field + call chains). */
  receiverMixedChain?: MixedChainStep[];
  /** When true, the type-as-receiver heuristic applies: if receiverName
   *  starts with an uppercase letter and has no TypeEnv binding, treat it
   *  as a type name (e.g. Java `User::getName`). */
  typeAsReceiverHeuristic?: boolean;
}

// ---------------------------------------------------------------------------
// Extractor interface (produced by createCallExtractor)
// ---------------------------------------------------------------------------

export interface CallExtractor {
  readonly language: SupportedLanguages;
  /**
   * Extract a call site from captured AST nodes.
   *
   * @param callNode     The @call capture (call_expression, method_invocation, …)
   * @param callNameNode The @call.name capture (identifier inside the call).
   *                     May be undefined when the call shape has no name capture
   *                     (e.g. Java method_reference via `::`).
   * @returns Extracted call site, or null when no call can be derived.
   */
  extract(callNode: SyntaxNode, callNameNode: SyntaxNode | undefined): ExtractedCallSite | null;
}

// ---------------------------------------------------------------------------
// Config interface (one per language / language group)
// ---------------------------------------------------------------------------

export interface CallExtractionConfig {
  language: SupportedLanguages;

  /**
   * Language-specific call site extraction.  Called **before** the generic
   * path.  If it returns non-null, the generic `inferCallForm` /
   * `extractReceiverName` path is skipped entirely.
   *
   * Use this for call shapes that don't follow the standard `@call` /
   * `@call.name` pattern (e.g. Java `method_reference` via `::`).
   */
  extractLanguageCallSite?: (callNode: SyntaxNode) => ExtractedCallSite | null;

  /**
   * Whether the type-as-receiver heuristic applies for this language.
   * When true and the receiver name starts with an uppercase letter,
   * the receiver is treated as a type name when no TypeEnv binding exists.
   *
   * Applies to JVM and C# languages where `Type.method()` and `Type::method`
   * are common patterns.
   */
  typeAsReceiverHeuristic?: boolean;
}
