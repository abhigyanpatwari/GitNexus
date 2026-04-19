// gitnexus/src/core/ingestion/variable-types.ts

import type { SupportedLanguages } from 'gitnexus-shared';
import type { FieldVisibility } from './field-types.js';
import type { SyntaxNode } from './utils/ast-helpers.js';

// Reuse FieldVisibility — same set of language visibility levels
export type VariableVisibility = FieldVisibility;

/**
 * Scope level for a variable declaration.
 * - 'module': module/package scope (TypeScript `export const`, Go package-level)
 * - 'file': file scope (C/C++ static file-scope, Python module-level)
 * - 'block': block-scoped (JS `let`/`const` inside a function)
 */
export type VariableScope = 'module' | 'file' | 'block';

/**
 * Represents a module/file-scoped variable, constant, or static declaration.
 */
export interface VariableInfo {
  /** Variable name */
  name: string;
  /** Declared type annotation (may be null if untyped) */
  type: string | null;
  /** Visibility modifier */
  visibility: VariableVisibility;
  /** Is this a constant (const, val, final)? */
  isConst: boolean;
  /** Is this a static declaration? */
  isStatic: boolean;
  /** Is this mutable (let, var vs const, val)? */
  isMutable: boolean;
  /** Scope of the declaration */
  scope: VariableScope;
  /** Source file path */
  sourceFile: string;
  /** Line number (1-based) */
  line: number;
}

/**
 * Context for variable extraction.
 */
export interface VariableExtractorContext {
  /** Current file path */
  filePath: string;
  /** Language ID */
  language: SupportedLanguages;
}

/**
 * Variable extractor interface — extracts structured metadata from
 * module/file-scoped variable, constant, and static declarations.
 */
export interface VariableExtractor {
  /** Language this extractor handles */
  language: SupportedLanguages;
  /** Extract variable metadata from a declaration node.
   *  Returns null if the node is not a recognized variable declaration. */
  extract(node: SyntaxNode, context: VariableExtractorContext): VariableInfo | null;
  /** Check if a node is a recognized variable declaration type. */
  isVariableDeclaration(node: SyntaxNode): boolean;
}

/**
 * Declarative config for building a variable extractor via the factory.
 * Follows the same pattern as FieldExtractionConfig and MethodExtractionConfig.
 */
export interface VariableExtractionConfig {
  /** Language this config applies to */
  language: SupportedLanguages;
  /** AST node types for const declarations (e.g., 'const_item', 'lexical_declaration') */
  constNodeTypes: string[];
  /** AST node types for static declarations (e.g., 'static_item') */
  staticNodeTypes: string[];
  /** AST node types for variable declarations (e.g., 'variable_declaration') */
  variableNodeTypes: string[];
  /** Extract the variable name from a declaration node */
  extractName: (node: SyntaxNode) => string | undefined;
  /** Extract type annotation from a declaration node */
  extractType: (node: SyntaxNode) => string | undefined;
  /** Extract visibility from a declaration node */
  extractVisibility: (node: SyntaxNode) => VariableVisibility;
  /** Check if a declaration is const/immutable */
  isConst: (node: SyntaxNode) => boolean;
  /** Check if a declaration is static */
  isStatic: (node: SyntaxNode) => boolean;
  /** Check if a declaration is mutable */
  isMutable: (node: SyntaxNode) => boolean;
}
