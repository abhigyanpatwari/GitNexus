// gitnexus/src/core/ingestion/field-types.ts

import type { TypeEnvironment } from './type-env.js';
import type { SymbolTable } from './symbol-table.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

/**
 * Visibility levels used across all supported languages.
 * - public / private / protected: universal modifiers
 * - internal: C#, Kotlin (assembly/module scope)
 * - package: Java (package-private, no keyword)
 * - fileprivate: Swift (file scope)
 * - open: Swift (subclassable across modules)
 */
export type FieldVisibility =
  | 'public'
  | 'private'
  | 'protected'
  | 'internal'
  | 'package'
  | 'fileprivate'
  | 'open';

/**
 * Represents a field or property within a class/struct/interface
 */
export interface FieldInfo {
  /** Field name */
  name: string;
  /** Resolved type (may be primitive, FQN, or generic) */
  type: string | null;
  /** Visibility modifier */
  visibility: FieldVisibility;
  /** Is this a static member? */
  isStatic: boolean;
  /** Is this readonly/const? */
  isReadonly: boolean;
  /** Source file path */
  sourceFile: string;
  /** Line number */
  line: number;
}

/**
 * Maps owner type FQN to its fields
 */
export type FieldTypeMap = Map<string, FieldInfo[]>;

/**
 * Context for field extraction
 */
export interface FieldExtractorContext {
  /** Type environment for resolution */
  typeEnv: TypeEnvironment;
  /** Symbol table for FQN lookups */
  symbolTable: SymbolTable;
  /** Current file path */
  filePath: string;
  /** Language ID */
  language: SupportedLanguages;
}

/**
 * Result of field extraction from a type declaration
 */
export interface ExtractedFields {
  /** Owner type FQN */
  ownerFqn: string;
  /** Extracted fields */
  fields: FieldInfo[];
  /** Nested types found during extraction */
  nestedTypes: string[];
}
