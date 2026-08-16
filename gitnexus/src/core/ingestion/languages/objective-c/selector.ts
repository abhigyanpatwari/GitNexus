import type { MixedChainStep } from 'gitnexus-shared';

import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { MAX_CHAIN_DEPTH } from '../../utils/call-analysis.js';
import { encodeReceiverChain } from '../../utils/receiver-chain-codec.js';

export type ObjectiveCMethodKind = 'instance' | 'class';

export interface ObjectiveCParameterSignature {
  readonly name: string;
  readonly type: string;
}

export interface ObjectiveCMethodSignature {
  readonly selector: string;
  readonly signedSelector: string;
  readonly kind: ObjectiveCMethodKind;
  readonly arity: number;
  readonly returnType: string | null;
  readonly parameters: readonly ObjectiveCParameterSignature[];
}

export interface ObjectiveCMessageSend {
  readonly selector: string;
  readonly signedSelector: string;
  readonly candidateNames: readonly string[];
  readonly receiver: string;
  readonly kind: ObjectiveCMethodKind;
  readonly arity: number;
}

export interface ObjectiveCSubscriptSend {
  readonly referenceName: string;
  readonly candidateNames: readonly string[];
  readonly receiver: string;
  readonly arity: number;
}

function unwrapMethodType(node: SyntaxNode | null | undefined): string | null {
  if (node === null || node === undefined || node.type !== 'method_type') return null;
  const text = node.text.trim();
  if (text.startsWith('(') && text.endsWith(')')) return text.slice(1, -1).trim();
  return text || null;
}

function methodKind(node: SyntaxNode): ObjectiveCMethodKind {
  const marker = node.child(0)?.text ?? node.text.trimStart().slice(0, 1);
  return marker === '+' ? 'class' : 'instance';
}

function signed(selector: string, kind: ObjectiveCMethodKind): string {
  return `${kind === 'class' ? '+' : '-'}${selector}`;
}

function parameterSignature(node: SyntaxNode): ObjectiveCParameterSignature {
  const typeNode = node.namedChildren.find((child) => child.type === 'method_type');
  const nameNode = [...node.namedChildren].reverse().find((child) => child.type === 'identifier');
  return {
    name: nameNode?.text ?? '',
    type: unwrapMethodType(typeNode) ?? '',
  };
}

/** Normalize a declaration/definition into Objective-C's full selector identity. */
export function extractObjectiveCMethodSignature(
  node: SyntaxNode,
): ObjectiveCMethodSignature | null {
  if (node.type !== 'method_declaration' && node.type !== 'method_definition') return null;

  const returnTypeNode = node.namedChildren.find((child) => child.type === 'method_type');
  const parameters: ObjectiveCParameterSignature[] = [];
  const selectorPieces: string[] = [];
  let pendingSelectorPiece: string | null = null;

  for (const child of node.namedChildren) {
    if (child.type === 'identifier') {
      pendingSelectorPiece = child.text;
      continue;
    }
    if (child.type !== 'method_parameter') continue;
    // Objective-C permits empty keyword pieces (`foo::` and even `::`).
    // tree-sitter represents those as adjacent method_parameter nodes with no
    // intervening identifier, so absence is a real empty piece, not a reason
    // to discard the selector segment.
    selectorPieces.push(pendingSelectorPiece ?? '');
    parameters.push(parameterSignature(child));
    pendingSelectorPiece = null;
  }

  if (parameters.length === 0 && pendingSelectorPiece !== null) {
    selectorPieces.push(pendingSelectorPiece);
  }
  if (selectorPieces.length === 0) return null;

  const selector =
    parameters.length === 0
      ? selectorPieces[0]
      : selectorPieces.map((piece) => `${piece}:`).join('');
  const kind = methodKind(node);
  return {
    selector,
    signedSelector: signed(selector, kind),
    kind,
    arity: parameters.length,
    returnType: unwrapMethodType(returnTypeNode),
    parameters,
  };
}

function enclosingMethodKind(node: SyntaxNode): ObjectiveCMethodKind | null {
  let current = node.parent;
  while (current !== null) {
    if (current.type === 'method_declaration' || current.type === 'method_definition') {
      return methodKind(current);
    }
    current = current.parent;
  }
  return null;
}

function messageKind(node: SyntaxNode, receiver: string): ObjectiveCMethodKind {
  if (receiver === 'self' || receiver === 'super') {
    return enclosingMethodKind(node) ?? 'instance';
  }
  return 'instance';
}

/** Normalize a message expression into the same signed selector used by definitions. */
export function extractObjectiveCMessageSend(node: SyntaxNode): ObjectiveCMessageSend | null {
  if (node.type !== 'message_expression') return null;
  const receiver = node.childForFieldName('receiver')?.text.trim() ?? '';
  const selectorPieces: string[] = [];
  let pendingSelectorPiece: string | null = null;
  let skipLeadingArgument = false;
  let arity = 0;

  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child === null) continue;
    const fieldName = node.fieldNameForChild(index);
    // The grammar recovers a leading empty keyword (`[obj :arg ...]`) as a
    // receiver-labelled ERROR ':' followed by a method-labelled argument.
    // Preserve the empty piece and ignore that one recovered argument label.
    if (fieldName === 'receiver' && child.type === 'ERROR' && child.text.trim() === ':') {
      selectorPieces.push('');
      arity += 1;
      skipLeadingArgument = true;
      continue;
    }
    if (fieldName === 'method') {
      if (skipLeadingArgument) {
        skipLeadingArgument = false;
      } else {
        pendingSelectorPiece = child.text;
      }
      continue;
    }
    if (child.type === ':') {
      selectorPieces.push(pendingSelectorPiece ?? '');
      pendingSelectorPiece = null;
      arity += 1;
    }
  }
  if (arity === 0 && pendingSelectorPiece !== null) selectorPieces.push(pendingSelectorPiece);
  if (receiver === '' || selectorPieces.length === 0) return null;

  const selector =
    arity === 0 ? selectorPieces[0] : selectorPieces.map((piece) => `${piece}:`).join('');
  const kind = messageKind(node, receiver);
  const candidateNames =
    receiver === 'self' || receiver === 'super'
      ? [signed(selector, kind)]
      : [signed(selector, 'instance'), signed(selector, 'class')];
  return {
    selector,
    signedSelector: signed(selector, kind),
    candidateNames,
    receiver,
    kind,
    arity,
  };
}

/** Encode nested bracket-message receivers through the shared chain codec. */
export function encodeObjectiveCReceiverChain(receiverNode: SyntaxNode): string | undefined {
  const steps: MixedChainStep[] = [];
  let current = receiverNode;

  while (current.type === 'message_expression') {
    if (steps.length >= MAX_CHAIN_DEPTH) return undefined;
    const message = extractObjectiveCMessageSend(current);
    const innerReceiver = current.childForFieldName('receiver');
    if (message === null || innerReceiver === null) return undefined;
    steps.unshift({ kind: 'call', name: message.selector });
    current = innerReceiver;
  }

  if (steps.length === 0) return undefined;
  return encodeReceiverChain(current.text.trim(), steps);
}

/** Lower Objective-C subscripting to its receiver-dependent selector candidates. */
export function extractObjectiveCSubscriptSend(node: SyntaxNode): ObjectiveCSubscriptSend | null {
  if (node.type !== 'subscript_expression') return null;
  const receiver = node.childForFieldName('argument')?.text.trim() ?? '';
  if (receiver === '') return null;
  const parent = node.parent;
  const isWrite =
    parent?.type === 'assignment_expression' && parent.childForFieldName('left')?.id === node.id;
  const kind = messageKind(node, receiver);
  const candidateNames = isWrite
    ? [signed('setObject:atIndexedSubscript:', kind), signed('setObject:forKeyedSubscript:', kind)]
    : [signed('objectAtIndexedSubscript:', kind), signed('objectForKeyedSubscript:', kind)];
  return {
    referenceName: isWrite ? '$objc-subscript-write' : '$objc-subscript-read',
    candidateNames,
    receiver,
    arity: isWrite ? 2 : 1,
  };
}
