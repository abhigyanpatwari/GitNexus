// gitnexus/src/core/ingestion/method-extractors/configs/dart.ts
// Verified against tree-sitter-dart 1.0.0 (80e23c07)

import { SupportedLanguages } from 'gitnexus-shared';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// Dart helpers
// ---------------------------------------------------------------------------

/** Type node types that represent a return type in function/getter/setter signatures. */
const TYPE_NODE_TYPES = new Set([
  'type_identifier',
  'generic_type',
  'function_type',
  'nullable_type',
  'void_type',
  'record_type',
]);

/**
 * Dart method_signature is a WRAPPER node containing one inner signature:
 * function_signature, constructor_signature, getter_signature, setter_signature,
 * operator_signature, or factory_constructor_signature.
 *
 * Name, parameters, and return type live on the INNER signature, not on
 * method_signature itself.
 */
function getInnerSignature(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (
      child &&
      (child.type === 'function_signature' ||
        child.type === 'constructor_signature' ||
        child.type === 'getter_signature' ||
        child.type === 'setter_signature' ||
        child.type === 'operator_signature' ||
        child.type === 'factory_constructor_signature')
    ) {
      return child;
    }
  }
  // `declaration` nodes (abstract methods) also wrap function_signature as a
  // named child — handled by the loop above.
  return null;
}

/**
 * Extract the method name from a method_signature node.
 *
 * Descends into the inner signature to find the name field/identifier.
 */
function extractDartName(node: SyntaxNode): string | undefined {
  const inner = getInnerSignature(node);
  if (!inner) return undefined;

  // constructor_signature name field may include "ClassName.namedCtor" via multiple children.
  // getter_signature, setter_signature, function_signature all have a 'name' field.
  if (inner.type === 'operator_signature') {
    // operator_signature has no 'name' field; name is 'operator' + the operator symbol
    for (let i = 0; i < inner.namedChildCount; i++) {
      const child = inner.namedChild(i);
      if (child?.type === 'binary_operator') {
        return `operator ${child.text.trim()}`;
      }
    }
    // Check for unnamed operator tokens like []= or ~
    for (let i = 0; i < inner.childCount; i++) {
      const child = inner.child(i);
      if (child && !child.isNamed && child.text.trim() !== 'operator') {
        const text = child.text.trim();
        if (text && !TYPE_NODE_TYPES.has(child.type)) {
          return `operator ${text}`;
        }
      }
    }
    return undefined;
  }

  if (inner.type === 'getter_signature') {
    const nameNode = inner.childForFieldName('name');
    return nameNode?.text;
  }

  if (inner.type === 'setter_signature') {
    const nameNode = inner.childForFieldName('name');
    return nameNode ? `set ${nameNode.text}` : undefined;
  }

  if (inner.type === 'factory_constructor_signature') {
    // Collect all identifier children to form "ClassName" or "ClassName.named"
    const parts: string[] = [];
    for (let i = 0; i < inner.childCount; i++) {
      const child = inner.child(i);
      if (child?.isNamed && child.type === 'identifier') {
        parts.push(child.text);
      }
    }
    return parts.length > 0 ? parts.join('.') : undefined;
  }

  // function_signature and constructor_signature both have a 'name' field
  const nameNode = inner.childForFieldName('name');
  if (nameNode) {
    // constructor_signature: name field may be multiple identifiers joined by '.'
    return nameNode.text;
  }

  return undefined;
}

/**
 * Extract the return type from the inner signature.
 *
 * function_signature children include type nodes before the name.
 * getter_signature children include type nodes before 'get' keyword.
 * constructor/setter signatures have no return type.
 */
function extractDartReturnType(node: SyntaxNode): string | undefined {
  const inner = getInnerSignature(node);
  if (!inner) return undefined;

  // Constructors and setters have no return type
  if (
    inner.type === 'constructor_signature' ||
    inner.type === 'setter_signature' ||
    inner.type === 'factory_constructor_signature'
  ) {
    return undefined;
  }

  // For function_signature, getter_signature, operator_signature:
  // The type node is a named child before the name/operator
  for (let i = 0; i < inner.namedChildCount; i++) {
    const child = inner.namedChild(i);
    if (child && TYPE_NODE_TYPES.has(child.type)) {
      return child.text?.trim();
    }
  }

  return undefined;
}

/**
 * Extract parameters from the inner signature's formal_parameter_list.
 *
 * Dart parameters can be:
 * - Positional required: `int x`
 * - Optional positional: `[int? x]` — wrapped in optional_formal_parameters with '['
 * - Optional named: `{int? x}` or `{required int x}` — wrapped in optional_formal_parameters with '{'
 */
function extractDartParameters(node: SyntaxNode): ParameterInfo[] {
  const inner = getInnerSignature(node);
  if (!inner) return [];

  // getter_signature has no parameters
  if (inner.type === 'getter_signature') return [];

  // Find formal_parameter_list — it's a child, not a field in function_signature
  let paramList: SyntaxNode | null = null;
  if (inner.type === 'constructor_signature' || inner.type === 'factory_constructor_signature') {
    paramList = inner.childForFieldName('parameters');
  }
  if (!paramList) {
    for (let i = 0; i < inner.namedChildCount; i++) {
      const child = inner.namedChild(i);
      if (child?.type === 'formal_parameter_list') {
        paramList = child;
        break;
      }
    }
  }
  if (!paramList) return [];

  return extractParamsFromList(paramList, false);
}

/**
 * Extract ParameterInfo entries from a formal_parameter_list or optional_formal_parameters node.
 */
function extractParamsFromList(listNode: SyntaxNode, isOptionalBlock: boolean): ParameterInfo[] {
  const params: ParameterInfo[] = [];

  for (let i = 0; i < listNode.namedChildCount; i++) {
    const child = listNode.namedChild(i);
    if (!child) continue;

    if (child.type === 'formal_parameter') {
      params.push(extractSingleParam(child, isOptionalBlock));
    } else if (child.type === 'optional_formal_parameters') {
      // Determine if these are named ({}) or positional ([]) optional params
      // by checking the surrounding delimiters
      params.push(...extractParamsFromList(child, true));
    }
  }

  return params;
}

/**
 * Extract a single ParameterInfo from a formal_parameter node.
 */
function extractSingleParam(param: SyntaxNode, isOptionalBlock: boolean): ParameterInfo {
  const nameNode = param.childForFieldName('name');
  const name = nameNode?.text ?? '<unknown>';

  // Find the type node
  let typeName: string | null = null;
  for (let i = 0; i < param.namedChildCount; i++) {
    const child = param.namedChild(i);
    if (child && TYPE_NODE_TYPES.has(child.type)) {
      typeName = extractSimpleTypeName(child) ?? child.text?.trim() ?? null;
      break;
    }
    // Also check type_identifier
    if (child?.type === 'type_identifier') {
      typeName = child.text?.trim() ?? null;
      break;
    }
  }

  // Check for 'required' keyword:
  // 1. Among children of the param node itself
  let hasRequired = false;
  for (let i = 0; i < param.childCount; i++) {
    const child = param.child(i);
    if (child && child.text.trim() === 'required') {
      hasRequired = true;
      break;
    }
  }
  // 2. In tree-sitter-dart, `required` may be an anonymous sibling token
  //    immediately preceding the formal_parameter inside optional_formal_parameters.
  if (!hasRequired) {
    let prev = param.previousSibling;
    // Skip comma separators
    while (prev && !prev.isNamed && prev.text.trim() === ',') {
      prev = prev.previousSibling;
    }
    if (prev && !prev.isNamed && prev.text.trim() === 'required') {
      hasRequired = true;
    }
  }

  // A parameter is optional if it's inside an optional_formal_parameters block
  // and does NOT have the 'required' keyword
  const isOptional = isOptionalBlock && !hasRequired;

  return {
    name,
    type: typeName,
    isOptional,
    isVariadic: false, // Dart has no variadic params
  };
}

/**
 * Dart visibility: underscore prefix = private, else public.
 *
 * We resolve the name by descending into the inner signature.
 */
function extractDartVisibility(node: SyntaxNode): MethodVisibility {
  const name = extractDartName(node);
  if (!name) return 'public';

  // Strip 'set ' or 'operator ' prefix to get the raw name
  const rawName = name.startsWith('set ')
    ? name.slice(4)
    : name.startsWith('operator ')
      ? name.slice(9)
      : name;

  return rawName.startsWith('_') ? 'private' : 'public';
}

/**
 * In tree-sitter-dart, `static` is an anonymous child token of
 * `method_signature` (or `declaration`), not a previous sibling.
 *
 * We check children first, then fall back to previous siblings for
 * grammar variants.
 */
function isDartStatic(node: SyntaxNode): boolean {
  // In tree-sitter-dart, `static` is an anonymous child token of method_signature
  // (or declaration), not a previous sibling.
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && !child.isNamed && child.text.trim() === 'static') return true;
    // Stop once we hit the inner signature — static always precedes it
    if (child?.isNamed) break;
  }
  // Also check previous siblings (fallback for grammar variants)
  let sibling = node.previousSibling;
  while (sibling) {
    if (sibling.isNamed && sibling.type !== 'annotation') break;
    if (!sibling.isNamed && sibling.text.trim() === 'static') return true;
    sibling = sibling.previousSibling;
  }
  return false;
}

/**
 * A Dart method is abstract if it has no function_body sibling following it.
 * In the tree-sitter grammar, function_body is a sibling of method_signature
 * in class_body.
 */
function isDartAbstract(node: SyntaxNode, _ownerNode: SyntaxNode): boolean {
  // `declaration` nodes in class_body represent abstract methods (no body, followed by ';').
  // Note: extension bodies cannot have abstract members in Dart, but `declaration` nodes
  // do not appear in extension_body in practice since extensions must provide implementations.
  if (node.type === 'declaration') return true;
  // For method_signature nodes, check if the next named sibling is a function_body
  const next = node.nextNamedSibling;
  return !next || next.type !== 'function_body';
}

/**
 * Check for `async`, `async*`, or `sync*` keyword in the function_body sibling.
 * The keyword appears as an unnamed child of function_body, or
 * as a sibling keyword before function_body.
 *
 * Dart has three async-like forms: `async` (Future), `async*` (Stream), `sync*` (Iterable).
 * All three are treated as async for graph purposes.
 */
function isDartAsync(node: SyntaxNode): boolean {
  let sibling: SyntaxNode | null = node.nextSibling;
  let limit = 3;
  while (sibling && limit > 0) {
    if (!sibling.isNamed) {
      const text = sibling.text.trim();
      if (text === 'async' || text === 'async*' || text === 'sync*') return true;
    }
    if (sibling.isNamed && sibling.type === 'function_body') {
      // Check first child of function_body for async/async*/sync*
      for (let i = 0; i < sibling.childCount; i++) {
        const child = sibling.child(i);
        if (child) {
          const text = child.text.trim();
          if (text === 'async' || text === 'async*' || text === 'sync*') return true;
        }
        // Stop at first substantial child
        if (child?.isNamed) break;
      }
      break;
    }
    sibling = sibling.nextSibling;
    limit--;
  }
  return false;
}

/**
 * Extract annotations that appear as sibling nodes before the method_signature
 * in class_body. Each annotation node is prefixed with '@'.
 */
function extractDartAnnotations(node: SyntaxNode): string[] {
  const annotations: string[] = [];
  let sibling = node.previousNamedSibling;
  while (sibling && sibling.type === 'annotation') {
    // annotation node text already includes '@', e.g. "@override"
    const text = sibling.text?.trim();
    if (text) {
      // Normalize: strip arguments from annotation if present, keep just the name
      // e.g. "@deprecated" -> "@deprecated", "@JsonKey(name: 'id')" -> "@JsonKey"
      const match = text.match(/^@(\w+)/);
      if (match) {
        annotations.unshift('@' + match[1]);
      } else {
        annotations.unshift(text);
      }
    }
    sibling = sibling.previousNamedSibling;
  }
  return annotations;
}

// ---------------------------------------------------------------------------
// Dart config
// ---------------------------------------------------------------------------

export const dartMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Dart,
  typeDeclarationNodes: ['class_definition', 'mixin_declaration', 'extension_declaration'],
  methodNodeTypes: ['method_signature', 'declaration'],
  bodyNodeTypes: ['class_body', 'extension_body'],

  extractName: extractDartName,
  extractReturnType: extractDartReturnType,
  extractParameters: extractDartParameters,
  extractVisibility: extractDartVisibility,

  isStatic: isDartStatic,
  isAbstract: isDartAbstract,
  isFinal: () => false, // Dart methods cannot be 'final'
  isAsync: isDartAsync,

  extractAnnotations: extractDartAnnotations,
};
