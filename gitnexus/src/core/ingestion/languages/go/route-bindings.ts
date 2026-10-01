import type { SyntaxNode } from 'tree-sitter';

const FUNCTIONS = new Set(['function_declaration', 'method_declaration', 'func_literal']);
const SCOPES = new Set([
  'block',
  'if_statement',
  'for_statement',
  'expression_switch_statement',
  'type_switch_statement',
  'select_statement',
  'expression_case',
  'type_case',
  'communication_case',
  'default_case',
]);

const BINDING_NODES = new Set([
  'short_var_declaration',
  'var_spec',
  'const_spec',
  'assignment_statement',
  'range_clause',
  'receive_statement',
  'type_switch_statement',
  'type_spec',
  'type_alias',
]);

/** A declaration, shared by every use and assignment that resolves to it. */
export interface GoRouteBinding {
  readonly visibleFrom: number;
  readonly ownerFunction: SyntaxNode;
  readonly type: SyntaxNode | null;
  readonly isInputParameter: boolean;
  readonly values: (SyntaxNode | null)[];
  capturedWrite: boolean;
}

function enclosingGoFunction(node: SyntaxNode): SyntaxNode | undefined {
  for (let current: SyntaxNode | null = node; current; current = current.parent) {
    if (FUNCTIONS.has(current.type)) return current;
  }
  return undefined;
}

function lexicalScope(node: SyntaxNode): SyntaxNode | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (SCOPES.has(current.type)) return current;
    if (FUNCTIONS.has(current.type)) return current.childForFieldName('body') ?? undefined;
  }
  return undefined;
}

/**
 * Route-local binding evidence. Declaration identity and visibility follow Go
 * blocks; value inference deliberately remains conservative across all writes.
 * Nested functions are visited so writes to captured locals cannot leave stale
 * proofs. Their own declarations remain separate from the captured bindings.
 */
export class GoRouteBindings {
  private readonly scopes = new Map<number, Map<string, GoRouteBinding>>();

  constructor(root: SyntaxNode) {
    const assignments: { name: SyntaxNode; value: SyntaxNode | null }[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) break;
      if (FUNCTIONS.has(node.type)) this.parameters(node);
      this.collectNode(node, assignments);
      for (let i = node.namedChildCount - 1; i >= 0; i--) {
        const child = node.namedChild(i);
        if (child) stack.push(child);
      }
    }
    // Resolve writes after collecting declarations, but at each write's source
    // position. A short declaration's LHS can refer to its newly declared name;
    // its initializer still sees the previous scope through ordinary lookup.
    for (const { name, value } of assignments) {
      const parent = name.parent?.type === 'expression_list' ? name.parent.parent : name.parent;
      const declaration = parent?.type === 'short_var_declaration';
      const scope = declaration && parent ? lexicalScope(parent) : undefined;
      const binding = scope ? this.scopes.get(scope.id)?.get(name.text) : this.lookup(name);
      if (!binding) continue;
      binding.values.push(value);
      if (enclosingGoFunction(name)?.id !== binding.ownerFunction.id) binding.capturedWrite = true;
    }
  }

  private collectNode(
    node: SyntaxNode,
    assignments: { name: SyntaxNode; value: SyntaxNode | null }[],
  ): void {
    if (!BINDING_NODES.has(node.type)) return;
    const scope = lexicalScope(node);
    if (!scope) return;
    if (node.type === 'short_var_declaration') {
      const names = node.childForFieldName('left')?.namedChildren ?? [];
      const values = node.childForFieldName('right')?.namedChildren ?? [];
      names.forEach((name, index) => {
        if (name.type !== 'identifier' || name.text === '_') return;
        const existing = this.scopes.get(scope.id)?.get(name.text);
        if (!existing) this.declare(name, scope, node.endIndex);
        assignments.push({ name, value: this.pairedValue(values, names.length, index) });
      });
    } else if (node.type === 'var_spec' || node.type === 'const_spec') {
      const names = node.childrenForFieldName('name');
      const values = node.childForFieldName('value')?.namedChildren ?? [];
      for (const [index, name] of names.entries()) {
        const binding = this.declare(name, scope, node.endIndex, node.childForFieldName('type'));
        if (binding && values.length > 0) {
          binding.values.push(this.pairedValue(values, names.length, index));
        }
      }
    } else if (node.type === 'assignment_statement') {
      const names = node.childForFieldName('left')?.namedChildren ?? [];
      const values = node.childForFieldName('right')?.namedChildren ?? [];
      names.forEach((name, index) => {
        if (name.type === 'identifier') {
          assignments.push({ name, value: this.pairedValue(values, names.length, index) });
        }
      });
    } else if (node.type === 'range_clause' || node.type === 'receive_statement') {
      const declares = node.children.some((child) => child.type === ':=');
      for (const name of node.childForFieldName('left')?.namedChildren ?? []) {
        if (name.type !== 'identifier') continue;
        if (declares) this.declare(name, scope, node.endIndex)?.values.push(null);
        else assignments.push({ name, value: null });
      }
    } else if (node.type === 'type_switch_statement') {
      for (const name of node.childForFieldName('alias')?.namedChildren ?? []) {
        this.declare(name, node, name.endIndex)?.values.push(null);
      }
    } else if (node.type === 'type_spec' || node.type === 'type_alias') {
      const name = node.childForFieldName('name');
      if (name) this.declare(name, scope, name.endIndex);
    }
  }

  lookup(node: SyntaxNode): GoRouteBinding | undefined {
    for (let current: SyntaxNode | null = node; current; current = current.parent) {
      const binding = this.scopes.get(current.id)?.get(node.text);
      if (binding && binding.visibleFrom <= node.startIndex) return binding;
    }
    return undefined;
  }

  private declare(
    name: SyntaxNode,
    scope: SyntaxNode,
    visibleFrom: number,
    type: SyntaxNode | null = null,
    isInputParameter = false,
  ): GoRouteBinding | undefined {
    if (name.text === '_') return undefined;
    const ownerFunction = enclosingGoFunction(scope);
    if (!ownerFunction) return undefined;
    let names = this.scopes.get(scope.id);
    if (!names) {
      names = new Map();
      this.scopes.set(scope.id, names);
    }
    const binding: GoRouteBinding = {
      visibleFrom,
      ownerFunction,
      type,
      isInputParameter,
      values: [],
      capturedWrite: false,
    };
    names.set(name.text, binding);
    return binding;
  }

  private parameters(fn: SyntaxNode): void {
    const body = fn.childForFieldName('body');
    if (!body) return;
    for (const parameter of fn.childForFieldName('type_parameters')?.namedChildren ?? []) {
      for (const name of parameter.childrenForFieldName('name')) {
        this.declare(name, fn, name.endIndex);
      }
    }
    for (const field of ['receiver', 'parameters', 'result']) {
      for (const parameter of fn.childForFieldName(field)?.namedChildren ?? []) {
        if (
          parameter.type !== 'parameter_declaration' &&
          parameter.type !== 'variadic_parameter_declaration'
        )
          continue;
        const fixed = parameter.type === 'parameter_declaration';
        for (const name of parameter.childrenForFieldName('name')) {
          this.declare(
            name,
            body,
            body.startIndex,
            fixed ? parameter.childForFieldName('type') : null,
            fixed && field !== 'result',
          );
        }
      }
    }
  }

  private pairedValue(
    values: readonly SyntaxNode[],
    count: number,
    index: number,
  ): SyntaxNode | null {
    // A multi-result call proves only the first result's constructor hint.
    return (values.length === count ? values[index] : index === 0 ? values[0] : null) ?? null;
  }
}
