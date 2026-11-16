import type { CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import type { JavaCallResultElementRoute } from './declared-type-captures.js';

/** An outer declaration a copy read; any write to it refuses the copy. */
interface Guard {
  readonly frame: BlockFrame;
  readonly name: string;
}

interface Producer {
  readonly call: SyntaxNode;
  readonly guards: readonly Guard[];
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

type Visit =
  | {
      readonly kind: 'enter';
      readonly node: SyntaxNode;
      /** A switch statement group stands for its switch block here. */
      readonly parent?: SyntaxNode;
      readonly grandparent?: SyntaxNode;
      readonly typeDepth: number;
    }
  | { readonly kind: 'leave'; readonly frame: BlockFrame };

const TYPE_BODIES = new Set(['class_body', 'interface_body', 'enum_body', 'annotation_type_body']);
// A switch block is one lexical block for all its statement groups (JLS 6.3),
// and a lambda's parameters hide every outer local of the same name.
const FRAMES = new Set(['block', 'constructor_body', 'switch_block', 'lambda_expression']);

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
 * of a local declared there. Inside a local or anonymous type body an outer
 * local's name may denote a field of that type, so such a body neither reads
 * nor writes the outer local. A lambda parameter likewise hides it.
 *
 * A `var` for-each over such a local (`for (var x : xs)`), or over a Map
 * local's `values()` / `keySet()`, records the same producer with an element
 * route, anchored at the loop body that declares the variable. Resolution
 * types it only from the selected producer's proven JDK container.
 */
export function synthesizeJavaFactoryAliasCaptures(root: SyntaxNode): CaptureMatch[] {
  const candidates: { readonly capture: CaptureMatch; readonly guards: readonly Guard[] }[] = [];
  const claims = new Map<string, BlockFrame[]>();
  const stack: Visit[] = [{ kind: 'enter', node: root, typeDepth: 0 }];
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
    typeDepth: number,
  ): Producer | undefined => {
    const owner = ownerOf(source, typeDepth);
    const producer = owner?.producers.get(source);
    if (owner === undefined || producer === undefined) return undefined;
    if (owner === frame) return producer;
    return { call: producer.call, guards: [...producer.guards, { frame: owner, name: source }] };
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

    const { node, parent, grandparent, typeDepth } = visit;
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
            current.producers.set(name.text, { call: value, guards: [] });
          else if (value?.type === 'identifier') {
            const producer = copiedProducer(value.text, current, typeDepth);
            if (producer !== undefined) {
              current.producers.set(name.text, producer);
              candidates.push({
                guards: producer.guards,
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
      const producer =
        route === undefined ? undefined : copiedProducer(route.source, current, typeDepth);
      if (name !== null && body !== null && route !== undefined && producer !== undefined)
        candidates.push({
          // Unless the loop is a statement of the producer's own block, it may
          // run again after a later write to its source (an enclosing loop).
          guards:
            parent?.id === current.block.id || !current.declarations.has(route.source)
              ? producer.guards
              : [...producer.guards, { frame: current, name: route.source }],
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
    const childDepth = TYPE_BODIES.has(node.type) ? typeDepth + 1 : typeDepth;
    for (let i = children.length - 1; i >= 0; i--)
      stack.push({
        kind: 'enter',
        node: children[i]!,
        parent: childParent,
        grandparent: parent,
        typeDepth: childDepth,
      });
  }
  return candidates
    .filter(({ guards }) => guards.every(({ frame, name }) => !frame.written.has(name)))
    .map(({ capture }) => capture);
}
