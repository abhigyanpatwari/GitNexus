/**
 * Assignment predicates shared by the scope captures and the rename provider.
 *
 * What makes an R binary expression a definition: the assignment operators `<-`, `<<-`
 * and `=`. The grammar gives every infix operator the same `binary_operator` node, so
 * `x <- R6Class(...)` and `x + R6Class(...)` differ only in the `operator` field. The scope
 * and definition queries carry the same constraint as `operator: ["<-" "<<-" "="]`.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { rBareName } from './bare-name.js';

const LEFT_ASSIGN_OPERATORS: ReadonlySet<string> = new Set(['<-', '<<-', '=']);

/** Whether `node` is `target <- value`, `target <<- value` or `target = value`. */
export const isRLeftAssignment = (node: SyntaxNode): boolean =>
  node.type === 'binary_operator' &&
  LEFT_ASSIGN_OPERATORS.has(node.childForFieldName('operator')?.text ?? '');

const CONSTANT_VALUE_TYPES: ReadonlySet<string> = new Set([
  'float',
  'integer',
  'complex',
  'string',
  'true',
  'false',
  'na',
  'inf',
  'nan',
]);

/**
 * Whether `node` is a constant that can never be a function: a number, a string, `TRUE`/`FALSE`,
 * `NA`, `Inf`, `NaN` or a signed number (`-1`, `+2`). `NULL` is not one: it is the usual
 * placeholder of an optional callback (`helper = NULL`), so a name holding it may hold a function.
 */
export function isRConstantValue(node: SyntaxNode): boolean {
  if (CONSTANT_VALUE_TYPES.has(node.type)) return true;
  return (
    node.type === 'unary_operator' &&
    ['-', '+'].includes(node.childForFieldName('operator')?.text ?? '') &&
    ['float', 'integer', 'complex', 'inf', 'nan'].includes(
      node.childForFieldName('rhs')?.type ?? '',
    )
  );
}

/** The name a plain assignment (`<-`, `=`, `<<-`, `->`, `->>`) or a `for` loop binds, or null. */
export function rBoundName(node: SyntaxNode): string | null {
  if (node.type === 'for_statement') {
    const variable = node.childForFieldName('variable');
    return variable?.type === 'identifier' ? rBareName(variable.text) : null;
  }
  if (node.type !== 'binary_operator') return null;
  const operator = node.childForFieldName('operator')?.text;
  if (operator === undefined) return null;
  let target: SyntaxNode | null = null;
  if (operator === '<-' || operator === '=' || operator === '<<-') {
    target = node.childForFieldName('lhs');
  } else if (operator === '->' || operator === '->>') {
    target = node.childForFieldName('rhs');
  }
  return target?.type === 'identifier' ? rBareName(target.text) : null;
}

const ownAssignments = new WeakMap<SyntaxNode['tree'], Map<number, ReadonlySet<string>>>();

/**
 * Names bound by an assignment or `for` loop in a function's own body, one entry per function.
 * A nested function's assignments bind its own variables and are not included.
 */
export function rOwnAssignedNames(fn: SyntaxNode): ReadonlySet<string> {
  let byFunction = ownAssignments.get(fn.tree);
  if (byFunction === undefined) ownAssignments.set(fn.tree, (byFunction = new Map()));
  const known = byFunction.get(fn.id);
  if (known !== undefined) return known;
  const names = new Set<string>();
  const body = fn.childForFieldName('body');
  const pending = body === null ? [] : [body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === 'function_definition') continue;
    const bound = rBoundName(node);
    if (bound !== null) names.add(bound);
    for (const child of node.namedChildren) pending.push(child);
  }
  byFunction.set(fn.id, names);
  return names;
}
