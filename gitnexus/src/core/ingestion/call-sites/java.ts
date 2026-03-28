/** Java `method_reference` (`::`) nodes (tree-sitter-java). `super::` still lacks TypeEnv receiver typing. */

import type { SyntaxNode } from '../utils/ast-helpers.js';

export type ParsedJavaMethodReference = {
  calledName: string;
  callForm: 'member' | 'constructor';
  receiverName?: string;
};

/** Parse `expr::method`, `Type::new`, `this::m`, `super::m`. */
export const parseJavaMethodReference = (
  callNode: SyntaxNode,
): ParsedJavaMethodReference | null => {
  if (callNode.type !== 'method_reference') return null;

  const recv = callNode.namedChild(0);
  if (!recv) return null;

  for (const c of callNode.children) {
    if (c.type === 'new') {
      if (recv.type !== 'identifier') return null;
      return { calledName: recv.text, callForm: 'constructor' };
    }
  }

  const rhs = callNode.child(callNode.childCount - 1);
  if (!rhs || rhs.type !== 'identifier') return null;
  const methodName = rhs.text;

  if (recv.type === 'identifier') {
    return { calledName: methodName, callForm: 'member', receiverName: recv.text };
  }
  if (recv.type === 'this') {
    return { calledName: methodName, callForm: 'member', receiverName: 'this' };
  }
  if (recv.type === 'super') {
    return { calledName: methodName, callForm: 'member', receiverName: 'super' };
  }
  return null;
};
