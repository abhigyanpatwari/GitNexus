// gitnexus/src/core/ingestion/field-extractors/typescript.ts

import type { SyntaxNode } from '../utils/ast-helpers.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { BaseFieldExtractor } from '../field-extractor.js';
import type {
  FieldExtractorContext,
  ExtractedFields,
  FieldInfo,
  FieldVisibility,
} from '../field-types.js';

/**
 * Hand-written TypeScript field extractor.
 *
 * This exists alongside the config-based extractor in configs/typescript-javascript.ts
 * (used for JavaScript) because TypeScript has unique requirements:
 * 1. type_alias_declaration with object type literals (e.g., type Config = { key: string })
 * 2. Optional property detection appending '| undefined' to types
 * 3. Nested type discovery within class/interface bodies
 *
 * The config-based extractor cannot express these TS-specific capabilities.
 * JavaScript uses the config-based version since it lacks type syntax.
 */
export class TypeScriptFieldExtractor extends BaseFieldExtractor {
  language = SupportedLanguages.TypeScript;

  /**
   * Node types that represent type declarations with fields in TypeScript
   */
  private static readonly TYPE_DECLARATION_NODES = new Set([
    'class_declaration',
    'interface_declaration',
    'abstract_class_declaration',
    'type_alias_declaration', // for object type literals
  ]);

  /**
   * Node types that contain field definitions within class bodies
   */
  private static readonly FIELD_NODE_TYPES = new Set([
    'public_field_definition', // class field: private users: User[]
    'property_signature', // interface property: name: string
    'field_definition', // fallback field type
  ]);

  /**
   * Visibility modifiers in TypeScript
   */
  private static readonly VISIBILITY_MODIFIERS = new Set<FieldVisibility>([
    'public',
    'private',
    'protected',
  ]);

  /**
   * Check if this node represents a type declaration with fields
   */
  isTypeDeclaration(node: SyntaxNode): boolean {
    return TypeScriptFieldExtractor.TYPE_DECLARATION_NODES.has(node.type);
  }

  /**
   * Extract visibility modifier from a field node
   */
  protected extractVisibility(node: SyntaxNode): FieldVisibility {
    // Check for accessibility_modifier named child (tree-sitter typescript)
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && child.type === 'accessibility_modifier') {
        const text = child.text.trim() as FieldVisibility;
        if (TypeScriptFieldExtractor.VISIBILITY_MODIFIERS.has(text)) {
          return text;
        }
      }
    }

    // Check for modifiers in the field's unnamed children (fallback)
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && !child.isNamed) {
        const text = child.text.trim() as FieldVisibility;
        if (TypeScriptFieldExtractor.VISIBILITY_MODIFIERS.has(text)) {
          return text;
        }
      }
    }

    // Check for modifier node (tree-sitter typescript may group these)
    const modifiers = node.childForFieldName('modifiers');
    if (modifiers) {
      for (let i = 0; i < modifiers.childCount; i++) {
        const modifier = modifiers.child(i);
        const modText = modifier?.text.trim() as FieldVisibility | undefined;
        if (modText && TypeScriptFieldExtractor.VISIBILITY_MODIFIERS.has(modText)) {
          return modText;
        }
      }
    }

    // TypeScript class members are public by default
    return 'public';
  }

  /**
   * Check if a field has the static modifier
   */
  private isStatic(node: SyntaxNode): boolean {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && !child.isNamed && child.text.trim() === 'static') {
        return true;
      }
    }

    const modifiers = node.childForFieldName('modifiers');
    if (modifiers) {
      for (let i = 0; i < modifiers.childCount; i++) {
        const modifier = modifiers.child(i);
        if (modifier && modifier.text === 'static') {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if a field has the readonly modifier
   */
  private isReadonly(node: SyntaxNode): boolean {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && !child.isNamed && child.text.trim() === 'readonly') {
        return true;
      }
    }

    const modifiers = node.childForFieldName('modifiers');
    if (modifiers) {
      for (let i = 0; i < modifiers.childCount; i++) {
        const modifier = modifiers.child(i);
        if (modifier && modifier.text === 'readonly') {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if a property is optional (has ?: syntax)
   */
  private isOptional(node: SyntaxNode): boolean {
    // Look for the optional marker '?' in unnamed children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && !child.isNamed && child.text === '?') {
        return true;
      }
    }

    // Also check for optional_property_signature or marker in type
    const kind = node.childForFieldName('kind');
    if (kind && kind.text === '?') {
      return true;
    }

    return false;
  }

  /**
   * Extract the full type text, handling complex generic types.
   *
   * type_annotation nodes wrap the literal ': SomeType' — only that branch
   * needs special handling to unwrap the inner child and skip the colon.
   * All other node kinds are already the type text itself, so normalizeType
   * is applied directly.
   */
  private extractFullType(typeNode: SyntaxNode | null): string | null {
    if (!typeNode) return null;
    if (typeNode.type === 'type_annotation') {
      const innerType = typeNode.firstNamedChild;
      return innerType ? this.normalizeType(innerType.text) : null;
    }
    return this.normalizeType(typeNode.text);
  }

  /**
   * Extract a single field from a field definition node
   */
  private extractField(node: SyntaxNode, context: FieldExtractorContext): FieldInfo | null {
    // Get the field name
    const nameNode = node.childForFieldName('name') ?? node.childForFieldName('property');
    if (!nameNode) return null;

    const name = nameNode.text;
    if (!name) return null;

    // Get the type annotation
    const typeNode = node.childForFieldName('type');
    let type: string | null = this.extractFullType(typeNode);

    // Try to resolve the type using the context
    if (type) {
      const resolvedType = this.resolveType(type, context);
      type = resolvedType ?? type;
    }

    return {
      name,
      type,
      visibility: this.extractVisibility(node),
      isStatic: this.isStatic(node),
      isReadonly: this.isReadonly(node),
      sourceFile: context.filePath,
      line: node.startPosition.row + 1,
    };
  }

  /**
   * Extract fields from a class body or interface body
   */
  private extractFieldsFromBody(bodyNode: SyntaxNode, context: FieldExtractorContext): FieldInfo[] {
    const fields: FieldInfo[] = [];

    // Find all field definition nodes within the body
    for (let i = 0; i < bodyNode.namedChildCount; i++) {
      const child = bodyNode.namedChild(i);
      if (!child) continue;

      if (TypeScriptFieldExtractor.FIELD_NODE_TYPES.has(child.type)) {
        const field = this.extractField(child, context);
        if (field) {
          fields.push(field);
        }
      }
    }

    return fields;
  }

  /**
   * Extract fields from an object type (used in type aliases)
   */
  private extractFieldsFromObjectType(
    objectTypeNode: SyntaxNode,
    context: FieldExtractorContext,
  ): FieldInfo[] {
    const fields: FieldInfo[] = [];

    // Find all property_signature nodes within the object type
    const propertySignatures = objectTypeNode.descendantsOfType('property_signature');

    for (const propNode of propertySignatures) {
      const field = this.extractField(propNode, context);
      if (field) {
        // Mark optional properties
        if (this.isOptional(propNode) && field.type) {
          field.type = field.type + ' | undefined';
        }
        fields.push(field);
      }
    }

    return fields;
  }

  /**
   * Extract fields from a class or interface declaration
   */
  extract(node: SyntaxNode, context: FieldExtractorContext): ExtractedFields | null {
    if (!this.isTypeDeclaration(node)) return null;

    // Get the type name
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return null;

    const typeName = nameNode.text;
    const ownerFqn = typeName;

    const fields: FieldInfo[] = [];
    const nestedTypes: string[] = [];

    // Handle different declaration types
    if (node.type === 'class_declaration' || node.type === 'abstract_class_declaration') {
      // Find the class body
      const bodyNode = node.childForFieldName('body');
      if (bodyNode) {
        const extractedFields = this.extractFieldsFromBody(bodyNode, context);
        fields.push(...extractedFields);
      }
    } else if (node.type === 'interface_declaration') {
      // Find the interface body
      const bodyNode = node.childForFieldName('body');
      if (bodyNode) {
        const extractedFields = this.extractFieldsFromBody(bodyNode, context);
        fields.push(...extractedFields);
      }
    } else if (node.type === 'type_alias_declaration') {
      // Handle type aliases with object types
      const valueNode = node.childForFieldName('value');
      if (valueNode && valueNode.type === 'object_type') {
        const extractedFields = this.extractFieldsFromObjectType(valueNode, context);
        fields.push(...extractedFields);
      }
    }

    // Find nested type declarations
    const nestedClasses = node.descendantsOfType('class_declaration');
    const nestedInterfaces = node.descendantsOfType('interface_declaration');
    const nestedDeclarations = [...nestedClasses, ...nestedInterfaces];

    for (const nested of nestedDeclarations) {
      // Skip the current node itself
      if (nested === node) continue;

      const nestedName = nested.childForFieldName('name');
      if (nestedName) {
        nestedTypes.push(nestedName.text);
      }
    }

    return {
      ownerFqn,
      fields,
      nestedTypes,
    };
  }
}

// Export a singleton instance for registration
export const typescriptFieldExtractor = new TypeScriptFieldExtractor();
