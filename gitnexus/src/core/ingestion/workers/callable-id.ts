/**
 * The id rules for a callable nested inside another callable (#2699).
 *
 * Extracted from `parse-worker.ts` for one reason: **three** phases there
 * build these ids independently — the definition phase
 * (`callableOwnQualifiedName`), the caller-attribution phase
 * (`findEnclosingFunctionId`), and the worker-path node-id derivation in
 * `processFileGroup`. An id they compute differently is not a test failure;
 * the caller attaches to a node that does not exist, so the edge is dropped
 * rather than reported. "Zero dangling edges" is what that looks like from
 * outside, which is why the divergence #2714 fixed went unnoticed.
 *
 * These functions are pure and free of module-scope side effects, unlike
 * `parse-worker.ts`, which posts a `ready` message to `parentPort` at import
 * and therefore cannot be value-imported by a unit test at all. That is what
 * makes the rule testable rather than merely commented.
 *
 * See `parse-worker.ts`'s `enclosingCallablePrefix` for how the prefix passed
 * in here is derived, and why only genuinely nested callables get one.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';

/**
 * Callable expressions the scope-resolution channel anchors on for a
 * closure binding (`@declaration.function` on the INNER node). Kept separate
 * from `FUNCTION_NODE_TYPES` because that set also lists declaration forms that
 * are never a binding initializer (`method_declaration`, `impl_item`, …).
 */
const BOUND_CALLABLE_EXPRESSION_TYPES = new Set([
  'arrow_function',
  'async_arrow_function',
  'function_expression',
  'generator_function',
  'anonymous_function',
  'closure_expression',
  'lambda_literal',
  'lambda_expression',
  // Named forms that are themselves the definition node (not a wrapper).
  'function_declaration',
  'generator_function_declaration',
  'async_function_declaration',
  'function_item',
  'function_definition',
  'method_definition',
  'local_function_statement',
]);

const INITIALIZER_FIELDS = [
  'value',
  'right',
  'initializer',
  'default_value',
  'result',
] as const;

function fieldInitializer(node: SyntaxNode): SyntaxNode | null {
  for (const field of INITIALIZER_FIELDS) {
    const child = node.childForFieldName(field);
    if (child !== null) return child;
  }
  return null;
}

function unwrapBoundCallable(node: SyntaxNode | null): SyntaxNode | undefined {
  if (node === null) return undefined;
  if (BOUND_CALLABLE_EXPRESSION_TYPES.has(node.type)) return node;

  // Parenthesized / thin wrappers: dig one level when the grammar fields it.
  const wrapped =
    node.childForFieldName('expression') ??
    node.childForFieldName('argument') ??
    (node.type.includes('parenthesized') ? node.namedChild(0) : null);
  if (wrapped !== null && wrapped.id !== node.id) {
    const found = unwrapBoundCallable(wrapped);
    if (found !== undefined) return found;
  }

  // HOC / factory: `const X = HOC((args) => …)` — the callable sits in arguments.
  if (node.type === 'call_expression' || node.type === 'arguments') {
    for (const child of node.namedChildren) {
      const found = unwrapBoundCallable(child);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * AST node whose start line keys the graph↔scope position join for a bound
 * callable (#2735).
 *
 * Graph-node queries put `@definition.function` on the OUTER binding wrapper
 * (`assignment_expression` / `lexical_declaration` / `let_declaration`); the
 * scope channel puts `@declaration.function` on the INNER callable so its range
 * aligns with `@scope.function`. The join is line-only (`positionKey`), so a
 * multi-line binding missed until the graph node's `startLine` followed the
 * initializer.
 *
 * Node *ids* stay on the binding wrapper via `localIdentity(definitionNode)` —
 * only the reported `startLine` moves to the callable body.
 */
export function boundCallablePositionNode(
  definitionNode: SyntaxNode,
  nameNode?: SyntaxNode | null,
): SyntaxNode {
  // Prefer the declarator/assignment that owns `nameNode`, so
  // `const a = () => 1, b = () => 2` does not give `b` the start line of `a`.
  if (nameNode !== undefined && nameNode !== null) {
    let current: SyntaxNode | null = nameNode;
    while (current !== null && current.id !== definitionNode.id) {
      const callable = unwrapBoundCallable(fieldInitializer(current));
      if (callable !== undefined) return callable;
      current = current.parent;
    }
  }

  if (BOUND_CALLABLE_EXPRESSION_TYPES.has(definitionNode.type)) {
    return definitionNode;
  }

  const fromDefinition = unwrapBoundCallable(fieldInitializer(definitionNode));
  if (fromDefinition !== undefined) return fromDefinition;

  for (const child of definitionNode.namedChildren) {
    const callable = unwrapBoundCallable(fieldInitializer(child));
    if (callable !== undefined) return callable;
  }

  return definitionNode;
}

/**
 * A function-local callable's own name segment: its name plus its declaration
 * position.
 *
 * The name chain alone is not enough, and the gap is the language's, not the
 * grammar's: ECMAScript creates an environment record per function AND per
 * block, so sibling blocks in one function hold genuinely different bindings —
 *
 *     function outer(a) {
 *       if (a) { const pick = …; return pick(1); }   // one binding
 *       else   { const pick = …; return pick(2); }   // a DIFFERENT binding
 *     }
 *
 * — and both are `outer.pick` by name. Putting a block token in the qualifier
 * would tag every local inside any `if`, the common case, and buy nothing over
 * putting the position on the declaration itself: a declaration's own position
 * is unique across every environment record it could belong to, without the
 * qualifier having to enumerate them. One rule, no conditionals, O(1).
 *
 * Applied ONLY to locals. Top-level functions and class methods keep their
 * bare/class-qualified ids, which is what keeps this off the symbols other
 * files, saved queries and stored references actually address.
 */
export const localIdentity = (node: SyntaxNode, name: string): string =>
  `${name}@${node.startPosition.row}:${node.startPosition.column}`;

/**
 * The qualified name of a callable nested inside another callable — THE single
 * definition of that rule, shared by all three id-building phases.
 *
 * A comment asking three call sites to stay in step is exactly the invariant
 * that rots; routing them through one function makes divergence require
 * deleting a call rather than editing a duplicated expression.
 */
export const nestedCallableQualifiedName = (
  prefix: string,
  node: SyntaxNode,
  name: string,
): string => `${prefix}.${localIdentity(node, name)}`;
