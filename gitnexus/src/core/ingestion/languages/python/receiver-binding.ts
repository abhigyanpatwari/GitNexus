/**
 * Synthesize implicit receiver and constructor-assigned field type bindings
 * for methods.
 *
 * Tree-sitter can't easily express "the first parameter of a function
 * defined directly inside a class body" via a single static query.
 * Doing this in code keeps the embedded scope query declarative and
 * lets us encode the `@classmethod` / `@staticmethod` decorator
 * awareness that Python's runtime depends on.
 */

import type { CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

/** Walk up to the enclosing `class_definition`, ignoring the immediate
 *  `decorated_definition` wrapper. Returns `null` when the function is
 *  free, lambda-bodied, or nested inside another function. */
function findEnclosingClassDefinition(node: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = node.parent;
  while (cur !== null) {
    if (cur.type === 'class_definition') return cur;
    if (cur.type === 'function_definition') return null;
    cur = cur.parent;
  }
  return null;
}

function classDefinitionName(classNode: SyntaxNode): string | null {
  return classNode.childForFieldName('name')?.text ?? null;
}

/** Does the function carry a `@<decoratorName>` decorator? Matches both
 *  bare `@classmethod` and module-qualified `@functools.classmethod`. */
function hasDecorator(fnNode: SyntaxNode, decoratorName: string): boolean {
  const parent = fnNode.parent;
  if (parent === null || parent.type !== 'decorated_definition') return false;
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child === null || child.type !== 'decorator') continue;
    const text = child.text.replace(/^@/, '').split('(')[0]!.trim();
    const tail = text.split('.').pop();
    if (tail === decoratorName) return true;
  }
  return false;
}

function firstNamedParameter(parameters: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < parameters.namedChildCount; i++) {
    const child = parameters.namedChild(i);
    if (child === null) continue;
    // Skip `*` / `/` markers.
    if (child.type === 'positional_separator' || child.type === 'keyword_separator') continue;
    return child;
  }
  return null;
}

function firstParameterName(param: SyntaxNode): string | null {
  if (param.type === 'identifier') return param.text;
  // typed_parameter / default_parameter / typed_default_parameter:
  // first child holds the identifier / pattern.
  const ident = param.childForFieldName('name') ?? findIdentifierChild(param);
  return ident?.text ?? null;
}

function findIdentifierChild(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child !== null && child.type === 'identifier') return child;
  }
  return null;
}

/**
 * Build a `@type-binding.self` (instance method) or `@type-binding.cls`
 * (`@classmethod`) match for `fnNode`, or `null` if `fnNode` is not a
 * method, is `@staticmethod`, or has no parameters.
 *
 * The caller is responsible for guaranteeing `fnNode.type ===
 * 'function_definition'`.
 */
export function synthesizeReceiverTypeBinding(fnNode: SyntaxNode): CaptureMatch | null {
  const enclosingClass = findEnclosingClassDefinition(fnNode);
  if (enclosingClass === null) return null;

  // Skip @staticmethod-decorated methods (no implicit receiver).
  if (hasDecorator(fnNode, 'staticmethod')) return null;
  const isClassmethod = hasDecorator(fnNode, 'classmethod');

  const params = fnNode.childForFieldName('parameters');
  if (params === null) return null;
  const first = firstNamedParameter(params);
  if (first === null) return null;

  const className = classDefinitionName(enclosingClass);
  if (className === null) return null;

  const firstName = firstParameterName(first);
  if (firstName === null) return null;

  // Receiver convention: instance methods get `self`, classmethods get `cls`.
  // We trust the AST literal name (Python convention is strict in practice).
  if (isClassmethod) {
    return {
      '@type-binding.cls': nodeToCapture('@type-binding.cls', first),
      '@type-binding.name': syntheticCapture('@type-binding.name', first, firstName),
      '@type-binding.type': syntheticCapture('@type-binding.type', first, className),
    };
  }
  return {
    '@type-binding.self': nodeToCapture('@type-binding.self', first),
    '@type-binding.name': syntheticCapture('@type-binding.name', first, firstName),
    '@type-binding.type': syntheticCapture('@type-binding.type', first, className),
  };
}

/**
 * The class name of a direct constructor call — `Outer()` — or `undefined` for
 * anything else. Python has no `new`, so a call is the only syntactic
 * construction form, and a call to a plain name is the shape every other
 * language spells `= new X()`.
 *
 * BARE NAMES ONLY. A dotted callee (`models.User()`, `f.Alpha()`) is refused.
 * The first cut of #2807 returned the callee's full dotted text, on the theory
 * that a dotted name resolves through `QualifiedNameIndex` the way the
 * module-level `u = models.User()` capture in `query.ts` does. Measured on a
 * fixture carrying both shapes, that arm produced no correct edge and did
 * produce wrong ones:
 *
 *   - `self.svc = f.Alpha()`, where `Alpha` is a METHOD on an unrelated object
 *     and `Alpha` is also a class elsewhere: the dotted lookup matches the
 *     TRAILING segment against a same-named class, so `self.svc.ping()` emitted
 *     a FABRICATED edge to `Alpha.ping`. The root does not have to be a
 *     parameter — a module-level `shared_factory.Alpha()` fabricates the same
 *     way — so no test on the root's binding form contains this.
 *   - `self.u = models.User()`, the shape the arm was written FOR, emitted no
 *     edge with the arm or without it. An instance field's binding lands in
 *     CLASS scope, which never reaches the namespace split that makes the
 *     module-level local form resolve.
 *
 * Accepted cost, stated plainly: `self.u = models.User()` still does not type
 * its field. It did not before this narrowing either, so nothing that worked is
 * given up — and declining to bind is the doctrine `compound-receiver.ts`
 * states, that a confidently WRONG owner is strictly worse than a missing edge.
 * Re-enabling dotted callees is a RESOLUTION-side change (teach the field path
 * the namespace split that #2826/#2828 is reworking); redoing it here could
 * only re-open the trailing-segment fabrication.
 *
 * This is also why the tier tie-break below can stay last-write-wins: the
 * displacement it used to suffer — `self.conn = Outer()` then
 * `self.conn = Registry.get()`, where the second, dotted, non-type candidate
 * overwrote the real constructor binding at the shared weakest tier and left
 * the field untyped — cannot arise once a dotted callee yields no candidate at
 * all. The weakest tier now ranks only REAL constructions against each other,
 * where the last write in `__init__` genuinely is the live one.
 */
function constructorCallTypeName(
  right: SyntaxNode | null,
  receiverName: string,
): string | undefined {
  if (right === null || right.type !== 'call') return undefined;
  const callee = right.childForFieldName('function');
  if (callee === null) return undefined;
  // An `attribute` callee is the dotted path refused above; `self.p =
  // self.build()` is one instance of it, and a method call is not a
  // construction.
  if (callee.type !== 'identifier') return undefined;
  const text = callee.text.trim();
  if (text.length === 0) return undefined;
  // `self.p = self()` invokes the instance's own `__call__`. It is a call to a
  // bare name, but that name is the receiver, not a type.
  if (text === receiverName) return undefined;
  return text;
}

/**
 * Synthesize class-scope field bindings for the common Python constructor
 * injection patterns:
 *
 *   def __init__(self, service: Service):
 *       self.service = service        # from the PARAMETER's annotation
 *       self.cache: Cache = build()   # from the FIELD's own annotation
 *       self.outer = Outer()          # from the CONSTRUCTOR called (#2807)
 *
 * The three tiers rank in that order — an explicit field annotation beats a
 * parameter annotation, which beats a construction. Anything else is still
 * refused: the receiver resolver needs positive evidence, not a name-only
 * guess from an arbitrary RHS.
 */
export function synthesizeConstructorFieldTypeBindings(fnNode: SyntaxNode): CaptureMatch[] {
  if (fnNode.childForFieldName('name')?.text !== '__init__') return [];
  if (findEnclosingClassDefinition(fnNode) === null) return [];
  if (hasDecorator(fnNode, 'staticmethod') || hasDecorator(fnNode, 'classmethod')) return [];

  const receiver = synthesizeReceiverTypeBinding(fnNode);
  const receiverName = receiver?.['@type-binding.self']?.text;
  if (receiverName === undefined) return [];

  const parameters = fnNode.childForFieldName('parameters');
  const body = fnNode.childForFieldName('body');
  if (parameters === null || body === null) return [];

  const parameterTypes = new Map<string, string>();
  for (let i = 0; i < parameters.namedChildCount; i++) {
    const parameter = parameters.namedChild(i);
    if (parameter === null) continue;
    const name = firstParameterName(parameter);
    const annotation = parameter.childForFieldName('type');
    if (name !== null && annotation !== null) parameterTypes.set(name, annotation.text);
  }

  // Three evidence tiers for one field, strongest first. A later assignment of
  // the SAME tier still wins (last write in `__init__` is the live one), but a
  // weaker one never displaces a stronger: `self.x: Outer = make()` keeps its
  // annotation even if a later branch does `self.x = Other()`.
  //
  // Same-tier last-write-wins is only sound because `constructorCallTypeName`
  // admits nothing but real constructions into the weakest tier — see the note
  // there on the `self.conn = Registry.get()` displacement it used to allow.
  const TIER_EXPLICIT = 2;
  const TIER_PARAMETER = 1;
  const TIER_CONSTRUCTOR = 0;
  type Candidate = { readonly match: CaptureMatch; readonly tier: number };
  const candidates = new Map<string, Candidate>();

  const stack: SyntaxNode[] = [body];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (
      node !== body &&
      (node.type === 'function_definition' ||
        node.type === 'lambda' ||
        node.type === 'class_definition' ||
        node.type === 'if_statement' ||
        node.type === 'for_statement' ||
        node.type === 'while_statement' ||
        node.type === 'try_statement' ||
        node.type === 'match_statement')
    ) {
      continue;
    }

    if (node.type === 'assignment') {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      if (left?.type === 'attribute') {
        const object = left.childForFieldName('object');
        const field = left.childForFieldName('attribute');
        if (object?.type === 'identifier' && object.text === receiverName && field !== null) {
          const explicitType = node.childForFieldName('type');
          const parameterType =
            right?.type === 'identifier' ? parameterTypes.get(right.text) : undefined;
          // `self.x = Outer()` — the type comes from the CONSTRUCTOR being
          // called (#2807). This is not the "arbitrary unannotated RHS" the
          // header warns against: a call to a name that resolves to a class is
          // the same positive evidence every other language reads from
          // `= new X()`, and without it an unannotated instance field could
          // never act as a call receiver at all. Weakest of the three tiers, so
          // an explicit annotation or a parameter annotation still wins.
          const constructedType =
            explicitType === null && parameterType === undefined
              ? constructorCallTypeName(right, receiverName)
              : undefined;
          const typeName = explicitType?.text ?? parameterType ?? constructedType;
          if (typeName !== undefined) {
            const explicit = explicitType !== null;
            const inferredFromConstructor = constructedType !== undefined;
            const tier = explicit
              ? TIER_EXPLICIT
              : inferredFromConstructor
                ? TIER_CONSTRUCTOR
                : TIER_PARAMETER;
            const existing = candidates.get(field.text);
            if (existing === undefined || tier >= existing.tier) {
              candidates.set(field.text, {
                tier,
                match: {
                  '@type-binding.name': syntheticCapture('@type-binding.name', field, field.text),
                  '@type-binding.type': syntheticCapture(
                    '@type-binding.type',
                    explicitType ?? right ?? field,
                    typeName,
                  ),
                  // The marker that tells `interpretPythonTypeBinding` which
                  // tier this is; an explicit annotation carries neither and
                  // reads as `annotation`.
                  ...(explicit
                    ? {}
                    : inferredFromConstructor
                      ? {
                          '@type-binding.constructor': syntheticCapture(
                            '@type-binding.constructor',
                            right ?? field,
                            '1',
                          ),
                        }
                      : {
                          '@type-binding.parameter': syntheticCapture(
                            '@type-binding.parameter',
                            right ?? field,
                            '1',
                          ),
                        }),
                  '@type-binding.instance-field': syntheticCapture(
                    '@type-binding.instance-field',
                    node,
                    '1',
                  ),
                },
              });
            }
          }
        }
      }
    }

    // Push in reverse so the LIFO walk visits source order. That keeps Map
    // insertion order (and therefore emitted capture order) deterministic.
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child !== null) stack.push(child);
    }
  }

  return [...candidates.values()].map(({ match }) => match);
}
