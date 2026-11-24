import type { MethodInfo } from '../../method-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { javaTypeText } from './type-spelling.js';

export function parameterTypes(
  node: SyntaxNode,
  spell: (type: SyntaxNode) => string = (type) => type.text,
): string[] {
  const parameters = node.childForFieldName('parameters')?.namedChildren ?? [];
  const result: string[] = [];
  let variadic = false;
  for (const parameter of parameters) {
    if (!['formal_parameter', 'spread_parameter'].includes(parameter.type)) continue;
    const declarator = parameter.namedChildren.find(
      (child) => child.type === 'variable_declarator',
    );
    const name = parameter.childForFieldName('name') ?? declarator?.childForFieldName('name');
    const type =
      parameter.childForFieldName('type') ??
      parameter.namedChildren.find(
        (child) =>
          child.type !== 'modifiers' &&
          child.type !== 'variable_declarator' &&
          child.id !== name?.id,
      );
    const dimensions =
      parameter.childForFieldName('dimensions') ?? declarator?.childForFieldName('dimensions');
    const brackets = dimensions ? spell(dimensions) : '';
    result.push(type ? spell(type) + brackets : '?');
    variadic ||= parameter.type === 'spread_parameter';
  }
  if (variadic) result.push('varargs');
  return result;
}

const callableKinds = new Set([
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
]);
const suffixesByTree = new WeakMap<SyntaxNode['tree'], Map<number, Map<number, string>>>();

/** Variadic invocation arity is open, so all variadics with the same name
 * normally share an unsuffixed graph ID. Only split actual collisions. */
function buildJavaVariadicGraphIds(body: SyntaxNode): Map<number, string> {
  const groups = new Map<string, { id: number; signatureSource: SyntaxNode }[]>();
  for (const declaration of body.namedChildren) {
    if (!callableKinds.has(declaration.type)) continue;
    const signatureSource =
      declaration.type === 'compact_constructor_declaration'
        ? (body.parent ?? declaration)
        : declaration;
    const parameters = signatureSource.childForFieldName('parameters');
    if (!parameters?.namedChildren.some((parameter) => parameter.type === 'spread_parameter'))
      continue;
    const kind = declaration.type === 'method_declaration' ? 'Method' : 'Constructor';
    const key = kind + ':' + declaration.childForFieldName('name')?.text;
    const group = groups.get(key) ?? [];
    group.push({ id: declaration.id, signatureSource });
    groups.set(key, group);
  }
  const suffixes = new Map<number, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const { id, signatureSource } of group) {
      const signature = parameterTypes(signatureSource, javaTypeText).slice(0, -1); // drop the varargs marker
      suffixes.set(id, `#${signature.length}~${signature.join(',')}...`);
    }
  }
  return suffixes;
}

export function addJavaVariadicGraphIds(ownerOrDeclaration: SyntaxNode, method: MethodInfo): void {
  if (!method.parameters.at(-1)?.isVariadic) return;
  const start = { row: method.line - 1, column: method.column };
  let declaration: SyntaxNode | null = callableKinds.has(ownerOrDeclaration.type)
    ? ownerOrDeclaration
    : ownerOrDeclaration.namedDescendantForPosition(start);
  while (declaration && !callableKinds.has(declaration.type)) declaration = declaration.parent;
  const body = declaration?.parent;
  if (!body || !declaration) return;
  let bodies = suffixesByTree.get(body.tree);
  if (!bodies) {
    bodies = new Map();
    suffixesByTree.set(body.tree, bodies);
  }
  let suffixes = bodies.get(body.id);
  if (!suffixes) {
    suffixes = buildJavaVariadicGraphIds(body);
    bodies.set(body.id, suffixes);
  }
  const suffix = suffixes.get(declaration.id);
  if (suffix !== undefined) method.graphIdSuffix = suffix;
}
