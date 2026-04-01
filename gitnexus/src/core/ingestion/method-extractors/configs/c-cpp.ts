// gitnexus/src/core/ingestion/method-extractors/configs/c-cpp.ts
// Verified against tree-sitter-cpp ^0.22.4

import { SupportedLanguages } from 'gitnexus-shared';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import { hasKeyword } from '../../field-extractors/configs/helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// C/C++ helpers
// ---------------------------------------------------------------------------

/**
 * Find the function_declarator inside a method node, handling pointer/reference
 * return types where the function_declarator is nested inside a pointer_declarator
 * or reference_declarator.
 */
function findFunctionDeclarator(node: SyntaxNode): SyntaxNode | null {
  const declarator = node.childForFieldName('declarator');
  if (!declarator) return null;
  if (declarator.type === 'function_declarator') return declarator;
  // pointer_declarator or reference_declarator wraps the function_declarator
  for (let i = 0; i < declarator.namedChildCount; i++) {
    const child = declarator.namedChild(i);
    if (child?.type === 'function_declarator') return child;
  }
  return null;
}

/**
 * Extract method name from a function_declarator.
 * The name is the `declarator` field of the function_declarator — typically a
 * field_identifier, but can be a destructor_name (~ClassName) or operator name.
 */
function extractCppMethodName(node: SyntaxNode): string | undefined {
  const funcDecl = findFunctionDeclarator(node);
  if (!funcDecl) return undefined;
  const nameNode = funcDecl.childForFieldName('declarator');
  if (!nameNode) return undefined;
  // destructor_name: ~ClassName
  if (nameNode.type === 'destructor_name') return nameNode.text;
  // operator_name: operator==, operator+, etc.
  if (nameNode.type === 'operator_name') return nameNode.text;
  return nameNode.text;
}

/**
 * Extract return type from the `type` field of the method node.
 * tree-sitter-cpp puts the return type as the `type` field on field_declaration
 * and function_definition nodes.
 */
function extractCppReturnType(node: SyntaxNode): string | undefined {
  const typeNode = node.childForFieldName('type');
  if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
  // Fallback: first type-like named child (for declarations without type field)
  const first = node.firstNamedChild;
  if (
    first &&
    (first.type === 'primitive_type' ||
      first.type === 'type_identifier' ||
      first.type === 'sized_type_specifier' ||
      first.type === 'template_type')
  ) {
    return extractSimpleTypeName(first) ?? first.text?.trim();
  }
  return undefined;
}

/**
 * Extract parameters from the parameter_list inside the function_declarator.
 *
 * C/C++ uses parameter_declaration (required) and optional_parameter_declaration
 * (with default value). Variadic `...` appears as a variadic_parameter_declaration.
 */
function extractCppParameters(node: SyntaxNode): ParameterInfo[] {
  const funcDecl = findFunctionDeclarator(node);
  if (!funcDecl) return [];
  const paramList = funcDecl.childForFieldName('parameters');
  if (!paramList) return [];
  const params: ParameterInfo[] = [];

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param) continue;

    switch (param.type) {
      case 'parameter_declaration': {
        const typeNode = param.childForFieldName('type');
        const declNode = param.childForFieldName('declarator');
        // Extract name — may be wrapped in pointer_declarator or reference_declarator
        const name = extractParamName(declNode);
        params.push({
          name: name ?? typeNode?.text?.trim() ?? '?',
          type: typeNode
            ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
            : null,
          isOptional: false,
          isVariadic: false,
        });
        break;
      }
      case 'optional_parameter_declaration': {
        const typeNode = param.childForFieldName('type');
        const declNode = param.childForFieldName('declarator');
        const name = extractParamName(declNode);
        params.push({
          name: name ?? typeNode?.text?.trim() ?? '?',
          type: typeNode
            ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
            : null,
          isOptional: true,
          isVariadic: false,
        });
        break;
      }
      case 'variadic_parameter_declaration': {
        // C-style `...` or typed variadic `T... args`
        const typeNode = param.childForFieldName('type');
        const declNode = param.childForFieldName('declarator');
        const name = extractParamName(declNode);
        params.push({
          name: name ?? '...',
          type: typeNode
            ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
            : null,
          isOptional: false,
          isVariadic: true,
        });
        break;
      }
      case 'variadic_parameter': {
        // Bare `...` (C-style)
        params.push({
          name: '...',
          type: null,
          isOptional: false,
          isVariadic: true,
        });
        break;
      }
    }
  }
  return params;
}

/** Extract parameter name, unwrapping pointer/reference declarators. */
function extractParamName(declNode: SyntaxNode | null): string | undefined {
  if (!declNode) return undefined;
  if (declNode.type === 'identifier') return declNode.text;
  // pointer_declarator (*name) or reference_declarator (&name)
  for (let i = 0; i < declNode.namedChildCount; i++) {
    const child = declNode.namedChild(i);
    if (child?.type === 'identifier') return child.text;
  }
  return declNode.text;
}

/**
 * Detect C++ access specifier by walking backwards through siblings.
 * Mirrors the field extractor pattern in c-cpp.ts.
 */
function extractCppVisibility(node: SyntaxNode): MethodVisibility {
  let sibling = node.previousNamedSibling;
  while (sibling) {
    if (sibling.type === 'access_specifier') {
      const text = sibling.text.replace(':', '').trim();
      if (text === 'public' || text === 'private' || text === 'protected') return text;
    }
    sibling = sibling.previousNamedSibling;
  }
  // Default: struct = public, class = private
  const parent = node.parent?.parent;
  return parent?.type === 'struct_specifier' ? 'public' : 'private';
}

/**
 * Detect pure virtual methods (`= 0`).
 * tree-sitter-cpp emits `=` (unnamed) followed by `number_literal` with text `0`.
 */
function isPureVirtual(node: SyntaxNode): boolean {
  let foundEquals = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.text === '=') {
      foundEquals = true;
    } else if (foundEquals && child.type === 'number_literal' && child.text === '0') {
      return true;
    } else if (foundEquals) {
      foundEquals = false; // Reset if something else follows `=`
    }
  }
  return false;
}

/**
 * Check for a virtual_specifier ('final' or 'override') inside the function_declarator.
 * In tree-sitter-cpp, these are named children of the function_declarator, not the
 * method node itself.
 */
function hasVirtualSpecifier(node: SyntaxNode, keyword: string): boolean {
  const funcDecl = findFunctionDeclarator(node);
  if (!funcDecl) return false;
  for (let i = 0; i < funcDecl.namedChildCount; i++) {
    const child = funcDecl.namedChild(i);
    if (child?.type === 'virtual_specifier' && child.text === keyword) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// C++ config
// ---------------------------------------------------------------------------

// C++ methods appear as field_declaration (declarations) or function_definition
// (inline definitions) inside field_declaration_list. The generic extractor
// iterates bodyNodeTypes children and matches against methodNodeTypes.
//
// Key difference from TS/JVM/C#: C++ has no dedicated method_declaration node.
// A field_declaration is a method if it contains a function_declarator.
// The generic extractor calls extractName() on every methodNodeType node — if
// extractName returns undefined (no function_declarator), the method is skipped.
//
// Known gaps:
//   - Out-of-class method definitions (void Foo::bar() {}) are not linked as
//     HAS_METHOD — they appear as top-level function_definition nodes.
//   - Friend declarations are not extracted.
//   - Template method declarations with explicit specialization.
export const cppMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.CPlusPlus,
  typeDeclarationNodes: ['class_specifier', 'struct_specifier'],
  // declaration covers constructors/destructors; field_declaration covers method
  // declarations; function_definition covers inline method definitions.
  // Non-method declarations (variables, typedefs) are filtered by extractName
  // returning undefined when no function_declarator is found.
  methodNodeTypes: ['field_declaration', 'function_definition', 'declaration'],
  bodyNodeTypes: ['field_declaration_list'],

  extractName: extractCppMethodName,
  extractReturnType: extractCppReturnType,
  extractParameters: extractCppParameters,
  extractVisibility: extractCppVisibility,

  isStatic(node) {
    return hasKeyword(node, 'static');
  },

  isAbstract(node) {
    return isPureVirtual(node);
  },

  isFinal(node) {
    return hasVirtualSpecifier(node, 'final');
  },

  isVirtual(node) {
    // In C++, override and method-level final are only legal on virtual functions,
    // so they imply virtual even without the explicit keyword.
    return (
      hasKeyword(node, 'virtual') ||
      hasVirtualSpecifier(node, 'override') ||
      hasVirtualSpecifier(node, 'final')
    );
  },

  isOverride(node) {
    return hasVirtualSpecifier(node, 'override');
  },
};

// ---------------------------------------------------------------------------
// C config (minimal — C has no classes/methods, only struct function pointers)
// ---------------------------------------------------------------------------

// C does not have methods in the OOP sense. Structs with function pointer fields
// are handled by the field extractor. This config exists for completeness but
// will rarely match since C structs don't contain function_definition nodes.
export const cMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.C,
  typeDeclarationNodes: ['struct_specifier'],
  methodNodeTypes: ['function_definition'],
  bodyNodeTypes: ['field_declaration_list'],

  extractName: extractCppMethodName,
  extractReturnType: extractCppReturnType,
  extractParameters: extractCppParameters,

  extractVisibility() {
    return 'public'; // C has no access control
  },

  isStatic(node) {
    return hasKeyword(node, 'static');
  },

  isAbstract() {
    return false; // C has no virtual/abstract
  },

  isFinal() {
    return false;
  },
};
