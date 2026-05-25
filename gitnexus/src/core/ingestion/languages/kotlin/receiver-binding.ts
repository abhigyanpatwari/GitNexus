import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { nodeToCapture, syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { normalizeKotlinType } from './interpret.js';

const TYPE_DECL_NODE_TYPES = new Set([
  'class_declaration',
  'object_declaration',
  'companion_object',
]);

export function synthesizeKotlinReceiverBinding(fnNode: SyntaxNode): CaptureMatch[] {
  if (fnNode.type !== 'function_declaration') return [];

  const anchorNode = findFunctionBody(fnNode);
  if (anchorNode === null) return [];

  const extensionReceiver = extensionReceiverType(fnNode);
  if (extensionReceiver !== null) {
    return [buildReceiverMatch(anchorNode, 'this', extensionReceiver)];
  }

  const enclosingType = findEnclosingTypeDeclaration(fnNode);
  if (enclosingType === null) return [];

  const enclosingName = typeDeclarationName(enclosingType);
  if (enclosingName === null) return [];

  const out = [buildReceiverMatch(anchorNode, 'this', enclosingName)];
  const superName = firstSuperclassText(enclosingType);
  if (superName !== null) out.push(buildReceiverMatch(anchorNode, 'super', superName));
  return out;
}

function findFunctionBody(fnNode: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < fnNode.namedChildCount; i++) {
    const child = fnNode.namedChild(i);
    if (child?.type === 'function_body') return child;
  }
  return fnNode;
}

function extensionReceiverType(fnNode: SyntaxNode): string | null {
  for (let i = 0; i < fnNode.namedChildCount; i++) {
    const child = fnNode.namedChild(i);
    if (child === null) continue;
    if (child.type === 'simple_identifier') return null;
    if (child.type === 'user_type' || child.type === 'nullable_type') {
      return normalizeKotlinType(child.text);
    }
  }
  return null;
}

function findEnclosingTypeDeclaration(node: SyntaxNode): SyntaxNode | null {
  let current = node.parent;
  while (current !== null) {
    if (TYPE_DECL_NODE_TYPES.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

function typeDeclarationName(typeNode: SyntaxNode): string | null {
  if (typeNode.type === 'companion_object') {
    return (
      typeNode.namedChildren.find((child) => child.type === 'type_identifier')?.text ??
      enclosingNonCompanionTypeName(typeNode) ??
      'Companion'
    );
  }
  return typeNode.namedChildren.find((child) => child.type === 'type_identifier')?.text ?? null;
}

function enclosingNonCompanionTypeName(node: SyntaxNode): string | null {
  let current = node.parent;
  while (current !== null) {
    if (current.type === 'class_declaration' || current.type === 'object_declaration') {
      return current.namedChildren.find((child) => child.type === 'type_identifier')?.text ?? null;
    }
    current = current.parent;
  }
  return null;
}

function firstSuperclassText(typeNode: SyntaxNode): string | null {
  if (typeNode.type !== 'class_declaration') return null;
  for (const child of typeNode.namedChildren) {
    if (child.type !== 'delegation_specifier') continue;
    const ctor = child.namedChildren.find((n) => n.type === 'constructor_invocation');
    const userType =
      ctor?.namedChildren.find((n) => n.type === 'user_type') ??
      child.namedChildren.find((n) => n.type === 'user_type');
    const name = userType?.namedChildren.find((n) => n.type === 'type_identifier')?.text;
    if (name !== undefined) return normalizeKotlinType(name);
  }
  return null;
}

function buildReceiverMatch(anchorNode: SyntaxNode, name: string, typeText: string): CaptureMatch {
  const out: Record<string, Capture> = {
    '@type-binding.self': nodeToCapture('@type-binding.self', anchorNode),
    '@type-binding.name': syntheticCapture('@type-binding.name', anchorNode, name),
    '@type-binding.type': syntheticCapture('@type-binding.type', anchorNode, typeText),
  };
  return out;
}
