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

/** Scans an AST node for untyped `var = callee()` patterns for return-type inference.
 *  Returns { varName, calleeName } if the node matches, undefined otherwise.
 *  `receiverClassName` — optional hint for method calls on known receivers
 *  (e.g. $this->getUser() in PHP provides the enclosing class name). */
export type ConstructorBindingScanner = (node: SyntaxNode) => { varName: string; calleeName: string; receiverClassName?: string } | undefined;

/** Extracts a return type string from a method/function definition node.
 *  Used for languages where return types are expressed in comments (e.g. YARD @return [Type])
 *  rather than in AST fields. Returns undefined if no return type can be determined. */
export type ReturnTypeExtractor = (node: SyntaxNode) => string | undefined;

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
  /** Scan for untyped `var = callee()` assignments for return-type inference.
   *  Called on every AST node during buildTypeEnv walk; returns undefined for non-matches.
   *  The callee binding is unverified — the caller must confirm against the SymbolTable. */
  scanConstructorBinding?: ConstructorBindingScanner;
  /** Extract return type from comment-based annotations (e.g. YARD @return [Type]).
   *  Called as fallback when extractMethodSignature finds no AST-based return type. */
  extractReturnType?: ReturnTypeExtractor;
}
