/**
 * Hooks for language-specific call-site AST shapes that are not covered by the
 * generic @call + @call.name tree-sitter pattern.
 *
 * Orchestration stays in call-processor.ts / parse-worker.ts; this module only
 * maps AST → { calledName, callForm, receiverName? }.
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { parseJavaMethodReference } from '../utils/call-analysis.js';

export type ParsedCallSite = {
  calledName: string;
  callForm: 'free' | 'member' | 'constructor';
  /** Present for member-style seeds (instance ref, this::, super::, Type::staticMethod). */
  receiverName?: string;
};

/**
 * When non-null, the match is fully described by the seed — callers must not require
 * @call.name. When null, use the standard @call.name + inferCallForm / extractReceiverName path.
 */
export function extractParsedCallSite(
  language: SupportedLanguages,
  callNode: SyntaxNode,
): ParsedCallSite | null {
  switch (language) {
    case SupportedLanguages.Java:
      if (callNode.type === 'method_reference') {
        const parsed = parseJavaMethodReference(callNode);
        if (!parsed) return null;
        return {
          calledName: parsed.calledName,
          callForm: parsed.callForm,
          ...(parsed.receiverName !== undefined ? { receiverName: parsed.receiverName } : {}),
        };
      }
      return null;
    default:
      return null;
  }
}
