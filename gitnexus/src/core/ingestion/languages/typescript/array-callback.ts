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
import { ARRAY_CALLBACK_METHODS } from '../../ts-js-hoc-utils.js';

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
 * The helper itself only handles direct `member_expression` callees. Broader
 * shapes like `(arr.map)(cb)` and `arr['map'](cb)` are now filtered at the
 * query layer, so this emit-side check stays focused on the direct fallback.
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
