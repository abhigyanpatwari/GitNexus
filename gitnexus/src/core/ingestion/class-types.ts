import type { NodeLabel, SupportedLanguages } from 'gitnexus-shared';
import type { SyntaxNode } from './utils/ast-helpers.js';

export type ClassLikeNodeLabel = Extract<
  NodeLabel,
  'Class' | 'Struct' | 'Interface' | 'Enum' | 'Record'
>;

export interface ExtractedClassSymbol {
  name: string;
  type: ClassLikeNodeLabel;
  qualifiedName: string;
  templateArguments?: string[];
}

export interface ClassCaptureContext {
  captureMap: Record<string, SyntaxNode>;
  definitionNode: SyntaxNode | null;
  nameNode: SyntaxNode | undefined;
}

/**
 * Cross-language qualified type names are normalized to dot-separated scope
 * segments:
 * - file/package scope contributes leading segments when the language has one
 * - lexical namespace/module/type scope contributes enclosing segments
 * - the simple type name is always the trailing segment
 */
export interface ClassExtractor {
  language: SupportedLanguages;
  isTypeDeclaration(node: SyntaxNode): boolean;
  extract(
    node: SyntaxNode,
    fallback?: {
      name?: string;
      type?: NodeLabel | null;
    },
  ): ExtractedClassSymbol | null;
  extractQualifiedName(node: SyntaxNode, simpleName: string): string | null;
  shouldSkipClassCapture?(
    context: ClassCaptureContext & { nodeLabel: ClassLikeNodeLabel },
  ): boolean;
  extractTemplateArgumentsFromCapture?(context: ClassCaptureContext): string[] | undefined;
}

export interface ClassExtractionConfig {
  language: SupportedLanguages;
  typeDeclarationNodes: string[];
  fileScopeNodeTypes?: string[];
  ancestorScopeNodeTypes?: string[];
  scopeNameNodeTypes?: string[];
  extractName?: (node: SyntaxNode) => string | undefined;
  extractType?: (node: SyntaxNode) => ClassLikeNodeLabel | undefined;
  extractScopeSegments?: (node: SyntaxNode) => string[] | null | undefined;
  extractTemplateArguments?: (node: SyntaxNode) => string[] | undefined;
  shouldSkipClassCapture?(
    context: ClassCaptureContext & { nodeLabel: ClassLikeNodeLabel },
  ): boolean;
  extractTemplateArgumentsFromCapture?(context: ClassCaptureContext): string[] | undefined;
}
