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
  readonly producers: Map<string, Producer>;
  readonly declarations: Set<string>;
  readonly written: Set<string>;
}

type Visit =
  | {
      readonly kind: 'enter';
      readonly node: SyntaxNode;
      readonly parent?: SyntaxNode;
      readonly grandparent?: SyntaxNode;
    }
  | { readonly kind: 'leave'; readonly frame: BlockFrame };

const TYPE_BODIES = new Set(['class_body', 'interface_body', 'enum_body', 'annotation_type_body']);

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

/** A local or anonymous type body between a copy and its source may declare
 * a same-named field, so the source name no longer denotes the local. */
function crossesTypeBody(node: SyntaxNode, block: SyntaxNode): boolean {
  for (let current = node.parent; current !== null; current = current.parent) {
    if (current.id === block.id) return false;
    if (TYPE_BODIES.has(current.type)) return true;
  }
  return true;
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
 * A `var` for-each over such a local (`for (var x : xs)`), or over a Map
 * local's `values()` / `keySet()`, records the same producer with an element
 * route, anchored at the loop body that declares the variable. Resolution
 * types it only from the selected producer's proven JDK container.
 */
export function synthesizeJavaFactoryAliasCaptures(root: SyntaxNode): CaptureMatch[] {
  const candidates: { readonly capture: CaptureMatch; readonly guards: readonly Guard[] }[] = [];
  const claims = new Map<string, BlockFrame[]>();
  const stack: Visit[] = [{ kind: 'enter', node: root }];
  let current: BlockFrame | undefined;

  const copiedProducer = (
    source: string,
    declarator: SyntaxNode,
    frame: BlockFrame,
  ): Producer | undefined => {
    const frames = claims.get(source);
    const owner = frames?.[frames.length - 1];
    const producer = owner?.producers.get(source);
    if (owner === undefined || producer === undefined) return undefined;
    if (owner === frame) return producer;
    if (crossesTypeBody(declarator, owner.block)) return undefined;
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

    const { node, parent, grandparent } = visit;
    if (node.type === 'block') {
      current = {
        block: node,
        parent: current,
        producers: new Map(),
        declarations: new Set(),
        written: new Set(),
      };
      stack.push({ kind: 'leave', frame: current });
    }

    // Local types introduce a provider-synthesized visibility scope extending
    // to the end of this block. Calls before it and aliases after it therefore
    // have different extracted scopes despite sharing the same AST block.
    if (
      current !== undefined &&
      parent?.id === current.block.id &&
      [
        'class_declaration',
        'interface_declaration',
        'enum_declaration',
        'record_declaration',
        'annotation_type_declaration',
      ].includes(node.type)
    )
      current.producers.clear();

    if (
      current !== undefined &&
      node.type === 'variable_declarator' &&
      parent?.type === 'local_variable_declaration' &&
      grandparent?.id === current.block.id
    ) {
      const name = node.childForFieldName('name');
      if (name !== null) {
        if (!current.declarations.has(name.text)) {
          const frames = claims.get(name.text) ?? [];
          frames.push(current);
          claims.set(name.text, frames);
          current.declarations.add(name.text);
        }
        // The new declaration owns its own initializer, including a self-read.
        current.producers.delete(name.text);
        if (parent.childForFieldName('type')?.text === 'var') {
          const value = unwrapJavaAliasInitializer(node.childForFieldName('value'));
          if (value?.type === 'method_invocation')
            current.producers.set(name.text, { call: value, guards: [] });
          else if (value?.type === 'identifier') {
            const producer = copiedProducer(value.text, node, current);
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
        route === undefined ? undefined : copiedProducer(route.source, node, current);
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
        const frames = claims.get(target.text);
        const owner = frames?.[frames.length - 1];
        owner?.producers.delete(target.text);
        owner?.written.add(target.text);
      }
    }

    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--)
      stack.push({ kind: 'enter', node: children[i]!, parent: node, grandparent: parent });
  }
  return candidates
    .filter(({ guards }) => guards.every(({ frame, name }) => !frame.written.has(name)))
    .map(({ capture }) => capture);
}
