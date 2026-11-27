import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { positionQualifiedCallableName } from '../../workers/callable-id.js';
import { ARRAY_METHOD_HOC_BLOCKLIST_SET, isRegistrationHandle } from '../../ts-js-hoc-utils.js';

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

/** Mirror the callable initializers captured by the JS and TS definition queries. */
function callableInitializer(declaration: SyntaxNode): SyntaxNode | undefined {
  const value = declaration.childForFieldName('value');
  if (!value) return undefined;
  if (callableKinds.includes(value.type)) return value;
  if (value.type !== 'call_expression' || isRegistrationHandle(declaration)) return undefined;
  const callee = value.childForFieldName('function');
  if (callee?.type !== 'identifier') {
    const property = callee?.childForFieldName('property');
    if (
      callee?.type !== 'member_expression' ||
      property?.type !== 'property_identifier' ||
      ARRAY_METHOD_HOC_BLOCKLIST_SET.has(property.text)
    )
      return undefined;
  }
  return value
    .childForFieldName('arguments')
    ?.namedChildren.find(
      (arg) => arg.type === 'arrow_function' || arg.type === 'function_expression',
    );
}

function moduleBindingScope(declaration: SyntaxNode): 'module' | 'block' | undefined {
  // A let/const initializer belongs to the for loop, outside its body block.
  let block =
    declaration.parent?.type === 'lexical_declaration' &&
    declaration.parent.parent?.type === 'for_statement';
  for (let parent = declaration.parent; parent; parent = parent.parent) {
    if (moduleBoundaries.has(parent.type)) return undefined;
    if (parent.type === 'statement_block' || parent.type === 'switch_body') block = true;
  }
  return block ? 'block' : 'module';
}

/** A file-level block may declare a second callable with the same module-relative graph name. */
export function blockCallableIdentity(declaration: SyntaxNode, name: string): string | undefined {
  if (
    declaration.type !== 'variable_declarator' ||
    declaration.parent?.type !== 'lexical_declaration' ||
    moduleBindingScope(declaration) !== 'block'
  )
    return;
  const tree = declaration.tree;
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
      if (other.type === 'variable_declarator' && !callableInitializer(other)) continue;
      const spelling = other.childForFieldName('name')?.text;
      if (!spelling || !moduleBindingScope(other)) continue;
      if (seen.has(spelling)) duplicates.add(spelling);
      else seen.add(spelling);
    }
    repeatedBindings.set(tree, duplicates);
    repeated = duplicates;
  }
  if (!repeated.has(name)) return undefined;
  // One lexical binding has one identity even when a wrapper takes multiple callbacks.
  const initializer = callableInitializer(declaration);
  return initializer && positionQualifiedCallableName(name, initializer.startPosition);
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
