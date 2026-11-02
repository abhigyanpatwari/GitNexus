import type { SyntaxNode } from '../../utils/ast-helpers.js';

export const OBJECTIVE_C_FUNCTION_TYPES = new Set([
  'function_definition',
  'method_definition',
  'block_literal',
]);

/** The grammar leaves fast-enumeration binding, collection and body unfielded. */
export function fastEnumerationParts(node: SyntaxNode):
  | {
      declarator: SyntaxNode;
      collection: SyntaxNode;
      body: SyntaxNode;
    }
  | undefined {
  if (node.type !== 'for_statement') return undefined;
  const children = node.children.filter((child) => child.type !== 'comment');
  const inIndex = children.findIndex((child) => child.type === 'in');
  if (inIndex < 0) return undefined;
  const declarator = children[inIndex - 1];
  const collection = children[inIndex + 1];
  const body = node.namedChildren.at(-1);
  return declarator && collection && body ? { declarator, collection, body } : undefined;
}

export function catchParameter(node: SyntaxNode): SyntaxNode | undefined {
  const type = node.namedChildren.find((child) => child.type === 'type_name');
  const children = type?.namedChildren ?? [];
  return (
    children.find((child) => child.type === 'identifier' || child.type.endsWith('_declarator')) ??
    // `@catch (id error)` parses its bare binding as a type_identifier.
    (children.length > 1 ? children.at(-1) : undefined)
  );
}
