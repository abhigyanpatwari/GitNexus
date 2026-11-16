import type { CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

interface BlockFrame {
  readonly block: SyntaxNode;
  readonly parent: BlockFrame | undefined;
  readonly producers: Map<string, SyntaxNode>;
  readonly declarations: Set<string>;
}

type Visit =
  | {
      readonly kind: 'enter';
      readonly node: SyntaxNode;
      readonly parent?: SyntaxNode;
      readonly grandparent?: SyntaxNode;
    }
  | { readonly kind: 'leave'; readonly frame: BlockFrame };

function unwrapJavaAliasInitializer(node: SyntaxNode | null): SyntaxNode | undefined {
  let current = node ?? undefined;
  while (current?.type === 'parenthesized_expression')
    current = current.firstNamedChild ?? undefined;
  return current;
}

/**
 * Preserve a factory alias's exact producer instead of guessing by method name.
 *
 * Only aliases declared in the producer's own AST block participate: the shared
 * call-result fact takes its scope from the original call's range. Each block
 * starts with an empty producer table, and writes invalidate the nearest local
 * producer. Copies retain the original call even if their source is later
 * assigned again. The existing selected-call join supplies the eventual type.
 */
export function synthesizeJavaFactoryAliasCaptures(root: SyntaxNode): CaptureMatch[] {
  const captures: CaptureMatch[] = [];
  const claims = new Map<string, BlockFrame[]>();
  const stack: Visit[] = [{ kind: 'enter', node: root }];
  let current: BlockFrame | undefined;

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
          if (value?.type === 'method_invocation') current.producers.set(name.text, value);
          else if (value?.type === 'identifier') {
            const producer = current.producers.get(value.text);
            if (producer !== undefined) {
              current.producers.set(name.text, producer);
              captures.push({
                '@call-result-assignment.call': nodeToCapture(
                  '@call-result-assignment.call',
                  producer,
                ),
                '@call-result-assignment.lhs': nodeToCapture('@call-result-assignment.lhs', name),
              });
            }
          }
        }
      }
    } else if (node.type === 'assignment_expression' || node.type === 'update_expression') {
      const target =
        node.type === 'assignment_expression'
          ? node.childForFieldName('left')
          : node.firstNamedChild;
      if (target?.type === 'identifier') {
        const frames = claims.get(target.text);
        frames?.[frames.length - 1]?.producers.delete(target.text);
      }
    }

    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--)
      stack.push({ kind: 'enter', node: children[i]!, parent: node, grandparent: parent });
  }
  return captures;
}
