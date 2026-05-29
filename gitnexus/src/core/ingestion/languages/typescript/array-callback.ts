/**
 * Array higher-order-method callback detection (issue #1876).
 *
 * The HOC-wrapped-arrow declaration pattern in the JS/TS scope queries
 * (`const X = call((args) => …)`) was added for React idioms
 * (`forwardRef` / `memo` / `useCallback`). It has the same AST shape as
 * an array higher-order-method call (`const x = arr.map(a => …)`), so
 * those callbacks also match and produce a spurious `@declaration.function`
 * named after the binding — duplicating the `@declaration.const` /
 * `@declaration.variable` def that the same binding already gets.
 *
 * For an array-method callback the binding holds a *value* (the method's
 * result), not a callable, so the `Function` def is semantically wrong.
 * `isArrayMethodCallbackArrow` lets the emitter (`captures.ts`) drop that
 * `@declaration.function` match, leaving only the value def.
 *
 * Shared by both the JavaScript and TypeScript capture emitters — the
 * relevant grammar nodes (`arrow_function`, `function_expression`,
 * `arguments`, `call_expression`, `member_expression`,
 * `property_identifier`) are identical across `tree-sitter-javascript`
 * and `tree-sitter-typescript`.
 *
 * Pure given the input node. No I/O, no globals.
 */

import type { SyntaxNode } from '../../utils/ast-helpers.js';

/**
 * Array prototype higher-order methods whose result is a value, not a
 * function. A callback passed to one of these is an anonymous callback,
 * never a top-level function definition. Identifier-callee HOCs
 * (`forwardRef(...)`, `useCallback(...)`, custom factories) are
 * deliberately NOT listed — they keep their `Function` classification.
 *
 * Trade-off (unchanged from before #1876): a custom *fluent-API* member
 * call with a callback whose method name is not in this set
 * (`qb.where(x => …)`) still classifies as `Function`. There is no clean
 * syntactic line beyond the well-known Array surface, so the set is
 * intentionally closed and easy to extend.
 *
 * Receiver-blind, by design: the match keys on the method NAME only, never
 * the receiver type (tree-sitter has no type information here). So an in-set
 * name on a NON-array receiver — `Map`/`Set` `.forEach`, an RxJS
 * `observable.map(…)`, a query builder `.sort(…)`, a lodash chain
 * `.filter(…)` — is ALSO treated as a callback and has its
 * `@declaration.function` dropped. This is an accepted limitation, not a
 * regression: those bindings hold the call's *result value*, not a callable,
 * so a value def is the correct classification anyway. The only genuine loss
 * is a bespoke DSL whose in-set-named method returns something callable —
 * rare enough to accept rather than guard with type inference. Pinned by the
 * "in-set method on a non-array receiver" case in `*-captures.test.ts`.
 */
export const ARRAY_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  'map',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'forEach',
  'reduce',
  'reduceRight',
  'some',
  'every',
  'flatMap',
  'sort',
]);

/**
 * True when `node` (an `arrow_function` / `function_expression`) is the
 * callback argument of an array higher-order-method call, i.e. the
 * enclosing call's callee is a `member_expression` whose property is one
 * of {@link ARRAY_CALLBACK_METHODS}.
 *
 * Returns false for direct assignments (`const fn = () => {}` — parent is
 * `variable_declarator`, not `arguments`) and for identifier-callee HOCs
 * (`forwardRef(() => …)` — callee is an `identifier`, not a
 * `member_expression`), so neither is ever suppressed.
 *
 * Intentional non-suppressing gaps (preserve current behavior, no
 * regression): parenthesized callee `(arr.map)(cb)` (`parenthesized_expression`)
 * and computed callee `arr['map'](cb)` (`subscript_expression`).
 */
export function isArrayMethodCallbackArrow(node: SyntaxNode): boolean {
  const args = node.parent;
  if (args === null || args.type !== 'arguments') return false;

  const call = args.parent;
  if (call === null || call.type !== 'call_expression') return false;

  const callee = call.childForFieldName('function');
  if (callee === null || callee.type !== 'member_expression') return false;

  const property = callee.childForFieldName('property');
  if (property === null || property.type !== 'property_identifier') return false;

  return ARRAY_CALLBACK_METHODS.has(property.text);
}
