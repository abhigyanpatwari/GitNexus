// gitnexus/src/core/ingestion/call-extractors/configs/jvm.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { CallExtractionConfig, ExtractedCallSite } from '../../call-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// Java method_reference (::) parsing — absorbs call-sites/java.ts
// ---------------------------------------------------------------------------

/**
 * Parse Java `method_reference` nodes (`expr::method`, `Type::new`,
 * `this::m`, `super::m`).
 */
function parseJavaMethodReference(callNode: SyntaxNode): ExtractedCallSite | null {
  if (callNode.type !== 'method_reference') return null;

  const recv = callNode.namedChild(0);
  if (!recv) return null;

  // Type::new  →  constructor call
  for (const c of callNode.children) {
    if (c.type === 'new') {
      if (recv.type !== 'identifier') return null;
      return { calledName: recv.text, callForm: 'constructor' };
    }
  }

  // expr::method  →  member call with receiver
  const rhs = callNode.child(callNode.childCount - 1);
  if (!rhs || rhs.type !== 'identifier') return null;
  const methodName = rhs.text;

  if (recv.type === 'identifier') {
    return { calledName: methodName, callForm: 'member', receiverName: recv.text };
  }
  if (recv.type === 'this') {
    return { calledName: methodName, callForm: 'member', receiverName: 'this' };
  }
  if (recv.type === 'super') {
    return { calledName: methodName, callForm: 'member', receiverName: 'super' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Configs
// ---------------------------------------------------------------------------

export const javaCallConfig: CallExtractionConfig = {
  language: SupportedLanguages.Java,
  extractLanguageCallSite: parseJavaMethodReference,
  typeAsReceiverHeuristic: true,
};

export const kotlinCallConfig: CallExtractionConfig = {
  language: SupportedLanguages.Kotlin,
  typeAsReceiverHeuristic: true,
};
