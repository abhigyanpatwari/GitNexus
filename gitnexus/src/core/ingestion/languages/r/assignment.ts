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

/**
 * Whether assigning `value` to a name binds something a call of that name may reach.
 *
 * R looks a callee up as a function and skips any binding that is not one, so what matters is
 * whether the value can be a function:
 *  - a `function_definition` is a real definition (the scope extractor already records it, and a
 *    call resolves to it), so it is not a lexical name here;
 *  - a constant (`isRConstantValue`) is skipped by R at a call, which then reaches the outer
 *    function, so it is not either;
 *  - everything else (an identifier, a call, anything computed, `NULL`) may hold a function.
 */
export function isLexicalAssignment(value: SyntaxNode): boolean {
  return value.type !== 'function_definition' && !isRConstantValue(value);
}

/** The first argument of a call node (`x` of `names(x)`), or null when there is none. */
function firstArgumentValue(call: SyntaxNode): SyntaxNode | null {
  const argument = call.childForFieldName('arguments')?.namedChildren.find((child) => {
    return child.type === 'argument';
  });
  return argument?.childForFieldName('value') ?? null;
}

/**
 * The identifier an assignment target writes through: `x` for `x`, `x$a`, `x@a`, `x[i]`, `x[[i]]`
 * and `names(x)`, `names(x)[2]`, `pkg::foo(x)` (a replacement call assigns its first argument, never
 * the called name). Null for a target with no identifier at its base (`f()$a`, a string).
 */
function assignmentBase(target: SyntaxNode): SyntaxNode | null {
  for (let node: SyntaxNode | null = target; node !== null; ) {
    switch (node.type) {
      case 'identifier':
        return node;
      case 'extract_operator':
        node = node.childForFieldName('lhs');
        break;
      case 'subset':
      case 'subset2':
        node = node.childForFieldName('function');
        break;
      case 'call':
        node = firstArgumentValue(node);
        break;
      default:
        return null;
    }
  }
  return null;
}

/** The name (as written) an assignment node binds to a value that may be a function, or null. */
function lexicalAssignmentOf(node: SyntaxNode): string | null {
  if (node.type !== 'binary_operator') return null;
  const operator = node.childForFieldName('operator')?.text;
  let target: SyntaxNode | null;
  let value: SyntaxNode | null;
  if (operator === '<-' || operator === '=') {
    target = node.childForFieldName('lhs');
    value = node.childForFieldName('rhs');
  } else if (operator === '->') {
    target = node.childForFieldName('rhs');
    value = node.childForFieldName('lhs');
  } else {
    // `<<-` and `->>` assign outward and bind nothing in this frame.
    return null;
  }
  if (target === null || value === null) return null;
  if (target.type === 'identifier') {
    return isLexicalAssignment(value) && target.text.length > 0 ? target.text : null;
  }
  // `x$a <- v`, `names(x) <- v`: R evaluates `x`, modifies it and binds the result to `x` here,
  // whatever the value. Not for `self`: writing a field of an R6 instance (`self$count <- 1`,
  // `self$items[[i]] <- v`) leaves `self` the same instance, so it stays the method's typed
  // receiver. Only a plain `self <- v` (above) rebinds it.
  const base = assignmentBase(target);
  if (base === null || base.text.length === 0 || base.text === 'self') return null;
  return base.text;
}

const lexicalAssigned = new WeakMap<SyntaxNode['tree'], Map<number, ReadonlySet<string>>>();

/**
 * The names a function's own body binds by ordinary assignment to a value that may be a function
 * (`isLexicalAssignment`), as written (backticks included, like a formal): `x <- v`, `x = v`,
 * `v -> x`, and the base identifier of a complex target (`x$a <- v`, `names(x) <- v`, never the
 * called name, so `foo(x) <- 1` binds `x`; a complex target based on `self` binds nothing, see
 * `lexicalAssignmentOf`). Flow-insensitive: a name counts when ANY assignment
 * of it in the body does. A nested function binds its own variables and is not read; `<<-` and
 * `->>` assign outward; `assign()`, `delayedAssign()`, `list2env()`, `local()` and `with()` are not
 * modelled (`local({ x <- f })` is read as an assignment in this frame, which only costs an edge).
 *
 * The one implementation behind both the call side (`rFunctionLexicalNames`) and the rename guard
 * (`checkSafety`), so the two cannot drift apart.
 */
export function rLexicalAssignedNames(fn: SyntaxNode): ReadonlySet<string> {
  let byFunction = lexicalAssigned.get(fn.tree);
  if (byFunction === undefined) lexicalAssigned.set(fn.tree, (byFunction = new Map()));
  const known = byFunction.get(fn.id);
  if (known !== undefined) return known;
  const names = new Set<string>();
  const body = fn.childForFieldName('body');
  const pending = body === null ? [] : [body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === 'function_definition') continue;
    const bound = lexicalAssignmentOf(node);
    if (bound !== null) names.add(bound);
    for (const child of node.namedChildren) pending.push(child);
  }
  byFunction.set(fn.id, names);
  return names;
}

/** Whether `node` is the callee of a call: `f(x)`, `x |> f()`. */
export function isCallee(node: SyntaxNode): boolean {
  const call = node.parent;
  return call?.type === 'call' && call.childForFieldName('function')?.id === node.id;
}

/** The left-hand side of `<-`, `=`, `<<-`, or the right-hand side of `->`, `->>`; null for any other node. */
export function assignmentTarget(node: SyntaxNode): SyntaxNode | null {
  if (node.type !== 'binary_operator') return null;
  const operator = node.childForFieldName('operator')?.text;
  if (operator === '<-' || operator === '=' || operator === '<<-')
    return node.childForFieldName('lhs');
  if (operator === '->' || operator === '->>') return node.childForFieldName('rhs');
  return null;
}

/**
 * Whether the call node `call` lies in the target chain of an assignment, which makes it a call of
 * the replacement function: `foo(x) <- v` runs `` `foo<-` ``, not `foo`. The chain is reached from the
 * assignment target (`assignmentTarget`) only through a call's first argument and the base of `$`,
 * `@`, `[` and `[[`, the same walk `assignmentBase` makes to find the variable written. Any other
 * argument (`foo(x, bar(1)) <- v`, the index of `x[bar(1)]`) and the value being assigned are
 * ordinary reads.
 *
 * For one call only: it walks up, and tree-sitter's `.parent` re-descends from the root, so asking
 * it about every call of a file is cubic in the nesting depth. The capture layer asks
 * {@link rReplacementCallTest} instead, which gives the same answer in one linear pass; this
 * function is the reference that pass is tested against.
 */
export function isRReplacementCall(call: SyntaxNode): boolean {
  for (let node = call; ; ) {
    const parent: SyntaxNode | null = node.parent;
    if (parent === null) return false;
    switch (parent.type) {
      case 'binary_operator':
        return assignmentTarget(parent)?.id === node.id;
      case 'extract_operator':
        if (parent.childForFieldName('lhs')?.id !== node.id) return false;
        node = parent;
        break;
      case 'subset':
      case 'subset2':
        if (parent.childForFieldName('function')?.id !== node.id) return false;
        node = parent;
        break;
      case 'argument': {
        const list = parent.parent;
        const owner = list?.parent;
        if (parent.childForFieldName('value')?.id !== node.id) return false;
        if (list?.type !== 'arguments' || owner?.type !== 'call') return false;
        if (owner.childForFieldName('arguments')?.id !== list.id) return false;
        if (list.namedChildren.find((child) => child.type === 'argument')?.id !== parent.id) {
          return false;
        }
        node = owner;
        break;
      }
      default:
        return false;
    }
  }
}

/**
 * The ids of every call under `root` that is in a replacement position: the calls for which
 * {@link isRReplacementCall} is true, found top-down in one pass. From the target of each
 * assignment, the chain is followed down through a call's first argument and the base of `$`,
 * `@`, `[` and `[[`, the reverse of the upward walk, so no `.parent` is read. Each node is visited
 * once and chains of different assignments never share a node, so the pass is linear in the
 * size of the tree; it uses an explicit stack, never recursion, however deep the nesting.
 */
export function rReplacementCallIds(root: SyntaxNode): Set<number> {
  const ids = new Set<number>();
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const target = assignmentTarget(node);
    if (target !== null) markReplacementChain(target, ids);
    for (const child of node.namedChildren) pending.push(child);
  }
  return ids;
}

/** Add every call of the target chain that starts at `target` to `ids`. */
function markReplacementChain(target: SyntaxNode, ids: Set<number>): void {
  for (let node: SyntaxNode | null = target; node !== null; ) {
    switch (node.type) {
      case 'call': {
        ids.add(node.id);
        const list = node.childForFieldName('arguments');
        const first =
          list?.type === 'arguments'
            ? list.namedChildren.find((child) => child.type === 'argument')
            : undefined;
        node = first?.childForFieldName('value') ?? null;
        break;
      }
      case 'extract_operator':
        node = node.childForFieldName('lhs');
        break;
      case 'subset':
      case 'subset2':
        node = node.childForFieldName('function');
        break;
      default:
        return;
    }
  }
}

/**
 * Whether a call of the tree under `root` is in a replacement position, for asking about many
 * calls of one file: the set of {@link rReplacementCallIds} is built on the first question and
 * reused, so the answers cost one linear pass in all.
 */
export function rReplacementCallTest(root: SyntaxNode): (call: SyntaxNode) => boolean {
  let ids: Set<number> | undefined;
  return (call) => (ids ??= rReplacementCallIds(root)).has(call.id);
}

/** The name of the replacement function a getter name stands for: `foo` -> `` `foo<-` ``. */
export function rSetterName(name: string): string {
  return '`' + rBareName(name) + '<-`';
}
