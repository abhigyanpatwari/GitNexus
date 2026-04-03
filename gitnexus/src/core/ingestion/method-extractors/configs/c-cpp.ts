// gitnexus/src/core/ingestion/method-extractors/configs/c-cpp.ts
// Verified against tree-sitter-cpp ^0.23.4

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
  // Recursively unwrap pointer_declarator / reference_declarator chains
  // (e.g. int** (*pfn)() has pointer_declarator → pointer_declarator → function_declarator)
  let current: SyntaxNode | null = declarator;
  while (current) {
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i);
      if (child?.type === 'function_declarator') return child;
    }
    // Go deeper into nested pointer/reference declarators
    const next = current.namedChildren.find(
      (c) => c.type === 'pointer_declarator' || c.type === 'reference_declarator',
    );
    current = next ?? null;
  }
  return null;
}

/**
 * Detect `= delete` and `= default` special member function declarations.
 * These are not callable methods and should be suppressed from extraction.
 * tree-sitter-cpp ^0.23.4 emits `delete_method_clause` / `default_method_clause`
 * as named children of the function_definition node.
 */
function isDeletedOrDefaulted(node: SyntaxNode): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'delete_method_clause' || child?.type === 'default_method_clause') {
      return true;
    }
  }
  return false;
}

/**
 * Extract method name from a function_declarator.
 * The name is the `declarator` field of the function_declarator — typically a
 * field_identifier, but can be a destructor_name (~ClassName) or operator name.
 */
function extractCppMethodName(node: SyntaxNode): string | undefined {
  const funcDecl = findFunctionDeclarator(node);
  if (!funcDecl) return undefined;

  // Suppress `= delete` and `= default` special members — these are not callable
  // methods and should not appear in HAS_METHOD edges.
  if (isDeletedOrDefaulted(node)) return undefined;

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
  if (typeNode) {
    const typeText = typeNode.text?.trim();
    // C++11 trailing return type: `auto foo() -> ReturnType`
    // When the declared type is `auto`, check for a trailing_return_type on the
    // function_declarator which holds the actual return type.
    if (typeText === 'auto') {
      const funcDecl = findFunctionDeclarator(node);
      if (funcDecl) {
        for (let i = 0; i < funcDecl.namedChildCount; i++) {
          const child = funcDecl.namedChild(i);
          if (child?.type === 'trailing_return_type') {
            // trailing_return_type contains a type_descriptor with the real type
            const typeDesc = child.firstNamedChild;
            if (typeDesc) return typeDesc.text?.trim();
          }
        }
      }
    }
    return typeText;
  }
  // Fallback: first type-like named child (for declarations without type field)
  const first = node.firstNamedChild;
  if (
    first &&
    (first.type === 'primitive_type' ||
      first.type === 'type_identifier' ||
      first.type === 'sized_type_specifier' ||
      first.type === 'template_type')
  ) {
    return first.text?.trim();
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

  // C/C++: bare `...` token in parameter list is an unnamed child (not a named node).
  // Check all children for the unnamed `...` token when no variadic was detected above.
  if (!params.some((p) => p.isVariadic)) {
    for (let i = 0; i < paramList.childCount; i++) {
      const child = paramList.child(i);
      if (child && !child.isNamed && child.text === '...') {
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

/** Extract parameter name, recursively unwrapping pointer/reference declarators. */
function extractParamName(declNode: SyntaxNode | null): string | undefined {
  if (!declNode) return undefined;
  if (declNode.type === 'identifier') return declNode.text;
  // Recursively unwrap pointer_declarator / reference_declarator chains (e.g. int** ptr)
  for (let i = 0; i < declNode.namedChildCount; i++) {
    const child = declNode.namedChild(i);
    if (!child) continue;
    if (child.type === 'identifier') return child.text;
    if (child.type === 'pointer_declarator' || child.type === 'reference_declarator') {
      return extractParamName(child);
    }
  }
  return undefined;
}

/**
 * Detect C++ access specifier by walking backwards through siblings.
 * Mirrors the field extractor pattern in c-cpp.ts.
 */
function extractCppVisibility(node: SyntaxNode): MethodVisibility {
  // If this node was unwrapped from a template_declaration, the access_specifier
  // is a sibling of the template_declaration in field_declaration_list, not of
  // this node — climb up one level before walking backward.
  const startNode = node.parent?.type === 'template_declaration' ? node.parent : node;

  let sibling = startNode.previousNamedSibling;
  while (sibling) {
    if (sibling.type === 'access_specifier') {
      const text = sibling.text.replace(':', '').trim();
      if (text === 'public' || text === 'private' || text === 'protected') return text;
    }
    sibling = sibling.previousNamedSibling;
  }
  // Default: struct/union = public, class = private
  const parent = startNode.parent?.parent;
  return parent?.type === 'struct_specifier' || parent?.type === 'union_specifier'
    ? 'public'
    : 'private';
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
//     This includes namespace-wrapped and nested classes.
//   - Friend declarations are not extracted.
//   - Template method declarations with explicit specialization.
//   - const-qualified method overloads (e.g. begin() vs begin() const) collapse
//     to the same name — the schema has no isConst field to distinguish them.
export const cppMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.CPlusPlus,
  typeDeclarationNodes: ['class_specifier', 'struct_specifier', 'union_specifier'],
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
// Verified against tree-sitter-c 0.23.2
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
