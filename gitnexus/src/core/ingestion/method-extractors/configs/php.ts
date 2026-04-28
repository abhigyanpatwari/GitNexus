// gitnexus/src/core/ingestion/method-extractors/configs/php.ts
// Verified against tree-sitter-php 0.23.12

import { SupportedLanguages } from 'gitnexus-shared';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// PHP helpers
// ---------------------------------------------------------------------------

/** Regex to extract PHPDoc @return annotations: `@return User` */
const PHPDOC_RETURN_RE = /@return\s+(\S+)/;

/** Node types to skip when walking backwards through siblings for PHPDoc. */
const PHPDOC_SKIP_NODE_TYPES: ReadonlySet<string> = new Set(['attribute_list', 'attribute']);

/**
 * Normalize a PHPDoc return type for the MethodExtractor.
 * Strips nullable prefix, null/false/void unions, namespace prefixes, and
 * rejects uninformative types (mixed, void, self, static, object, array).
 */
function normalizePhpReturnType(raw: string): string | undefined {
  let type = raw.startsWith('?') ? raw.slice(1) : raw;
  const parts = type
    .split('|')
    .filter((p) => p !== 'null' && p !== 'false' && p !== 'void' && p !== 'mixed');
  if (parts.length !== 1) return undefined;
  type = parts[0];
  const segments = type.split('\\');
  type = segments[segments.length - 1];
  if (
    type === 'mixed' ||
    type === 'void' ||
    type === 'self' ||
    type === 'static' ||
    type === 'object' ||
    type === 'array'
  )
    return undefined;
  if (/^\w+(\[\])?$/.test(type) || /^\w+\s*</.test(type)) return type;
  return undefined;
}

/**
 * Walk backwards through preceding siblings of `node` to find a PHPDoc
 * `@return Type` annotation. Skips `attribute_list` nodes (PHP 8 attributes).
 */
function extractPhpDocReturnType(node: SyntaxNode): string | undefined {
  let sibling = node.previousSibling;
  while (sibling) {
    if (sibling.type === 'comment') {
      const match = PHPDOC_RETURN_RE.exec(sibling.text);
      if (match) return normalizePhpReturnType(match[1]);
    } else if (sibling.isNamed && !PHPDOC_SKIP_NODE_TYPES.has(sibling.type)) {
      break;
    }
    sibling = sibling.previousSibling;
  }
  return undefined;
}

const PHP_VIS = new Set<MethodVisibility>(['public', 'private', 'protected']);

/**
 * Find the visibility keyword from a visibility_modifier named child.
 * PHP tree-sitter emits `visibility_modifier` as a named node with text
 * "public", "private", or "protected".
 */
function findPhpVisibility(node: SyntaxNode): MethodVisibility {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'visibility_modifier') {
      const text = child.text.trim() as MethodVisibility;
      if (PHP_VIS.has(text)) return text;
    }
  }
  return 'public'; // PHP methods are public by default
}

/**
 * Check for a named modifier child of a specific type.
 * PHP tree-sitter uses distinct node types: abstract_modifier, final_modifier,
 * static_modifier — rather than a wrapper `modifiers` node with keyword children.
 */
function hasModifierNode(node: SyntaxNode, modifierType: string): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === modifierType) return true;
  }
  return false;
}

/**
 * Extract the return type from a PHP method_declaration node.
 *
 * In tree-sitter-php, the return type is not exposed via a named field.
 * It appears as a type node (primitive_type, named_type, union_type,
 * optional_type, nullable_type, intersection_type) after the formal_parameters
 * and a `:` token separator.
 *
 * When the AST return type is missing or uninformative (`array` / `iterable`),
 * falls back to parsing PHPDoc `@return Type` from preceding doc comments.
 */
function extractPhpReturnType(node: SyntaxNode): string | undefined {
  const TYPE_NODE_TYPES = new Set([
    'primitive_type',
    'named_type',
    'union_type',
    'optional_type',
    'nullable_type',
    'intersection_type',
  ]);

  let astType: string | undefined;
  let seenParams = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'formal_parameters') {
      seenParams = true;
      continue;
    }
    // After the parameters node, look for the colon and then the type
    if (seenParams && child.isNamed && TYPE_NODE_TYPES.has(child.type)) {
      astType = child.text?.trim();
      break;
    }
    // Stop at body or semicolon
    if (child.type === 'compound_statement' || (!child.isNamed && child.text === ';')) {
      break;
    }
  }

  // If AST type is missing or uninformative, try PHPDoc @return fallback
  if (!astType || astType === 'array' || astType === 'iterable') {
    const docType = extractPhpDocReturnType(node);
    if (docType) return docType;
  }

  return astType;
}

/**
 * Extract parameters from a PHP method_declaration node.
 *
 * PHP parameter types in tree-sitter-php:
 * - `simple_parameter`: regular parameter with optional type and default
 * - `variadic_parameter`: `...$param` with optional type
 * - `property_promotion_parameter`: constructor promotion `private string $name`
 *   (may also be variadic via an ERROR node containing `...`)
 */
function extractPhpParameters(node: SyntaxNode): ParameterInfo[] {
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return [];

  const params: ParameterInfo[] = [];

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param) continue;

    if (param.type === 'simple_parameter') {
      const nameNode = param.childForFieldName('name');
      if (!nameNode) continue;
      const typeNode = param.childForFieldName('type');
      const typeName = typeNode ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim()) : null;

      // Detect optional: '=' token among children indicates a default value
      let isOptional = false;
      for (let j = 0; j < param.childCount; j++) {
        const c = param.child(j);
        if (c && !c.isNamed && c.text === '=') {
          isOptional = true;
          break;
        }
      }

      params.push({
        name: stripDollar(nameNode.text),
        type: typeName ?? null,
        rawType: typeNode?.text?.trim() ?? null,
        isOptional,
        isVariadic: false,
      });
    } else if (param.type === 'variadic_parameter') {
      const nameNode = param.childForFieldName('name');
      if (!nameNode) continue;
      const typeNode = param.childForFieldName('type');
      const typeName = typeNode ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim()) : null;

      params.push({
        name: stripDollar(nameNode.text),
        type: typeName ?? null,
        rawType: typeNode?.text?.trim() ?? null,
        isOptional: false,
        isVariadic: true,
      });
    } else if (param.type === 'property_promotion_parameter') {
      const nameNode = param.childForFieldName('name');
      if (!nameNode) continue;
      const typeNode = param.childForFieldName('type');
      const typeName = typeNode ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim()) : null;

      // Detect variadic: an ERROR child containing "..." indicates variadic promotion
      let isVariadic = false;
      for (let j = 0; j < param.childCount; j++) {
        const c = param.child(j);
        if (c && (c.text === '...' || (c.type === 'ERROR' && c.text === '...'))) {
          isVariadic = true;
          break;
        }
      }

      params.push({
        name: stripDollar(nameNode.text),
        type: typeName ?? null,
        rawType: typeNode?.text?.trim() ?? null,
        isOptional: false,
        isVariadic,
      });
    }
  }

  return params;
}

/** Strip leading $ from PHP variable names. */
function stripDollar(name: string): string {
  return name.startsWith('$') ? name.slice(1) : name;
}

/**
 * Extract PHP 8 attributes (#[...]) from a method_declaration node.
 *
 * AST structure: attribute_list → attribute_group → attribute → name child.
 * Names are prefixed with '#' to distinguish from Java/Kotlin @ annotations.
 */
function extractPhpAnnotations(node: SyntaxNode): string[] {
  const annotations: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type !== 'attribute_list') continue;
    for (let j = 0; j < child.namedChildCount; j++) {
      const group = child.namedChild(j);
      if (!group || group.type !== 'attribute_group') continue;
      for (let k = 0; k < group.namedChildCount; k++) {
        const attr = group.namedChild(k);
        if (!attr || attr.type !== 'attribute') continue;
        const nameNode = attr.firstNamedChild;
        if (nameNode && nameNode.type === 'name') {
          annotations.push('#' + nameNode.text);
        }
      }
    }
  }
  return annotations;
}

// ---------------------------------------------------------------------------
// PHP config
// ---------------------------------------------------------------------------

export const phpMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.PHP,
  typeDeclarationNodes: [
    'class_declaration',
    'interface_declaration',
    'trait_declaration',
    'enum_declaration',
  ],
  methodNodeTypes: ['method_declaration', 'function_definition'],
  bodyNodeTypes: ['declaration_list'],

  extractName(node) {
    return node.childForFieldName('name')?.text;
  },

  extractReturnType: extractPhpReturnType,

  extractParameters: extractPhpParameters,

  extractVisibility: findPhpVisibility,

  isStatic(node) {
    return hasModifierNode(node, 'static_modifier');
  },

  isAbstract(node, ownerNode) {
    if (hasModifierNode(node, 'abstract_modifier')) return true;
    // Interface methods are implicitly abstract when they have no body.
    // Check ownerNode first, then fall back to walking the parent chain
    // (needed when called from extractFromNode where ownerNode === node).
    let isInterface = ownerNode.type === 'interface_declaration';
    if (!isInterface) {
      let p = node.parent;
      while (p) {
        if (p.type === 'interface_declaration') {
          isInterface = true;
          break;
        }
        p = p.parent;
      }
    }
    if (isInterface) {
      const body = node.childForFieldName('body');
      if (body) return false;
      for (let i = 0; i < node.namedChildCount; i++) {
        if (node.namedChild(i)?.type === 'compound_statement') return false;
      }
      return true;
    }
    return false;
  },

  isFinal(node) {
    return hasModifierNode(node, 'final_modifier');
  },

  extractAnnotations: extractPhpAnnotations,
};
