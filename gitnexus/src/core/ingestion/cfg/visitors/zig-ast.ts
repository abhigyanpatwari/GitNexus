/** Grammar-specific shapes shared by the Zig CFG walk and lexical harvest. */
import type { SyntaxNode } from '../../utils/ast-helpers.js';

export const ZIG_OPAQUE = new Set([
  'function_declaration',
  'function_signature',
  'struct_declaration',
  'union_declaration',
  'enum_declaration',
  'opaque_declaration',
]);

export const zigChildren = (node: SyntaxNode): SyntaxNode[] =>
  node.children.filter(
    (c) =>
      c.type !== 'comment' &&
      (c.isNamed || c.type === 'unreachable' || c.type === 'undefined' || c.type === 'null'),
  );

export const zigPayload = (node: SyntaxNode): SyntaxNode | undefined =>
  node.namedChildren.find((c) => c.type === 'payload');

export const zigLabel = (node: SyntaxNode): string | undefined =>
  node.namedChildren.find((c) => c.type === 'block_label' || c.type === 'break_label')
    ?.namedChildren[0]?.text;

/** The value operand of `return` / `break` (a labeled break's label is not a value). */
export const zigJumpValue = (node: SyntaxNode): SyntaxNode | undefined =>
  zigChildren(node).find((c) => c.type !== 'break_label');

export function zigAssignment(node: SyntaxNode): {
  targets: SyntaxNode[];
  value?: SyntaxNode;
  operator?: string;
} {
  const operator = node.children.find((c) => !c.isNamed && /^(?:[+*%/&|^<>-].*)?=$/.test(c.text));
  if (!operator) return { targets: [], value: undefined };
  const type = node.childForFieldName('type');
  return {
    targets: node.namedChildren.filter(
      (c) => c.endIndex <= operator.startIndex && c.id !== type?.id,
    ),
    value: zigChildren(node).find((c) => c.startIndex >= operator.endIndex),
    operator: operator.text,
  };
}

export function zigConditional(node: SyntaxNode): {
  inputs: SyntaxNode[];
  body?: SyntaxNode;
  payload?: SyntaxNode;
  alternative?: SyntaxNode;
  elsePayload?: SyntaxNode;
  update?: SyntaxNode;
} {
  const children = zigChildren(node);
  const elseClause = children.find((c) => c.type === 'else_clause');
  const elseToken = node.children.find((c) => c.type === 'else');
  const close = node.children.find((c) => c.type === ')');
  const inputs = children.filter(
    (c) => close && c.endIndex <= close.startIndex && c.type !== 'block_label',
  );
  const tail = children.filter(
    (c) => close && c.startIndex >= close.endIndex && c.id !== elseClause?.id,
  );
  const colon = node.children.find((c) => c.type === ':');
  const update = colon
    ? tail.find((c) => c.startIndex >= colon.endIndex && c.type !== 'payload')
    : undefined;
  const body =
    node.childForFieldName('body') ??
    tail.find(
      (c) =>
        c.type !== 'payload' &&
        c.id !== update?.id &&
        (!elseToken || c.startIndex < elseToken.startIndex),
    );
  const alternative =
    elseClause?.childForFieldName('alternative') ??
    tail.find((c) => elseToken && c.startIndex >= elseToken.endIndex && c.type !== 'payload');
  return {
    inputs,
    body: body ?? undefined,
    update,
    payload: tail.find(
      (c) => c.type === 'payload' && (!elseToken || c.startIndex < elseToken.startIndex),
    ),
    alternative: alternative ?? undefined,
    elsePayload: elseClause
      ? zigPayload(elseClause)
      : tail.find((c) => c.type === 'payload' && elseToken && c.startIndex > elseToken.endIndex),
  };
}
