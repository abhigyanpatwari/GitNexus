import type { Capture, MixedChainStep } from 'gitnexus-shared';
import { syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { MAX_CHAIN_DEPTH } from '../../utils/call-analysis.js';
import { encodeReceiverChain } from '../../utils/receiver-chain-codec.js';

const NAMED_TYPES = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
]);

function unwrap(node: SyntaxNode | null | undefined): SyntaxNode | undefined {
  let current = node ?? undefined;
  while (current?.type === 'parenthesized_expression')
    current = current.firstNamedChild ?? undefined;
  return current;
}

function implicitArrayChain(node: SyntaxNode): string | undefined {
  const indices: MixedChainStep[] = [];
  let current = unwrap(node);
  while (current?.type === 'array_access') {
    if (indices.length >= MAX_CHAIN_DEPTH) return undefined;
    indices.push({ kind: 'index' });
    current = unwrap(current.childForFieldName('array'));
  }
  if (
    indices.length === 0 ||
    current?.type !== 'method_invocation' ||
    current.childForFieldName('object') !== null
  )
    return undefined;
  // A chain carries no argument identity. Restrict the new implicit route to
  // no-argument calls; owned-method lookup must still refuse overload sets.
  const args = current.childForFieldName('arguments');
  if (
    args === null ||
    args.namedChildren.some((child) => !['line_comment', 'block_comment'].includes(child.type))
  )
    return undefined;
  const name = current.childForFieldName('name')?.text;
  return name === undefined
    ? undefined
    : encodeReceiverChain('this', [{ kind: 'call', name }, ...indices]);
}

/**
 * Complete a Java array receiver rooted at an implicit instance call.
 *
 * The shared chain extractor deliberately refuses a bare call's missing base.
 * Java can prove that base is lexical `this` inside an instance method. Prepare
 * eligible nodes once so deeply nested references do not repeat ancestor walks.
 * Anonymous types and static methods refuse because the existing named-type
 * receiver binding cannot establish their `this` identity.
 */
export function createJavaImplicitArrayReceiverChainSynthesizer(root: SyntaxNode) {
  const chains = new Map<number, string>();
  const stack = [
    { node: root, parent: undefined as SyntaxNode | undefined, namedType: false, instance: false },
  ];
  while (stack.length > 0) {
    const visit = stack.pop()!;
    const { node, parent } = visit;
    let { namedType, instance } = visit;
    if (NAMED_TYPES.has(node.type)) {
      namedType = true;
      instance = false;
    } else if (
      node.type === 'class_body' &&
      ['object_creation_expression', 'enum_constant'].includes(parent?.type ?? '')
    ) {
      namedType = false;
      instance = false;
    } else if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
      const modifiers = node.namedChildren.find((child) => child.type === 'modifiers');
      instance = namedType && !modifiers?.children.some((child) => child.type === 'static');
    }
    if (instance && node.type === 'array_access') {
      const encoded = implicitArrayChain(node);
      if (encoded !== undefined) chains.set(node.id, encoded);
    }
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--)
      stack.push({ node: children[i]!, parent: node, namedType, instance });
  }

  return (grouped: Record<string, Capture>, receiverNode: SyntaxNode | null | undefined): void => {
    if (
      grouped['@reference.call.member'] === undefined ||
      grouped['@reference.receiver-chain'] !== undefined
    )
      return;
    const receiver = unwrap(receiverNode);
    if (receiver === undefined || receiverNode == null) return;
    const encoded = chains.get(receiver.id);
    if (encoded !== undefined)
      grouped['@reference.receiver-chain'] = syntheticCapture(
        '@reference.receiver-chain',
        receiverNode,
        encoded,
      );
  };
}
