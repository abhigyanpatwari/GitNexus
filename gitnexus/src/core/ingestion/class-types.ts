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
  /**
   * When true, this language's nested-type graph nodes are keyed by their
   * fully-qualified path (e.g. `Class:file:Outer.Inner`) instead of the simple
   * tail name, so same-tail nested types in one file stay distinct (#1978).
   * Surfaced from `ClassExtractionConfig.qualifiedNodeId`.
   */
  readonly qualifiedNodeId: boolean;
  isTypeDeclaration(node: SyntaxNode): boolean;
  extract(
    node: SyntaxNode,
    fallback?: {
      name?: string;
      type?: NodeLabel | null;
    },
  ): ExtractedClassSymbol | null;
  extractQualifiedName(node: SyntaxNode, simpleName: string): string | null;
  /**
   * #1991: qualify a scope-defining node that maps to a class-like registry label
   * (e.g. a Ruby `module` → Trait) but is NOT a typeDeclaration, so it cannot go
   * through extract()/extractQualifiedName (which bail on non-typeDeclarations).
   * Walks the same ancestor scopes as the node-id path. Optional — only providers
   * that materialize such nodes implement it.
   */
  qualifyScopeName?(node: SyntaxNode, simpleName: string): string;
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
  /**
   * Opt-in (#1978): key this language's nested-type graph nodes (and their
   * member-owner edges) by the fully-qualified path instead of the simple tail
   * name, so same-tail nested types in one file stop colliding. Default false.
   * Requires `ancestorScopeNodeTypes` to be set so `buildQualifiedName` can walk
   * the scope chain.
   */
  qualifiedNodeId?: boolean;
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
