import type { Range } from 'gitnexus-shared';
import { synthesizeJavaTypeIdentity, type SyntaxNode } from '../../utils/ast-helpers.js';
import { synthesizeJavaRecordComponentAccessorCaptures } from './record-components.js';

/** Written types retain their declaration context; a caller's imports cannot
 * reinterpret a parameter declared in another file. These are capture facts,
 * not the receiver-oriented (container-unwrapped) TypeRef hints. */
export type JavaArgumentFact =
  | { readonly kind: 'typed'; readonly spelling: string; readonly at: Range }
  | { readonly kind: 'null' }
  | {
      readonly kind: 'factory';
      readonly owner: string;
      readonly name: 'asList' | 'singletonList';
      readonly arguments: readonly JavaArgumentFact[];
      readonly typeArguments: readonly string[];
      readonly at: Range;
      readonly shadowed: boolean;
    }
  | { readonly kind: 'unknown' };

export interface JavaOverloadTypeFact {
  readonly name: string;
  readonly simpleName: string;
  readonly kind: string;
  readonly range: Range;
  readonly visible: Range;
  readonly bases: readonly string[];
  readonly typeParameters: readonly string[];
  readonly modifiers?: readonly string[];
}

export interface JavaOverloadMethodFact {
  readonly name: string;
  readonly owner: string;
  readonly range: Range;
  readonly parameterTypes: readonly string[];
  readonly modifiers: readonly string[];
  readonly typeParameters: readonly string[];
}

export interface JavaOverloadCallFact {
  readonly name: string;
  readonly range: Range;
  readonly arguments: readonly JavaArgumentFact[];
  readonly receiver?: JavaArgumentFact;
  readonly receiverSpelling?: string;
  readonly receiverCall?: { readonly name: string; readonly range: Range };
  readonly receiverIsValue: boolean;
  readonly staticContext: boolean;
}

export interface JavaOverloadFileFacts {
  readonly version: 1;
  readonly packageName: string;
  readonly imports: readonly {
    readonly name: string;
    readonly wildcard: boolean;
    readonly static: boolean;
  }[];
  readonly types: readonly JavaOverloadTypeFact[];
  readonly methods: readonly JavaOverloadMethodFact[];
  readonly calls: readonly JavaOverloadCallFact[];
}

const files = new Map<string, JavaOverloadFileFacts>();
const callIndexes = new Map<string, ReadonlyMap<string, JavaOverloadCallFact>>();
const UNKNOWN: JavaArgumentFact = { kind: 'unknown' };
const typeNodes = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
]);
const callableNodes = new Set([
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
  'lambda_expression',
]);
const lexicalScopes = new Set([
  'block',
  'for_statement',
  'enhanced_for_statement',
  'catch_clause',
  'lambda_expression',
  'switch_block',
]);

export const javaOverloadRangeKey = (range: Range): string =>
  `${range.startLine}:${range.startCol}:${range.endLine}:${range.endCol}`;

export function setJavaOverloadFacts(
  filePath: string,
  facts: JavaOverloadFileFacts | undefined,
): void {
  if (facts === undefined) files.delete(filePath);
  else files.set(filePath, facts);
  callIndexes.delete(filePath);
}

export function clearJavaOverloadFacts(): void {
  files.clear();
  callIndexes.clear();
}

export function getJavaOverloadFacts(filePath: string): JavaOverloadFileFacts | undefined {
  return files.get(filePath);
}

export function getJavaOverloadCall(
  filePath: string,
  range: Range,
  name: string,
): JavaOverloadCallFact | undefined {
  let index = callIndexes.get(filePath);
  if (index === undefined) {
    const facts = files.get(filePath);
    if (facts === undefined) return undefined;
    index = new Map(
      facts.calls.map((call) => [`${javaOverloadRangeKey(call.range)}:${call.name}`, call]),
    );
    callIndexes.set(filePath, index);
  }
  return index.get(`${javaOverloadRangeKey(range)}:${name}`);
}

export function javaRangeContains(outer: Range, inner: Range): boolean {
  return (
    (outer.startLine < inner.startLine ||
      (outer.startLine === inner.startLine && outer.startCol <= inner.startCol)) &&
    (outer.endLine > inner.endLine ||
      (outer.endLine === inner.endLine && outer.endCol >= inner.endCol))
  );
}

function rangeOf(node: SyntaxNode): Range {
  return {
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column,
  };
}

function enclosing(
  node: SyntaxNode,
  predicate: (node: SyntaxNode) => boolean,
): SyntaxNode | undefined {
  let parent = node.parent;
  while (parent !== null) {
    if (predicate(parent)) return parent;
    parent = parent.parent;
  }
  return undefined;
}

function isType(node: SyntaxNode): boolean {
  return (
    typeNodes.has(node.type) ||
    ((node.type === 'object_creation_expression' || node.type === 'enum_constant') &&
      node.namedChildren.some((child) => child.type === 'class_body'))
  );
}

function typeIdentity(node: SyntaxNode): string | undefined {
  return synthesizeJavaTypeIdentity(node)?.name ?? node.childForFieldName('name')?.text;
}

function parameterTypes(node: SyntaxNode): string[] {
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
      parameter.childForFieldName('dimensions')?.text ??
      declarator?.childForFieldName('dimensions')?.text ??
      '';
    result.push(type === undefined || type === null ? '?' : type.text + dimensions);
    variadic ||= parameter.type === 'spread_parameter';
  }
  if (variadic) result.push('varargs');
  return result;
}

function typeParameters(node: SyntaxNode): string[] {
  const parameters = node.childForFieldName('type_parameters');
  return (
    parameters?.namedChildren.flatMap((parameter) => {
      const name = parameter.namedChildren.find((child) => child.type === 'type_identifier');
      return name === undefined ? [] : [name.text];
    }) ?? []
  );
}

function modifiers(node: SyntaxNode): string[] {
  return (
    node.namedChildren
      .find((child) => child.type === 'modifiers')
      ?.children.filter((child) => !child.isNamed)
      .map((child) => child.text) ?? []
  );
}

interface Binding {
  readonly name: string;
  readonly type?: string;
  readonly at: Range;
  readonly scope: Range;
  readonly depth: number;
  readonly available: number;
  readonly field: boolean;
  readonly owner?: SyntaxNode;
  readonly inheritable: boolean;
}

/** One AST walk records declarations and lexical bindings. Calls are evaluated
 * against those bindings after the walk, so fields are visible before their
 * declaration while local declarations retain their source-order boundary. */
export function captureJavaOverloadFacts(root: SyntaxNode): JavaOverloadFileFacts | undefined {
  const types: JavaOverloadTypeFact[] = [];
  const typeFactsByNode = new Map<number, JavaOverloadTypeFact>();
  const typeNodesByFact = new Map<JavaOverloadTypeFact, SyntaxNode>();
  const methods: JavaOverloadMethodFact[] = [];
  // Reuse the scope synthesizer's validated component names and explicit
  // accessor suppression so generated declarations have the same evidence as
  // source-written methods without creating a second accessor authority.
  const implicitAccessors = new Map(
    synthesizeJavaRecordComponentAccessorCaptures(root).flatMap((capture) => {
      const declaration = capture['@declaration.method'];
      const name = capture['@declaration.name'];
      return declaration === undefined || name === undefined
        ? []
        : [[javaOverloadRangeKey(declaration.range), name.text] as const];
    }),
  );
  const callNodes: SyntaxNode[] = [];
  const bindings = new Map<string, Binding[]>();
  const imports: { name: string; wildcard: boolean; static: boolean }[] = [];
  let packageName = '';
  const stack = [{ node: root, depth: 0 }];
  const addBinding = (
    name: string | undefined,
    type: string | undefined,
    node: SyntaxNode,
    scope: SyntaxNode,
    depth: number,
    available: number,
    field = false,
  ) => {
    if (name === undefined) return;
    const list = bindings.get(name) ?? [];
    list.push({
      name,
      type,
      at: rangeOf(node),
      scope: rangeOf(scope),
      depth,
      available,
      field,
      owner: enclosing(node, isType),
      inheritable: !field || node.parent === null || !modifiers(node.parent).includes('private'),
    });
    bindings.set(name, list);
  };
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (node.type === 'package_declaration') {
      packageName =
        node.namedChildren.find(
          (child) => child.type === 'scoped_identifier' || child.type === 'identifier',
        )?.text ?? '';
    } else if (node.type === 'import_declaration') {
      const name = node.namedChildren.find(
        (child) => child.type === 'scoped_identifier' || child.type === 'identifier',
      )?.text;
      if (name !== undefined)
        imports.push({
          name,
          wildcard: node.namedChildren.some((child) => child.type === 'asterisk'),
          static: node.children.some((child) => child.type === 'static'),
        });
    }
    if (isType(node)) {
      const identity = typeIdentity(node);
      const simpleName =
        node.type === 'enum_constant'
          ? identity
          : (node.childForFieldName('name')?.text ?? identity);
      if (identity !== undefined && simpleName !== undefined) {
        const visibilityScope =
          enclosing(
            node,
            (parent) => lexicalScopes.has(parent.type) || parent.type === 'class_body',
          ) ?? root;
        const visible = lexicalScopes.has(visibilityScope.type)
          ? {
              ...rangeOf(visibilityScope),
              startLine: node.startPosition.row + 1,
              startCol: node.startPosition.column,
            }
          : rangeOf(visibilityScope);
        const bases: string[] = [];
        for (const child of node.namedChildren) {
          if (child.type === 'superclass')
            bases.push(...child.namedChildren.map((part) => part.text));
          if (child.type === 'super_interfaces' || child.type === 'extends_interfaces') {
            const list = child.namedChildren.find((part) => part.type === 'type_list');
            bases.push(...(list?.namedChildren ?? child.namedChildren).map((part) => part.text));
          }
        }
        if (node.type === 'object_creation_expression') {
          const base = node.childForFieldName('type');
          if (base !== null) bases.push(base.text);
        } else if (node.type === 'enum_constant') {
          const host = enclosing(node, (parent) => parent.type === 'enum_declaration');
          const base = host?.childForFieldName('name');
          if (base !== undefined && base !== null) bases.push(base.text);
        }
        const flags = modifiers(node);
        if (
          (node.parent?.type === 'interface_body' ||
            node.parent?.type === 'annotation_type_body') &&
          !flags.some((flag) => ['public', 'protected', 'private'].includes(flag))
        )
          flags.push('public');
        const fact: JavaOverloadTypeFact = {
          name: identity,
          simpleName,
          kind: node.type,
          range: rangeOf(node),
          visible,
          bases,
          typeParameters: typeParameters(node),
          modifiers: flags,
        };
        types.push(fact);
        typeFactsByNode.set(node.id, fact);
        typeNodesByFact.set(fact, node);
      }
    }
    const implicitAccessor =
      node.type === 'formal_parameter' || node.type === 'spread_parameter'
        ? implicitAccessors.get(javaOverloadRangeKey(rangeOf(node)))
        : undefined;
    if (
      (callableNodes.has(node.type) && node.type !== 'lambda_expression') ||
      implicitAccessor !== undefined
    ) {
      const owner = enclosing(node, isType);
      const ownerIdentity = owner === undefined ? undefined : typeIdentity(owner);
      const name = implicitAccessor ?? node.childForFieldName('name')?.text;
      if (ownerIdentity !== undefined && name !== undefined) {
        const flags = implicitAccessor === undefined ? modifiers(node) : ['public'];
        if (
          owner?.type === 'interface_declaration' &&
          !flags.includes('private') &&
          !flags.includes('public')
        )
          flags.push('public');
        methods.push({
          name,
          owner: ownerIdentity,
          range: rangeOf(node),
          parameterTypes: implicitAccessor === undefined ? parameterTypes(node) : [],
          modifiers: flags,
          typeParameters: typeParameters(node),
        });
      }
    }
    if (node.type === 'method_invocation') callNodes.push(node);
    if (
      node.type === 'formal_parameter' ||
      node.type === 'spread_parameter' ||
      node.type === 'catch_formal_parameter'
    ) {
      const scope = enclosing(
        node,
        (parent) => callableNodes.has(parent.type) || parent.type === 'catch_clause',
      );
      const declarator = node.namedChildren.find((child) => child.type === 'variable_declarator');
      const name = node.childForFieldName('name') ?? declarator?.childForFieldName('name');
      const type =
        node.childForFieldName('type') ??
        node.namedChildren.find(
          (child) =>
            child.type !== 'modifiers' &&
            child.type !== 'variable_declarator' &&
            child.id !== name?.id,
        );
      const dimensions =
        node.childForFieldName('dimensions')?.text ??
        declarator?.childForFieldName('dimensions')?.text ??
        '';
      if (scope !== undefined)
        addBinding(
          name?.text,
          type === undefined || type === null
            ? undefined
            : type.text + dimensions + (node.type === 'spread_parameter' ? '[]' : ''),
          node,
          scope,
          depth,
          scope.startIndex,
        );
    } else if (
      node.type === 'variable_declarator' &&
      (node.parent?.type === 'field_declaration' ||
        node.parent?.type === 'constant_declaration' ||
        node.parent?.type === 'local_variable_declaration')
    ) {
      const declaration = node.parent;
      const field = declaration.type !== 'local_variable_declaration';
      const scope = enclosing(node, (parent) =>
        field
          ? ['class_body', 'interface_body', 'enum_body'].includes(parent.type)
          : lexicalScopes.has(parent.type),
      );
      const type = declaration.childForFieldName('type');
      const dimensions = node.childForFieldName('dimensions')?.text ?? '';
      if (scope !== undefined)
        addBinding(
          node.childForFieldName('name')?.text,
          type?.text === 'var'
            ? undefined
            : type?.text === undefined
              ? undefined
              : type.text + dimensions,
          node,
          scope,
          depth,
          field ? scope.startIndex : node.startIndex,
          field,
        );
    } else if (node.type === 'enhanced_for_statement') {
      const type = node.childForFieldName('type')?.text;
      const body = node.childForFieldName('body');
      if (body !== null)
        addBinding(
          node.childForFieldName('name')?.text,
          type === undefined
            ? undefined
            : type + (node.childForFieldName('dimensions')?.text ?? ''),
          node,
          body,
          depth + 1,
          body.startIndex,
        );
    } else if (node.type === 'lambda_expression') {
      const parameters = node.childForFieldName('parameters');
      if (parameters?.type === 'identifier')
        addBinding(parameters.text, undefined, parameters, node, depth + 1, node.startIndex);
      else if (parameters?.type === 'inferred_parameters') {
        for (const parameter of parameters.namedChildren)
          addBinding(parameter.text, undefined, parameter, node, depth + 1, node.startIndex);
      }
    }
    for (let i = node.namedChildren.length - 1; i >= 0; i--)
      stack.push({ node: node.namedChildren[i]!, depth: depth + 1 });
  }
  if (types.length === 0 && methods.length === 0 && callNodes.length === 0) return undefined;

  // Resolve only inheritance visible in this AST. A missing superclass or a
  // generic substitution is an uncertainty barrier, never permission to bind
  // an enclosing instance's same-named field instead (JLS 6.5.6.1, 8.3).
  // Include traversal depth so a cached shallow proof cannot bypass the bound
  // on a longer path. Caching unknown results also bounds repeated failures.
  const fieldLookupCache = new Map<string, readonly Binding[] | undefined>();
  const fieldsFor = (
    owner: SyntaxNode,
    name: string,
    inherited: boolean,
    seen = new Set<number>(),
  ): readonly Binding[] | undefined => {
    if (seen.has(owner.id) || seen.size >= 64) return undefined;
    const cacheKey = `${owner.id}:${name}:${inherited}:${seen.size}`;
    if (fieldLookupCache.has(cacheKey)) return fieldLookupCache.get(cacheKey);
    fieldLookupCache.set(cacheKey, undefined);
    seen.add(owner.id);
    const fact = typeFactsByNode.get(owner.id);
    if (fact === undefined) return undefined;
    const own = (bindings.get(name) ?? []).filter(
      (binding) => binding.field && binding.owner?.id === owner.id,
    );
    if (own.length > 0) {
      if (inherited && fact.typeParameters.length > 0) return undefined;
      const result = inherited ? own.filter((binding) => binding.inheritable) : own;
      fieldLookupCache.set(cacheKey, result);
      return result;
    }
    if (fact.kind !== 'class_declaration' && fact.kind !== 'interface_declaration')
      return undefined;
    const found = new Map<string, Binding>();
    for (const spelling of fact.bases) {
      let nameOfBase = spelling.split('<')[0]!.trim();
      if (packageName !== '' && nameOfBase.startsWith(`${packageName}.`))
        nameOfBase = nameOfBase.slice(packageName.length + 1);
      const visible = types.filter(
        (candidate) =>
          candidate.simpleName === nameOfBase && javaRangeContains(candidate.visible, fact.range),
      );
      let nearest: JavaOverloadTypeFact | undefined;
      for (const candidate of visible) {
        if (nearest === undefined || javaRangeContains(nearest.visible, candidate.visible))
          nearest = candidate;
      }
      if (nearest === undefined) {
        if (nameOfBase === 'java.lang.Object') continue;
        return undefined;
      }
      if (
        visible.some(
          (candidate) =>
            candidate !== nearest &&
            javaOverloadRangeKey(candidate.visible) === javaOverloadRangeKey(nearest!.visible),
        )
      )
        return undefined;
      const base = typeNodesByFact.get(nearest);
      const inheritedFields =
        base === undefined ? undefined : fieldsFor(base, name, true, new Set(seen));
      if (inheritedFields === undefined) return undefined;
      for (const binding of inheritedFields) found.set(javaOverloadRangeKey(binding.at), binding);
    }
    const result = [...found.values()];
    fieldLookupCache.set(cacheKey, result);
    return result;
  };
  const bindingAt = (name: string, node: SyntaxNode, fieldOnly = false): Binding | undefined => {
    const at = rangeOf(node);
    let owner = enclosing(node, isType);
    while (owner !== undefined) {
      if (!fieldOnly) {
        let local: Binding | undefined;
        for (const binding of bindings.get(name) ?? []) {
          if (
            binding.field ||
            binding.owner?.id !== owner.id ||
            binding.available > node.startIndex ||
            !javaRangeContains(binding.scope, at)
          )
            continue;
          if (
            local === undefined ||
            binding.depth > local.depth ||
            (binding.depth === local.depth && binding.available > local.available)
          )
            local = binding;
        }
        if (local !== undefined) return local;
      }
      const fields = fieldsFor(owner, name, false);
      if (fields === undefined || fields.length > 1) return undefined;
      if (fields.length === 1) return fields[0];
      if (fieldOnly || modifiers(owner).includes('static')) return undefined;
      owner = enclosing(owner, isType);
    }
    return undefined;
  };
  const expression = (node: SyntaxNode, depth = 0): JavaArgumentFact => {
    if (depth > 12) return UNKNOWN;
    const typed = (spelling: string, at = rangeOf(node)): JavaArgumentFact => ({
      kind: 'typed',
      spelling,
      at,
    });
    switch (node.type) {
      case 'decimal_integer_literal':
      case 'hex_integer_literal':
      case 'octal_integer_literal':
      case 'binary_integer_literal':
        return typed(/[lL]$/.test(node.text) ? 'long' : 'int');
      case 'decimal_floating_point_literal':
      case 'hex_floating_point_literal':
        return typed(/[fF]$/.test(node.text) ? 'float' : 'double');
      case 'string_literal':
        return typed('java.lang.String');
      case 'character_literal':
        return typed('char');
      case 'true':
      case 'false':
        return typed('boolean');
      case 'null_literal':
        return { kind: 'null' };
      case 'identifier': {
        const binding = bindingAt(node.text, node);
        return binding?.type === undefined ? UNKNOWN : typed(binding.type, binding.at);
      }
      case 'field_access': {
        if (node.childForFieldName('object')?.type !== 'this') return UNKNOWN;
        const name = node.childForFieldName('field')?.text;
        const binding = name === undefined ? undefined : bindingAt(name, node, true);
        return binding?.type === undefined ? UNKNOWN : typed(binding.type, binding.at);
      }
      case 'parenthesized_expression':
        return node.namedChildren[0] === undefined
          ? UNKNOWN
          : expression(node.namedChildren[0], depth + 1);
      case 'cast_expression':
      case 'object_creation_expression': {
        const type = node.childForFieldName('type');
        return type === null ? UNKNOWN : typed(type.text);
      }
      case 'array_creation_expression': {
        const type = node.childForFieldName('type');
        const dimensions =
          node.namedChildren.filter((child) => child.type === 'dimensions_expr').length +
          (node.namedChildren.find((child) => child.type === 'dimensions')?.text.match(/\[/g)
            ?.length ?? 0);
        return type === null || dimensions === 0
          ? UNKNOWN
          : typed(type.text + '[]'.repeat(dimensions));
      }
      case 'unary_expression': {
        const operand = node.childForFieldName('operand') ?? node.namedChildren[0];
        if (operand === undefined || operand === null) return UNKNOWN;
        const value = expression(operand, depth + 1);
        if (
          value.kind !== 'typed' ||
          !['byte', 'short', 'char', 'int', 'long', 'float', 'double', 'boolean'].includes(
            value.spelling,
          )
        )
          return UNKNOWN;
        return typed(['byte', 'short', 'char'].includes(value.spelling) ? 'int' : value.spelling);
      }
      case 'method_invocation': {
        const name = node.childForFieldName('name')?.text;
        const owner = node.childForFieldName('object');
        if ((name !== 'asList' && name !== 'singletonList') || owner === null) return UNKNOWN;
        const args =
          node
            .childForFieldName('arguments')
            ?.namedChildren.filter(
              (child) => child.type !== 'line_comment' && child.type !== 'block_comment',
            ) ?? [];
        const firstName = owner.text.split('.')[0]!;
        return {
          kind: 'factory',
          owner: owner.text,
          name,
          arguments: args.map((arg) => expression(arg, depth + 1)),
          typeArguments:
            node.childForFieldName('type_arguments')?.namedChildren.map((type) => type.text) ?? [],
          at: rangeOf(node),
          shadowed: bindingAt(firstName, owner) !== undefined,
        };
      }
      default:
        return UNKNOWN;
    }
  };
  const calls = callNodes.map((node): JavaOverloadCallFact => {
    const receiver = node.childForFieldName('object');
    let directReceiver = receiver;
    while (directReceiver?.type === 'parenthesized_expression')
      directReceiver = directReceiver.namedChildren[0] ?? null;
    const receiverName =
      directReceiver?.type === 'method_invocation'
        ? directReceiver.childForFieldName('name')?.text
        : undefined;
    const callable = enclosing(
      node,
      (parent) => callableNodes.has(parent.type) && parent.type !== 'lambda_expression',
    );
    return {
      name: node.childForFieldName('name')?.text ?? '',
      range: rangeOf(node),
      arguments: (node.childForFieldName('arguments')?.namedChildren ?? [])
        .filter((arg) => arg.type !== 'line_comment' && arg.type !== 'block_comment')
        .map((arg) => expression(arg)),
      ...(receiver === null
        ? {}
        : { receiver: expression(receiver), receiverSpelling: receiver.text }),
      ...(receiverName === undefined || directReceiver === null
        ? {}
        : { receiverCall: { name: receiverName, range: rangeOf(directReceiver) } }),
      receiverIsValue:
        receiver !== null &&
        (receiver.type !== 'identifier' || bindingAt(receiver.text, receiver) !== undefined),
      staticContext: callable !== undefined && modifiers(callable).includes('static'),
    };
  });
  return { version: 1, packageName, imports, types, methods, calls };
}

/** Side-channel revival is fail-closed: malformed data never revives stale
 * facts from a preceding file generation in a long-lived process. */
export function isJavaOverloadFileFacts(value: unknown): value is JavaOverloadFileFacts {
  if (value === null || typeof value !== 'object') return false;
  const facts = value as JavaOverloadFileFacts;
  const range = (r: Range): boolean =>
    r !== null &&
    typeof r === 'object' &&
    [r.startLine, r.startCol, r.endLine, r.endCol].every(Number.isSafeInteger);
  const strings = (items: readonly string[]): boolean =>
    Array.isArray(items) && items.every((item) => typeof item === 'string');
  const argument = (arg: JavaArgumentFact, depth = 0): boolean => {
    if (depth > 12 || arg === null || typeof arg !== 'object') return false;
    if (arg.kind === 'null' || arg.kind === 'unknown') return true;
    if (arg.kind === 'typed') return typeof arg.spelling === 'string' && range(arg.at);
    return (
      arg.kind === 'factory' &&
      typeof arg.owner === 'string' &&
      ['asList', 'singletonList'].includes(arg.name) &&
      typeof arg.shadowed === 'boolean' &&
      range(arg.at) &&
      strings(arg.typeArguments) &&
      Array.isArray(arg.arguments) &&
      arg.arguments.every((item) => argument(item, depth + 1))
    );
  };
  return (
    facts.version === 1 &&
    typeof facts.packageName === 'string' &&
    Array.isArray(facts.imports) &&
    facts.imports.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof item.name === 'string' &&
        typeof item.wildcard === 'boolean' &&
        typeof item.static === 'boolean',
    ) &&
    Array.isArray(facts.types) &&
    facts.types.every(
      (type) =>
        type !== null &&
        typeof type === 'object' &&
        typeof type.name === 'string' &&
        typeof type.simpleName === 'string' &&
        typeof type.kind === 'string' &&
        range(type.range) &&
        range(type.visible) &&
        strings(type.bases) &&
        strings(type.typeParameters) &&
        (type.modifiers === undefined || strings(type.modifiers)),
    ) &&
    Array.isArray(facts.methods) &&
    facts.methods.every(
      (method) =>
        method !== null &&
        typeof method === 'object' &&
        typeof method.name === 'string' &&
        typeof method.owner === 'string' &&
        range(method.range) &&
        strings(method.parameterTypes) &&
        strings(method.modifiers) &&
        strings(method.typeParameters),
    ) &&
    Array.isArray(facts.calls) &&
    facts.calls.every(
      (call) =>
        call !== null &&
        typeof call === 'object' &&
        typeof call.name === 'string' &&
        range(call.range) &&
        typeof call.receiverIsValue === 'boolean' &&
        typeof call.staticContext === 'boolean' &&
        Array.isArray(call.arguments) &&
        call.arguments.every((arg) => argument(arg)) &&
        (call.receiver === undefined || argument(call.receiver)) &&
        (call.receiverSpelling === undefined || typeof call.receiverSpelling === 'string') &&
        (call.receiverCall === undefined ||
          (call.receiverCall !== null &&
            typeof call.receiverCall === 'object' &&
            typeof call.receiverCall.name === 'string' &&
            range(call.receiverCall.range))),
    )
  );
}
