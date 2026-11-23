import { type CaptureMatch, type ParsedFile, type ScopeId, type TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { inheritedFieldResolver } from './inherited-field-types.js';
import { javaClassScopeOfBody, type JavaCallResultElementRoute } from './declared-type-captures.js';

/** An outer declaration a copy read; any write to it refuses the copy. */
interface Guard {
  readonly frame: BlockFrame;
  readonly name: string;
}

/** A local or anonymous class body a value was read into, under `name`. */
interface Crossing {
  readonly type: TypeBody;
  readonly name: string;
}

interface Producer {
  readonly call: SyntaxNode;
  readonly guards: readonly Guard[];
  readonly crossings: readonly Crossing[];
}

interface BlockFrame {
  readonly block: SyntaxNode;
  readonly parent: BlockFrame | undefined;
  /** How many type bodies enclose the block; a deeper body is another class. */
  readonly typeDepth: number;
  readonly producers: Map<string, Producer>;
  readonly declarations: Set<string>;
  readonly written: Set<string>;
}

/** The type bodies enclosing a node, innermost first. The owner is recorded
 * on the way down, so no ancestor is read back. */
interface TypeBody {
  readonly body: SyntaxNode;
  readonly owner: SyntaxNode | undefined;
  readonly depth: number;
  readonly outer: TypeBody | undefined;
}

type Visit =
  | {
      readonly kind: 'enter';
      readonly node: SyntaxNode;
      /** A switch statement group stands for its switch block here. */
      readonly parent?: SyntaxNode;
      readonly grandparent?: SyntaxNode;
      readonly types: TypeBody | undefined;
    }
  | { readonly kind: 'leave'; readonly frame: BlockFrame };

const TYPE_BODIES = new Set(['class_body', 'interface_body', 'enum_body', 'annotation_type_body']);
// A switch block is one lexical block for all its statement groups (JLS 6.3),
// and a lambda's parameters hide every outer local of the same name.
const FRAMES = new Set([
  'block',
  'constructor_body',
  'switch_block',
  'lambda_expression',
  'for_statement',
]);
// Nodes that declare a variable under their `name` field.
const NAMED_DECLARATIONS = new Set([
  'variable_declarator',
  'formal_parameter',
  'catch_formal_parameter',
  'resource',
  'enhanced_for_statement',
  'instanceof_expression',
]);

/**
 * The element route of a copy read through local or anonymous class bodies:
 * this prefix and a JSON list of `[class scope, name]`, answered by
 * `javaEnclosingLocalAliasType`.
 */
export const JAVA_ENCLOSING_LOCAL_ROUTE = 'enclosing-local:';
// The ParsedFile store drops a site whose element is longer; drop it here so a
// cached and an uncached run agree.
const MAX_ROUTE_LENGTH = 4_096;

function unwrapJavaAliasInitializer(node: SyntaxNode | null): SyntaxNode | undefined {
  let current = node ?? undefined;
  while (current?.type === 'parenthesized_expression')
    current = current.firstNamedChild ?? undefined;
  return current;
}

/** The local a `var` for-each iterates and how its element is reached:
 * `xs` itself, or a Map local's no-argument `values()` / `keySet()`. */
function elementRoute(
  value: SyntaxNode | undefined,
): { readonly source: string; readonly element: JavaCallResultElementRoute } | undefined {
  if (value?.type === 'identifier') return { source: value.text, element: 'iterate' };
  if (value?.type !== 'method_invocation') return undefined;
  const receiver = unwrapJavaAliasInitializer(value.childForFieldName('object'));
  const member = value.childForFieldName('name')?.text;
  const args = value.childForFieldName('arguments');
  if (
    receiver?.type !== 'identifier' ||
    (member !== 'values' && member !== 'keySet') ||
    args === null ||
    args.namedChildren.some((child) => !['line_comment', 'block_comment'].includes(child.type))
  )
    return undefined;
  return { source: receiver.text, element: member };
}

/** The names a lambda's parameters declare: `x ->`, `(x, y) ->`, `(T x) ->`. */
function lambdaParameterNames(lambda: SyntaxNode): string[] {
  const parameters = lambda.childForFieldName('parameters');
  if (parameters === null) return [];
  if (parameters.type === 'identifier') return [parameters.text];
  const names: string[] = [];
  for (const parameter of parameters.namedChildren) {
    const name =
      parameter.type === 'identifier'
        ? parameter
        : (parameter.childForFieldName('name') ??
          parameter.namedChildren
            .find((child) => child.type === 'variable_declarator')
            ?.childForFieldName('name') ??
          null);
    if (name?.type === 'identifier') names.push(name.text);
  }
  return names;
}

/** The variable names a node declares: a field, local, parameter, resource,
 * catch or loop variable, pattern variable or lambda parameter. */
function declaredNames(node: SyntaxNode): readonly string[] {
  if (NAMED_DECLARATIONS.has(node.type)) {
    const name = node.childForFieldName('name');
    return name?.type === 'identifier' ? [name.text] : [];
  }
  if (node.type === 'type_pattern' || node.type === 'record_pattern_component')
    return node.namedChildren.filter((child) => child.type === 'identifier').map((n) => n.text);
  return node.type === 'lambda_expression' ? lambdaParameterNames(node) : [];
}

/**
 * Whether code in a type body may read an enclosing method's locals: an
 * anonymous class, or a non-static class (a local class or an inner class of
 * one). Interfaces, enums and records are static contexts (JLS 8.1.3, 14.3).
 */
function readsEnclosingLocals({ body, owner }: TypeBody): boolean {
  if (body.type !== 'class_body' || owner === undefined) return false;
  if (owner.type === 'object_creation_expression') return true;
  return (
    owner.type === 'class_declaration' &&
    !(
      owner.namedChildren
        .find((child) => child.type === 'modifiers')
        ?.children.some((child) => child.type === 'static') ?? false
    )
  );
}

/**
 * Preserve a factory alias's exact producer instead of guessing by method name.
 *
 * Each block starts with an empty producer table, and writes invalidate the
 * nearest local producer. A copy in the producer's own block retains the
 * original call even if its source is later assigned again. A copy in a
 * nested block (`if (c) { var w = u; }`) may run after a later write to its
 * source (a loop), so it is kept only when that source is never written. The
 * fact is anchored at the copy's own name, so the binding lands in the scope
 * that declares the copy. The existing selected-call join supplies the type.
 *
 * A constructor body is a block, and so is a switch block: the statements of
 * an old-style `case 1:` group belong to the switch block, which is the scope
 * of a local declared there. A lambda parameter hides an outer local.
 *
 * Inside a local or anonymous class body an outer local is read only if it is
 * effectively final (JLS 8.1.3), so the copy is kept only when the source is
 * never written. The name may instead denote a member of that class: the copy
 * is refused when the body declares a variable of that name anywhere (a
 * field, a parameter, a local), and its route asks resolution to confirm that
 * no supertype of the class declares a field of that name. An interface,
 * enum, record or static class body reads no outer local.
 *
 * A `var` for-each over such a local (`for (var x : xs)`), or over a Map
 * local's `values()` / `keySet()`, records the same producer with an element
 * route, anchored at the loop body that declares the variable. Resolution
 * types it only from the selected producer's proven JDK container.
 */
export function synthesizeJavaFactoryAliasCaptures(
  root: SyntaxNode,
  filePath: string,
): CaptureMatch[] {
  const candidates: {
    readonly capture: CaptureMatch;
    readonly guards: readonly Guard[];
    readonly crossings: readonly Crossing[];
  }[] = [];
  const claims = new Map<string, BlockFrame[]>();
  // Variable names declared in each local or anonymous class body, by node id.
  const declaredIn = new Map<number, Set<string>>();
  const stack: Visit[] = [{ kind: 'enter', node: root, types: undefined }];
  let current: BlockFrame | undefined;

  const declare = (name: string, frame: BlockFrame): void => {
    if (frame.declarations.has(name)) return;
    const frames = claims.get(name) ?? [];
    frames.push(frame);
    claims.set(name, frames);
    frame.declarations.add(name);
  };

  /** The frame whose local `name` denotes at this depth, if it is a local. */
  const ownerOf = (name: string, typeDepth: number): BlockFrame | undefined => {
    const frames = claims.get(name);
    const owner = frames?.[frames.length - 1];
    return owner?.typeDepth === typeDepth ? owner : undefined;
  };

  const copiedProducer = (
    source: string,
    frame: BlockFrame,
    types: TypeBody | undefined,
    throughBodies: boolean,
  ): Producer | undefined => {
    const frames = claims.get(source);
    const owner = frames?.[frames.length - 1];
    const producer = owner?.producers.get(source);
    if (owner === undefined || producer === undefined) return undefined;
    const guards = [...producer.guards, { frame: owner, name: source }];
    if (owner.typeDepth === (types?.depth ?? 0))
      return owner === frame ? producer : { ...producer, guards };
    if (!throughBodies) return undefined;
    const crossings = [...producer.crossings];
    for (let type = types; type !== undefined && type.depth > owner.typeDepth; type = type.outer) {
      if (!readsEnclosingLocals(type)) return undefined;
      crossings.push({ type, name: source });
    }
    return { call: producer.call, guards, crossings };
  };

  while (stack.length > 0) {
    const visit = stack.pop()!;
    if (visit.kind === 'leave') {
      for (const name of visit.frame.declarations) {
        const frames = claims.get(name)!;
        frames.pop();
        if (frames.length === 0) claims.delete(name);
      }
      current = visit.frame.parent;
      continue;
    }

    const { node, parent, grandparent, types } = visit;
    const typeDepth = types?.depth ?? 0;
    if (FRAMES.has(node.type)) {
      current = {
        block: node,
        parent: current,
        typeDepth,
        producers: new Map(),
        declarations: new Set(),
        written: new Set(),
      };
      stack.push({ kind: 'leave', frame: current });
      if (node.type === 'lambda_expression')
        for (const name of lambdaParameterNames(node)) declare(name, current);
    }
    const declaring = types === undefined ? undefined : declaredIn.get(types.body.id);
    if (declaring !== undefined) for (const name of declaredNames(node)) declaring.add(name);

    // A local type declared between a producer and its copy needs no reset:
    // the copy's binding is anchored at its own name, inside the type's
    // visibility scope, and the producer is still typed at its own call.
    if (
      current !== undefined &&
      node.type === 'variable_declarator' &&
      parent?.type === 'local_variable_declaration' &&
      grandparent?.id === current.block.id
    ) {
      const name = node.childForFieldName('name');
      if (name !== null) {
        declare(name.text, current);
        // The new declaration owns its own initializer, including a self-read.
        current.producers.delete(name.text);
        if (parent.childForFieldName('type')?.text === 'var') {
          const value = unwrapJavaAliasInitializer(node.childForFieldName('value'));
          if (value?.type === 'method_invocation')
            current.producers.set(name.text, { call: value, guards: [], crossings: [] });
          else if (value?.type === 'identifier') {
            const producer = copiedProducer(value.text, current, types, true);
            if (producer !== undefined) {
              current.producers.set(name.text, producer);
              candidates.push({
                guards: producer.guards,
                crossings: producer.crossings,
                capture: {
                  '@call-result-assignment.call': nodeToCapture(
                    '@call-result-assignment.call',
                    producer.call,
                  ),
                  '@call-result-assignment.lhs': nodeToCapture('@call-result-assignment.lhs', name),
                  '@call-result-assignment.scope': nodeToCapture(
                    '@call-result-assignment.scope',
                    name,
                  ),
                },
              });
            }
          }
        }
      }
    } else if (
      current !== undefined &&
      node.type === 'enhanced_for_statement' &&
      node.childForFieldName('type')?.text === 'var'
    ) {
      const name = node.childForFieldName('name');
      const body = node.childForFieldName('body');
      const route = elementRoute(unwrapJavaAliasInitializer(node.childForFieldName('value')));
      // The element route is the loop's own; a value read through a class
      // body has no route left for its proof.
      const producer =
        route === undefined ? undefined : copiedProducer(route.source, current, types, false);
      if (
        name !== null &&
        body !== null &&
        route !== undefined &&
        producer !== undefined &&
        producer.crossings.length === 0
      )
        candidates.push({
          // Unless the loop is a statement of the producer's own block, it may
          // run again after a later write to its source (an enclosing loop).
          guards:
            parent?.id === current.block.id || !current.declarations.has(route.source)
              ? producer.guards
              : [...producer.guards, { frame: current, name: route.source }],
          crossings: [],
          capture: {
            '@call-result-assignment.call': nodeToCapture(
              '@call-result-assignment.call',
              producer.call,
            ),
            '@call-result-assignment.lhs': nodeToCapture('@call-result-assignment.lhs', name),
            '@call-result-assignment.scope': nodeToCapture('@call-result-assignment.scope', body),
            '@call-result-assignment.element': {
              ...nodeToCapture('@call-result-assignment.element', node),
              text: route.element,
            },
          },
        });
    } else if (node.type === 'assignment_expression' || node.type === 'update_expression') {
      const target =
        node.type === 'assignment_expression'
          ? node.childForFieldName('left')
          : node.firstNamedChild;
      if (target?.type === 'identifier') {
        const owner = ownerOf(target.text, typeDepth);
        owner?.producers.delete(target.text);
        owner?.written.add(target.text);
      }
    }

    const children = node.namedChildren;
    const childParent = node.type === 'switch_block_statement_group' ? parent : node;
    let childTypes = types;
    if (TYPE_BODIES.has(node.type)) {
      childTypes = { body: node, owner: parent, depth: typeDepth + 1, outer: types };
      // Only a body inside a block can read an enclosing method's locals.
      if (current !== undefined) declaredIn.set(node.id, new Set());
    }
    for (let i = children.length - 1; i >= 0; i--)
      stack.push({
        kind: 'enter',
        node: children[i]!,
        parent: childParent,
        grandparent: parent,
        types: childTypes,
      });
  }
  const out: CaptureMatch[] = [];
  for (const { capture, guards, crossings } of candidates) {
    if (guards.some(({ frame, name }) => frame.written.has(name))) continue;
    if (crossings.length === 0) {
      out.push(capture);
      continue;
    }
    // A variable of that name declared anywhere in a crossed body may be what
    // the copy reads; refuse rather than track each declaration's scope.
    const hidden = crossings.some(({ type, name }) => {
      const declared = declaredIn.get(type.body.id);
      return declared === undefined || declared.has(name);
    });
    if (hidden) continue;
    const proofs: [ScopeId | undefined, string][] = crossings.map(({ type, name }) => [
      type.owner === undefined ? undefined : javaClassScopeOfBody(type.body, filePath, type.owner),
      name,
    ]);
    const route = JAVA_ENCLOSING_LOCAL_ROUTE + JSON.stringify(proofs);
    if (proofs.some(([scope]) => scope === undefined) || route.length > MAX_ROUTE_LENGTH) continue;
    const lhs = capture['@call-result-assignment.lhs']!;
    out.push({
      ...capture,
      '@call-result-assignment.element': {
        ...lhs,
        name: '@call-result-assignment.element',
        text: route,
      },
    });
  }
  return out;
}

type AliasSource = 'local' | 'unknown' | TypeRef;
const enclosingLocalSources = new WeakMap<
  ScopeResolutionIndexes,
  ReadonlyMap<string, AliasSource>
>();

function parseRoute(route: string): readonly (readonly [string, string])[] | undefined {
  try {
    const parsed: unknown = JSON.parse(route.slice(JAVA_ENCLOSING_LOCAL_ROUTE.length));
    return Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (pair: unknown) =>
          Array.isArray(pair) &&
          pair.length === 2 &&
          typeof pair[0] === 'string' &&
          typeof pair[1] === 'string',
      )
      ? (parsed as [string, string][])
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Settle every enclosing-local route once per resolution pass, after the MRO
 * is known. An inherited field shadows the enclosing local even when its
 * factory call has no known return type. Keep the field's declaration scope
 * on the copy. Inaccessible fields leave the enclosing local visible. An
 * incomplete hierarchy or ambiguous field leaves the source undecided.
 */
export function indexJavaEnclosingLocalAliases(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const sources = new Map<string, AliasSource>();
  enclosingLocalSources.set(indexes, sources);
  const inheritedField = inheritedFieldResolver(indexes);
  const sourceOf = (route: string): AliasSource => {
    const proofs = parseRoute(route);
    if (proofs === undefined) return 'unknown';
    for (const [scope, name] of proofs) {
      const field = inheritedField({ kind: 'unshadowed-field', scope, name });
      if (field === 'absent' || field === 'hidden') continue;
      // A route through several copies can change which variable it reads at
      // each crossing. Only a single crossing identifies this field directly.
      if (typeof field !== 'object' || proofs.length !== 1) return 'unknown';
      return field.scope.typeBindings.get(name) ?? 'unknown';
    }
    return 'local';
  };
  for (const parsed of parsedFiles) {
    for (const site of parsed.callResultAssignmentSites ?? []) {
      const route = site.element;
      if (!route?.startsWith(JAVA_ENCLOSING_LOCAL_ROUTE)) continue;
      let source = sources.get(route);
      if (source === undefined) sources.set(route, (source = sourceOf(route)));
      if (typeof source !== 'object') continue;
      const bindings = indexes.scopeTree.getScope(site.inScope)?.typeBindings as
        | Map<string, TypeRef>
        | undefined;
      if (bindings === undefined) continue;
      // The type is read at the field, but the local claim owns the copy's range.
      const bindingRange = bindings.get(site.lhs)?.bindingRange;
      bindings.set(site.lhs, { ...source, bindingRange });
    }
  }
}

/** A copy supplied by an inherited field is independent of the outer call. */
export function javaAliasReadsInheritedField(
  route: string | undefined,
  scopes: ScopeResolutionIndexes,
): boolean {
  return route !== undefined && typeof enclosingLocalSources.get(scopes)?.get(route) === 'object';
}

/** The selected producer's own return type for a copy whose route stands. */
export function javaEnclosingLocalAliasType(
  returned: TypeRef,
  route: string,
  scopes: ScopeResolutionIndexes,
): TypeRef | undefined {
  return enclosingLocalSources.get(scopes)?.get(route) === 'local' ? returned : undefined;
}
