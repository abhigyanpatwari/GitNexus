// gitnexus/src/core/ingestion/call-extractors/configs/c-cpp.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { CallExtractionConfig } from '../../call-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

export const cCallConfig: CallExtractionConfig = {
  language: SupportedLanguages.C,
};

export const cppCallConfig: CallExtractionConfig = {
  language: SupportedLanguages.CPlusPlus,
  extractLanguageCallSite(callNode) {
    return extractCppOperatorCallSite(callNode);
  },
};

function extractCppOperatorCallSite(callNode: SyntaxNode) {
  if (callNode.type !== 'binary_expression') return null;

  const operator = callNode.childForFieldName('operator')?.text.trim();
  if (operator === '+') {
    const left = callNode.childForFieldName('left');
    const right = callNode.childForFieldName('right');
    if (left?.type !== 'identifier' || right?.type !== 'identifier') return null;
    return {
      calledName: 'operator+',
      callForm: 'member' as const,
      receiverName: left.text,
      argCount: 1,
    };
  }

  if (operator === '<<') {
    const right = callNode.childForFieldName('right');
    if (right?.type !== 'identifier') return null;
    return {
      calledName: 'operator<<',
      callForm: 'free' as const,
      argCount: 2,
    };
  }

  return null;
}
