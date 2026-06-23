// gitnexus/src/core/ingestion/method-extractors/configs/jvm.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import { findVisibility, hasModifier } from '../../field-extractors/configs/helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// Shared JVM helpers
// ---------------------------------------------------------------------------

const INTERFACE_OWNER_TYPES = new Set(['interface_declaration', 'annotation_type_declaration']);

function extractReturnTypeFromField(node: SyntaxNode): string | undefined {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return undefined;
  // Use .text to preserve full generic types (e.g. List<User>, Stream<T>)
  // needed by the call resolver for return-type inference.
  return typeNode.text?.trim();
}

function extractAnnotations(node: SyntaxNode, modifierType: string): string[] {
  const annotations: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === modifierType) {
      for (let j = 0; j < child.namedChildCount; j++) {
        const mod = child.namedChild(j);
        if (mod && (mod.type === 'marker_annotation' || mod.type === 'annotation')) {
          const nameNode = mod.childForFieldName('name') ?? mod.firstNamedChild;
          if (nameNode) annotations.push('@' + nameNode.text);
        }
      }
    }
  }
  return annotations;
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const JAVA_VIS = new Set<MethodVisibility>(['public', 'private', 'protected']);

function extractJavaParameters(node: SyntaxNode): ParameterInfo[] {
  const params: ParameterInfo[] = [];
  let paramList = node.childForFieldName('parameters');
  // Compact constructors have no parameter list — inherit from parent record_declaration
  if (!paramList && node.type === 'compact_constructor_declaration') {
    const recordNode = node.parent?.parent; // compact_ctor → class_body → record_declaration
    if (recordNode?.type === 'record_declaration') {
      paramList = recordNode.childForFieldName('parameters');
    }
  }
  if (!paramList) return params;

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param) continue;

    if (param.type === 'formal_parameter') {
      const nameNode = param.childForFieldName('name');
      const typeNode = param.childForFieldName('type');
      if (nameNode) {
        params.push({
          name: nameNode.text,
          type: typeNode ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim()) : null,
          rawType: typeNode?.text?.trim() ?? null,
          isOptional: false,
          isVariadic: false,
        });
      }
    } else if (param.type === 'spread_parameter') {
      // Varargs: type_identifier + "..." + variable_declarator
      let paramName: string | undefined;
      let paramType: string | null = null;
      let paramRawType: string | null = null;
      for (let j = 0; j < param.namedChildCount; j++) {
        const c = param.namedChild(j);
        if (!c) continue;
        if (c.type === 'variable_declarator') {
          const nameChild = c.childForFieldName('name');
          paramName = nameChild?.text ?? c.text;
        } else if (
          c.type === 'type_identifier' ||
          c.type === 'generic_type' ||
          c.type === 'scoped_type_identifier' ||
          c.type === 'integral_type' ||
          c.type === 'floating_point_type' ||
          c.type === 'boolean_type'
        ) {
          paramRawType = c.text?.trim() ?? null;
          paramType = extractSimpleTypeName(c) ?? paramRawType;
        }
      }
      if (paramName) {
        params.push({
          name: paramName,
          type: paramType,
          rawType: paramRawType,
          isOptional: false,
          isVariadic: true,
        });
      }
    }
  }
  return params;
}

export const javaMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Java,
  typeDeclarationNodes: [
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
    'annotation_type_declaration',
  ],
  methodNodeTypes: [
    'method_declaration',
    'constructor_declaration',
    'compact_constructor_declaration',
    'annotation_type_element_declaration',
  ],
  bodyNodeTypes: [
    'class_body',
    'interface_body',
    'enum_body',
    'enum_body_declarations',
    'annotation_type_body',
  ],
  extractName(node) {
    const nameNode = node.childForFieldName('name');
    return nameNode?.text;
  },

  extractReturnType: extractReturnTypeFromField,

  extractParameters: extractJavaParameters,

  extractVisibility(node) {
    return findVisibility(node, JAVA_VIS, 'package', 'modifiers');
  },

  isStatic(node) {
    return hasModifier(node, 'modifiers', 'static');
  },

  isAbstract(node, ownerNode) {
    if (hasModifier(node, 'modifiers', 'abstract')) return true;
    // Interface methods are implicitly abstract unless they have a body (default methods)
    if (INTERFACE_OWNER_TYPES.has(ownerNode.type)) {
      const body = node.childForFieldName('body');
      return !body;
    }
    return false;
  },

  isFinal(node) {
    return hasModifier(node, 'modifiers', 'final');
  },

  extractAnnotations(node) {
    return extractAnnotations(node, 'modifiers');
  },
};

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------

const KOTLIN_VIS = new Set<MethodVisibility>(['public', 'private', 'protected', 'internal']);

function kotlinParameterHasDefaultValue(param: SyntaxNode): boolean {
  // tree-sitter-kotlin inlines `_function_value_parameter`, so `=` and its
  // expression are siblings of `parameter`, not children of the parameter.
  for (let sibling = param.nextSibling; sibling !== null; sibling = sibling.nextSibling) {
    if (sibling.type === ',' || sibling.type === ')') return false;
    if (sibling.type === '=') return true;
  }
  return false;
}

/**
 * Member name for a Kotlin method node. A `secondary_constructor`
 * (`constructor(...) { }`) has no name child — its only identity token is
 * the anonymous `constructor` keyword — so it is named "constructor" (F48,
 * issue #1919), matching the @name the KOTLIN_QUERIES structure rule captures
 * off that keyword so method-extractor enrichment keys (`name:line`) align.
 * Multiple secondary constructors collide on this name but are disambiguated
 * downstream by the `#<arity>` ID suffix the worker appends to Constructors.
 */
function extractKotlinMethodName(node: SyntaxNode): string | undefined {
  if (node.type === 'secondary_constructor') return 'constructor';
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'simple_identifier') return child.text;
  }
  return undefined;
}

function extractKotlinParameters(node: SyntaxNode): ParameterInfo[] {
  const params: ParameterInfo[] = [];
  // Kotlin: function_declaration / secondary_constructor >
  // function_value_parameters > parameter. Both node types nest the
  // parameter list the same way, so the same walk extracts a secondary
  // constructor's parameters (F48).
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === 'function_value_parameters') {
      let nextIsVariadic = false;
      for (let j = 0; j < child.namedChildCount; j++) {
        const param = child.namedChild(j);
        if (!param) continue;
        // parameter_modifiers containing vararg precedes the parameter node
        if (param.type === 'parameter_modifiers') {
          for (let m = 0; m < param.namedChildCount; m++) {
            const mod = param.namedChild(m);
            if (mod && mod.text === 'vararg') nextIsVariadic = true;
          }
          continue;
        }
        if (param.type !== 'parameter') continue;

        let paramName: string | undefined;
        let paramType: string | null = null;
        let paramRawType: string | null = null;
        const isVariadic = nextIsVariadic;
        nextIsVariadic = false;

        for (let k = 0; k < param.namedChildCount; k++) {
          const part = param.namedChild(k);
          if (!part) continue;
          if (part.type === 'simple_identifier') {
            paramName = part.text;
          } else if (
            part.type === 'user_type' ||
            part.type === 'nullable_type' ||
            part.type === 'function_type'
          ) {
            paramRawType = part.text?.trim() ?? null;
            paramType = extractSimpleTypeName(part) ?? paramRawType;
          }
        }

        if (paramName) {
          params.push({
            name: paramName,
            type: paramType,
            rawType: paramRawType,
            isOptional: kotlinParameterHasDefaultValue(param),
            isVariadic: isVariadic,
          });
        }
      }
      break;
    }
  }

  return params;
}

function extractKotlinReturnType(node: SyntaxNode): string | undefined {
  // Kotlin: return type appears after `:` following the parameter list
  // In tree-sitter-kotlin, it's a user_type/nullable_type child after function_value_parameters
  let seenParams = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'function_value_parameters') {
      seenParams = true;
      continue;
    }
    if (
      seenParams &&
      (child.type === 'user_type' ||
        child.type === 'nullable_type' ||
        child.type === 'function_type')
    ) {
      return child.text?.trim();
    }
    if (child.type === 'function_body') break;
  }
  return undefined;
}

export const kotlinMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Kotlin,
  typeDeclarationNodes: ['class_declaration', 'object_declaration', 'companion_object'],
  methodNodeTypes: ['function_declaration', 'secondary_constructor'],
  bodyNodeTypes: ['class_body'],
  staticOwnerTypes: new Set(['companion_object', 'object_declaration']),
  extractName: extractKotlinMethodName,

  extractReturnType: extractKotlinReturnType,

  extractParameters: extractKotlinParameters,

  extractVisibility(node) {
    return findVisibility(node, KOTLIN_VIS, 'public', 'modifiers');
  },

  isStatic(_node) {
    // Kotlin has no static — companion object members are separate
    return false;
  },

  isAbstract(node, ownerNode) {
    if (hasModifier(node, 'modifiers', 'abstract')) return true;
    // Interface methods without a body are abstract
    // Kotlin interfaces: class_declaration with "interface" keyword child
    for (let i = 0; i < ownerNode.childCount; i++) {
      const child = ownerNode.child(i);
      if (child && child.text === 'interface') {
        const body = node.childForFieldName('body');
        // function_declaration > function_body
        let hasBody = !!body;
        if (!hasBody) {
          for (let j = 0; j < node.namedChildCount; j++) {
            const c = node.namedChild(j);
            if (c && c.type === 'function_body') {
              hasBody = true;
              break;
            }
          }
        }
        return !hasBody;
      }
    }
    return false;
  },

  isFinal(node) {
    // Kotlin functions are closed (final) by default — only open/abstract/override makes them overridable
    if (hasModifier(node, 'modifiers', 'open')) return false;
    if (hasModifier(node, 'modifiers', 'abstract')) return false;
    if (hasModifier(node, 'modifiers', 'override')) return false;
    return true;
  },

  extractAnnotations(node) {
    const annotations: string[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && child.type === 'modifiers') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const mod = child.namedChild(j);
          if (mod && mod.type === 'annotation') {
            // Kotlin annotation text includes the @ prefix
            const text = mod.text.trim();
            annotations.push(text.startsWith('@') ? text : '@' + text);
          }
        }
      }
    }
    return annotations;
  },

  extractReceiverType(node) {
    // Extension function receiver. Newer tree-sitter-kotlin exposes it as a
    // `receiver` field wrapping a `receiver_type` (which wraps the user_type);
    // older grammars emitted a bare user_type/nullable_type child before the
    // name (e.g. fun String.format(...) → receiver is "String").
    const receiverField = node.childForFieldName('receiver');
    if (receiverField) {
      const inner = receiverField.namedChild(0) ?? receiverField;
      return extractSimpleTypeName(inner) ?? inner.text?.trim();
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'simple_identifier') break; // past the name — no receiver
      if (
        child.type === 'receiver_type' ||
        child.type === 'user_type' ||
        child.type === 'nullable_type'
      ) {
        return extractSimpleTypeName(child) ?? child.text?.trim();
      }
    }
    return undefined;
  },
};
