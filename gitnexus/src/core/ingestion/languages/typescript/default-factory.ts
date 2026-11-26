import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { canonicalTypeScriptName } from './identifiers.js';

/** A direct return supplies the identity of the value exported by a local factory call. */
export function defaultFactoryResult(root: SyntaxNode): SyntaxNode | undefined {
  const statements = root.namedChildren;
  const expression = statements
    .find(
      (node) =>
        node.type === 'export_statement' && node.children.some((token) => token.type === 'default'),
    )
    ?.childForFieldName('value');
  if (expression?.type !== 'call_expression') return undefined;
  const callee = expression.childForFieldName('function');
  if (callee?.type !== 'identifier') return undefined;
  const name = canonicalTypeScriptName(callee.text);
  const declarations = statements
    .map((node) =>
      node.type === 'export_statement' ? node.childForFieldName('declaration') : node,
    )
    .filter(
      (node) =>
        node?.type === 'function_declaration' &&
        canonicalTypeScriptName(node.childForFieldName('name')?.text ?? '') === name,
    );
  const factory = declarations[0];
  if (
    declarations.length !== 1 ||
    !factory ||
    factory.children.some((token) => token.type === 'async')
  )
    return undefined;
  const body = factory
    .childForFieldName('body')
    ?.namedChildren.filter((node) => node.type !== 'comment');
  const returned =
    body?.length === 1 && body[0].type === 'return_statement' ? body[0].lastNamedChild : undefined;
  if (returned?.type !== 'arrow_function' && returned?.type !== 'function_expression')
    return undefined;
  const writes = root.descendantsOfType([
    'assignment_expression',
    'augmented_assignment_expression',
    'update_expression',
    'for_in_statement',
  ]);
  for (const write of writes) {
    const target = write.childForFieldName('left') ?? write.childForFieldName('argument');
    if (
      target &&
      [
        target,
        ...target.descendantsOfType(['identifier', 'shorthand_property_identifier_pattern']),
      ].some((part) => canonicalTypeScriptName(part.text) === name)
    )
      return undefined;
  }
  return returned;
}
