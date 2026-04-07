// gitnexus/src/core/ingestion/method-types.ts

import type { SupportedLanguages } from 'gitnexus-shared';
import type { FieldVisibility } from './field-types.js';
import type { SyntaxNode } from './utils/ast-helpers.js';

// Reuse FieldVisibility — same set of language visibility levels
export type MethodVisibility = FieldVisibility;

export interface ParameterInfo {
  name: string;
  type: string | null;
  /** Full type text including generic/template args (e.g. 'vector<int>', 'List<String>').
   *  Used by typeTagForId for overload disambiguation where generic args matter.
   *  Falls back to `type` when not set. */
  rawType?: string | null;
  isOptional: boolean;
  isVariadic: boolean;
}

export interface MethodInfo {
  name: string;
  receiverType: string | null;
  returnType: string | null;
  parameters: ParameterInfo[];
  visibility: MethodVisibility;
  isStatic: boolean;
  isAbstract: boolean;
  isFinal: boolean;
  isVirtual?: boolean;
  isOverride?: boolean;
  isAsync?: boolean;
  isPartial?: boolean;
  isConst?: boolean;
  annotations: string[];
  sourceFile: string;
  line: number;
}

export interface MethodExtractorContext {
  filePath: string;
  language: SupportedLanguages;
}

export interface ExtractedMethods {
  ownerName: string;
  methods: MethodInfo[];
}

export interface MethodExtractor {
  language: SupportedLanguages;
  extract(node: SyntaxNode, context: MethodExtractorContext): ExtractedMethods | null;
  isTypeDeclaration(node: SyntaxNode): boolean;
  /** Extract method info from a standalone method node (e.g. Go top-level method_declaration). */
  extractFromNode?(node: SyntaxNode, context: MethodExtractorContext): MethodInfo | null;
  /** Extract function name + label from an AST node during parent-walk.
   *  Languages with non-standard AST structures (e.g. C/C++ declarator
   *  unwrapping, Swift init/deinit, Rust impl_item) provide this hook
   *  to replace the generic name-field lookup.
   *  Return null to fall through to the generic extractor. */
  extractFunctionName?(
    node: SyntaxNode,
  ): { funcName: string | null; label: import('gitnexus-shared').NodeLabel } | null;
}

export interface MethodExtractionConfig {
  language: SupportedLanguages;
  typeDeclarationNodes: string[];
  methodNodeTypes: string[];
  bodyNodeTypes: string[];
  extractName: (node: SyntaxNode) => string | undefined;
  extractReturnType: (node: SyntaxNode) => string | undefined;
  extractParameters: (node: SyntaxNode) => ParameterInfo[];
  extractVisibility: (node: SyntaxNode) => MethodVisibility;
  isStatic: (node: SyntaxNode) => boolean;
  isAbstract: (node: SyntaxNode, ownerNode: SyntaxNode) => boolean;
  isFinal: (node: SyntaxNode) => boolean;
  extractAnnotations?: (node: SyntaxNode) => string[];
  extractReceiverType?: (node: SyntaxNode) => string | undefined;
  isVirtual?: (node: SyntaxNode) => boolean;
  isOverride?: (node: SyntaxNode) => boolean;
  isAsync?: (node: SyntaxNode) => boolean;
  isPartial?: (node: SyntaxNode) => boolean;
  isConst?: (node: SyntaxNode) => boolean;
  /** Resolve the owner name from a standalone method node (e.g. Go receiver type). */
  extractOwnerName?: (node: SyntaxNode) => string | undefined;
  /** Extract a primary constructor from the owner node itself (e.g. C# 12 class Point(int x, int y)). */
  extractPrimaryConstructor?: (
    ownerNode: SyntaxNode,
    context: MethodExtractorContext,
  ) => MethodInfo | null;
  /** Extract function name + label from an AST node during parent-walk.
   *  Passed through to the MethodExtractor by createMethodExtractor. */
  extractFunctionName?: (
    node: SyntaxNode,
  ) => { funcName: string | null; label: import('gitnexus-shared').NodeLabel } | null;
}
