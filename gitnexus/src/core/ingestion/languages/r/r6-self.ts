/**
 * What `self` is inside an R6 method.
 *
 * R6 methods are `name = function(...)` arguments of the `public`/`private`/`active` list of an
 * `R6Class(...)` call, and `self` in their body is the instance of that class. The class is the
 * name the `R6Class` call is assigned to (`Child <- R6::R6Class(...)`), the same name the
 * `Class` definition carries, so `self$m()` resolves through that class and its parents.
 * Anywhere else `self` is no R6 instance: a free function, an `R6Class` call that is assigned to
 * nothing, a `setRefClass` method (which uses `.self`). The scope there owns `self` without a
 * type, and a `self$m()` call is left unresolved rather than matched to a free function `m`.
 */
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { isRLeftAssignment, rBoundName } from './assignment.js';

const R6_SECTIONS: ReadonlySet<string> = new Set(['public', 'private', 'active']);

/** The section name of an `argument` node (`public = list(...)`), or null. */
const argumentName = (argument: SyntaxNode): string | null => {
  const name = argument.childForFieldName('name');
  return name?.type === 'identifier' ? name.text : null;
};

/** Whether `call` is `R6Class(...)` or `R6::R6Class(...)`. */
const isR6ClassCall = (call: SyntaxNode): boolean => {
  if (call.type !== 'call') return false;
  const fn = call.childForFieldName('function');
  if (fn?.type === 'identifier') return fn.text === 'R6Class';
  return fn?.type === 'namespace_operator' && fn.childForFieldName('rhs')?.text === 'R6Class';
};

/** The `call` an `arguments` node's `argument` belongs to, or null. */
const callOf = (argument: SyntaxNode): SyntaxNode | null => {
  const list = argument.parent;
  const call = list?.type === 'arguments' ? list.parent : null;
  return call?.type === 'call' ? call : null;
};

/**
 * The class a method's `self` is, or null when `argument` is not an R6 method.
 *
 * `argument` is a `name = function(...)` argument of `list(...)`, itself the value of a
 * `public`/`private`/`active` argument of an `R6Class(...)` call that is the right-hand side of
 * an assignment to a plain identifier. The name is returned as written, backticks included, as
 * the `Class` definition keeps it.
 */
export function rR6MethodClassName(argument: SyntaxNode): string | null {
  if (argument.type !== 'argument') return null;
  if (argument.childForFieldName('name')?.type !== 'identifier') return null;
  if (argument.childForFieldName('value')?.type !== 'function_definition') return null;

  const listCall = callOf(argument);
  if (listCall === null) return null;
  const listFn = listCall.childForFieldName('function');
  if (listFn?.type !== 'identifier' || listFn.text !== 'list') return null;

  const section = listCall.parent;
  if (section?.type !== 'argument') return null;
  if (section.childForFieldName('value')?.id !== listCall.id) return null;
  const sectionName = argumentName(section);
  if (sectionName === null || !R6_SECTIONS.has(sectionName)) return null;

  const r6Call = callOf(section);
  if (r6Call === null || !isR6ClassCall(r6Call)) return null;

  const assignment = r6Call.parent;
  if (assignment === null || !isRLeftAssignment(assignment)) return null;
  if (assignment.childForFieldName('rhs')?.id !== r6Call.id) return null;
  const target = assignment.childForFieldName('lhs');
  return target?.type === 'identifier' && target.text.length > 0 ? target.text : null;
}

/**
 * Whether the file binds the name `self` at top level (`self <- Foo$new()`, `self = ...`,
 * `... -> self`). Its free functions then read that variable, which may be typed, so they are not
 * frames that own `self` untyped.
 */
export function fileBindsSelf(program: SyntaxNode): boolean {
  for (let i = 0; i < program.namedChildCount; i++) {
    const child = program.namedChild(i);
    if (child !== null && rBoundName(child) === 'self') return true;
  }
  return false;
}

/**
 * A per-file classifier for {@link rFunctionOwnsSelf}-style questions: whether a
 * `function_definition` starts a frame in which `self` is not an R6 instance. That holds when it
 * is neither the function of an R6 method nor nested inside another function (a closure in a
 * method sees the method's `self`; a closure in a free function sees the free function's, which
 * is none). The answer for an ancestor is remembered, so the work over a file is linear in its
 * size however deeply functions nest.
 */
export function createSelfOwnerClassifier(): (fn: SyntaxNode) => boolean {
  const insideFunction = new Map<number, boolean>();
  const isInsideFunction = (node: SyntaxNode): boolean => {
    const path: number[] = [];
    let answer = false;
    for (let up = node.parent; up !== null; up = up.parent) {
      if (up.type === 'function_definition') {
        answer = true;
        break;
      }
      const known = insideFunction.get(up.id);
      if (known !== undefined) {
        answer = known;
        break;
      }
      path.push(up.id);
    }
    for (const id of path) insideFunction.set(id, answer);
    return answer;
  };
  return (fn) => {
    if (fn.type !== 'function_definition') return false;
    const parent = fn.parent;
    if (parent !== null && rR6MethodClassName(parent) !== null) return false;
    return !isInsideFunction(fn);
  };
}

/**
 * `ScopeResolver.resolveReceiverMember` for R, for a typed `self` only: when neither the class nor
 * a parent defines the member, report an ambiguous lookup with no candidate.
 *
 * The generic lookup keeps a lexical route for `self` (a class body binds its own members, so the
 * name is also looked up in the enclosing scopes), and in R that walk reaches a free function of
 * the same name: `self$nothere()` would bind a top-level `nothere`. R reads `nothere` off the
 * instance, so a free function is never the answer. Answering `ambiguous` makes the pass record a
 * suppressed outcome and mark the site handled, which stops that fallback; the outcome reason is
 * `member-lookup-ambiguous`, where `member-not-found` would be more exact. A member that the
 * class or a parent does define is left to the generic MRO walk (`undefined`).
 */
export const rResolveSelfMember: NonNullable<ScopeResolver['resolveReceiverMember']> = (
  owner,
  name,
  site,
  scopes,
  model,
) => {
  if (site.kind !== 'call' || site.explicitReceiver?.name !== 'self') return undefined;
  for (const ownerId of [owner.nodeId, ...scopes.methodDispatch.mroFor(owner.nodeId)]) {
    if (model.methods.lookupAllByOwner(ownerId, name).length > 0) return undefined;
    if (model.fields.lookupAllByOwner(ownerId, name).length > 0) return undefined;
  }
  return { kind: 'ambiguous', candidateIds: [] };
};
