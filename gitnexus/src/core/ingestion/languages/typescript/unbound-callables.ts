import type { SyntaxNode } from '../../utils/ast-helpers.js';

/** Bare callback/return expressions have a function identity, but no outer binding. */
export function unboundCallableName(node: SyntaxNode): string | undefined {
  if (node.type !== 'arrow_function' && node.type !== 'function_expression') return undefined;
  const parent = node.parent;
  const isCallback =
    parent?.type === 'arguments' &&
    parent.parent?.type === 'call_expression' &&
    parent.parent.parent?.type === 'expression_statement';
  if (parent?.type !== 'return_statement' && !isCallback) return undefined;
  return (
    node.childForFieldName('name')?.text ??
    // Display names also ride the identifier-only taint-path codec. Internal
    // anonymous identity remains positional through the provider identity hook.
    `fn_${node.startPosition.row}_${node.startPosition.column}`
  );
}

// Shared by the TS and JS grammars, with the same INNER anchor as the CFG.
export function unboundCallableQuery(
  anchor: 'definition.function' | 'declaration.function',
): string {
  const marker = anchor === 'declaration.function' ? ' @callable.unbound' : '';
  return `
(expression_statement
  (call_expression
    arguments: (arguments
      [(arrow_function) (function_expression)] @${anchor}${marker})))
(return_statement
  [(arrow_function) (function_expression)] @${anchor}${marker})
`;
}
