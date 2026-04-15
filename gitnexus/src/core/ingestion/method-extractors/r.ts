// gitnexus/src/core/ingestion/method-extractors/r.ts

/**
 * R method extractor — hand-written because R expresses classes and methods
 * as function calls rather than dedicated syntax.
 *
 * Handles:
 * - R6 methods: function entries in public/private/active list()
 * - S4 setMethod(): owner hints for method implementations dispatched on signature
 * - R5/setRefClass methods: methods = list(name = function(...) {...})
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import { SupportedLanguages } from 'gitnexus-shared';
import type {
  MethodExtractor,
  MethodExtractorContext,
  ExtractedMethods,
  MethodInfo,
  MethodVisibility,
  ParameterInfo,
} from '../method-types.js';

export const rMethodExtractor: MethodExtractor = {
  language: SupportedLanguages.R,

  isTypeDeclaration(node: SyntaxNode): boolean {
    return isR6Class(node) || isRefClass(node);
  },

  extract(node: SyntaxNode, context: MethodExtractorContext): ExtractedMethods | null {
    if (isR6Class(node)) return extractR6Methods(node, context);
    if (isRefClass(node)) return extractRefClassMethods(node, context);
    return null;
  },
};

/** Resolve the owning class name for a top-level R setMethod("foo", "Bar", ...) definition. */
export function getRTopLevelMethodOwnerName(node: SyntaxNode): string | null {
  if (!isS4SetMethod(node)) return null;
  const args = node.childForFieldName('arguments');
  if (!args) return null;

  let stringArgIndex = 0;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (!arg || arg.type !== 'argument') continue;
    const argName = arg.childForFieldName('name')?.text;
    const value = arg.childForFieldName('value');
    if (argName === 'signature') {
      const namedSignature = extractQuotedString(value);
      if (namedSignature) return namedSignature;
    }
    if (value?.type !== 'string') continue;
    stringArgIndex++;
    if (stringArgIndex === 2) {
      return extractQuotedString(value);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// R6 method extraction
// ---------------------------------------------------------------------------

function extractR6Methods(
  node: SyntaxNode,
  context: MethodExtractorContext,
): ExtractedMethods | null {
  const ownerName = node.childForFieldName('lhs')?.text;
  if (!ownerName) return null;

  const call = node.childForFieldName('rhs');
  if (!call) return null;

  const args = call.childForFieldName('arguments');
  if (!args) return null;

  const methods: MethodInfo[] = [];

  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (!arg || arg.type !== 'argument') continue;

    const section = arg.childForFieldName('name')?.text;
    if (section !== 'public' && section !== 'private' && section !== 'active') continue;

    const visibility: MethodVisibility = section === 'private' ? 'private' : 'public';

    const listCall = arg.childForFieldName('value');
    if (!listCall || listCall.type !== 'call') continue;

    const listArgs = listCall.childForFieldName('arguments');
    if (!listArgs) continue;

    for (let j = 0; j < listArgs.namedChildCount; j++) {
      const entry = listArgs.namedChild(j);
      if (!entry || entry.type !== 'argument') continue;

      const nameNode = entry.childForFieldName('name');
      const valueNode = entry.childForFieldName('value');
      if (!nameNode || valueNode?.type !== 'function_definition') continue;

      methods.push({
        name: nameNode.text,
        receiverType: null,
        returnType: null,
        parameters: extractRParameters(valueNode),
        visibility,
        isStatic: false,
        isAbstract: false,
        isFinal: false,
        annotations: section === 'active' ? ['@active'] : [],
        sourceFile: context.filePath,
        line: entry.startPosition.row + 1,
      });
    }
  }

  return methods.length > 0 ? { ownerName, methods } : null;
}

// ---------------------------------------------------------------------------
// S4 / R5 (setRefClass) method extraction
// ---------------------------------------------------------------------------

function extractRefClassMethods(
  node: SyntaxNode,
  context: MethodExtractorContext,
): ExtractedMethods | null {
  const args = node.childForFieldName('arguments');
  if (!args) return null;

  // First string argument is the class name
  let ownerName: string | undefined;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (!arg || arg.type !== 'argument') continue;
    const val = arg.childForFieldName('value');
    if (val?.type === 'string') {
      const content = val.namedChildren.find((c) => c.type === 'string_content');
      ownerName = content?.text ?? val.text.replace(/^["']|["']$/g, '');
      break;
    }
  }
  if (!ownerName) return null;

  const methods: MethodInfo[] = [];

  // setRefClass(... methods = list(name = function(...) { ... }))
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (!arg || arg.type !== 'argument') continue;

    const paramName = arg.childForFieldName('name')?.text;
    if (paramName !== 'methods') continue;

    const listCall = arg.childForFieldName('value');
    if (!listCall || listCall.type !== 'call') continue;

    const listArgs = listCall.childForFieldName('arguments');
    if (!listArgs) continue;

    for (let j = 0; j < listArgs.namedChildCount; j++) {
      const entry = listArgs.namedChild(j);
      if (!entry || entry.type !== 'argument') continue;

      const nameNode = entry.childForFieldName('name');
      const valueNode = entry.childForFieldName('value');
      if (!nameNode || valueNode?.type !== 'function_definition') continue;

      methods.push({
        name: nameNode.text,
        receiverType: null,
        returnType: null,
        parameters: extractRParameters(valueNode),
        visibility: 'public',
        isStatic: false,
        isAbstract: false,
        isFinal: false,
        annotations: [],
        sourceFile: context.filePath,
        line: entry.startPosition.row + 1,
      });
    }
  }

  return methods.length > 0 ? { ownerName, methods } : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isR6Class(node: SyntaxNode): boolean {
  if (node.type !== 'binary_operator') return false;
  const rhs = node.childForFieldName('rhs');
  if (!rhs || rhs.type !== 'call') return false;
  const fn = rhs.childForFieldName('function');
  if (!fn) return false;
  if (fn.type === 'identifier' && fn.text === 'R6Class') return true;
  if (fn.type === 'namespace_operator') {
    return fn.childForFieldName('rhs')?.text === 'R6Class';
  }
  return false;
}

function isRefClass(node: SyntaxNode): boolean {
  if (node.type !== 'call') return false;
  const fn = node.childForFieldName('function');
  return fn?.type === 'identifier' && fn.text === 'setRefClass';
}

function isS4SetMethod(node: SyntaxNode): boolean {
  if (node.type !== 'call') return false;
  const fn = node.childForFieldName('function');
  return fn?.type === 'identifier' && fn.text === 'setMethod';
}

function extractQuotedString(node: SyntaxNode | null): string | null {
  if (!node || node.type !== 'string') return null;
  const content = node.namedChildren.find((c) => c.type === 'string_content');
  return content?.text ?? node.text.replace(/^["']|["']$/g, '');
}

/** Extract parameter names from an R function_definition node. */
function extractRParameters(fnNode: SyntaxNode): ParameterInfo[] {
  const params: ParameterInfo[] = [];
  const paramList = fnNode.childForFieldName('parameters');
  if (!paramList) return params;

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param) continue;

    if (param.type === 'identifier') {
      params.push({
        name: param.text,
        type: null,
        isOptional: false,
        isVariadic: param.text === '...',
      });
    } else if (param.type === 'argument') {
      // Named argument with default value -> optional parameter
      const nameNode = param.childForFieldName('name');
      if (nameNode) {
        params.push({
          name: nameNode.text,
          type: null,
          isOptional: true,
          isVariadic: false,
        });
      }
    }
  }

  return params;
}
