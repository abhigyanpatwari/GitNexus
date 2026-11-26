import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { canonicalTypeScriptName } from './identifiers.js';

/** A direct return supplies the identity of the value exported by a local factory call. */
export function defaultFactoryResult(
  root: SyntaxNode,
): { name: string; value: SyntaxNode; checkPriorWrites: boolean } | undefined {
  const statements = root.namedChildren;
  const exportIndex = statements.findIndex(
    (node) =>
      node.type === 'export_statement' && node.children.some((token) => token.type === 'default'),
  );
  const expression = statements[exportIndex]?.childForFieldName('value');
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
  // Hoisted function declarations cannot run their bodies before this export.
  // Any earlier executable statement could call code that reassigns the factory.
  const checkPriorWrites = statements.some((statement, index) => {
    // Static dependencies can run before the body, including through a cycle.
    if (
      statement.type === 'import_statement' ||
      (statement.type === 'export_statement' && statement.childForFieldName('source'))
    )
      return true;
    if (index >= exportIndex) return false;
    const decl =
      statement.type === 'export_statement'
        ? statement.childForFieldName('declaration')
        : statement;
    return (
      !decl ||
      ![
        'function_declaration',
        'generator_function_declaration',
        'comment',
        'interface_declaration',
        'type_alias_declaration',
        'ambient_declaration',
      ].includes(decl.type)
    );
  });
  return { name, value: returned, checkPriorWrites };
}
