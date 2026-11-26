import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { positionQualifiedCallableName } from '../../workers/callable-id.js';

const callableKinds = ['arrow_function', 'function_expression', 'generator_function'];
const moduleBoundaries = new Set([
  ...callableKinds,
  'function_declaration',
  'generator_function_declaration',
  'class',
  'class_declaration',
  'method_definition',
  'internal_module',
  'module',
]);
const repeatedBindings = new WeakMap<SyntaxNode['tree'], ReadonlySet<string>>();

function moduleBindingScope(declaration: SyntaxNode): 'module' | 'block' | undefined {
  let block = false;
  for (let parent = declaration.parent; parent; parent = parent.parent) {
    if (moduleBoundaries.has(parent.type)) return undefined;
    if (parent.type === 'statement_block' || parent.type === 'switch_body') block = true;
  }
  return block ? 'block' : 'module';
}

/** A file-level block may declare a second callable with the same module-relative graph name. */
export function blockCallableIdentity(node: SyntaxNode, name: string): string | undefined {
  const declaration = node.parent;
  if (
    !declaration ||
    declaration.type !== 'variable_declarator' ||
    declaration.parent?.type !== 'lexical_declaration' ||
    moduleBindingScope(declaration) !== 'block'
  )
    return;
  const tree = node.tree;
  if (!tree) return;
  let repeated = repeatedBindings.get(tree);
  if (!repeated) {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const other of tree.rootNode.descendantsOfType([
      'variable_declarator',
      'function_declaration',
      'generator_function_declaration',
    ])) {
      if (
        other.type === 'variable_declarator' &&
        !callableKinds.includes(other.childForFieldName('value')?.type ?? '')
      )
        continue;
      const spelling = other.childForFieldName('name')?.text;
      if (!spelling || !moduleBindingScope(other)) continue;
      if (seen.has(spelling)) duplicates.add(spelling);
      else seen.add(spelling);
    }
    repeatedBindings.set(tree, duplicates);
    repeated = duplicates;
  }
  return repeated.has(name) ? positionQualifiedCallableName(name, node.startPosition) : undefined;
}

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
