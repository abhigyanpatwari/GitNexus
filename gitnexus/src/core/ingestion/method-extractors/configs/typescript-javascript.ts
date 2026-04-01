// gitnexus/src/core/ingestion/method-extractors/configs/typescript-javascript.ts
// Verified against tree-sitter-typescript ^0.23.2, tree-sitter-javascript ^0.23.0

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
// TS/JS helpers
// ---------------------------------------------------------------------------

const VISIBILITY_KEYWORDS = new Set<MethodVisibility>(['public', 'private', 'protected']);

/**
 * Extract parameters from formal_parameters.
 *
 * Handles both TS node types (required_parameter, optional_parameter, rest_parameter)
 * and JS node types (identifier, assignment_pattern, rest_pattern), plus destructured
 * parameters (object_pattern, array_pattern) in both grammars.
 */
function extractTsJsParameters(node: SyntaxNode): ParameterInfo[] {
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return [];
  const params: ParameterInfo[] = [];

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param) continue;

    switch (param.type) {
      case 'required_parameter': {
        const patternNode = param.childForFieldName('pattern');
        if (!patternNode) break;

        // Skip TS `this` parameter — it's a compile-time type constraint, not a real param
        if (patternNode.type === 'this') break;

        // Rest parameter: pattern is a rest_pattern (...args) — extract inner identifier
        const isRest = patternNode.type === 'rest_pattern';
        const nameNode = isRest ? patternNode.firstNamedChild : patternNode;
        if (!nameNode) break;

        // type field is a type_annotation — unwrap to get the inner type node
        const typeAnnotation = param.childForFieldName('type');
        const typeNode = typeAnnotation?.firstNamedChild;

        // Default value: presence of a 'value' field means isOptional
        const hasDefault = !!param.childForFieldName('value');

        params.push({
          name: nameNode.text,
          type: typeNode
            ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
            : null,
          isOptional: hasDefault,
          isVariadic: isRest,
        });
        break;
      }
      case 'optional_parameter': {
        const nameNode = param.childForFieldName('pattern');
        if (!nameNode) break;
        const typeAnnotation = param.childForFieldName('type');
        const typeNode = typeAnnotation?.firstNamedChild;
        params.push({
          name: nameNode.text,
          type: typeNode
            ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
            : null,
          isOptional: true,
          isVariadic: false,
        });
        break;
      }
      case 'rest_parameter': {
        const nameNode = param.childForFieldName('pattern');
        if (!nameNode) break;
        const typeAnnotation = param.childForFieldName('type');
        const typeNode = typeAnnotation?.firstNamedChild;
        params.push({
          name: nameNode.text,
          type: typeNode
            ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
            : null,
          isOptional: false,
          isVariadic: true,
        });
        break;
      }
      case 'identifier': {
        // JS: bare parameter name, no type info
        params.push({ name: param.text, type: null, isOptional: false, isVariadic: false });
        break;
      }
      case 'assignment_pattern': {
        // JS: param = defaultValue — the left side is the name, isOptional = true
        const left = param.childForFieldName('left');
        if (left) {
          params.push({ name: left.text, type: null, isOptional: true, isVariadic: false });
        }
        break;
      }
      case 'rest_pattern': {
        // JS: ...args
        const inner = param.firstNamedChild;
        if (inner) {
          params.push({ name: inner.text, type: null, isOptional: false, isVariadic: true });
        }
        break;
      }
      case 'object_pattern':
      case 'array_pattern': {
        // Destructured parameter — use full text as name
        params.push({ name: param.text, type: null, isOptional: false, isVariadic: false });
        break;
      }
    }
  }
  return params;
}

/**
 * Extract return type from return_type field, unwrapping type_annotation.
 *
 * tree-sitter-typescript uses `return_type` as the field name (not `type` like JVM).
 * The return_type field points to a type_annotation node that must be unwrapped.
 */
function extractTsJsReturnType(node: SyntaxNode): string | undefined {
  const returnType = node.childForFieldName('return_type');
  if (returnType) {
    if (returnType.type === 'type_annotation') {
      const inner = returnType.firstNamedChild;
      if (inner) return extractSimpleTypeName(inner) ?? inner.text?.trim();
    }
    return extractSimpleTypeName(returnType) ?? returnType.text?.trim();
  }
  return undefined;
}

/**
 * Extract visibility from accessibility_modifier or #private name.
 *
 * tree-sitter-typescript emits accessibility_modifier as a named child of method nodes
 * (not as a modifiers wrapper like JVM). Pass 1 scans for that child; pass 2 checks for
 * ES2022 private_property_identifier (#name). Default: public.
 */
function extractTsJsVisibility(node: SyntaxNode): MethodVisibility {
  // Pass 1: check for accessibility_modifier named child (TS-specific)
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === 'accessibility_modifier') {
      const t = child.text.trim();
      if (VISIBILITY_KEYWORDS.has(t as MethodVisibility)) return t as MethodVisibility;
    }
  }
  // Pass 2: ES2022 private methods (#name) are inherently private
  const nameNode = node.childForFieldName('name');
  if (nameNode && nameNode.type === 'private_property_identifier') return 'private';
  // No accessibility_modifier found — default to public.
  // Note: tree-sitter-typescript does not wrap modifiers in a 'modifiers' node
  // (unlike JVM), so there is no wrapper to scan.
  return 'public';
}

/**
 * Extract decorator names, prefixed with '@'.
 *
 * In tree-sitter-typescript, decorators are **siblings** of the method_definition in the
 * class_body — they are NOT children of the method node. We find them by walking backwards
 * from the method node through its preceding siblings in the parent body.
 */
function extractTsJsDecorators(node: SyntaxNode): string[] {
  const decorators: string[] = [];
  // Walk backwards via previousNamedSibling to collect consecutive decorator siblings.
  // This avoids the O(N) index-finding scan through the parent's children.
  let sibling = node.previousNamedSibling;
  while (sibling && sibling.type === 'decorator') {
    const name = extractDecoratorName(sibling);
    if (name) decorators.unshift(name);
    sibling = sibling.previousNamedSibling;
  }
  return decorators;
}

function extractDecoratorName(decorator: SyntaxNode): string | undefined {
  const expr = decorator.firstNamedChild;
  if (!expr) return undefined;
  if (expr.type === 'call_expression') {
    const fn = expr.childForFieldName('function');
    return fn ? '@' + fn.text : undefined;
  }
  if (expr.type === 'identifier') return '@' + expr.text;
  if (expr.type === 'member_expression') return '@' + expr.text;
  return undefined;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// TS and JS share the same config base. TS-only node types (abstract_class_declaration,
// interface_declaration, abstract_method_signature, method_signature, interface_body) are
// included because the JS grammar never produces these nodes — they are harmless no-ops.
// This mirrors the field extractor's typescript-javascript.ts shared pattern.
//
// Note: TS and JS share a method config but NOT a field extractor because the TS field
// extractor needs a hand-written class for type_alias_declaration object literals and
// nested type discovery. Methods have no such requirement.
const shared: Omit<MethodExtractionConfig, 'language'> = {
  typeDeclarationNodes: [
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
  ],
  // Note: TS constructors are method_definition nodes (name = 'constructor'), so no
  // explicit constructor_declaration entry is needed (unlike JVM/C# configs).
  // Known gaps:
  //   - call_signature and construct_signature (e.g., interface Fn { (x: string): void; })
  //     are not extracted — they have no name field and are uncommon in practice.
  //   - class_expression (const Foo = class { ... }) — methods inside class expressions
  //     are not discovered because class_expression is not in typeDeclarationNodes.
  //   - declare module / declare global augmentations — methods inside ambient_module_declaration
  //     wrappers are not surfaced because the top-level walker doesn't descend into them.
  methodNodeTypes: ['method_definition', 'method_signature', 'abstract_method_signature'],
  bodyNodeTypes: ['class_body', 'interface_body'],

  extractName(node) {
    const nameNode = node.childForFieldName('name');
    return nameNode?.text;
  },

  extractReturnType: extractTsJsReturnType,
  extractParameters: extractTsJsParameters,
  extractVisibility: extractTsJsVisibility,

  isStatic(node) {
    return hasKeyword(node, 'static');
  },

  isAbstract(node, ownerNode) {
    // Explicit abstract keyword on the method itself
    if (hasKeyword(node, 'abstract')) return true;
    // Interface methods are implicitly abstract — TS interfaces never have method bodies
    // (unlike Java default methods), so no !body check needed
    if (ownerNode.type === 'interface_declaration') return true;
    return false;
  },

  isFinal(_node) {
    return false; // TS/JS has no final/sealed methods
  },

  extractAnnotations: extractTsJsDecorators,

  isAsync(node) {
    return hasKeyword(node, 'async');
  },

  isOverride(node) {
    return hasKeyword(node, 'override');
  },
};

export const typescriptMethodConfig: MethodExtractionConfig = {
  ...shared,
  language: SupportedLanguages.TypeScript,
};

export const javascriptMethodConfig: MethodExtractionConfig = {
  ...shared,
  language: SupportedLanguages.JavaScript,
};
