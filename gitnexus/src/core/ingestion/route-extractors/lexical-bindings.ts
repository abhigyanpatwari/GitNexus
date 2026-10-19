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

/** Visit binding positions only: property keys and default RHSs are expressions. */
export function patternBindingNames(node: Node | null): Node[] {
  if (!node) return [];
  switch (node.type) {
    case 'identifier':
    case 'shorthand_property_identifier_pattern':
      return [node];
    case 'required_parameter':
    case 'optional_parameter':
      return patternBindingNames(node.childForFieldName('pattern'));
    case 'pair_pattern':
      return patternBindingNames(node.childForFieldName('value'));
    case 'assignment_pattern':
    case 'object_assignment_pattern':
      return patternBindingNames(node.childForFieldName('left'));
    case 'rest_pattern':
      return patternBindingNames(node.firstNamedChild);
    case 'object_pattern':
    case 'array_pattern':
    case 'formal_parameters':
      return node.namedChildren.flatMap(patternBindingNames);
    default:
      return [];
  }
}

interface FunctionEnvironment {
  readonly parameters: Node;
  readonly parameterNames: ReadonlySet<string>;
  readonly scopeId?: string;
  readonly declarations: Node[];
  containsExpression: boolean;
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
  const scopeAt = (node: Node) => {
    if (!nodeScopes.has(node.id))
      nodeScopes.set(
        node.id,
        positions.atPosition(
          parsedFile.filePath,
          node.startPosition.row + 1 + lineOffset,
          node.startPosition.column,
        ),
      );
    return nodeScopes.get(node.id);
  };
  const owners = new Map<number, Map<string, NameClaimResult | undefined>>();
  const ownership: LexicalBindings['ownership'] = (node, name = node.text, atUse = false) => {
    const key = `${atUse ? 'use' : 'owner'}\0${name}`;
    let cached = owners.get(node.id);
    if (cached?.has(key)) return cached.get(key);
    if (!cached) owners.set(node.id, (cached = new Map()));
    const position = {
      startLine: node.startPosition.row + 1 + lineOffset,
      startCol: node.startPosition.column,
    };
    const scope = scopeAt(node);
    const owner =
      scope === undefined
        ? undefined
        : lookupLexicalName(
            scope,
            name,
            { scopes },
            { purpose: 'value', ...(atUse ? { position } : {}) },
          );
    cached.set(key, owner);
    return owner;
  };
  const bindingId: LexicalBindings['bindingId'] = (node, name = node.text, atUse = false) => {
    const owner = ownership(node, name, atUse);
    // Imports and untyped parameters can have no BindingRef. A future claim or
    // explicit blocked claim is different: it remains a TDZ/availability barrier.
    if (
      atUse &&
      owner?.status === 'blocked' &&
      owner.claims.some(
        (claim) =>
          claim.kind === 'blocked' ||
          (claim.kind === 'binding' &&
            claim.availableFrom &&
            (claim.availableFrom.startLine > node.startPosition.row + 1 + lineOffset ||
              (claim.availableFrom.startLine === node.startPosition.row + 1 + lineOffset &&
                claim.availableFrom.startCol > node.startPosition.column))),
      )
    )
      return undefined;
    return owner?.scope ? `${owner.scope.id}\0${name}` : undefined;
  };

  const environments: FunctionEnvironment[] = [];
  const declarationNodes = new Set<number>();
  const references = new Map<string, number[]>();
  const visitPattern = (pattern: Node | null): Node[] => {
    const names = patternBindingNames(pattern);
    for (const name of names) declarationNodes.add(name.id);
    return names;
  };
  const pending: {
    node: Node;
    parent?: Node;
    body?: FunctionEnvironment;
    formals?: FunctionEnvironment;
    typeOnly?: boolean;
    inParameters?: boolean;
  }[] = [{ node: rootNode }];
  while (pending.length) {
    const { node, parent, body, formals, typeOnly, inParameters } = pending.pop()!;
    if (node.type === 'comment' || node.type === 'ERROR') continue;
    const isFunction = LEXICAL_FUNCTION_TYPES.has(node.type);
    let environment: FunctionEnvironment | undefined;
    if (isFunction) {
      const name = node.childForFieldName('name');
      if (name) {
        declarationNodes.add(name.id);
        if (node.type === 'function_declaration' || node.type === 'generator_function_declaration')
          body?.declarations.push(name);
      }
      const parameters =
        node.childForFieldName('parameters') ?? node.childForFieldName('parameter');
      if (parameters) {
        const names = visitPattern(parameters);
        const scopeId = scopeAt(parameters);
        let functionScope = scopeId === undefined ? undefined : scopes.getScope(scopeId);
        while (functionScope && functionScope.kind !== 'Function')
          functionScope =
            functionScope.parent === null ? undefined : scopes.getScope(functionScope.parent);
        environment = {
          parameters,
          parameterNames: new Set(names.map((name) => name.text)),
          scopeId: functionScope?.id,
          declarations: [],
          containsExpression: false,
        };
        environments.push(environment);
      }
    } else if (node.type === 'variable_declarator') {
      const names = visitPattern(node.childForFieldName('name'));
      if (parent?.type === 'variable_declaration') body?.declarations.push(...names);
    } else if (node.type === 'catch_clause') {
      visitPattern(node.childForFieldName('parameter'));
    } else if (node.type === 'for_in_statement' && node.childForFieldName('kind')) {
      const names = visitPattern(node.childForFieldName('left'));
      if (node.childForFieldName('kind')?.text === 'var') body?.declarations.push(...names);
    } else if (node.type === 'class' || node.type === 'class_declaration') {
      const name = node.childForFieldName('name');
      if (name) declarationNodes.add(name.id);
    }
    if (
      formals &&
      (node.type === 'assignment_pattern' ||
        node.type === 'object_assignment_pattern' ||
        node.type === 'computed_property_name' ||
        ((node.type === 'required_parameter' || node.type === 'optional_parameter') &&
          node.childForFieldName('value')))
    )
      formals.containsExpression = true;
    const inType =
      typeOnly || ['type_annotation', 'type_parameters', 'type_arguments'].includes(node.type);
    if (
      inParameters &&
      !inType &&
      !declarationNodes.has(node.id) &&
      (node.type === 'identifier' || node.type === 'shorthand_property_identifier')
    ) {
      const id = bindingId(node);
      if (id) {
        const existing = references.get(id);
        if (existing) existing.push(node.startIndex);
        else references.set(id, [node.startIndex]);
      }
    }
    const functionBody = isFunction ? node.childForFieldName('body') : null;
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      pending.push({
        node: child,
        parent: node,
        body: isFunction ? (child.id === functionBody?.id ? environment : undefined) : body,
        formals: isFunction
          ? child.id === environment?.parameters.id
            ? environment
            : undefined
          : formals,
        typeOnly: inType,
        inParameters: inParameters || child.id === environment?.parameters.id,
      });
    }
  }

  const ambiguous = new Set<string>();
  for (const environment of environments) {
    if (!environment.containsExpression) continue;
    for (const declaration of environment.declarations) {
      // A var in a class static block, or a block-owned function declaration,
      // does not share this function's collapsed variable environment.
      const owner = ownership(declaration);
      if (owner?.scope?.id !== environment.scopeId) continue;
      const name = declaration.text;
      const id = bindingId(declaration);
      if (!id) continue;
      const uses = references.get(id) ?? [];
      let lo = 0;
      let hi = uses.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (uses[mid] < environment.parameters.startIndex) lo = mid + 1;
        else hi = mid;
      }
      if (
        environment.parameterNames.has(name) ||
        (lo < uses.length && uses[lo] < environment.parameters.endIndex)
      ) {
        ambiguous.add(id);
      }
    }
  }
  return {
    ownership,
    bindingId,
    isGlobal: (node, name) => ownership(node, name)?.status === 'absent',
    ambiguous: (id) => ambiguous.has(id),
  };
}
