// gitnexus/src/core/ingestion/method-types.ts

import type { SupportedLanguages } from 'gitnexus-shared';
import type { FieldVisibility } from './field-types.js';
import type { SyntaxNode } from './utils/ast-helpers.js';

// Reuse FieldVisibility — same set of language visibility levels
export type MethodVisibility = FieldVisibility;

export interface ParameterInfo {
  name: string;
  type: string | null;
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
  /** Extract a primary constructor from the owner node itself (e.g. C# 12 class Point(int x, int y)). */
  extractPrimaryConstructor?: (
    ownerNode: SyntaxNode,
    context: MethodExtractorContext,
  ) => MethodInfo | null;
}
