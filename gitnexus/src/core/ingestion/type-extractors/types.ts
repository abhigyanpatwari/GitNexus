import type { SyntaxNode } from '../utils.js';

/** Extracts type bindings from a declaration node into the env map */
export type TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>) => void;

/** Extracts type bindings from a parameter node into the env map */
export type ParameterExtractor = (node: SyntaxNode, env: Map<string, string>) => void;

/** Minimal interface for checking whether a name is a known class/struct.
 *  Narrower than ReadonlySet — only `.has()` is used by extractors. */
export type ClassNameLookup = { has(name: string): boolean };

/** Extracts type bindings from a constructor-call initializer, with access to known class names */
export type InitializerExtractor = (node: SyntaxNode, env: Map<string, string>, classNames: ClassNameLookup) => void;

/** Per-language type extraction configuration */
export interface LanguageTypeConfig {
  /** Node types that represent typed declarations for this language */
  declarationNodeTypes: ReadonlySet<string>;
  /** Extract a (varName → typeName) binding from a declaration node */
  extractDeclaration: TypeBindingExtractor;
  /** Extract a (varName → typeName) binding from a parameter node */
  extractParameter: ParameterExtractor;
  /** Extract a (varName → typeName) binding from a constructor-call initializer.
   *  Called as fallback when extractDeclaration produces no binding for a declaration node.
   *  Only for languages with syntactic constructor markers (new, composite_literal, ::new).
   *  Receives classNames — the set of class/struct names visible in the current file's AST. */
  extractInitializer?: InitializerExtractor;
}
