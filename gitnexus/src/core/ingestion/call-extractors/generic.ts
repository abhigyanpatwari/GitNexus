// gitnexus/src/core/ingestion/call-extractors/generic.ts

/**
 * Generic table-driven call extractor factory.
 *
 * Mirrors method-extractors/generic.ts and field-extractors/generic.ts —
 * define a config per language and generate extractors from configs.
 *
 * The factory converts a declarative {@link CallExtractionConfig} into a
 * runtime {@link CallExtractor} whose `extract()` method:
 *   1. Tries `config.extractLanguageCallSite(callNode)` for non-standard shapes.
 *   2. Falls through to the generic path using shared utilities from
 *      `utils/call-analysis.ts` (`inferCallForm`, `extractReceiverName`, etc.).
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import {
  inferCallForm,
  extractReceiverName,
  extractReceiverNode,
  extractMixedChain,
  countCallArguments,
} from '../utils/call-analysis.js';
import type { CallExtractor, CallExtractionConfig, ExtractedCallSite } from '../call-types.js';

/**
 * Create a CallExtractor from a declarative config.
 */
export function createCallExtractor(config: CallExtractionConfig): CallExtractor {
  return {
    language: config.language,

    extract(callNode: SyntaxNode, callNameNode: SyntaxNode | undefined): ExtractedCallSite | null {
      // ── Path 1: Language-specific call site ──────────────────────────
      // Non-standard call shapes (e.g. Java `::` method references) are
      // handled entirely by the config hook.  When it returns a result,
      // the generic path is skipped — no argCount, no mixed chain.
      //
      // Note: `extractLanguageCallSite` is called on every `extract()`
      // invocation — both `extract(callNode, undefined)` (parse-worker
      // Path 1) and `extract(callNode, callNameNode)` (Path 2).
      // Language hooks must therefore be idempotent and cheap (e.g. a
      // single node-type check).
      if (config.extractLanguageCallSite) {
        const seed = config.extractLanguageCallSite(callNode);
        if (seed) {
          return {
            ...seed,
            ...(config.typeAsReceiverHeuristic ? { typeAsReceiverHeuristic: true } : {}),
          };
        }
      }

      // ── Path 2: Generic extraction via @call.name ────────────────────
      if (!callNameNode) return null;

      const calledName = callNameNode.text;
      const callForm = inferCallForm(callNode, callNameNode);
      let receiverName = callForm === 'member' ? extractReceiverName(callNameNode) : undefined;
      let receiverMixedChain: ExtractedCallSite['receiverMixedChain'];

      // When the receiver is a complex expression (call chain, field chain,
      // or mixed), extractReceiverName returns undefined.  Walk the receiver
      // node to build a unified mixed chain for deferred resolution.
      if (callForm === 'member' && receiverName === undefined) {
        const receiverNode = extractReceiverNode(callNameNode);
        if (receiverNode) {
          const extracted = extractMixedChain(receiverNode);
          if (extracted && extracted.chain.length > 0) {
            receiverMixedChain = extracted.chain;
            receiverName = extracted.baseReceiverName;
          }
        }
      }

      return {
        calledName,
        ...(callForm !== undefined ? { callForm } : {}),
        ...(receiverName !== undefined ? { receiverName } : {}),
        argCount: countCallArguments(callNode),
        ...(receiverMixedChain !== undefined ? { receiverMixedChain } : {}),
        ...(config.typeAsReceiverHeuristic ? { typeAsReceiverHeuristic: true } : {}),
      };
    },
  };
}
