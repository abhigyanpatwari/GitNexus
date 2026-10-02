import type Parser from 'tree-sitter';
import type { SyntaxNode } from 'tree-sitter';
import type { ExtractedToolDef } from '../../workers/parse-worker.js';
import { plainString, propertyName } from '../../route-extractors/data-route-table.js';

interface Scope {
  parent?: Scope;
  functionScope: boolean;
  bindings: Map<string, Binding>;
}

interface Binding {
  name: SyntaxNode;
  scope: Scope;
  kind: 'unknown' | 'sdk' | 'variable' | 'parameter' | 'function';
  value?: SyntaxNode;
  type?: SyntaxNode;
  typeOnly?: boolean;
  immutable?: boolean;
  invalid?: boolean;
}

const FUNCTIONS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'arrow_function',
  'method_definition',
]);
const BLOCKS = new Set([
  'statement_block',
  'for_statement',
  'for_in_statement',
  'switch_body',
  'catch_clause',
  'class_body',
]);
const SDK_MODULES = new Set([
  '@modelcontextprotocol/sdk/server/mcp.js',
  '@modelcontextprotocol/sdk/server/mcp',
]);

function lookup(scope: Scope, name: string): Binding | undefined {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding) return binding;
  }
}

/** Only binding/assignment patterns: never descend into keys, types or defaults. */
function patternNames(pattern: SyntaxNode): SyntaxNode[] {
  const names: SyntaxNode[] = [];
  const pending = [pattern];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') {
      names.push(node);
    } else if (node.type === 'pair_pattern') {
      const value = node.childForFieldName('value');
      if (value) pending.push(value);
    } else if (node.type === 'assignment_pattern' || node.type === 'object_assignment_pattern') {
      const left = node.childForFieldName('left');
      if (left) pending.push(left);
    } else if (
      node.type === 'array_pattern' ||
      node.type === 'object_pattern' ||
      node.type === 'rest_pattern'
    ) {
      pending.push(...node.namedChildren);
    }
  }
  return names;
}

function declare(scope: Scope, name: SyntaxNode, details: Partial<Binding> = {}): void {
  const previous = scope.bindings.get(name.text);
  if (previous) {
    previous.invalid = true;
  } else {
    scope.bindings.set(name.text, { name, scope, kind: 'unknown', ...details });
  }
}

function variableScope(scope: Scope): Scope {
  while (!scope.functionScope && scope.parent) scope = scope.parent;
  return scope;
}

function collectBindings(root: SyntaxNode) {
  const moduleScope: Scope = { functionScope: true, bindings: new Map() };
  const scopes = new Map<number, Scope>();
  const calls: SyntaxNode[] = [];
  const writes: SyntaxNode[] = [];
  const pending = [{ node: root, scope: moduleScope }];
  while (pending.length) {
    const entry = pending.pop()!;
    const node = entry.node;
    let scope = entry.scope;
    const isFunction = FUNCTIONS.has(node.type);
    const name = node.childForFieldName('name');
    if (node.type === 'function_declaration' || node.type === 'generator_function_declaration') {
      if (name) declare(scope, name, { kind: 'function', value: node, immutable: true });
    } else if (
      [
        'class_declaration',
        'interface_declaration',
        'type_alias_declaration',
        'enum_declaration',
      ].includes(node.type)
    ) {
      if (name) declare(scope, name);
    }
    if (
      isFunction ||
      BLOCKS.has(node.type) ||
      node.type === 'class' ||
      node.type === 'class_declaration'
    ) {
      scope = { parent: scope, functionScope: isFunction, bindings: new Map() };
    }
    scopes.set(node.id, scope);

    if (node.type === 'class' && name) declare(scope, name);

    if (isFunction) {
      if (name && (node.type === 'function_expression' || node.type === 'generator_function')) {
        declare(scope, name, { kind: 'function', value: node, immutable: true });
      }
      const parameters = node.childForFieldName('parameters');
      const single = node.childForFieldName('parameter');
      for (const parameter of parameters?.namedChildren ?? (single ? [single] : [])) {
        const pattern = parameter.childForFieldName('pattern') ?? parameter;
        const type = parameter.childForFieldName('type')?.namedChildren[0];
        for (const bindingName of patternNames(pattern)) {
          declare(scope, bindingName, {
            kind: 'parameter',
            ...(pattern.type === 'identifier' && type ? { type } : {}),
          });
        }
      }
    } else if (node.type === 'import_statement') {
      const source = node.childForFieldName('source');
      const sdk = source !== null && SDK_MODULES.has(plainString(source) ?? '');
      const typeOnly = node.children.some((child) => child.type === 'type');
      const clause = node.namedChildren.find((child) => child.type === 'import_clause');
      for (const child of clause?.namedChildren ?? []) {
        if (child.type === 'identifier') declare(scope, child);
        else if (child.type === 'namespace_import') {
          const local = child.namedChildren[0];
          if (local) declare(scope, local);
        } else if (child.type === 'named_imports') {
          for (const specifier of child.namedChildren) {
            const imported = specifier.childForFieldName('name');
            const local = specifier.childForFieldName('alias') ?? imported;
            if (local)
              declare(scope, local, {
                kind: sdk && imported?.text === 'McpServer' ? 'sdk' : 'unknown',
                typeOnly: typeOnly || specifier.children.some((part) => part.type === 'type'),
              });
          }
        }
      }
    } else if (node.type === 'variable_declarator') {
      if (name) {
        const target = node.parent?.type === 'variable_declaration' ? variableScope(scope) : scope;
        for (const bindingName of patternNames(name)) {
          declare(target, bindingName, {
            kind: 'variable',
            immutable: node.parent?.childForFieldName('kind')?.type === 'const',
            ...(name.type === 'identifier'
              ? { value: node.childForFieldName('value') ?? undefined }
              : {}),
          });
        }
      }
    } else if (node.type === 'catch_clause') {
      const parameter = node.childForFieldName('parameter');
      if (parameter) for (const bindingName of patternNames(parameter)) declare(scope, bindingName);
    } else if (node.type === 'for_in_statement') {
      const left = node.childForFieldName('left');
      const kind = node.childForFieldName('kind');
      if (left && kind) {
        const target = kind.type === 'var' ? variableScope(scope) : scope;
        for (const bindingName of patternNames(left)) declare(target, bindingName);
      } else if (left) writes.push(left);
    } else if (node.type === 'type_parameter') {
      if (name) declare(scope, name);
    }
    if (node.type === 'call_expression') calls.push(node);
    if (node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression') {
      const left = node.childForFieldName('left');
      if (left) writes.push(left);
    } else if (
      node.type === 'update_expression' ||
      (node.type === 'unary_expression' && node.children.some((child) => child.type === 'delete'))
    ) {
      const argument = node.childForFieldName('argument');
      if (argument) writes.push(argument);
    }
    for (let index = node.namedChildCount - 1; index >= 0; index--) {
      pending.push({ node: node.namedChild(index)!, scope });
    }
  }
  // Resolve writes after declarations so later declarations also shadow outer names.
  for (let target of writes) {
    const scope = scopes.get(target.id)!;
    const members: Array<string | null> = [];
    while (target.type === 'member_expression' || target.type === 'subscript_expression') {
      const object = target.childForFieldName('object');
      if (!object) break;
      const property = target.childForFieldName('property');
      const index = target.childForFieldName('index');
      members.push(property ? propertyName(property) : index ? plainString(index) : null);
      target = object;
    }
    for (const name of patternNames(target)) {
      const binding = lookup(scope, name.text);
      // Lifecycle callbacks and other known properties do not replace the receiver
      // or its registration methods. Unknown keys and constructor mutations remain unsafe.
      if (
        binding?.kind !== 'sdk' &&
        members.length > 0 &&
        members.every((member) => member !== null) &&
        !['tool', 'registerTool', '__proto__'].includes(members[members.length - 1]!)
      )
        continue;
      if (binding) binding.invalid = true;
    }
  }
  return { scopes, calls };
}

function sdkBinding(node: SyntaxNode, scope: Scope, forType = false): boolean {
  if (node.type !== 'identifier' && node.type !== 'type_identifier') return false;
  const binding = lookup(scope, node.text);
  return binding?.kind === 'sdk' && !binding.invalid && (forType || !binding.typeOnly);
}

function sdkReceiver(node: SyntaxNode, scope: Scope, scopes: ReadonlyMap<number, Scope>): boolean {
  if (node.type !== 'identifier') return false;
  const binding = lookup(scope, node.text);
  if (!binding || binding.invalid) return false;
  if (binding.kind === 'parameter' && binding.type) {
    return sdkBinding(binding.type, binding.scope, true);
  }
  const value = binding.value;
  if (binding.kind !== 'variable' || value?.type !== 'new_expression') return false;
  if (value.endIndex > node.startIndex && variableScope(binding.scope) === variableScope(scope))
    return false;
  const constructor = value.childForFieldName('constructor');
  return constructor !== null && sdkBinding(constructor, scopes.get(value.id)!);
}

/** An unknown later property can replace description; a later explicit property restores proof. */
function descriptionFromConfig(config: SyntaxNode): string {
  let description = '';
  if (config.type !== 'object') return description;
  for (const child of config.namedChildren) {
    if (child.type === 'comment') continue;
    const key = child.childForFieldName('key') ?? child.childForFieldName('name');
    const name =
      child.type === 'shorthand_property_identifier' ? child.text : key && propertyName(key);
    if (child.type === 'pair' && name === 'description') {
      const value = child.childForFieldName('value');
      description = value ? (plainString(value) ?? '') : '';
    } else if (!name || name === 'description') {
      description = '';
    }
  }
  return description;
}

function handlerNodeId(
  node: SyntaxNode,
  scope: Scope,
  callableBindings: ReadonlyMap<number, string> | undefined,
): string | undefined {
  if (node.type !== 'identifier') return undefined;
  const binding = lookup(scope, node.text);
  if (!binding || binding.invalid) return undefined;
  if (binding.kind === 'variable') {
    const value = binding.value;
    if (
      !binding.immutable ||
      !value ||
      (value.type !== 'arrow_function' && value.type !== 'function_expression')
    )
      return undefined;
    if (value.endIndex > node.startIndex && variableScope(binding.scope) === variableScope(scope))
      return undefined;
  } else if (binding.kind !== 'function') return undefined;
  return callableBindings?.get(binding.name.id);
}

/** Direct SDK registrations only; no wrapper, alias-chain or runtime-value inference. */
export function extractToolDefinitions(
  tree: Parser.Tree,
  filePath: string,
  lineOffset = 0,
  callableBindings?: ReadonlyMap<number, string>,
): ExtractedToolDef[] {
  // Ordinary files need no lexical walk; every supported receiver originates here.
  const importsSdk = tree.rootNode.namedChildren.some((node) => {
    if (node.type !== 'import_statement') return false;
    const source = node.childForFieldName('source');
    return source !== null && SDK_MODULES.has(plainString(source) ?? '');
  });
  if (!importsSdk) return [];

  const { scopes, calls } = collectBindings(tree.rootNode);
  const definitions: ExtractedToolDef[] = [];
  for (const call of calls) {
    const callee = call.childForFieldName('function');
    if (call.hasError || callee?.type !== 'member_expression') continue;
    const receiver = callee.childForFieldName('object');
    const method = callee.childForFieldName('property');
    if (
      !receiver ||
      method?.type !== 'property_identifier' ||
      (method.text !== 'registerTool' && method.text !== 'tool') ||
      !sdkReceiver(receiver, scopes.get(call.id)!, scopes)
    )
      continue;
    const args =
      call
        .childForFieldName('arguments')
        ?.namedChildren.filter((child) => child.type !== 'comment') ?? [];
    if (args.some((arg) => arg.type === 'spread_element')) continue;
    if (method.text === 'registerTool' ? args.length !== 3 : args.length < 2 || args.length > 5)
      continue;
    const toolName = plainString(args[0]);
    if (toolName === null) continue;
    const description =
      method.text === 'registerTool'
        ? descriptionFromConfig(args[1])
        : args.length > 2
          ? (plainString(args[1]) ?? '')
          : '';
    const handler = handlerNodeId(args[args.length - 1], scopes.get(call.id)!, callableBindings);
    definitions.push({
      filePath,
      toolName,
      description,
      lineNumber: call.startPosition.row + 1 + lineOffset,
      ...(handler !== undefined ? { handlerNodeId: handler } : {}),
      allowFileFallback: false,
    });
  }
  return definitions;
}
