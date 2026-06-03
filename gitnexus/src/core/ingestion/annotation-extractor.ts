/**
 * Annotation Extractor - Java/Kotlin annotation parsing
 *
 * Extracts annotations from AST nodes for Java/Kotlin source code.
 * This module is separate from parse-worker to allow testing without
 * worker thread initialization.
 */

import Parser from 'tree-sitter';

/**
 * Represents an annotation extracted from Java/Kotlin source code.
 * Captures both marker annotations (e.g., @Transactional) and full annotations
 * with arguments (e.g., @Transactional(readOnly = true, timeout = 30)).
 */
export interface AnnotationInfo {
  /** Annotation name with @ prefix (e.g., "@Transactional") */
  name: string;
  /** Key-value attributes (e.g., {readOnly: "true", timeout: "30"}) */
  attrs?: Record<string, string>;
}

/**
 * Extracts all annotations from a method_declaration or class_declaration node
 * for Java/Kotlin. Annotations appear in the 'modifiers' child node.
 *
 * Handles:
 * - marker_annotation: @Transactional
 * - annotation with arguments: @Transactional(readOnly = true)
 * - annotations with nested annotations: @Retryable(backoff = @Backoff(delay = 1000))
 */
export function extractAnnotations(node: Parser.SyntaxNode | null): AnnotationInfo[] {
  const annotations: AnnotationInfo[] = [];

  if (!node) return annotations;

  // Find modifiers child
  const modifiers = node.children.find(c => c.type === 'modifiers');
  if (!modifiers) return annotations;

  for (const child of modifiers.children) {
    if (child.type === 'marker_annotation' || child.type === 'annotation') {
      const ann = extractSingleAnnotation(child);
      if (ann) annotations.push(ann);
    }
  }

  return annotations;
}

/**
 * Extracts a single annotation (marker or full) from its AST node.
 */
export function extractSingleAnnotation(node: Parser.SyntaxNode): AnnotationInfo | null {
  if (node.type !== 'marker_annotation' && node.type !== 'annotation') {
    return null;
  }

  // (#55) Kotlin wraps the annotation name in a `constructor_invocation`
  // node: annotation > constructor_invocation > user_type > type_identifier.
  // Java keeps the identifier as a direct child of `annotation`. Kotlin
  // marker annotations skip the constructor_invocation layer and go
  // directly: annotation > user_type > type_identifier. Handle all
  // three shapes so the extractor works for Java + Kotlin.
  let nameNode = node.children.find(c => c.type === 'identifier' || c.type === 'scoped_identifier');
  if (!nameNode) {
    // Kotlin full annotation: annotation > constructor_invocation > user_type > type_identifier
    const ctor = node.children.find(c => c.type === 'constructor_invocation');
    if (ctor) {
      const userType = ctor.children.find(c => c.type === 'user_type' || c.type === 'scoped_identifier');
      if (userType) {
        nameNode = userType.children.find(c => c.type === 'type_identifier' || c.type === 'scoped_identifier') ?? userType;
      }
    }
  }
  if (!nameNode) {
    // Kotlin marker annotation: annotation > user_type > type_identifier
    const userType = node.children.find(c => c.type === 'user_type' || c.type === 'scoped_identifier');
    if (userType) {
      nameNode = userType.children.find(c => c.type === 'type_identifier' || c.type === 'scoped_identifier') ?? userType;
    }
  }
  if (!nameNode) return null;

  const name = '@' + nameNode.text;
  const annInfo: AnnotationInfo = { name };

  // If it's a full annotation, extract arguments. Java uses
  // `annotation_argument_list`; Kotlin uses `value_arguments` (nested
  // inside `constructor_invocation`).
  if (node.type === 'annotation') {
    let argsList = node.childForFieldName('arguments')
      ?? node.children.find(c => c.type === 'annotation_argument_list');
    if (!argsList) {
      const ctor = node.children.find(c => c.type === 'constructor_invocation');
      if (ctor) {
        argsList = ctor.children.find(c => c.type === 'value_arguments');
      }
    }
    if (argsList) {
      annInfo.attrs = extractAnnotationArgs(argsList);
    }
  }

  return annInfo;
}

/**
 * Extracts key-value pairs from an annotation_argument_list.
 * Handles:
 * - Named args: key = value (Java `element_value_pair` or Kotlin `value_argument`)
 * - Unnamed args: value (stored with numeric index as key)
 * - Nested annotations: @Backoff(delay = 1000)
 */
function extractAnnotationArgs(argsList: Parser.SyntaxNode): Record<string, string> {
  const attrs: Record<string, string> = {};

  for (const child of argsList.children) {
    // Java: element_value_pair: key = value (key is `identifier`)
    // Kotlin: value_argument: key = value (key is `simple_identifier`)
    if (child.type === 'element_value_pair' || child.type === 'value_argument') {
      // Detect named vs unnamed: Kotlin unnamed args like
      // `@GetMapping("/users")` produce value_argument without a `simple_identifier`
      // key (just a string literal value). Use the presence of `=` as the
      // marker for named args.
      const hasEquals = child.children.some(c => c.type === '=');
      if (!hasEquals) {
        // Unnamed Kotlin value_argument: the value is its first non-trivial child.
        const value = extractArgValue(child.children.find(c =>
          c.type !== '(' && c.type !== ')' && !c.text.match(/^\s*$/)
        ));
        if (value !== null) {
          const idx = Object.keys(attrs).filter(k => k.match(/^\d+$/)).length;
          attrs[String(idx)] = value;
        }
        continue;
      }
      const keyNode = child.children.find(c => c.type === 'identifier' || c.type === 'simple_identifier');
      if (!keyNode) continue;

      const key = keyNode.text;
      const value = extractArgValue(child.children.find(c =>
        c.type !== 'identifier' && c.type !== 'simple_identifier' &&
        c.type !== '=' && !c.text.match(/^\s*$/)
      ));
      if (value !== null) {
        attrs[key] = value;
      }
    }
    // Unnamed argument: single value (e.g., @GetMapping("/users") in Java)
    else if (child.type === 'string_literal' || child.type === 'number' || child.type === 'true' || child.type === 'false' || child.type === 'identifier') {
      // Store with numeric index - first unnamed arg gets key "0"
      const idx = Object.keys(attrs).filter(k => k.match(/^\d+$/)).length;
      attrs[String(idx)] = extractArgValue(child) || '';
    }
    // Array argument: {value1, value2}
    else if (child.type === 'element_value_array_initializer') {
      const values: string[] = [];
      for (const elem of child.children) {
        const val = extractArgValue(elem);
        if (val !== null) values.push(val);
      }
      const idx = Object.keys(attrs).filter(k => k.match(/^\d+$/)).length;
      attrs[String(idx)] = '[' + values.join(', ') + ']';
    }
  }

  return attrs;
}

/**
 * Extracts the string value from an annotation argument value node.
 * Handles: string_literal, number, boolean, identifier, field_access,
 * nested annotation, and element_value_array_initializer.
 */
function extractArgValue(node: Parser.SyntaxNode | undefined): string | null {
  if (!node) return null;

  switch (node.type) {
    case 'string_literal':
      // Extract content from string_literal (remove quotes)
      for (const child of node.children) {
        if (child.type === 'string_fragment') {
          return child.text;
        }
      }
      return node.text.replace(/^["']|["']$/g, '');

    case 'number':
    case 'decimal_integer_literal':
    case 'hex_integer_literal':
    case 'octal_integer_literal':
    case 'float_literal':
    case 'double_literal':
      return node.text;

    case 'true':
    case 'false':
    case 'boolean_literal':
      return node.text;

    case 'identifier':
    case 'type_identifier':
      return node.text;

    case 'field_access':
    case 'scoped_identifier':
      // e.g., RequestMethod.POST -> store as "RequestMethod.POST"
      return node.text;

    case 'annotation':
      // Nested annotation: @Backoff(delay = 1000)
      const nested = extractSingleAnnotation(node);
      if (nested) {
        // Format as nested annotation string
        const attrsStr = nested.attrs
          ? Object.entries(nested.attrs).map(([k, v]) => `${k}=${v}`).join(', ')
          : '';
        return nested.name + (attrsStr ? `(${attrsStr})` : '');
      }
      return null;

    case 'element_value_array_initializer':
      const values: string[] = [];
      for (const elem of node.children) {
        const val = extractArgValue(elem);
        if (val !== null) values.push(val);
      }
      return '{' + values.join(', ') + '}';

    default:
      // For other node types, try to get meaningful text
      if (node.text && !node.text.match(/^\s*$/) && !node.text.match(/^[{}\[\](),]$/)) {
        return node.text;
      }
      return null;
  }
}