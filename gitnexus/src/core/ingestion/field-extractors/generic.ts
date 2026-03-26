// gitnexus/src/core/ingestion/field-extractors/generic.ts

/**
 * Generic table-driven field extractor factory.
 *
 * Instead of 14 separate 300-line files, define a config per language and
 * generate extractors from configs.  The factory creates a class extending
 * BaseFieldExtractor whose behaviour is entirely driven by FieldExtractionConfig.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import { SupportedLanguages } from '../../../config/supported-languages.js';
import { BaseFieldExtractor } from '../field-extractor.js';
import type { FieldExtractor } from '../field-extractor.js';
import type { FieldExtractorContext, ExtractedFields, FieldInfo, FieldVisibility } from '../field-types.js';

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

export interface FieldExtractionConfig {
  language: SupportedLanguages;
  /** AST node types that are class/struct/interface declarations */
  typeDeclarationNodes: string[];
  /** AST node types that represent field/property declarations inside a body */
  fieldNodeTypes: string[];
  /** AST node type(s) for the class body container (e.g., 'class_body', 'declaration_list') */
  bodyNodeTypes: string[];
  /** Default visibility when no modifier is present */
  defaultVisibility: FieldVisibility;
  /**
   * Extract field name from a field declaration node.
   * Use this for nodes that declare exactly one field.
   */
  extractName: (node: SyntaxNode) => string | undefined;
  /**
   * Extract multiple field names from a single declaration node.
   * Optional override for languages where one AST node can declare
   * several fields (e.g. Ruby `attr_accessor :foo, :bar`).
   * When present, the factory uses this instead of `extractName`.
   */
  extractNames?: (node: SyntaxNode) => string[];
  /** Extract type annotation from a field declaration node */
  extractType: (node: SyntaxNode) => string | undefined;
  /** Extract visibility from a field declaration node */
  extractVisibility: (node: SyntaxNode) => FieldVisibility;
  /** Check if a field is static */
  isStatic: (node: SyntaxNode) => boolean;
  /** Check if a field is readonly/final/const */
  isReadonly: (node: SyntaxNode) => boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a FieldExtractor from a declarative config.
 */
export function createFieldExtractor(config: FieldExtractionConfig): FieldExtractor {
  const typeDeclarationSet = new Set(config.typeDeclarationNodes);
  const fieldNodeSet = new Set(config.fieldNodeTypes);
  const bodyNodeSet = new Set(config.bodyNodeTypes);

  class GenericFieldExtractor extends BaseFieldExtractor {
    language = config.language;

    isTypeDeclaration(node: SyntaxNode): boolean {
      return typeDeclarationSet.has(node.type);
    }

    protected extractVisibility(node: SyntaxNode): FieldVisibility {
      return config.extractVisibility(node);
    }

    extract(node: SyntaxNode, context: FieldExtractorContext): ExtractedFields | null {
      if (!this.isTypeDeclaration(node)) return null;

      const nameNode = node.childForFieldName('name');
      if (!nameNode) return null;

      const ownerFqn = nameNode.text;
      const fields: FieldInfo[] = [];

      // Find body container(s)
      const bodies = this.findBodies(node);
      for (const body of bodies) {
        this.extractFieldsFromBody(body, context, fields);
      }

      return { ownerFqn, fields, nestedTypes: [] };
    }

    // ------------------------------------------------------------------
    // private helpers
    // ------------------------------------------------------------------

    private findBodies(node: SyntaxNode): SyntaxNode[] {
      const result: SyntaxNode[] = [];
      // Try named 'body' field first
      const bodyField = node.childForFieldName('body');
      if (bodyField && bodyNodeSet.has(bodyField.type)) {
        result.push(bodyField);
        return result;
      }
      // Walk immediate children for matching body node types
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && bodyNodeSet.has(child.type)) {
          result.push(child);
        }
      }
      // Fallback: use the body field even if its type is not in bodyNodeSet
      if (result.length === 0 && bodyField) {
        result.push(bodyField);
      }
      return result;
    }

    private extractFieldsFromBody(
      body: SyntaxNode,
      context: FieldExtractorContext,
      out: FieldInfo[],
    ): void {
      for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i);
        if (!child) continue;

        if (fieldNodeSet.has(child.type)) {
          if (config.extractNames) {
            // Multi-name path: one node may declare several fields (e.g. Ruby attr_accessor)
            const names = config.extractNames(child);
            for (const name of names) {
              const field = this.buildField(child, name, context);
              if (field) out.push(field);
            }
          } else {
            const field = this.extractSingleField(child, context);
            if (field) out.push(field);
          }
        }
      }
    }

    private extractSingleField(
      node: SyntaxNode,
      context: FieldExtractorContext,
    ): FieldInfo | null {
      const name = config.extractName(node);
      if (!name) return null;
      return this.buildField(node, name, context);
    }

    private buildField(
      node: SyntaxNode,
      name: string,
      context: FieldExtractorContext,
    ): FieldInfo | null {
      if (!name) return null;

      let type: string | null = config.extractType(node) ?? null;
      if (type) {
        type = this.normalizeType(type);
        const resolved = this.resolveType(type, context);
        if (resolved) type = resolved;
      }

      return {
        name,
        type,
        visibility: config.extractVisibility(node),
        isStatic: config.isStatic(node),
        isReadonly: config.isReadonly(node),
        sourceFile: context.filePath,
        line: node.startPosition.row + 1,
      };
    }
  }

  return new GenericFieldExtractor();
}
