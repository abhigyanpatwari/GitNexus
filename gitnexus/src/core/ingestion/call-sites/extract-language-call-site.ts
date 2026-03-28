/** Non-generic @call shapes → { calledName, callForm, receiverName? } (used from call-processor / parse-worker). */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { parseJavaMethodReference } from './java.js';

export type ParsedCallSite = {
  calledName: string;
  callForm: 'free' | 'member' | 'constructor';
  receiverName?: string;
};

/** Non-null → seed replaces @call.name; null → use @call.name + inferCallForm / extractReceiverName. */
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
