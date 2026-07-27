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
