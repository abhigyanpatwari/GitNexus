// gitnexus/src/core/ingestion/field-extractor.ts

import type { SyntaxNode } from './utils/ast-helpers.js';
import { SupportedLanguages } from 'gitnexus-shared';
import type { FieldExtractorContext, ExtractedFields, FieldVisibility } from './field-types.js';

/**
 * Language-specific field extractor
 */
export interface FieldExtractor {
  /** Language this extractor handles */
  language: SupportedLanguages;

  /**
   * Extract fields from a class/struct/interface declaration
   */
  extract(node: SyntaxNode, context: FieldExtractorContext): ExtractedFields | null;

  /**
   * Check if this node represents a type declaration with fields
   */
  isTypeDeclaration(node: SyntaxNode): boolean;
}

/**
 * Base class for field extractors with common utilities
 */
export abstract class BaseFieldExtractor implements FieldExtractor {
  abstract language: SupportedLanguages;

  abstract extract(node: SyntaxNode, context: FieldExtractorContext): ExtractedFields | null;
  abstract isTypeDeclaration(node: SyntaxNode): boolean;

  protected normalizeType(type: string | null): string | null {
    if (!type) return null;
    return type.trim().replace(/\s+/g, ' ');
  }

  protected resolveType(typeName: string, context: FieldExtractorContext): string | null {
    const { typeEnv, symbolTable, filePath } = context;

    // Try to find in type environment (check file scope first)
    const fileEnv = typeEnv.fileScope();
    const local = fileEnv.get(typeName);
    if (local) return local;

    // Try symbol table lookup in current file
    const symbols = symbolTable.lookupExactAll(filePath, typeName);
    if (symbols.length === 1) {
      return symbols[0].nodeId;
    }

    return typeName;
  }

  protected abstract extractVisibility(node: SyntaxNode): FieldVisibility;
}
