// gitnexus/src/core/ingestion/method-extractors/configs/go.ts
// Verified against tree-sitter-go 0.23.4

import { SupportedLanguages } from 'gitnexus-shared';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// Go helpers
// ---------------------------------------------------------------------------

/**
 * Extract the method/function name.
 * - method_declaration: name is a `field_identifier`
 * - function_declaration: name is an `identifier`
 */
function extractGoName(node: SyntaxNode): string | undefined {
  const nameNode = node.childForFieldName('name');
  return nameNode?.text;
}

/**
 * Extract return type from the `result` field.
 *
 * Go supports single return (`int`) and multi-return (`(User, error)`).
 * Multi-return appears as a `parameter_list` — extract the first type.
 */
function extractGoReturnType(node: SyntaxNode): string | undefined {
  const result = node.childForFieldName('result');
  if (!result) return undefined;

  // Single return type (type_identifier, pointer_type, etc.)
  if (result.type !== 'parameter_list') {
    return result.text?.trim();
  }

  // Multi-return: (Type, error) — extract first parameter's type
  for (let i = 0; i < result.namedChildCount; i++) {
    const param = result.namedChild(i);
    if (param?.type === 'parameter_declaration') {
      const typeNode = param.childForFieldName('type');
      if (typeNode) return typeNode.text?.trim();
    }
  }
  return undefined;
}

/**
 * Extract parameters from the `parameters` field.
 *
 * Go parameter_list contains parameter_declaration nodes with optional
 * `name` and required `type` fields. Go allows multiple names for one type:
 * `func(a, b int)` — each name shares the type.
 *
 * Handles variadic_parameter_declaration (`...string`).
 */
function extractGoParameters(node: SyntaxNode): ParameterInfo[] {
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return [];
  const params: ParameterInfo[] = [];

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param) continue;

    if (param.type === 'parameter_declaration') {
      const typeNode = param.childForFieldName('type');
      const typeName = typeNode
        ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
        : null;

      // Go allows multiple names for one type: func(a, b int)
      const names: string[] = [];
      for (let j = 0; j < param.namedChildCount; j++) {
        const child = param.namedChild(j);
        if (child?.type === 'identifier') {
          names.push(child.text);
        }
      }

      const rawType = typeNode?.text?.trim() ?? null;
      if (names.length === 0) {
        // Unnamed parameter: func(int, string)
        params.push({
          name: `_${i}`,
          type: typeName,
          rawType,
          isOptional: false,
          isVariadic: false,
        });
      } else {
        for (const name of names) {
          params.push({ name, type: typeName, rawType, isOptional: false, isVariadic: false });
        }
      }
    } else if (param.type === 'variadic_parameter_declaration') {
      const nameNode = param.childForFieldName('name');
      const typeNode = param.childForFieldName('type');
      const typeName = typeNode
        ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
        : null;
      params.push({
        name: nameNode?.text ?? `_${i}`,
        type: typeName,
        rawType: typeNode?.text?.trim() ?? null,
        isOptional: false,
        isVariadic: true,
      });
    }
  }
  return params;
}

/**
 * Go visibility: uppercase first character = exported (public), lowercase = unexported (private).
 */
function extractGoVisibility(node: SyntaxNode): MethodVisibility {
  const name = extractGoName(node);
  if (!name || name.length === 0) return 'private';
  const first = name[0];
  return first === first.toUpperCase() && first !== first.toLowerCase() ? 'public' : 'private';
}

/**
 * Extract receiver type from the `receiver` field.
 *
 * The receiver is a parameter_list with one parameter_declaration:
 *   (r *Repo) → pointer_type → type_identifier "Repo"
 *   (r Repo)  → type_identifier "Repo"
 */
function extractGoReceiverType(node: SyntaxNode): string | undefined {
  const receiver = node.childForFieldName('receiver');
  if (!receiver) return undefined;

  for (let i = 0; i < receiver.namedChildCount; i++) {
    const param = receiver.namedChild(i);
    if (param?.type === 'parameter_declaration') {
      const typeNode = param.childForFieldName('type');
      if (!typeNode) continue;
      // Unwrap pointer_type: *User → User
      const inner = typeNode.type === 'pointer_type' ? typeNode.firstNamedChild : typeNode;
      return inner?.text;
    }
  }
  return undefined;
}

/**
 * Resolve owner name from the receiver type.
 * For function_declaration (no receiver), returns undefined.
 */
function extractGoOwnerName(node: SyntaxNode): string | undefined {
  return extractGoReceiverType(node);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const goMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Go,

  // Each method_declaration/function_declaration is treated as its own "container"
  // for extractFromNode() — not used with extract() in the traditional sense.
  // method_elem covers interface method signatures (abstract methods).
  typeDeclarationNodes: ['method_declaration', 'function_declaration', 'method_elem'],
  methodNodeTypes: ['method_declaration', 'function_declaration', 'method_elem'],
  bodyNodeTypes: [],

  extractName: extractGoName,
  extractReturnType: extractGoReturnType,
  extractParameters: extractGoParameters,
  extractVisibility: extractGoVisibility,
  extractReceiverType: extractGoReceiverType,
  extractOwnerName: extractGoOwnerName,

  isStatic(node) {
    // Go functions (no receiver) are effectively static
    return node.type === 'function_declaration';
  },

  isAbstract(node, _ownerNode) {
    // Go interface method signatures (method_elem) are abstract — no body
    return node.type === 'method_elem';
  },

  isFinal(_node) {
    return false; // Go has no final methods
  },
};
