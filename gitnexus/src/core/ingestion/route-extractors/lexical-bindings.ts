import type Parser from 'tree-sitter';
import { buildPositionIndex, buildScopeTree, lookupLexicalName } from 'gitnexus-shared';
import type { NameClaimResult, ParsedFile } from 'gitnexus-shared';

type Node = Parser.SyntaxNode;
export interface LexicalBindings {
  ownership(node: Node, name?: string, atUse?: boolean): NameClaimResult | undefined;
  bindingId(node: Node, name?: string, atUse?: boolean): string | undefined;
  isGlobal(node: Node, name: string): boolean;
  ambiguous(bindingId: string): boolean;
}

/** Callable boundaries, including methods that can contain their own var declarations. */
export const LEXICAL_FUNCTION_TYPES: ReadonlySet<string> = new Set([
  'arrow_function',
  'function_expression',
  'function_declaration',
  'generator_function',
  'generator_function_declaration',
  'method_definition',
  'function_signature',
  'method_signature',
  'abstract_method_signature',
]);

/** Expressions that wrap a value or an assignment target without changing it. */
export const TRANSPARENT_EXPRESSION_TYPES: ReadonlySet<string> = new Set([
  'parenthesized_expression',
  'as_expression',
  'satisfies_expression',
  'non_null_expression',
]);

/** Lexical binding identity: the declaring scope and the declared name. */
export const bindingKey = (scopeId: string, name: string): string => `${scopeId}\0${name}`;

/** The pattern a formal parameter declares, without its type or default value. */
export function parameterPattern(node: Node | null): Node | null {
  if (node?.type === 'required_parameter' || node?.type === 'optional_parameter')
    node = node.childForFieldName('pattern');
  if (node?.type === 'assignment_pattern') node = node.childForFieldName('left');
  return node;
}

/** Visit binding positions only: property keys and default RHSs are expressions. */
export function patternBindingNames(root: Node | null): Node[] {
  const names: Node[] = [];
  const stack = root ? [root] : [];
  while (stack.length > 0) {
    const node = stack.pop()!;
    let next: readonly (Node | null)[] = [];
    if (TRANSPARENT_EXPRESSION_TYPES.has(node.type))
      // Assignment targets may be wrapped: `(app) = x`, `(app as T) = x`, `app! = x`.
      next = [node.namedChildren.find((child) => child.type !== 'comment') ?? null];
    else
      switch (node.type) {
        case 'identifier':
        case 'shorthand_property_identifier_pattern':
          names.push(node);
          break;
        case 'required_parameter':
        case 'optional_parameter':
          next = [node.childForFieldName('pattern')];
          break;
        case 'pair_pattern':
          next = [node.childForFieldName('value')];
          break;
        case 'assignment_pattern':
        case 'object_assignment_pattern':
          next = [node.childForFieldName('left')];
          break;
        case 'rest_pattern':
          next = [node.firstNamedChild];
          break;
        case 'object_pattern':
        case 'array_pattern':
        case 'formal_parameters':
          next = node.namedChildren;
          break;
      }
    // Reverse pushes keep source order.
    for (let i = next.length - 1; i >= 0; i--) {
      const child = next[i];
      if (child) stack.push(child);
    }
  }
  return names;
}

const TYPE_SUBTREES: ReadonlySet<string> = new Set([
  'type_annotation',
  'type_parameters',
  'type_arguments',
]);

/** Whether formals contain a default value or computed key (ECMAScript ContainsExpression). */
function containsParameterExpression(parameters: Node): boolean {
  // Plain identifier parameters, the common case, need no subtree search.
  if (parameters.type === 'identifier') return false;
  const plain = parameters.namedChildren.every(
    (parameter) =>
      parameter.type === 'comment' ||
      parameter.type === 'identifier' ||
      ((parameter.type === 'required_parameter' || parameter.type === 'optional_parameter') &&
        parameter.childForFieldName('value') === null &&
        ['identifier', 'this'].includes(parameter.childForFieldName('pattern')?.type ?? '')),
  );
  if (plain) return false;
  return (
    parameters.descendantsOfType([
      'assignment_pattern',
      'object_assignment_pattern',
      'computed_property_name',
    ]).length > 0 ||
    parameters
      .descendantsOfType(['required_parameter', 'optional_parameter'])
      .some((parameter) => parameter.childForFieldName('value') !== null)
  );
}

/** `var` and function declarations of one function body, excluding nested callables. */
function bodyDeclarations(body: Node | null): Node[] {
  const declarations: Node[] = [];
  const pending = body ? [body] : [];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type === 'comment' || node.type === 'ERROR') continue;
    if (LEXICAL_FUNCTION_TYPES.has(node.type)) {
      const name = node.childForFieldName('name');
      if (
        name &&
        (node.type === 'function_declaration' || node.type === 'generator_function_declaration')
      )
        declarations.push(name);
      continue;
    }
    if (node.type === 'variable_declaration') {
      for (const declarator of node.namedChildren)
        if (declarator.type === 'variable_declarator')
          declarations.push(...patternBindingNames(declarator.childForFieldName('name')));
    } else if (node.type === 'for_in_statement' && node.childForFieldName('kind')?.text === 'var')
      declarations.push(...patternBindingNames(node.childForFieldName('left')));
    for (const child of node.namedChildren) pending.push(child);
  }
  return declarations;
}

/**
 * Per-file lexical identity shared by HTTP analyses. ParsedFile owns declarations;
 * the AST only identifies the parameter/body environment collapse it cannot model.
 */
export function createLexicalBindings(
  parsedFile: ParsedFile,
  lineOffset: number,
  rootNode: Node,
): LexicalBindings {
  const scopes = buildScopeTree(parsedFile.scopes);
  const positions = buildPositionIndex(parsedFile.scopes);
  const nodeScopes = new Map<number, ReturnType<typeof positions.atPosition>>();
  // Native node getters are costly; each lookup reads `id` and `startPosition` once.
  const scopeAt = (node: Node, id = node.id, start = node.startPosition) => {
    if (nodeScopes.has(id)) return nodeScopes.get(id);
    const scope = positions.atPosition(
      parsedFile.filePath,
      start.row + 1 + lineOffset,
      start.column,
    );
    nodeScopes.set(id, scope);
    return scope;
  };
  const owners = new Map<number, Map<string, NameClaimResult | undefined>>();
  const ownership: LexicalBindings['ownership'] = (node, name = node.text, atUse = false) => {
    const id = node.id;
    const key = `${atUse ? 'use' : 'owner'}\0${name}`;
    let cached = owners.get(id);
    if (cached?.has(key)) return cached.get(key);
    if (!cached) owners.set(id, (cached = new Map()));
    const start = node.startPosition;
    const scope = scopeAt(node, id, start);
    const owner =
      scope === undefined
        ? undefined
        : lookupLexicalName(
            scope,
            name,
            { scopes },
            atUse
              ? {
                  purpose: 'value',
                  position: { startLine: start.row + 1 + lineOffset, startCol: start.column },
                }
              : { purpose: 'value' },
          );
    cached.set(key, owner);
    return owner;
  };
  // A future claim or an explicit blocked claim is a TDZ/availability barrier.
  const blockedBefore = (claims: NameClaimResult['claims'], start: Parser.Point) =>
    claims.some(
      (claim) =>
        claim.kind === 'blocked' ||
        (claim.kind === 'binding' &&
          claim.availableFrom &&
          (claim.availableFrom.startLine > start.row + 1 + lineOffset ||
            (claim.availableFrom.startLine === start.row + 1 + lineOffset &&
              claim.availableFrom.startCol > start.column))),
    );
  const bindingId: LexicalBindings['bindingId'] = (node, name = node.text, atUse = false) => {
    const owner = ownership(node, name, atUse);
    // Imports and untyped parameters can have no BindingRef. A future claim or
    // explicit blocked claim is different: it remains a TDZ/availability barrier.
    if (atUse && owner?.status === 'blocked' && blockedBefore(owner.claims, node.startPosition))
      return undefined;
    return owner?.scope ? bindingKey(owner.scope.id, name) : undefined;
  };

  // Parameter defaults or computed keys give the body its own variable
  // environment, which the ParsedFile collapses into one function scope. Most
  // functions have neither, so a native type search finds the few that do and
  // only their formals and bodies are walked.
  const ambiguous = new Set<string>();
  for (const fn of rootNode.descendantsOfType([...LEXICAL_FUNCTION_TYPES])) {
    const parameters = fn.childForFieldName('parameters') ?? fn.childForFieldName('parameter');
    if (!parameters || !containsParameterExpression(parameters)) continue;
    let functionScope = scopes.getScope(scopeAt(parameters) ?? '');
    while (functionScope && functionScope.kind !== 'Function')
      functionScope =
        functionScope.parent === null ? undefined : scopes.getScope(functionScope.parent);
    const parameterNames = new Set(patternBindingNames(parameters).map((name) => name.text));
    const uses = new Set<string>();
    const formals = [parameters];
    while (formals.length > 0) {
      const node = formals.pop()!;
      if (node.type === 'comment' || node.type === 'ERROR' || TYPE_SUBTREES.has(node.type))
        continue;
      if (node.type === 'identifier' || node.type === 'shorthand_property_identifier') {
        const id = bindingId(node);
        if (id) uses.add(id);
      }
      for (const child of node.namedChildren) formals.push(child);
    }
    for (const declaration of bodyDeclarations(fn.childForFieldName('body'))) {
      // A var in a class static block, or a block-owned function declaration,
      // does not share this function's collapsed variable environment.
      if (ownership(declaration)?.scope?.id !== functionScope?.id) continue;
      const id = bindingId(declaration);
      if (id && (parameterNames.has(declaration.text) || uses.has(id))) ambiguous.add(id);
    }
  }
  return {
    ownership,
    bindingId,
    isGlobal: (node, name) => ownership(node, name)?.status === 'absent',
    ambiguous: (id) => ambiguous.has(id),
  };
}
