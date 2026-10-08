import type {
  LanguageTypeConfig,
  ParameterExtractor,
  TypeBindingExtractor,
  InitializerExtractor,
  ConstructorBindingScanner,
} from './types.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { getRClassNameArgument } from '../field-extractors/r.js';

/**
 * R type extractor — roxygen2 annotation parsing.
 *
 * R has no static type system and roxygen2 has no type syntax: a `@param`
 * description is free prose. A parameter is therefore typed from a roxygen
 * comment only when the type is stated in an anchored form AND names a class
 * the file defines:
 *
 *   #' @param repo UserRepo                 (the description is the type alone)
 *   #' @param backup {UserRepo} a spare     (the type in braces, prose after it)
 *   save <- function(repo, backup) { ... }
 *
 * Prose that merely starts with a capitalised word (`@param df Data frame of
 * observations`) binds nothing, even when a class called `Data` exists, and a
 * description may run over several lines: it is read up to the next tag.
 * The type is bound for a formal of the documented function, inside that
 * function only.
 *
 * Resolution tiers:
 * - Tier 0: roxygen2 @param annotations (extractParameter binds each documented formal)
 * - Tier 1: Constructor inference via `obj <- ClassName$new()` (R6) or `obj <- new("ClassName")` (S4)
 */

/** A `@param` tag: the parameter name and the description text that follows it. */
interface RoxygenParam {
  readonly name: string;
  readonly description: string;
}

/** The whole description is a single type word: `UserRepo`. */
const BARE_TYPE_RE = /^([A-Z][\w.]*)$/;

/** The description starts with a braced type: `{UserRepo} the repository`. */
const BRACED_TYPE_RE = /^\{([A-Z][\w.]*)\}(?:\s|$)/;

/**
 * Walk backwards through preceding sibling nodes collecting consecutive
 * roxygen2 comment lines (`#'`). Returns the joined comment block text.
 */
const collectRoxygenBlock = (node: SyntaxNode): string => {
  const commentTexts: string[] = [];
  let sibling = node.previousSibling;
  while (sibling) {
    if (sibling.type === 'comment' && sibling.text.startsWith("#'")) {
      commentTexts.unshift(sibling.text);
    } else if (sibling.type === 'comment') {
      // Regular comment (not roxygen2) — skip, don't break
    } else if (sibling.isNamed) {
      break;
    }
    sibling = sibling.previousSibling;
  }
  return commentTexts.join('\n');
};

/**
 * Split a roxygen block into its `@param` tags. A tag's description is the
 * rest of its line plus every following line up to the next `@tag`, joined by
 * single spaces. A tag whose name is not one plain identifier (`x,y`, `...`,
 * `na.rm`) is skipped, and its continuation lines belong to no tag.
 */
const parseRoxygenParams = (block: string): RoxygenParam[] => {
  const params: RoxygenParam[] = [];
  let name: string | undefined;
  let parts: string[] = [];
  const flush = (): void => {
    if (name !== undefined) params.push({ name, description: parts.join(' ').trim() });
    name = undefined;
    parts = [];
  };

  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/^#'[ \t]*/, '').trim();
    const tag = /^@(\w+)(?:[ \t]+(.*))?$/.exec(line);
    if (tag) {
      flush();
      if (tag[1] !== 'param') continue;
      const head = /^(\w+)(?:[ \t]+(.*))?$/.exec(tag[2] ?? '');
      if (!head) continue;
      name = head[1];
      if (head[2]) parts.push(head[2]);
    } else if (name !== undefined && line.length > 0) {
      parts.push(line);
    }
  }
  flush();
  return params;
};

/** The type a `@param` description states in an anchored form, if any. */
const anchoredType = (description: string): string | undefined =>
  (BARE_TYPE_RE.exec(description) ?? BRACED_TYPE_RE.exec(description))?.[1];

/**
 * The class a node declares, in the shapes `query.ts` captures as
 * `@declaration.class`: `X <- R6Class(...)` / `X <- R6::R6Class(...)`, and
 * `setClass("X", ...)` / `setRefClass("X", ...)`.
 */
const declaredClassName = (node: SyntaxNode): string | undefined => {
  if (node.type === 'binary_operator') {
    const lhs = node.childForFieldName('lhs');
    const rhs = node.childForFieldName('rhs');
    if (lhs?.type !== 'identifier' || rhs?.type !== 'call') return undefined;
    const fn = rhs.childForFieldName('function');
    const calleeName =
      fn?.type === 'namespace_operator' ? fn.childForFieldName('rhs')?.text : fn?.text;
    return calleeName === 'R6Class' ? lhs.text : undefined;
  }
  if (node.type !== 'call') return undefined;
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'identifier' || (fn.text !== 'setClass' && fn.text !== 'setRefClass')) {
    return undefined;
  }
  // The class name is the argument that takes the `Class` formal, by name or else
  // the first unnamed one; `contains = "Base"` ahead of `Class = "A"` is not it.
  const args = node.childForFieldName('arguments');
  return (args && getRClassNameArgument(args)) ?? undefined;
};

/** Class names defined anywhere in the file, built on first use and kept per tree. */
const localClassNamesByTree = new WeakMap<object, ReadonlySet<string>>();
const localClassNames = (node: SyntaxNode): ReadonlySet<string> => {
  const cached = localClassNamesByTree.get(node.tree);
  if (cached) return cached;
  const names = new Set<string>();
  for (const candidate of node.tree.rootNode.descendantsOfType(['binary_operator', 'call'])) {
    const name = declaredClassName(candidate);
    if (name !== undefined) names.add(name);
  }
  localClassNamesByTree.set(node.tree, names);
  return names;
};

/**
 * The roxygen2 `@param` types documented for an assigned function: the
 * comment block directly above `name <- function(...)`, keyed by parameter
 * name. Returns a map of paramName → typeName.
 */
const collectRoxygenParams = (assignment: SyntaxNode): Map<string, string> => {
  const params = new Map<string, string>();
  for (const { name, description } of parseRoxygenParams(collectRoxygenBlock(assignment))) {
    const typeName = anchoredType(description);
    if (typeName !== undefined && localClassNames(assignment).has(typeName)) {
      params.set(name, typeName);
    }
  }
  return params;
};

/**
 * R node types that may carry type bindings.
 * - `binary_operator`: function definitions use `name <- function(...)` which
 *   tree-sitter-r parses as binary_operator nodes. Also used for constructor
 *   assignments like `obj <- ClassName$new()`.
 */
const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set(['binary_operator']);

/**
 * R declaration extraction. Roxygen types are bound per formal by
 * `extractParameter`, so a function definition binds nothing here: this
 * hook runs in the scope that CONTAINS the assignment (the file, for a
 * top-level function), and a type bound there would be visible in every
 * function of the file.
 */
const extractDeclaration: TypeBindingExtractor = (
  _node: SyntaxNode,
  _env: Map<string, string>,
): void => {
  // Constructor bindings are made by extractInitializer; roxygen types by extractParameter.
};

/**
 * R parameter extraction: the roxygen2 `@param` type of a formal.
 *
 * Runs once per formal with the env of the function that owns it, so the
 * binding is visible inside that function only. The roxygen block is the one
 * above the assignment `name <- function(...)` the formal belongs to; a name
 * the block documents but the function does not have is never visited, and a
 * function that is not the right-hand side of an assignment (a callback)
 * is documented by nothing. The `...` formal is not an identifier and is
 * skipped.
 */
const extractParameter: ParameterExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  if (node.type !== 'parameter') return;
  const name = node.childForFieldName('name');
  if (name?.type !== 'identifier') return;

  const fn = node.parent?.parent;
  if (fn?.type !== 'function_definition') return;
  const assignment = fn.parent;
  if (assignment?.type !== 'binary_operator') return;
  const rhs = assignment.childForFieldName('rhs');
  if (rhs?.startIndex !== fn.startIndex || rhs.endIndex !== fn.endIndex) return;

  const typeName = collectRoxygenParams(assignment).get(name.text);
  if (typeName !== undefined) env.set(name.text, typeName);
};

/**
 * R constructor inference:
 * - R6: `obj <- ClassName$new(...)` → type is ClassName
 * - S4: `obj <- new("ClassName", ...)` → type is ClassName
 *
 * Resolves against locally-known class names.
 */
const extractInitializer: InitializerExtractor = (node, env, classNames): void => {
  const result = scanConstructorBinding(node);
  if (!result) return;
  if (env.has(result.varName)) return;
  if (classNames.has(result.calleeName)) {
    env.set(result.varName, result.calleeName);
  }
};

/**
 * R constructor binding scanner: captures both R6 `obj <- ClassName$new()`
 * and S4 `obj <- new("ClassName", ...)` patterns.
 */
const scanConstructorBinding: ConstructorBindingScanner = (node) => {
  if (node.type !== 'binary_operator') return undefined;
  const lhs = node.childForFieldName('lhs');
  const rhs = node.childForFieldName('rhs');
  if (!lhs || !rhs) return undefined;
  if (lhs.type !== 'identifier') return undefined;
  if (rhs.type !== 'call') return undefined;

  const fn = rhs.childForFieldName('function');
  if (!fn) return undefined;

  // R6 pattern: obj <- ClassName$new(...)
  // tree-sitter-r parses `ClassName$new` as an `extract_operator` node
  if (fn.type === 'extract_operator') {
    const children = fn.namedChildren;
    if (children.length >= 2) {
      const className = children[0];
      const method = children[1];
      if (className?.type === 'identifier' && method?.text === 'new') {
        return { varName: lhs.text, calleeName: className.text };
      }
    }
  }

  // S4 pattern: obj <- new("ClassName", ...)
  if (fn.type === 'identifier' && fn.text === 'new') {
    // `new(Class, ...)`: the class is the argument that takes the `Class` formal.
    const args = rhs.childForFieldName('arguments');
    const className = args && getRClassNameArgument(args);
    if (className) return { varName: lhs.text, calleeName: className };
  }

  return undefined;
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  extractInitializer,
  scanConstructorBinding,
};
