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

/** A named type's body members. Interface and annotation fields are static. */
const INSTANCE_MEMBER_BODIES = new Set(['class_body', 'enum_body_declarations']);

function isStatic(node: SyntaxNode): boolean {
  const modifiers = node.namedChildren.find((child) => child.type === 'modifiers');
  return modifiers?.children.some((child) => child.type === 'static') ?? false;
}

/** An instance context with no method scope to carry `this`: an instance
 * initializer block, or the initializer of an instance field. */
export interface JavaInitializerReceiverContext {
  readonly node: SyntaxNode;
  /** The named type whose instance `this` denotes there. */
  readonly type: SyntaxNode;
}

export interface JavaImplicitArrayReceiverChainSynthesizer {
  (grouped: Record<string, Capture>, receiverNode: SyntaxNode | null | undefined): void;
  /** Initializer contexts that received a chain. Read after every match. */
  initializerContexts(): readonly JavaInitializerReceiverContext[];
}

interface Visit {
  readonly node: SyntaxNode;
  readonly parent: SyntaxNode | undefined;
  /** The named type whose instance `this` denotes, if any. */
  readonly type: SyntaxNode | undefined;
  /** Directly inside an anonymous class body (`type` is then undefined). */
  readonly anonymous: boolean;
  readonly instance: boolean;
  readonly initializer: SyntaxNode | undefined;
}

/**
 * Complete a Java array receiver rooted at an implicit instance call.
 *
 * The shared chain extractor deliberately refuses a bare call's missing base.
 * Java can prove that base is lexical `this` in an instance context: an
 * instance method, constructor or compact constructor, an instance initializer
 * block, or an instance field's initializer. Prepare eligible nodes once so
 * deeply nested references do not repeat ancestor walks. Static members and
 * static initializers have no `this` and refuse. In an anonymous class body
 * only methods take part: their `this` binding names the anonymous class
 * (`synthesizeJavaReceiverBinding`). Its initializers have no such binding,
 * where `this` could fall back to an enclosing class, so they refuse.
 */
export function createJavaImplicitArrayReceiverChainSynthesizer(
  root: SyntaxNode,
): JavaImplicitArrayReceiverChainSynthesizer {
  const chains = new Map<number, string>();
  const contextOf = new Map<number, JavaInitializerReceiverContext>();
  const used = new Map<number, JavaInitializerReceiverContext>();
  const stack: Visit[] = [
    {
      node: root,
      parent: undefined,
      type: undefined,
      anonymous: false,
      instance: false,
      initializer: undefined,
    },
  ];
  while (stack.length > 0) {
    const visit = stack.pop()!;
    const { node, parent } = visit;
    let { type, anonymous, instance, initializer } = visit;
    if (NAMED_TYPES.has(node.type)) {
      type = node;
      anonymous = false;
      instance = false;
      initializer = undefined;
    } else if (
      node.type === 'class_body' &&
      ['object_creation_expression', 'enum_constant'].includes(parent?.type ?? '')
    ) {
      type = undefined;
      anonymous = true;
      instance = false;
      initializer = undefined;
    } else if (
      node.type === 'method_declaration' ||
      node.type === 'constructor_declaration' ||
      // A record's compact canonical constructor is an instance context.
      node.type === 'compact_constructor_declaration'
    ) {
      instance = (type !== undefined || anonymous) && !isStatic(node);
      initializer = undefined;
    } else if (type !== undefined && INSTANCE_MEMBER_BODIES.has(parent?.type ?? '')) {
      // A `static { }` initializer is its own node; a bare block is instance.
      if (node.type === 'block') {
        instance = true;
        initializer = node;
      } else if (node.type === 'field_declaration' && !isStatic(node)) instance = true;
    } else if (
      instance &&
      node.type === 'variable_declarator' &&
      parent?.type === 'field_declaration'
    )
      initializer = node.childForFieldName('value') ?? undefined;

    if (instance && node.type === 'array_access') {
      const encoded = implicitArrayChain(node);
      if (encoded !== undefined) {
        chains.set(node.id, encoded);
        if (initializer !== undefined && type !== undefined)
          contextOf.set(node.id, { node: initializer, type });
      }
    }
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--)
      stack.push({ node: children[i]!, parent: node, type, anonymous, instance, initializer });
  }

  const synthesize = (
    grouped: Record<string, Capture>,
    receiverNode: SyntaxNode | null | undefined,
  ): void => {
    if (
      grouped['@reference.call.member'] === undefined ||
      grouped['@reference.receiver-chain'] !== undefined
    )
      return;
    const receiver = unwrap(receiverNode);
    if (receiver === undefined || receiverNode == null) return;
    const encoded = chains.get(receiver.id);
    if (encoded === undefined) return;
    grouped['@reference.receiver-chain'] = syntheticCapture(
      '@reference.receiver-chain',
      receiverNode,
      encoded,
    );
    const context = contextOf.get(receiver.id);
    if (context !== undefined) used.set(context.node.id, context);
  };
  return Object.assign(synthesize, { initializerContexts: () => [...used.values()] });
}
